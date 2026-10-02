// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Rib,
  RibAction,
  RibContext,
  RibRunEvent,
  RibViewDescriptor,
  SnapshotManager,
} from "@keelson/shared";
import { z } from "zod";
import {
  BdClient,
  type BdSummary,
  type BeadsProject,
  discoverBeadsProjects,
  type Measured,
  unmeasured,
} from "./bd";
import { BEAD_ID_PATTERN } from "./bead-id";
import {
  composeBacklog,
  composeInspect,
  composeInspectNeedsBd,
  composeMeasuringPanel,
  composeMeasuringPulse,
  composePulse,
  composeRecommend,
  composeShipped,
  composeSweepFailed,
  composeTrackers,
  composeWip,
  composeYourCalls,
  EMPTY_PANEL,
  recommendNext,
} from "./board";
import {
  ALL_KEYS,
  ATTENTION_KEY,
  BACKLOG_KEY,
  BEADS_SURFACE_ID,
  EPIC_MAP_KEY,
  INSPECT_KEY,
  PULSE_KEY,
  RECOMMEND_KEY,
  SHIPPED_KEY,
  TRACKERS_KEY,
  WIP_KEY,
} from "./keys";
import { composeEpicMap, epicMapFailed } from "./map";
import {
  bdBelowFloor,
  fetchIssue,
  measureProject,
  type ProjectMeasurement,
  readComments,
  SWEEP_STEPS,
  type SweepProgress,
} from "./measure";
import { GhClient } from "./pr";
import { type SyncReport, syncMergedPRs } from "./sync";
import { makeBeadsTools } from "./tools";

// ── Module state, reset on every activation.
let snapshots: SnapshotManager | undefined;
let unregisters: (() => void)[] = [];
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let seedTimer: ReturnType<typeof setTimeout> | undefined;
let bdClient: BdClient | undefined;
let ghClient: GhClient | undefined;
const syncingProjects = new Set<string>();
let listBeadsProjects: (() => BeadsProject[]) | undefined;
let dataDir: string | undefined;
const cleanupInFlight = new Map<string, Promise<void>>();

// The rib owns its scope: the tracker strip posts `select-project` with a
// beads project id, the choice persists across restarts, and with none saved
// the first tracker by name is shown. `selectedBeadId` drives the inspector
// and resets on scope change.
let scopeId: string | undefined;
let selectedBeadId: string | undefined;

const REFRESH_MS = 300_000;
// Boot-time compose can race project loading; one early re-seed repaints the
// first frames without waiting a full cadence.
const SEED_RETRY_MS = 15_000;
// One bd sweep per project feeds every panel. Only refreshAll() (cadence,
// mutation) pays for a re-measure — invalidation is event-driven, so the TTL
// matches the cadence and exists only as a backstop. A failed sweep expires
// sooner so the next compose retries.
const MEASURE_TTL_MS = REFRESH_MS;
const FAILED_TTL_MS = 30_000;
// Projects whose last good sweep stays in memory, so switching back paints
// at once and refreshes in place.
const KEEP_PROJECTS = 6;

interface Sweep {
  at: number;
  promise: Promise<ProjectMeasurement>;
  progress: SweepProgress;
  result?: Measured<ProjectMeasurement>;
}

const sweeps = new Map<string, Sweep>();
const lastGood = new Map<string, ProjectMeasurement>();
// Tile counts for the tracker strip, one `bd status` per project.
const summaries = new Map<string, Measured<BdSummary>>();
let summariesAt = 0;
let summariesRunning = false;

