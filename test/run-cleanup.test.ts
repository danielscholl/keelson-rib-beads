import { afterEach, describe, expect, test } from "bun:test";
import type { RibContext, RibExec, RibExecOptions, RibRunEvent } from "@keelson/shared";
import rib from "../src/index";

type Node = {
  nodeId: string;
  status: "succeeded" | "failed" | "skipped";
  outputText: string | null;
  startedAt: string | null;
};

function fixture() {
  const event: RibRunEvent = {
    workflowName: "beads-work",
    runId: "run-approval-1",
    status: "cancelled",
    inputs: { bead: "cos-hjf.3" },
    startedAt: "2026-09-23T20:00:00Z",
    completedAt: "2026-09-23T20:05:00Z",
  };
  const nodes: Node[] = [
    {
      nodeId: "claim",
      status: "succeeded",
      outputText: '{"status":"claimed","id":"cos-hjf.3"}',
      startedAt: event.startedAt,
    },
    {
      nodeId: "approve-plan",
      status: "failed",
      outputText: null,
      startedAt: event.startedAt,
    },
    { nodeId: "create-pr", status: "skipped", outputText: null, startedAt: null },
    { nodeId: "beads-writeback", status: "skipped", outputText: null, startedAt: null },
  ];
  const run = {
    runId: event.runId,
    workflowName: event.workflowName,
    status: event.status,
    completedAt: event.completedAt,
    projectId: "project-1",
    workingDir: "/run/project",
    nodes,
  };
  const issue = { id: "cos-hjf.3", status: "in_progress", assignee: "worker", notes: "" };
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const updates: string[][] = [];
  let failUpdate = false;
  const exec: RibExec = {
    async runJSON<T>(cmd: string, args: string[], opts?: RibExecOptions) {
      calls.push({ cmd, args, cwd: opts?.cwd });
      if (cmd === "keelson") return { ok: true, data: { data: run } as T };
      if (cmd !== "bd") throw new Error(`Unexpected command: ${cmd}`);
      return { ok: true, data: [{ ...issue }] as T };
    },
    async runText(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts?.cwd });
      if (cmd !== "bd") throw new Error(`Unexpected command: ${cmd}`);
      updates.push(args);
      if (failUpdate) return { ok: false, code: 1, error: "bd unavailable" };
      const status = args.indexOf("--status");
      if (status !== -1) issue.status = args[status + 1] ?? issue.status;
      const assignee = args.indexOf("--assignee");
      if (assignee !== -1) issue.assignee = args[assignee + 1] ?? issue.assignee;
      const note = args.indexOf("--append-notes");
      if (note !== -1) issue.notes += `${args[note + 1]}\n`;
      return { ok: true, data: "ok" };
    },
  };
  const ctx: RibContext = {
    getExec: () => exec,
    getProjects: () => [
      { id: "project-1", name: "test", rootPath: "/project/root", createdAt: event.startedAt },
    ],
  };
  rib.registerTools?.(ctx);
  return {
    event,
    nodes,
    run,
    issue,
    calls,
    updates,
    ctx,
    failNextUpdate: () => (failUpdate = true),
  };
}

afterEach(() => rib.dispose?.());

