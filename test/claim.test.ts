import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the claim node's bash against a fake `bd` whose `show` reports the
// bead's current status and dependencies, and whose `update --claim` flips
// the status to in_progress and records the call.

async function claimScript(): Promise<string> {
  const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
  const workflow = Bun.YAML.parse(yaml) as { nodes: { id: string; bash?: string }[] };
  const node = workflow.nodes.find((n) => n.id === "claim");
  if (!node?.bash) throw new Error("claim node has no bash body");
  return node.bash;
}

type Dep = { id: string; status: string; dependency_type: string };

let sandbox: string;
let artifacts: string;
let binDir: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "beads-claim-"));
  artifacts = join(sandbox, "artifacts");
  binDir = join(sandbox, "bin");
  mkdirSync(artifacts);
  mkdirSync(binDir);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function installFakeBd(dependencies: Dep[]): void {
  const state = join(sandbox, "status");
  const deps = join(sandbox, "deps.json");
  writeFileSync(state, "open");
  writeFileSync(deps, JSON.stringify(dependencies));
  const path = join(binDir, "bd");
  writeFileSync(
    path,
    [
      "#!/bin/bash",
      `printf '%s\\n' "$*" >> "${join(sandbox, "calls")}"`,
      'if [ "$1" = "show" ]; then',
      `  jq -nc --arg id "$2" --arg s "$(cat "${state}")" --slurpfile d "${deps}" '[{id:$id,title:"t",status:$s,assignee:(if $s == "in_progress" then "agent" else null end),dependencies:$d[0]}]'`,
      "  exit 0",
      "fi",
      `if [ "$1" = "update" ] && [ "$3" = "--claim" ]; then printf in_progress > "${state}"; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function calls(): string[] {
  try {
    return readFileSync(join(sandbox, "calls"), "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function runClaim(bead: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", "-c", await claimScript()], {
    cwd: sandbox,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      KEELSON_ARTIFACTS_DIR: artifacts,
      KEELSON_INPUTS_bead: bead,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, exitCode };
}

const epicParent: Dep = { id: "cos-hjf", status: "open", dependency_type: "parent-child" };

describe("beads-work claim node with an explicit bead id", () => {
  test("refuses a bead whose blocker is still in progress", async () => {
    installFakeBd([
      epicParent,
      { id: "cos-hjf.1", status: "in_progress", dependency_type: "blocks" },
    ]);
    const { stdout, exitCode } = await runClaim("cos-hjf.2");
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.status).toBe("blocked");
    expect(out.blockers).toEqual(["cos-hjf.1"]);
    expect(calls().some((c) => c.includes("--claim"))).toBe(false);
    expect(existsSync(join(artifacts, ".bead-id"))).toBe(false);
  });

  test("claims a bead once every blocker is closed", async () => {
    installFakeBd([epicParent, { id: "cos-hjf.1", status: "closed", dependency_type: "blocks" }]);
    const { stdout, exitCode } = await runClaim("cos-hjf.2");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).status).toBe("claimed");
    expect(calls()).toContain("update cos-hjf.2 --claim");
    expect(readFileSync(join(artifacts, ".bead-id"), "utf-8").trim()).toBe("cos-hjf.2");
  });

  test("an open epic parent alone does not block the claim", async () => {
    installFakeBd([epicParent]);
    const { stdout } = await runClaim("cos-hjf.2");
    expect(JSON.parse(stdout).status).toBe("claimed");
  });

  test("non-blocking links to open beads do not block the claim", async () => {
    installFakeBd([{ id: "cos-abc", status: "open", dependency_type: "related" }]);
    const { stdout } = await runClaim("cos-hjf.2");
    expect(JSON.parse(stdout).status).toBe("claimed");
  });
});
