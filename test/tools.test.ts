import { describe, expect, test } from "bun:test";
import type { RibExec, ToolContext } from "@keelson/shared";
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
    refreshBoard: () => {},
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