describe("beads-work exceptional cleanup", () => {
  test("cancellation at approval releases an explicit claim and records the run reason", async () => {
    const { event, issue, updates, calls, ctx } = fixture();
    await rib.onRunEvent?.(event, ctx);
    expect(issue).toMatchObject({ status: "open", assignee: "" });
    expect(updates).toEqual([
      [
        "update",
        "cos-hjf.3",
        "--status",
        "open",
        "--assignee",
        "",
        "--append-notes",
        expect.stringContaining(
          "bead-work run: PR none — cancelled — run run-approval-1; cancelled",
        ),
      ],
    ]);
    expect(issue.notes).toContain("claim released");
    expect(calls[0]).toMatchObject({
      cmd: "keelson",
      args: ["workflow", "status", "run-approval-1", "--json"],
    });
    expect(calls[1]).toMatchObject({ cmd: "bd", cwd: "/project/root" });
  });

  test("cancellation recovers the automatically selected bead from claim JSON output", async () => {
    const { event, issue, nodes, updates, ctx } = fixture();
    event.inputs = {};
    issue.id = "cos-auto.2";
    nodes[0]!.outputText = '{"status":"claimed","id":"cos-auto.2"}';
    await rib.onRunEvent?.(event, ctx);
    expect(updates[0]?.slice(0, 2)).toEqual(["update", "cos-auto.2"]);
    expect(issue.status).toBe("open");
    expect(issue.assignee).toBe("");
  });

  test("a recorded PR number keeps the claim and appends a board-compatible note", async () => {
    const { event, issue, nodes, updates, ctx } = fixture();
    nodes[2] = {
      nodeId: "create-pr",
      status: "succeeded",
      outputText: "Created draft PR #42",
      startedAt: event.startedAt,
    };
    await rib.onRunEvent?.(event, ctx);
    expect(issue).toMatchObject({ status: "in_progress", assignee: "worker" });
    expect(updates[0]).toEqual([
      "update",
      "cos-hjf.3",
      "--append-notes",
      expect.stringContaining("bead-work run: PR #42 — cancelled — run run-approval-1"),
    ]);
  });

  test("a PR URL in a later node also keeps the claim", async () => {
    const { event, issue, nodes, ctx } = fixture();
    nodes[2] = {
      nodeId: "create-pr",
      status: "failed",
      outputText: null,
      startedAt: event.startedAt,
    };
    nodes.splice(3, 0, {
      nodeId: "enforce-draft",
      status: "succeeded",
      outputText: "PR: https://github.com/example/repo/pull/42",
      startedAt: event.startedAt,
    });
    await rib.onRunEvent?.(event, ctx);
    expect(issue.status).toBe("in_progress");
    expect(issue.notes).toContain("PR https://github.com/example/repo/pull/42");
  });

  test("started create-pr without an identifier keeps the claim and notes unknown PR state", async () => {
    const { event, issue, nodes, updates, ctx } = fixture();
    nodes[2] = {
      nodeId: "create-pr",
      status: "failed",
      outputText: "pushed branch; PR creation interrupted",
      startedAt: event.startedAt,
    };
    await rib.onRunEvent?.(event, ctx);
    expect(issue).toMatchObject({ status: "in_progress", assignee: "worker" });
    expect(issue.notes).toContain("PR state unknown");
    expect(updates[0]).not.toContain("--status");
  });

  test("a failed create-pr with a missing start timestamp still has unknown PR state", async () => {
    const { event, issue, nodes, ctx } = fixture();
    nodes[2] = {
      nodeId: "create-pr",
      status: "failed",
      outputText: null,
      startedAt: null,
    };
    await rib.onRunEvent?.(event, ctx);
    expect(issue.status).toBe("in_progress");
    expect(issue.notes).toContain("PR state unknown");
  });

  test("cancellation still releases a claim if writeback started but was interrupted", async () => {
    const { event, nodes, issue, updates, ctx } = fixture();
    nodes[3]!.status = "failed";
    nodes[3]!.startedAt = event.startedAt;
    await rib.onRunEvent?.(event, ctx);
    expect(issue).toMatchObject({ status: "open", assignee: "" });
    expect(updates).toHaveLength(1);
  });

  test("failed before writeback releases; failed after writeback does nothing", async () => {
    const { event, run, nodes, issue, updates, calls, ctx } = fixture();
    event.status = "failed";
    run.status = "failed";
    await rib.onRunEvent?.(event, ctx);
    expect(issue.status).toBe("open");
    expect(issue.notes).toContain("— failed — run run-approval-1");

    issue.status = "in_progress";
    nodes[3]!.status = "failed";
    nodes[3]!.startedAt = event.startedAt;
    await rib.onRunEvent?.(event, ctx);
    expect(updates).toHaveLength(1);
    expect(calls.filter((call) => call.cmd === "bd")).toHaveLength(2);
  });

  test("ignores other workflows and nonterminal statuses without consulting the CLI", async () => {
    const { event, calls, ctx } = fixture();
    event.workflowName = "beads-next";
    await rib.onRunEvent?.(event, ctx);
    event.workflowName = "beads-work";
    event.status = "succeeded";
    await rib.onRunEvent?.(event, ctx);
    event.status = "running";
    await rib.onRunEvent?.(event, ctx);
    expect(calls).toEqual([]);
  });

  test("duplicate events produce one note, even when delivered concurrently", async () => {
    const { event, issue, updates, ctx } = fixture();
    await Promise.all([rib.onRunEvent?.(event, ctx), rib.onRunEvent?.(event, ctx)]);
    await rib.onRunEvent?.(event, ctx);
    expect(updates).toHaveLength(1);
    expect(issue.notes.match(/bead-work run:/g)).toHaveLength(1);
  });

  test("leaves an already changed bead untouched and surfaces failed mutations", async () => {
    const { event, issue, updates, ctx, failNextUpdate } = fixture();
    issue.status = "closed";
    await rib.onRunEvent?.(event, ctx);
    expect(updates).toHaveLength(0);
    issue.status = "in_progress";
    failNextUpdate();
    await expect(rib.onRunEvent?.(event, ctx)).rejects.toThrow(
      "bd update cos-hjf.3: bd unavailable",
    );
  });
});
