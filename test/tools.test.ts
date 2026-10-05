import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, RibExec, ToolContext } from "@keelson/shared";
import { BdClient } from "../src/bd";
import { makeBeadsTools } from "../src/tools";

function updateTool() {
  const calls: string[][] = [];
  const exec: RibExec = {
    async runJSON() {
      return { ok: false, code: 1, error: "not used" };
    },
    async runText(cmd, args) {
      if (cmd !== "bd") throw new Error(`Unexpected command: ${cmd}`);
      calls.push(args);
      return { ok: true, data: "updated" };
    },
  };
  const tools = makeBeadsTools({
    bd: new BdClient(exec),
    beadsProjects: () => [{ id: "project-1", name: "test", rootPath: "/project/root" }],
    registeredProjects: () => [],
    refreshBoard: () => {},
    syncMerged: async () => {
      throw new Error("not used");
    },
  });
  const tool = tools.find((entry) => entry.name === "beads_update");
  if (!tool) throw new Error("beads_update tool is missing");
  const ctx: ToolContext = {
    cwd: "/project/root",
    abortSignal: new AbortController().signal,
    emit: () => {},
  };
  return { tool, ctx, calls };
}

const initRoots: string[] = [];
afterEach(() => {
  for (const root of initRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function initTool() {
  const rootPath = mkdtempSync(join(tmpdir(), "beads-tool-demo-"));
  initRoots.push(rootPath);
  const project = {
    id: "project-demo",
    name: "demo",
    rootPath,
    createdAt: "2026-01-01T00:00:00Z",
  };
  let registered: Project[] = [project];
  const calls: string[][] = [];
  const events: { content: string; isError?: boolean }[] = [];
  let refreshes = 0;
  let failure = "";
  let refreshFailure = false;
  const exec: RibExec = {
    async runText(cmd, args) {
      if (cmd === "git") {
        if (args.includes("--show-toplevel")) return { ok: true, data: realpathSync(rootPath) };
        return { ok: true, data: "", exitCode: args[0] === "status" ? 0 : 1 };
      }
      calls.push(args);
      if (failure) return { ok: false, code: 1, error: failure };
      mkdirSync(join(rootPath, ".beads"));
      return { ok: true, data: "" };
    },
    async runJSON<T>(_cmd: string, args: string[]) {
      calls.push(args);
      const data = args.includes("config")
        ? { key: "issue_prefix", value: "cos" }
        : {
            summary: {
              total_issues: 0,
              open_issues: 0,
              ready_issues: 0,
              blocked_issues: 0,
              in_progress_issues: 0,
              closed_issues: 0,
            },
          };
      return { ok: true, data: data as T };
    },
  };
  const tools = makeBeadsTools({
    bd: new BdClient(exec),
    beadsProjects: () => [],
    registeredProjects: () => registered,
    refreshBoard: () => {
      if (refreshFailure) throw new Error("sample refresh failure");
      refreshes++;
    },
    syncMerged: async () => {
      throw new Error("not used");
    },
  });
  const tool = tools.find((entry) => entry.name === "beads_init")!;
  const ctx: ToolContext = {
    cwd: "/unregistered/context",
    abortSignal: new AbortController().signal,
    emit: (event) => {
      if (event.type === "tool_result") events.push(event);
    },
  };
  return {
    tool,
    ctx,
    calls,
    events,
    project,
    tools,
    refreshes: () => refreshes,
    fail: (error: string) => {
      failure = error;
    },
    failRefresh: () => {
      refreshFailure = true;
    },
    registry: (projects: Project[]) => {
      registered = projects;
    },
  };
}

describe("beads_init", () => {
  test("publishes a required project, optional prefix and ordinary write policy", () => {
    const { tool, tools } = initTool();
    expect(tool.state_changing).toBe(true);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ project: "demo" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ project: "project-demo", prefix: "cos" }).success).toBe(
      true,
    );
    expect(tools.find((entry) => entry.name === "beads_projects")?.description).toContain(
      "beads_init",
    );
  });

  test.each([
    {},
    { project: " " },
    { project: "demo", prefix: "" },
    { project: "demo", prefix: 1 },
  ])("direct execution validates inputs: %j", async (input) => {
    const { tool, ctx, events, calls, refreshes } = initTool();
    await tool.execute(input, ctx);
    expect(events[0]?.isError).toBe(true);
    expect(events[0]?.content).toContain("input invalid");
    expect(calls).toEqual([]);
    expect(refreshes()).toBe(0);
  });

  test.each([
    "demo",
    "project-demo",
  ])("returns measured evidence and refreshes for %s", async (selector) => {
    const { tool, ctx, events, project, calls, refreshes } = initTool();
    await tool.execute({ project: selector, prefix: "cos; echo sample" }, ctx);
    expect(events[0]?.isError).toBeUndefined();
    expect(JSON.parse(events[0]!.content)).toMatchObject({
      result: "initialized",
      project: { id: project.id, name: project.name },
      path: join(realpathSync(project.rootPath), ".beads"),
      prefix: "cos",
      status: { summary: { total_issues: 0 } },
    });
    expect(calls[0]?.slice(-2)).toEqual(["--prefix", "cos; echo sample"]);
    expect(refreshes()).toBe(1);
  });

  test("a repeated call reports the actual prefix without mutation or another refresh", async () => {
    const { tool, ctx, events, calls, refreshes } = initTool();
    await tool.execute({ project: "demo" }, ctx);
    await tool.execute({ project: "demo", prefix: "different" }, ctx);
    expect(JSON.parse(events[1]!.content)).toMatchObject({ result: "existing", prefix: "cos" });
    expect(calls.filter((args) => args[0] === "init")).toHaveLength(1);
    expect(refreshes()).toBe(1);
  });

  test("unknown names and filesystem paths never use the context directory", async () => {
    const { tool, ctx, events, calls, project } = initTool();
    for (const selector of ["unknown", project.rootPath, ctx.cwd]) {
      await tool.execute({ project: selector }, ctx);
    }
    expect(events.every((event) => event.isError)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("an unavailable registry fails without writes", async () => {
    const { tool, ctx, events, calls, registry } = initTool();
    registry([]);
    await tool.execute({ project: "demo" }, ctx);
    expect(events[0]?.content).toContain("No registered keelson projects");
    expect(events[0]?.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("initialization errors identify the project and do not refresh", async () => {
    const { tool, ctx, events, fail, refreshes } = initTool();
    fail("sample initialization failure");
    await tool.execute({ project: "demo" }, ctx);
    expect(events[0]?.isError).toBe(true);
    expect(events[0]?.content).toContain("beads_init 'demo' failed: bd init failed:");
    expect(refreshes()).toBe(0);
  });

  test("a refresh failure does not roll back a successful initialization", async () => {
    const { tool, ctx, events, project, failRefresh } = initTool();
    failRefresh();
    await tool.execute({ project: "demo" }, ctx);
    expect(events[0]?.isError).toBe(true);
    expect(events[0]?.content).toContain("tracker remains initialized");
    expect(existsSync(join(project.rootPath, ".beads"))).toBe(true);
  });
});

describe("beads_update assignment", () => {
  test("release forwards the empty assignee alongside open status", async () => {
    const { tool, ctx, calls } = updateTool();
    expect(tool.description).toContain("status 'open' and assignee ''");
    await tool.execute({ id: "cos-hjf.3", status: "open", assignee: "" }, ctx);
    expect(calls).toEqual([["update", "cos-hjf.3", "--status", "open", "--assignee", ""]]);
  });

  test("empty-only update clears assignment without changing status", async () => {
    const { tool, ctx, calls } = updateTool();
    await tool.execute({ id: "cos-hjf.3", assignee: "" }, ctx);
    expect(calls).toEqual([["update", "cos-hjf.3", "--assignee", ""]]);
  });

  test("omitting assignee does not implicitly clear it", async () => {
    const { tool, ctx, calls } = updateTool();
    await tool.execute({ id: "cos-hjf.3", status: "open" }, ctx);
    expect(calls).toEqual([["update", "cos-hjf.3", "--status", "open"]]);
  });

  test("nonempty assignee is forwarded unchanged", async () => {
    const { tool, ctx, calls } = updateTool();
    await tool.execute({ id: "cos-hjf.3", assignee: "worker" }, ctx);
    expect(calls).toEqual([["update", "cos-hjf.3", "--assignee", "worker"]]);
  });
});
