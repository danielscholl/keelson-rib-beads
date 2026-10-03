import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RibExec } from "@keelson/shared";
import {
  beadIdOf,
  type LiveRun,
  NODE_PHASE,
  phaseOf,
  RunTracker,
  runsFor,
  viewOf,
} from "../src/runs";

const WORKFLOW = readFileSync(join(import.meta.dir, "../workflows/beads-work.yml"), "utf8");

type Node = { nodeId: string; status: string; outputText?: string | null };

function detail(over: Partial<Record<string, unknown>> & { nodes?: Node[] } = {}) {
  return {
    runId: "c2ecde81-0000-0000-0000-000000000000",
    workflowName: "beads-work",
    status: "running",
    startedAt: "2026-10-02T23:01:00.000Z",
    projectId: "p1",
    workingDir: "/tmp/demo",
    inputs: { ARGUMENTS: "cos-hjf.1" },
    runningNodes: [] as { nodeId: string }[],
    nodes: [] as Node[],
    ...over,
  };
}

describe("run phases", () => {
  test("every beads-work node has a phase, and the map names no other node", () => {
    const ids = [...WORKFLOW.matchAll(/^ {2}- id: (\S+)$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(40);
    expect(ids.filter((id) => id && !NODE_PHASE[id])).toEqual([]);
    expect(Object.keys(NODE_PHASE).filter((id) => !ids.includes(id))).toEqual([]);
  });

  test("the furthest started node sets the phase; skipped rows never count", () => {
    const nodes: Node[] = [
      { nodeId: "claim", status: "succeeded" },
      { nodeId: "approve-plan", status: "succeeded" },
      { nodeId: "validate", status: "skipped" },
      { nodeId: "await-ci", status: "skipped" },
    ];
    expect(phaseOf({ nodes, runningNodes: [{ nodeId: "implement" }] })).toBe("build");
    expect(phaseOf({ nodes: nodes.slice(0, 1), runningNodes: [] })).toBe("brief");
  });

  test("an open gate reads as the approval phase", () => {
    const nodes: Node[] = [
      { nodeId: "plan", status: "succeeded" },
      { nodeId: "approve-plan", status: "awaiting" },
    ];
    expect(phaseOf({ nodes })).toBe("approval");
    expect(viewOf(detail({ status: "paused", nodes }), "2026-10-02T23:10:00.000Z")?.phase).toBe(
      "approval",
    );
  });
});

describe("binding a run to its bead", () => {
  test("ARGUMENTS names the bead first, then the claim node's output", () => {
    expect(beadIdOf({ inputs: { ARGUMENTS: "cos-hjf.1" }, nodes: [] })).toBe("cos-hjf.1");
    const claimed: Node = {
      nodeId: "claim",
      status: "succeeded",
      outputText: '{"status":"claimed","id":"cos-hjf.3","assignee":"worker"}',
    };
    expect(beadIdOf({ inputs: { ARGUMENTS: "" }, nodes: [claimed] })).toBe("cos-hjf.3");
    expect(beadIdOf({ inputs: {}, nodes: [{ ...claimed, status: "failed" }] })).toBeUndefined();
  });

  test("a run belongs to its project by id, else by working directory", () => {
    const base = { status: "running", phase: "brief", startedAt: "", readAt: "" } as const;
    const runs: LiveRun[] = [
      { ...base, runId: "a", projectId: "p1" },
      { ...base, runId: "b", workingDir: "/tmp/demo" },
      { ...base, runId: "c", projectId: "p2", workingDir: "/tmp/demo" },
    ];
    expect(runsFor(runs, { id: "p1", rootPath: "/tmp/demo" }).map((r) => r.runId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("run tracker", () => {
  function harness() {
    const runs = new Map<string, ReturnType<typeof detail>>();
    const calls: string[][] = [];
    let fail: string | undefined;
    let hold: Promise<void> | undefined;
    const exec = {
      async runJSON(_cmd: string, args: string[]) {
        calls.push(args);
        if (fail) return { ok: false, code: 1, error: fail };
        const run = runs.get(args[2] ?? "");
        const gate = hold;
        if (gate) await gate;
        return run
          ? { ok: true, data: { ok: true, data: { run } } }
          : { ok: false, code: 1, error: "not found" };
      },
    } as unknown as RibExec;
    const changes: LiveRun[][] = [];
    const tracker = new RunTracker({
      exec: () => exec,
      onChange: (changed) => changes.push([...changed]),
      pollMs: 60_000,
      now: () => new Date("2026-10-02T23:16:00.000Z"),
    });
    return {
      runs,
      calls,
      changes,
      tracker,
      failWith: (error: string | undefined) => {
        fail = error;
      },
      // Reads started now wait for release(); reads started after it do not.
      holdReads: () => {
        let release = () => {};
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        return () => release();
      },
      stopHolding: () => {
        hold = undefined;
      },
    };
  }

  const launch = (run: ReturnType<typeof detail>, status: "running" | "succeeded" = "running") => ({
    workflowName: "beads-work",
    runId: run.runId,
    status,
    inputs: { ARGUMENTS: "cos-hjf.1" },
    startedAt: run.startedAt,
  });

  test("follows a run from launch to its end, then stops reading", async () => {
    const h = harness();
    const run = detail({ runningNodes: [{ nodeId: "plan" }] });
    h.runs.set(run.runId, run);
    await h.tracker.event({
      workflowName: "beads-work",
      runId: run.runId,
      status: "running",
      inputs: {},
      startedAt: run.startedAt,
    });
    expect(h.tracker.all()).toHaveLength(1);
    expect(h.tracker.all()[0]).toMatchObject({ beadId: "cos-hjf.1", phase: "plan" });
    expect(h.changes).toHaveLength(1);

    h.runs.set(run.runId, { ...run, status: "succeeded" });
    await h.tracker.poll();
    expect(h.tracker.all()).toHaveLength(0);
    expect(h.changes.at(-1)?.[0]?.runId).toBe(run.runId);

    const before = h.calls.length;
    await h.tracker.poll();
    expect(h.calls.length).toBe(before);
    h.tracker.dispose();
  });

  test("a failed read keeps the last good view and says why", async () => {
    const h = harness();
    const run = detail({ runningNodes: [{ nodeId: "implement" }] });
    h.runs.set(run.runId, run);
    await h.tracker.event(launch(run));
    h.failWith("server unavailable");
    await h.tracker.poll();
    expect(h.tracker.all()[0]).toMatchObject({ phase: "build", error: "server unavailable" });
    h.tracker.dispose();
  });

  test("a run whose first read fails is kept, unmeasured, and keeps polling", async () => {
    const h = harness();
    const run = detail();
    h.runs.set(run.runId, { ...run, runningNodes: [{ nodeId: "implement" }] });
    h.failWith("connection refused");
    await h.tracker.event(launch(run));
    expect(h.tracker.all()[0]).toMatchObject({ beadId: "cos-hjf.1", error: "connection refused" });
    h.failWith(undefined);
    await h.tracker.poll();
    expect(h.tracker.all()[0]?.error).toBeUndefined();
    expect(h.tracker.all()[0]?.phase).toBe("build");
    h.tracker.dispose();
  });

  test("a poll that lands after the end event never brings the run back", async () => {
    const h = harness();
    const run = detail();
    h.runs.set(run.runId, run);
    await h.tracker.event(launch(run));
    const release = h.holdReads();
    const slowPoll = h.tracker.poll();
    h.stopHolding();
    h.runs.set(run.runId, { ...run, status: "succeeded" });
    await h.tracker.event(launch(run, "succeeded"));
    expect(h.tracker.all()).toHaveLength(0);
    release();
    await slowPoll;
    expect(h.tracker.all()).toHaveLength(0);
    h.tracker.dispose();
  });

  test("a run the server no longer knows is over", async () => {
    const h = harness();
    const run = detail();
    h.runs.set(run.runId, run);
    await h.tracker.event(launch(run));
    h.runs.delete(run.runId);
    await h.tracker.poll();
    expect(h.tracker.all()).toHaveLength(0);
    h.tracker.dispose();
  });

  test("a repeat read with nothing new repaints nothing", async () => {
    const h = harness();
    const run = detail({ runningNodes: [{ nodeId: "implement" }] });
    h.runs.set(run.runId, run);
    await h.tracker.event(launch(run));
    await h.tracker.poll();
    expect(h.changes).toHaveLength(1);
    h.tracker.dispose();
  });
});
