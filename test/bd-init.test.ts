import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibExec } from "@keelson/shared";
import { BdClient, discoverBeadsProjects } from "../src/bd";

const roots: string[] = [];

function project(name = "demo") {
  const rootPath = mkdtempSync(join(tmpdir(), "beads-init-demo-"));
  roots.push(rootPath);
  return { id: `project-${name}`, name, rootPath, createdAt: "2026-01-01T00:00:00Z" };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("init fixtures", () => {
  test("a registered sample project need not already carry a tracker", () => {
    const demo = project();
    expect(existsSync(join(demo.rootPath, ".beads"))).toBe(false);
    expect(discoverBeadsProjects([demo])).toEqual([]);
    mkdirSync(join(demo.rootPath, ".beads"));
    expect(discoverBeadsProjects([demo])).toEqual([
      { id: demo.id, name: demo.name, rootPath: demo.rootPath },
    ]);
  });

  test("the client serializes reads and writes across projects after a failure", async () => {
    const demo = project();
    const other = project("other");
    const calls: string[][] = [];
    let active = 0;
    let peak = 0;
    const exec: RibExec = {
      async runText(_cmd, args) {
        calls.push(args);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { ok: false, code: 1, error: "sample failure" };
      },
      async runJSON<T>(_cmd: string, args: string[]) {
        calls.push(args);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { ok: true, data: [] as T };
      },
    };
    const bd = new BdClient(exec);
    const [write, read] = await Promise.all([
      bd.mutate(demo.rootPath, ["create", "Sample task"]),
      bd.readJSON(other.rootPath, ["ready"]),
    ]);
    expect(write).toEqual({ ok: false, error: "sample failure" });
    expect(read).toEqual({ ok: true, data: [] });
    expect(calls).toEqual([
      ["create", "Sample task"],
      ["--sandbox", "ready", "--json"],
    ]);
    expect(peak).toBe(1);
  });
});