const FRAME_BEAD_ID = new RegExp(`^${BEAD_ID_PATTERN}$`);
const selectProjectPayload = z.object({ scopeId: z.string().min(1).optional() });
const beadPayload = z.object({ id: z.string().min(1) });
const runDetailPayload = z.object({
  data: z.object({
    run: z.object({
      runId: z.string(),
      workflowName: z.string(),
      status: z.string(),
      completedAt: z.string().nullable(),
      projectId: z.string().nullable(),
      workingDir: z.string().nullable(),
      nodes: z.array(
        z.object({
          nodeId: z.string(),
          status: z.string(),
          outputText: z.string().nullable(),
          startedAt: z.string().nullable(),
        }),
      ),
    }),
  }),
});
const claimOutput = z.object({
  status: z.string(),
  id: z.string().optional(),
  assignee: z.string().optional(),
});
const cleanupIssue = z.object({
  id: z.string(),
  status: z.string(),
  assignee: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

function prFromOutput(output: string, nodeId: string): string | undefined {
  const url = /https?:\/\/[^\s"'<>]+\/pull\/\d+/.exec(output)?.[0];
  if (url) return url;
  const number =
    /\b(?:PR|pull request)\s*(?:number|#|:|=)\s*#?(\d+)\b/i.exec(output)?.[1] ??
    /\bpr[_-]?number\s*["']?\s*[:=]\s*["']?(\d+)\b/i.exec(output)?.[1] ??
    (nodeId === "create-pr" ? /"number"\s*:\s*"?(\d+)"?/.exec(output)?.[1] : undefined);
  return number ? `#${number}` : undefined;
}

async function cleanupEndedRun(event: RibRunEvent, ctx: RibContext): Promise<void> {
  const exec = ctx.getExec();
  const result = await exec.runJSON<unknown>(
    "keelson",
    ["workflow", "status", event.runId, "--json"],
    { timeoutMs: 30_000 },
  );
  if (!result.ok) throw new Error(`beads-work ${event.runId}: run detail failed: ${result.error}`);
  const parsed = runDetailPayload.safeParse(result.data);
  if (!parsed.success) throw new Error(`beads-work ${event.runId}: invalid workflow run detail`);
  const run = parsed.data.data.run;
  if (
    run.runId !== event.runId ||
    run.workflowName !== event.workflowName ||
    run.status !== event.status ||
    (event.completedAt && run.completedAt !== event.completedAt)
  ) {
    return;
  }
  const writeback = run.nodes.find((node) => node.nodeId === "beads-writeback");
  if (
    event.status === "failed" &&
    (writeback?.startedAt || writeback?.status === "succeeded" || writeback?.status === "failed")
  ) {
    return;
  }

  const claim = run.nodes.find((node) => node.nodeId === "claim");
  if (!claim) throw new Error(`beads-work ${event.runId}: claim node missing from run detail`);
  if (claim.status !== "succeeded") return;
  if (!claim.outputText) return;
  const output = claimOutput.safeParse(JSON.parse(claim.outputText));
  if (!output.success) throw new Error(`beads-work ${event.runId}: invalid claim output`);
  if (output.data.status === "empty") return;
  if (output.data.status !== "claimed" || !output.data.id) {
    throw new Error(`beads-work ${event.runId}: claimed bead ID not recorded`);
  }
  const explicitId = event.inputs.bead?.trim();
  const beadId = output.data.id;
  if (explicitId && explicitId !== beadId) return;
  // Older runs did not persist the claim's assignee; they cannot safely release it.
  if (!output.data.assignee) return;

  const cwd =
    (run.projectId &&
      ctx.getProjects?.().find((project) => project.id === run.projectId)?.rootPath) ||
    run.workingDir;
  if (!cwd) throw new Error(`beads-work ${event.runId}: run project directory not recorded`);
  const bd = bdClient;
  if (!bd) throw new Error(`beads-work ${event.runId}: bd client not registered`);
  const shown = await bd.readJSON<unknown>(cwd, ["show", beadId]);
  if (!shown.ok) throw new Error(`beads-work ${event.runId}: bd show ${beadId}: ${shown.error}`);
  const issue = cleanupIssue.safeParse(Array.isArray(shown.data) ? shown.data[0] : shown.data);
  if (!issue.success || issue.data.id !== beadId) {
    throw new Error(`beads-work ${event.runId}: invalid bd show result for ${beadId}`);
  }
  if (issue.data.status !== "in_progress" || issue.data.assignee !== output.data.assignee) return;

  const createPrIndex = run.nodes.findIndex((node) => node.nodeId === "create-pr");
  if (createPrIndex < 0) throw new Error(`beads-work ${event.runId}: create-pr node missing`);
  const pr = run.nodes
    .slice(createPrIndex)
    .flatMap((node) => (node.outputText ? [prFromOutput(node.outputText, node.nodeId)] : []))
    .find((value) => value !== undefined);
  const createPr = run.nodes[createPrIndex];
  const prUnknown =
    !pr &&
    (Boolean(createPr?.startedAt) ||
      createPr?.status === "succeeded" ||
      createPr?.status === "failed");
  const disposition = prUnknown
    ? "PR state unknown; claim retained"
    : pr
      ? "claim retained"
      : "claim released";
  const marker = `run ${event.runId}; ${event.status}; ended ${event.completedAt ?? "unknown"}`;
  const note = `bead-work run: PR ${pr ?? (prUnknown ? "unknown" : "none")} — ${event.status} — ${marker}; ${disposition}`;
  if (issue.data.notes?.split("\n").some((line) => line.includes(marker))) return;
  const args = ["update", beadId];
  if (!pr && !prUnknown) args.push("--status", "open", "--assignee", "");
  args.push("--append-notes", note);
  const updated = await bd.mutate(cwd, args);
  if (!updated.ok)
    throw new Error(`beads-work ${event.runId}: bd update ${beadId}: ${updated.error}`);
  refreshAll();
}
const syncPayload = z.object({ projectId: z.string().min(1) });

function sortedTrackers(): BeadsProject[] {
  return [...(listBeadsProjects?.() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

const scopeFile = (): string | undefined => (dataDir ? join(dataDir, "scope.json") : undefined);

function savedScope(): string | undefined {
  const file = scopeFile();
  if (!file || !existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { scopeId?: unknown };
    return typeof raw.scopeId === "string" ? raw.scopeId : undefined;
  } catch {
    return undefined;
  }
}

function saveScope(id: string): void {
  const file = scopeFile();
  if (!file || !dataDir) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ scopeId: id }));
  } catch {
    // A lost preference costs one click; it never blocks the board.
  }
}

// The scope resolves lazily: projects can register after activation, and a
// tracker that disappears falls back to the saved choice or the first one.
function scopedProject(): BeadsProject | undefined {
  const trackers = sortedTrackers();
  const current = scopeId ? trackers.find((p) => p.id === scopeId) : undefined;
  if (current) return current;
  const saved = savedScope();
  const fallback = trackers.find((p) => p.id === saved) ?? trackers[0];
  scopeId = fallback?.id;
  return fallback;
}

function startSweep(project: BeadsProject): Sweep {
  if (!bdClient || !ghClient) {
    const error = "beads clients not bound";
    const promise = Promise.reject(new Error(error));
    promise.catch(() => undefined);
    return {
      at: Date.now(),
      promise,
      progress: { done: 0, total: SWEEP_STEPS, label: "bd version" },
      result: unmeasured(error),
    };
  }
  const progress: SweepProgress = { done: 0, total: SWEEP_STEPS, label: "bd version" };
  let started: Sweep | undefined;
  const promise = measureProject(bdClient, project, undefined, ghClient, (p) => {
    if (!started) return;
    started.progress = p;
    if (scopeId === project.id && sweeps.get(project.id) === started) recomposeKeys([PULSE_KEY]);
  });
  const sweep: Sweep = { at: Date.now(), progress, promise };
  started = sweep;
  sweeps.set(project.id, sweep);
  const settle = (result: Measured<ProjectMeasurement>) => {
    if (sweeps.get(project.id) !== sweep) return;
    sweep.result = result;
    if (result.ok) {
      lastGood.delete(project.id);
      lastGood.set(project.id, result.data);
      while (lastGood.size > KEEP_PROJECTS) {
        const oldest = lastGood.keys().next().value;
        if (oldest === undefined) break;
        lastGood.delete(oldest);
      }
      summaries.set(project.id, result.data.summary);
    } else {
      sweep.at = Date.now() - MEASURE_TTL_MS + FAILED_TTL_MS;
    }
    if (scopeId === project.id) recomposeKeys(ALL_KEYS);
    void refreshSummaries();
  };
  sweep.promise.then(
    (m) => settle({ ok: true, data: m }),
    (err) => settle(unmeasured(err instanceof Error ? err.message : String(err))),
  );
  return sweep;
}

function getSweep(project: BeadsProject): Sweep {
  const sweep = sweeps.get(project.id);
  if (sweep && (!sweep.result || Date.now() - sweep.at < MEASURE_TTL_MS)) return sweep;
  return startSweep(project);
}

// The settled measurement when there is one, else the in-flight sweep's.
// Callers that must answer now (the inspector) prefer the last good sweep.
async function currentMeasurement(project: BeadsProject): Promise<ProjectMeasurement> {
  const sweep = getSweep(project);
  if (sweep.result?.ok) return sweep.result.data;
  const previous = lastGood.get(project.id);
  if (previous && !sweep.result) return previous;
  return sweep.promise;
}

// Counts for the strip's other tiles, read after the selected sweep so they
// never delay it (bd is serialized). Throttled to half the cadence.
async function refreshSummaries(): Promise<void> {
  if (summariesRunning || !bdClient) return;
  if (Date.now() - summariesAt < REFRESH_MS / 2 && summaries.size > 0) {
    recomposeKeys([TRACKERS_KEY]);
    return;
  }
  summariesRunning = true;
  try {
    for (const project of sortedTrackers()) {
      if (project.id === scopeId && summaries.has(project.id)) continue;
      const bd = bdClient;
      if (!bd) return;
      const res = await bd
        .readJSON<{ summary?: BdSummary }>(project.rootPath, ["status"])
        .catch((err: unknown) =>
          unmeasured<{ summary?: BdSummary }>(err instanceof Error ? err.message : String(err)),
        );
      summaries.set(
        project.id,
        res.ok
          ? res.data.summary
            ? { ok: true, data: res.data.summary }
            : unmeasured("bd status carried no summary")
          : res,
      );
      recomposeKeys([TRACKERS_KEY]);
    }
    summariesAt = Date.now();
  } finally {
    summariesRunning = false;
  }
}

// The host answers a recompose that lands mid-compose with the in-flight
// frame, so a state change during a compose would never paint. A key asked
// for while composing runs once more when that compose ends.
const composing = new Set<string>();
const recomposeAgain = new Set<string>();

function recomposeKey(key: string): void {
  const sm = snapshots;
  if (!sm) return;
  if (composing.has(key)) {
    recomposeAgain.add(key);
    return;
  }
  composing.add(key);
  sm.recompose(key)
    .catch(() => undefined)
    .finally(() => {
      composing.delete(key);
      if (recomposeAgain.delete(key) && snapshots === sm) recomposeKey(key);
    });
}

function recomposeKeys(keys: readonly string[]): void {
  for (const key of keys) recomposeKey(key);
}

function refreshAll(): void {
  sweeps.clear();
  summariesAt = 0;
  recomposeKeys(ALL_KEYS);
}

async function reconcile(project: BeadsProject, confirm: boolean): Promise<SyncReport> {
  if (!bdClient || !ghClient) throw new Error("beads clients not bound");
  if (syncingProjects.has(project.id))
    throw new Error(`reconciliation already running for ${project.name}`);
  syncingProjects.add(project.id);
  try {
    return await syncMergedPRs(bdClient, ghClient, project, { confirm });
  } finally {
    syncingProjects.delete(project.id);
    if (confirm) refreshAll();
  }
}

function syncErrors(report: SyncReport): string | undefined {
  const failures = report.results.filter((result) => result.status === "error");
  return (
    report.error ??
    (failures.length ? `${failures.length} bead(s) could not be reconciled` : undefined)
  );
}

// Composer factory: every panel resolves the scope the same way. With no
// tracker registered only the strip renders; the rest hide (the
// zero-section signal). A pending sweep paints the project's last good
// measurement when there is one, else a measuring placeholder; the sweep's
// settle recomposes every key.
function makePanelComposer(
  compose: (m: ProjectMeasurement, refreshing?: SweepProgress) => unknown,
  measuring: (projectName: string, progress: SweepProgress) => unknown,
  failed: (error: string) => unknown = composeSweepFailed,
  resting: unknown = EMPTY_PANEL,
): () => Promise<unknown> {
  return async () => {
    const project = scopedProject();
    if (!project) return resting;
    const sweep = getSweep(project);
    // The host keeps the last frame when a composer throws, which would
    // leave a placeholder or another project's panels standing.
    const safely = (m: ProjectMeasurement, refreshing?: SweepProgress) => {
      try {
        return compose(m, refreshing);
      } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
      }
    };
    if (sweep.result)
      return sweep.result.ok ? safely(sweep.result.data) : failed(sweep.result.error);
    const previous = lastGood.get(project.id);
    return previous ? safely(previous, sweep.progress) : measuring(project.name, sweep.progress);
  };
}

function composeTrackerStrip(): unknown {
  const project = scopedProject();
  return composeTrackers(
    sortedTrackers().map((p) => ({
      id: p.id,
      name: p.name,
      ...(summaries.has(p.id) ? { summary: summaries.get(p.id) } : {}),
    })),
    project?.id,
  );
}

const rib: Rib = {
  id: "beads",
  displayName: "Beads",

  views: ALL_KEYS.map(
    (key): RibViewDescriptor => ({
      key,
      canvasKind: key === EPIC_MAP_KEY ? "html" : "view",
      title: `Beads — ${key.split(":").pop()}`,
    }),
  ),

  // The tracker strip on top picks the backlog; the Overview under it says
  // the totals. Then three zones in the order the operator acts: what is
  // running, what to start and the calls only a person can make; the epic map
  // at full width, hidden when no epic is open; then what is loose and what
  // landed. The inspector has no region; selection opens it in the canvas
  // drawer. The rib drives refresh in-process, so regions declare no cadence.
  // Not projectScoped: the host's picker lists every project and moves Chat's
  // active project too, while this strip lists only trackers.
  surfaces: [
    {
      id: BEADS_SURFACE_ID,
      title: "Beads",
      heading: "Beads backlog",
      subtitle: "Measured with bd: what's in flight, what's left, and what shipped.",
      layout: {
        header: {
          key: TRACKERS_KEY,
          title: "Trackers",
          glyph: { char: "▦", tone: "accent" },
        },
        rows: [
          {
            columns: [
              {
                key: PULSE_KEY,
                title: "Overview",
                glyph: { char: "◉", tone: "accent" },
                live: true,
              },
            ],
          },
          {
            zoneTitle: "Now",
            columns: [
              { key: WIP_KEY, title: "In flight", glyph: { char: "◐", tone: "info" } },
              { key: RECOMMEND_KEY, title: "Next up", glyph: { char: "→", tone: "accent" } },
              {
                key: ATTENTION_KEY,
                title: "Your calls",
                glyph: { char: "◆", tone: "warn" },
                hideWhenEmpty: true,
              },
            ],
          },
          {
            zoneTitle: "Epics",
            columns: [
              {
                key: EPIC_MAP_KEY,
                title: "Wave map",
                glyph: { char: "▰", tone: "accent" },
                hideWhenEmpty: true,
              },
            ],
          },
          {
            zoneTitle: "Backlog and shipped",
            columns: [
              {
                key: BACKLOG_KEY,
                title: "Backlog",
                glyph: { char: "○", tone: "accent" },
                collapsible: true,
                hideWhenEmpty: true,
              },
              {
                key: SHIPPED_KEY,
                title: "Shipped",
                glyph: { char: "✓", tone: "ok" },
                collapsible: true,
              },
            ],
          },
        ],
      },
    },
  ],

  contributeDocs: () => [
    {
      title: "Beads",
      summary:
        "The Beads rib for Keelson: a beads (bd) backlog bridged as chat tools, an overview-plus-inspector backlog surface, and workflows that drive work from the ready queue.",
      content: [
        "# Beads rib",
        "",
        "Bridges the beads issue tracker (the `bd` CLI) into keelson. Any registered",
        "keelson project whose repository carries a `.beads/` directory is discovered",
        "automatically; every tool takes an optional `project` name when several are",
        "registered.",
        "",
        "## The surface",
        "",
        "A tracker strip on top lists every registered project with a .beads",
        "tracker and its counts; a click switches the board and the choice persists.",
        "A first sweep fills a progress meter; a project seen before paints from its",
        "last sweep and refreshes in place. The Overview's flow strip (waiting → ready →",
        "in progress → in review → done 7d) carries the totals, leaves out empty lanes,",
        "and reports a shared",
        "cause once: a bd older than 1.2 or a gh that fails every PR lookup. Now holds",
        "In flight (every claim with a stage meter — claimed, PR open, merged — its",
        "live stage, what closing it releases, and the newest comment or run remark),",
        "Next up (one leverage-ranked pick with its unlock chain, runner-up, and",
        "Inspect / Start actions; never a person's call) and Your calls (beads of",
        "type decision or labelled owner or human, ranked by the work waiting on",
        "each; hidden when empty). Merged PRs to reconcile and agent housekeeping",
        "(stale claims, epic closeouts) are one line each on the Overview.",
        "Epics holds the wave map: each open epic's children in columns,",
        "a column being one more than the deepest column among a bead's open",
        "blockers, with lines to its blockers and a holds N tag on a bead that holds",
        "two or more and a your call tag on a person's call. Clicking a bead in the",
        "map opens the inspector.",
        "Backlog and shipped holds the Backlog (open beads on no",
        "epic, grouped by priority; hidden when there are none) and Shipped: closes",
        "this week against last, created this week against last, and every close in",
        "the fortnight by day, one row each with its PR. Clicking any bead",
        "opens the inspector in a side drawer beside the board: the title over a",
        "line of facts,",
        "dependency links by edge type (each opens that bead), description,",
        "acceptance criteria, and a history timeline (created, claimed, plan, PR,",
        "comments, closed). Every panel is fail-closed: a failed bd query renders",
        "UNMEASURED, never empty-but-healthy.",
        "Panels measure linked PRs read-only on a 5-minute cadence using an",
        "authenticated gh CLI. There is no automatic merge webhook. The confirmed",
        "Reconcile merged PRs action rechecks and closes eligible beads in the",
        "selected project with reason Merged via <canonical PR URL>; refresh alone",
        "never closes anything. Mutations recompose immediately;",
        "beads_board_refresh does so on demand.",
        "",
        "## Tools",
        "",
        "Read: beads_projects, beads_status, beads_ready, beads_blocked, beads_show,",
        "beads_list, beads_epics, beads_stale.",
        "Write: beads_create, beads_update (claim/status/priority/notes),",
        "beads_close (manual, confirmation-gated), beads_dep.",
        "beads_sync_merged is state-changing: omit confirm for a read-only preview",
        "of bead ID, PR URL and merge timestamp; confirm: true closes verified",
        "merged PR beads and reports closed, skipped and error results. Its optional",
        "project name defaults only when exactly one beads project is registered.",
        "",
        "## Conventions the tools encode",
        "",
        "- Ready order is priority, but leverage outranks it: a bead with a high",
        "  dependent_count unblocks the most downstream work — start there.",
        "- Epics are structure, never work items (`--exclude-type=epic`).",
        "- A decision, or a bead labelled owner or human, is a person's call: Next up",
        "  skips it and beads-work never auto-claims it (an explicit id still works).",
        "- Closing follows verified merge and explicit confirmation, or manual",
        "  beads_close with a reason; automated runs never close beads. Cleanup",
        "  releases only a claim still held by the run when create-pr never",
        "  started and no PR is recorded. Epic acceptance criteria still need review.",
        "- No one-liner beads: batch trivia, split research into its own bead.",
        "",
        "## Workflows",
        "",
        "- `beads-next` — recommends what to start first (leverage-ranked), read-only.",
        "- `beads-groom` — backlog health report: stale claims, blocked chains,",
        "  priority drift; proposes bd commands, never runs them.",
        "- `beads-work` — claims a bead (or takes an id), plans, gates on approval,",
        "  implements in a worktree, opens a draft PR, reviews, waits on CI, and",
        "  records the outcome on the bead. Never closes; on cancellation or failure",
        "  before writeback, retains claims with a recorded or unknown PR state, and",
        "  releases to open with no assignee only when create-pr never started and",
        "  no PR exists.",
        "  After the PR merges, use reconciliation or manual beads_close.",
      ].join("\n"),
    },
  ],

  registerTools: (ctx: RibContext) => {
    const exec = ctx.getExec();
    bdClient = new BdClient(exec);
    ghClient = new GhClient(exec);
    listBeadsProjects = () => discoverBeadsProjects(ctx.getProjects?.() ?? []);
    dataDir = ctx.getDataDir?.();

    for (const un of unregisters) un();
    unregisters = [];
    snapshots = ctx.getSnapshotManager?.();
    if (snapshots) {
      const sm = snapshots;
      const register = (key: string, compose: () => Promise<unknown>) =>
        unregisters.push(sm.register(key, compose));
      register(TRACKERS_KEY, async () => composeTrackerStrip());
      register(PULSE_KEY, makePanelComposer(composePulse, composeMeasuringPulse));
      const panel = (
        key: string,
        compose: (m: ProjectMeasurement, ctx: { selectedId?: string }) => unknown,
      ) =>
        register(
          key,
          makePanelComposer(
            (m) => compose(m, { selectedId: selectedBeadId }),
            composeMeasuringPanel,
          ),
        );
      panel(RECOMMEND_KEY, composeRecommend);
      panel(WIP_KEY, composeWip);
      panel(ATTENTION_KEY, composeYourCalls);
      panel(BACKLOG_KEY, composeBacklog);
      panel(SHIPPED_KEY, composeShipped);
      // An empty fragment hides the region, at rest and while measuring.
      register(
        EPIC_MAP_KEY,
        makePanelComposer(composeEpicMap, () => "", epicMapFailed, ""),
      );
      register(INSPECT_KEY, async () => {
        const project = scopedProject();
        if (!project || !bdClient) return composeInspect(undefined, []);
        if (!selectedBeadId) return composeInspect(undefined, []);
        const m = await currentMeasurement(project);
        if (bdBelowFloor(m)) return composeInspectNeedsBd(m);
        const id = selectedBeadId;
        const issue = await fetchIssue(bdClient, project.rootPath, id);
        const comments =
          issue.ok && issue.data.comment_count
            ? await readComments(bdClient, project.rootPath, id)
            : undefined;
        // The board's current pick rides along: when the inspected bead is
        // blocked, "Start X instead" must name the same bead Next up does.
        const rec = m.ready.ok ? recommendNext(m.ready.data).pick : undefined;
        const epicRow = m.epics.ok ? m.epics.data.find((r) => r.epic.id === id) : undefined;
        return composeInspect(issue, m.blocked.ok ? m.blocked.data : [], rec, {
          epicRow,
          prInfo: m.prInfo,
          projectId: project.id,
          ...(comments ? { comments } : {}),
        });
      });

      recomposeKeys(ALL_KEYS);
      if (seedTimer) clearTimeout(seedTimer);
      seedTimer = setTimeout(refreshAll, SEED_RETRY_MS);
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(refreshAll, REFRESH_MS);
    }

    return makeBeadsToolsBound();
  },

  onRunEvent: async (event: RibRunEvent, ctx: RibContext) => {
    if (event.workflowName !== "beads-work" || !["cancelled", "failed"].includes(event.status)) {
      return;
    }
    const key = `${event.runId}:${event.status}:${event.completedAt ?? ""}`;
    const pending = cleanupInFlight.get(key);
    if (pending) return pending;
    const task = cleanupEndedRun(event, ctx);
    cleanupInFlight.set(key, task);
    try {
      await task;
    } finally {
      if (cleanupInFlight.get(key) === task) cleanupInFlight.delete(key);
    }
  },

  // Board actions: the tracker strip posts `select-project`; the panels post
  // `select-bead` (inspector) and `claim-bead` (bd update --claim).
  onAction: async (action: RibAction) => {
    // The epic map is a sandboxed frame that renders tracker text, so a
    // frame-relayed action may select a bead and nothing else.
    if (action.origin === "canvas-html" && action.type !== "select-bead") {
      return { ok: false as const, error: `beads does not accept '${action.type}' from a frame` };
    }
    switch (action.type) {
      case "select-project": {
        const parsed = selectProjectPayload.safeParse(action.payload ?? {});
        if (!parsed.success) {
          return {
            ok: false as const,
            error: "select-project payload must be { scopeId?: string }",
          };
        }
        const target = parsed.data.scopeId;
        if (target && !sortedTrackers().some((p) => p.id === target)) {
          return { ok: false as const, error: `no beads tracker is registered as ${target}` };
        }
        if (target !== scopeId) selectedBeadId = undefined;
        scopeId = target;
        const project = scopedProject();
        if (project) saveScope(project.id);
        // A select with no tracker id re-measures the current one.
        if (project && !target) sweeps.delete(project.id);
        recomposeKeys(ALL_KEYS);
        return { ok: true as const };
      }
      case "select-bead": {
        const parsed = beadPayload.safeParse(action.payload ?? {});
        if (!parsed.success) {
          return { ok: false as const, error: "select-bead payload must be { id: string }" };
        }
        if (action.origin === "canvas-html" && !FRAME_BEAD_ID.test(parsed.data.id)) {
          return { ok: false as const, error: "select-bead from a frame needs a bead id" };
        }
        selectedBeadId = parsed.data.id;
        // Compose the inspector BEFORE answering: the open-canvas directive
        // below opens that snapshot in the drawer, and it must show the bead
        // just clicked, not the previous frame. Selection is cheap — the
        // measurement cache holds, only bd show runs.
        await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
        recomposeKeys(ALL_KEYS.filter((key) => key !== INSPECT_KEY));
        // The inspector lives only in the canvas drawer, so a click anywhere
        // on the page shows its detail in view.
        return {
          ok: true as const,
          data: {
            effect: "open-canvas" as const,
            key: INSPECT_KEY,
            title: "Bead",
            placement: "side" as const,
          },
        };
      }
      case "claim-bead": {
        const parsed = beadPayload.safeParse(action.payload ?? {});
        if (!parsed.success) {
          return { ok: false as const, error: "claim-bead payload must be { id: string }" };
        }
        const project = scopedProject();
        if (!project || !bdClient) {
          return { ok: false as const, error: "no beads project is in scope" };
        }
        const res = await bdClient.mutate(project.rootPath, ["update", parsed.data.id, "--claim"]);
        if (!res.ok) return { ok: false as const, error: `bd update --claim failed: ${res.error}` };
        selectedBeadId = parsed.data.id;
        refreshAll();
        return { ok: true as const, data: { claimed: parsed.data.id } };
      }
      case "sync-merged-beads": {
        const parsed = syncPayload.safeParse(action.payload ?? {});
        if (!parsed.success) {
          return {
            ok: false as const,
            error: "sync-merged-beads payload must be { projectId: string }",
          };
        }
        const project = scopedProject();
        if (!project || project.id !== parsed.data.projectId) {
          return {
            ok: false as const,
            error: "selected beads project no longer matches this action",
          };
        }
        try {
          const report = await reconcile(project, true);
          const error = syncErrors(report);
          return error
            ? { ok: false as const, error, data: report }
            : { ok: true as const, data: report };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
      }
      default:
        return { ok: false as const, error: `beads does not handle '${action.type}'` };
    }
  },

  dispose(): void {
    if (seedTimer) clearTimeout(seedTimer);
    seedTimer = undefined;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    for (const un of unregisters) un();
    unregisters = [];
    snapshots = undefined;
    // A re-activation resolves scope again from the saved choice.
    scopeId = undefined;
    selectedBeadId = undefined;
    sweeps.clear();
    lastGood.clear();
    composing.clear();
    recomposeAgain.clear();
    summaries.clear();
    summariesAt = 0;
    bdClient = undefined;
    ghClient = undefined;
    syncingProjects.clear();
    listBeadsProjects = undefined;
    dataDir = undefined;
    cleanupInFlight.clear();
  },
};

// The chat tools share the same client, discovery, and refresh nudge the
// panels use.
function makeBeadsToolsBound() {
  if (!bdClient || !ghClient || !listBeadsProjects) return [];
  return makeBeadsTools({
    bd: bdClient,
    beadsProjects: listBeadsProjects,
    refreshBoard: refreshAll,
    syncMerged: reconcile,
  });
}

export default rib;
