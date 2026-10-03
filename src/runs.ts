// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Live beads-work runs: which run holds which bead, and how far along it is.
// bd hears from a run only when the run writes to it, so the board reads each
// live run's own status, polling while any run is live and not otherwise.

import type { RibExec, RibRunEvent } from "@keelson/shared";
import { z } from "zod";
import { extractBeadId } from "./bead-id";

export const RUN_WORKFLOW = "beads-work";
export const RUN_POLL_MS = 15_000;
const READ_TIMEOUT_MS = 10_000;

// The points where an operator would act or wait, in run order.
export const RUN_PHASES = ["brief", "plan", "approval", "build", "review", "CI"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

// Every beads-work node, by phase. A test fails when the workflow gains a node
// this map does not name.
export const NODE_PHASE: Readonly<Record<string, RunPhase>> = {
  claim: "brief",
  context: "brief",
  "detect-base": "brief",
  "seed-verify": "brief",
  "extract-brief": "brief",
  classify: "brief",
  investigate: "brief",
  "criteria-count-initial": "brief",
  "extract-brief-llm": "brief",
  "brief-ready": "brief",
  "criteria-count": "brief",
  plan: "plan",
  "plan-ready": "plan",
  "coverage-check": "plan",
  "coverage-ready": "plan",
  "approve-plan": "approval",
  "record-approval": "approval",
  implement: "build",
  validate: "build",
  "fix-validation": "build",
  revalidate: "build",
  "scrub-trailers": "build",
  "dependency-audit": "build",
  "create-pr": "review",
  "enforce-draft": "review",
  "capture-diff": "review",
  "review-correctness": "review",
  "review-conventions": "review",
  "review-coverage": "review",
  triage: "review",
  "apply-fixes": "review",
  "re-review": "review",
  "review-loop": "review",
  "post-fix-validate": "review",
  "dependency-audit-final": "review",
  "await-ci": "CI",
  "triage-ci": "CI",
  "fix-ci": "CI",
  "scrub-trailers-final": "CI",
  "finalize-pr": "CI",
  "request-review-bot": "CI",
  report: "CI",
  "distill-trail": "CI",
  "memory-trail": "CI",
  "ci-green-gate": "CI",
  "beads-writeback": "CI",
};

export interface LiveRun {
  runId: string;
  status: "running" | "paused";
  phase: RunPhase;
  startedAt: string;
  // When this view was read; elapsed times are measured against it.
  readAt: string;
  projectId?: string;
  workingDir?: string;
  // Absent until the run names its bead: ARGUMENTS, else the claim node.
  beadId?: string;
  pr?: string;
  // Present while the run waits at its plan gate.
  gate?: RunGate;
  // Set when the newest read failed; the rest is the last good read.
  error?: string;
}

export interface RunGate {
  since?: string;
  tasks?: number;
  summary?: string;
}

const runNode = z.object({
  nodeId: z.string(),
  status: z.string(),
  outputText: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
});
const runDetail = z.object({
  data: z.object({
    run: z.object({
      runId: z.string(),
      workflowName: z.string(),
      status: z.string(),
      startedAt: z.string(),
      projectId: z.string().nullable().optional(),
      workingDir: z.string().nullable().optional(),
      inputs: z.record(z.string(), z.string()).nullable().optional(),
      runningNodes: z.array(z.object({ nodeId: z.string() })).optional(),
      nodes: z.array(runNode),
    }),
  }),
});

type RunDetail = z.infer<typeof runDetail>["data"]["run"];

const isLive = (status: string): status is LiveRun["status"] =>
  status === "running" || status === "paused";

export function prFromOutput(output: string, nodeId: string): string | undefined {
  const url = /https?:\/\/[^\s"'<>]+\/pull\/\d+/.exec(output)?.[0];
  if (url) return url;
  const number =
    /\b(?:PR|pull request)\s*(?:number|#|:|=)\s*#?(\d+)\b/i.exec(output)?.[1] ??
    /\bpr[_-]?number\s*["']?\s*[:=]\s*["']?(\d+)\b/i.exec(output)?.[1] ??
    (nodeId === "create-pr" ? /"number"\s*:\s*"?(\d+)"?/.exec(output)?.[1] : undefined);
  return number ? `#${number}` : undefined;
}

// The furthest phase any started node has reached. Skipped nodes never count:
// a pending node can already carry a skipped row.
export function phaseOf(run: Pick<RunDetail, "nodes" | "runningNodes">): RunPhase {
  const started = [
    ...run.nodes.filter((n) => n.status !== "skipped").map((n) => n.nodeId),
    ...(run.runningNodes ?? []).map((n) => n.nodeId),
  ];
  let at = 0;
  for (const id of started) {
    const phase = NODE_PHASE[id];
    if (phase) at = Math.max(at, RUN_PHASES.indexOf(phase));
  }
  return RUN_PHASES[at] ?? "brief";
}

// The claim node's own order: the bead input, then the first id in ARGUMENTS.
function beadFromInputs(inputs: Record<string, string> | null | undefined): string | undefined {
  return extractBeadId(inputs?.bead) ?? extractBeadId(inputs?.ARGUMENTS);
}

export function beadIdOf(run: Pick<RunDetail, "inputs" | "nodes">): string | undefined {
  const fromInputs = beadFromInputs(run.inputs);
  if (fromInputs) return fromInputs;
  const claim = run.nodes.find((n) => n.nodeId === "claim" && n.status === "succeeded");
  if (!claim?.outputText) return undefined;
  try {
    const parsed = JSON.parse(claim.outputText) as { id?: unknown };
    return typeof parsed.id === "string" ? extractBeadId(parsed.id) : undefined;
  } catch {
    return undefined;
  }
}

function prOf(run: RunDetail): string | undefined {
  for (const id of ["finalize-pr", "create-pr"]) {
    const node = run.nodes.find((n) => n.nodeId === id && n.outputText);
    const pr = node?.outputText ? prFromOutput(node.outputText, id) : undefined;
    if (pr) return pr;
  }
  return undefined;
}

// What the plan gate asks about, from plan-ready's output: the task count and
// the plan's own summary, so a card can say what approving commits to.
export function gateOf(run: Pick<RunDetail, "nodes">): RunGate {
  const awaiting = run.nodes.find((n) => n.status === "awaiting");
  const ready = run.nodes.find((n) => n.nodeId === "plan-ready")?.outputText ?? "";
  const tasks = Number(/^TASK_COUNT=(\d+)$/m.exec(ready)?.[1]);
  const after = ready.split(/^## Summary[ \t]*$/m)[1] ?? "";
  const summary = after
    .trim()
    .split(/\n\s*\n|\n#/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return {
    ...(awaiting?.startedAt ? { since: awaiting.startedAt } : {}),
    ...(Number.isFinite(tasks) && tasks > 0 ? { tasks } : {}),
    ...(summary ? { summary } : {}),
  };
}

export function viewOf(run: RunDetail, readAt: string): LiveRun | undefined {
  if (!isLive(run.status)) return undefined;
  const beadId = beadIdOf(run);
  const pr = prOf(run);
  return {
    runId: run.runId,
    status: run.status,
    phase: phaseOf(run),
    startedAt: run.startedAt,
    readAt,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    ...(run.workingDir ? { workingDir: run.workingDir } : {}),
    ...(beadId ? { beadId } : {}),
    ...(pr ? { pr } : {}),
    ...(run.nodes.some((n) => n.nodeId === "approve-plan" && n.status === "awaiting")
      ? { gate: gateOf(run) }
      : {}),
  };
}

export function runsFor(
  runs: Iterable<LiveRun>,
  project: { id: string; rootPath: string },
): LiveRun[] {
  return [...runs]
    .filter(
      (r) => r.projectId === project.id || (!r.projectId && r.workingDir === project.rootPath),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface RunTrackerDeps {
  exec: () => RibExec | undefined;
  // Called with every run that changed or ended since the last call.
  onChange: (changed: readonly LiveRun[]) => void;
  pollMs?: number;
  now?: () => Date;
}

export class RunTracker {
  private readonly live = new Map<string, LiveRun>();
  // The newest read started per run; an older read that lands later is dropped.
  private readonly reads = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: RunTrackerDeps) {}

  all(): LiveRun[] {
    return [...this.live.values()];
  }

  async event(event: RibRunEvent): Promise<void> {
    if (event.workflowName !== RUN_WORKFLOW) return;
    if (!isLive(event.status)) return this.end(event.runId);
    // A run whose first read fails still polls, unmeasured, until one lands.
    const beadId = beadFromInputs(event.inputs);
    const seed: LiveRun | undefined = this.live.has(event.runId)
      ? undefined
      : {
          runId: event.runId,
          status: event.status,
          phase: "brief",
          startedAt: event.startedAt,
          readAt: this.nowIso(),
          ...(beadId ? { beadId } : {}),
        };
    await this.readAll([event.runId], seed);
  }

  // The host's end event is final: no read can bring the run back after it.
  private end(runId: string): void {
    this.reads.set(runId, (this.reads.get(runId) ?? 0) + 1);
    const ended = this.live.get(runId);
    this.live.delete(runId);
    this.syncTimer();
    if (ended) this.deps.onChange([{ ...ended, readAt: this.nowIso() }]);
  }

  // One poll pass over every live run; overlapping calls share the pass.
  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.readAll([...this.live.keys()]).finally(() => {
        this.polling = undefined;
      });
    }
    return this.polling;
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.live.clear();
  }

  private async readAll(runIds: readonly string[], seed?: LiveRun): Promise<void> {
    const changed: LiveRun[] = [];
    for (const runId of new Set(runIds)) {
      const ticket = (this.reads.get(runId) ?? 0) + 1;
      this.reads.set(runId, ticket);
      const read = await this.read(runId, this.live.get(runId) ?? seed);
      if (this.disposed) return;
      if (this.reads.get(runId) !== ticket) continue;
      const before = this.live.get(runId);
      const after = read;
      if (after) this.live.set(runId, after);
      else this.live.delete(runId);
      const settled = after ?? before;
      if (settled && JSON.stringify(withoutClock(before)) !== JSON.stringify(withoutClock(after))) {
        changed.push(after ?? { ...settled, readAt: this.nowIso() });
      }
    }
    this.syncTimer();
    if (changed.length) this.deps.onChange(changed);
  }

  // The run's live view, undefined once it has ended. A failed read keeps the
  // last good view with the error, so the card can say UNMEASURED.
  private async read(runId: string, before: LiveRun | undefined): Promise<LiveRun | undefined> {
    const exec = this.deps.exec();
    const fail = (error: string): LiveRun | undefined =>
      before ? { ...before, error, readAt: this.nowIso() } : undefined;
    if (!exec) return fail("exec unavailable");
    const res = await exec.runJSON<unknown>("keelson", ["workflow", "status", runId, "--json"], {
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (!res.ok) return /not found/i.test(res.error) ? undefined : fail(res.error);
    const parsed = runDetail.safeParse(res.data);
    if (!parsed.success) return fail("run detail did not parse");
    const run = parsed.data.data.run;
    if (run.workflowName !== RUN_WORKFLOW) return undefined;
    return viewOf(run, this.nowIso());
  }

  private syncTimer(): void {
    if (this.live.size > 0 && !this.timer && !this.disposed) {
      this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? RUN_POLL_MS);
    } else if (this.live.size === 0) {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

// A minute ticking over is a change worth repainting; the read clock alone is not.
function withoutClock(run: LiveRun | undefined): unknown {
  if (!run) return undefined;
  const { readAt, ...rest } = run;
  return { ...rest, minute: Math.floor(new Date(readAt).getTime() / 60_000) };
}
