import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the beads-writeback node's bash against a fake `bd` on PATH that
// answers `bd show` with a chosen status and records every other call.

async function nodeScript(id: string): Promise<string> {
  const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
  const workflow = Bun.YAML.parse(yaml) as { nodes: { id: string; bash?: string }[] };
  const node = workflow.nodes.find((n) => n.id === id);
  if (!node?.bash) throw new Error(`${id} node has no bash body`);
  return node.bash;
}

let sandbox: string;
let artifacts: string;
let binDir: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "beads-writeback-"));
  artifacts = join(sandbox, "artifacts");
  binDir = join(sandbox, "bin");
  mkdirSync(artifacts);
  mkdirSync(binDir);
  writeFileSync(join(artifacts, ".bead-id"), "fn-bye\n");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function installFakeBd(status: string, closedAt = ""): void {
  const path = join(binDir, "bd");
  const closed = closedAt ? `,"closed_at":"${closedAt}"` : "";
  writeFileSync(
    path,
    [
      "#!/bin/bash",
      `if [ "$1" = "show" ]; then printf '[{"id":"fn-bye","status":"${status}"${closed}}]\\n'; exit 0; fi`,
      `printf '%s\\n' "$*" >> "${join(sandbox, "calls")}"`,
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

async function runWriteback(): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", "-c", await nodeScript("beads-writeback")], {
    cwd: sandbox,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      KEELSON_ARTIFACTS_DIR: artifacts,
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

describe("beads-writeback", () => {
  test("leaves a bead alone once a human has closed it", async () => {
    installFakeBd("closed");
    writeFileSync(join(artifacts, ".pr-url"), "https://example/pr/6\n");
    const { stdout, exitCode } = await runWriteback();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("left alone — fn-bye is closed");
    expect(calls()).toEqual([]);
  });

  test("warns when the bead was closed after this run claimed it", async () => {
    installFakeBd("closed", "2026-09-13T19:17:19Z");
    writeFileSync(join(artifacts, ".claimed-at"), "2026-09-13T19:06:30Z\n");
    const { stdout } = await runWriteback();
    expect(stdout).toContain("left alone — fn-bye is closed");
    expect(stdout).toContain("WARNING — fn-bye was closed at 2026-09-13T19:17:19Z");
    expect(calls()).toEqual([]);
  });

  test("does not warn when the bead was closed before the run claimed it", async () => {
    installFakeBd("closed", "2026-09-13T18:00:00Z");
    writeFileSync(join(artifacts, ".claimed-at"), "2026-09-13T19:06:30Z\n");
    const { stdout } = await runWriteback();
    expect(stdout).toContain("left alone — fn-bye is closed");
    expect(stdout).not.toContain("WARNING");
  });

  test("leaves a deferred bead alone", async () => {
    installFakeBd("deferred");
    const { stdout } = await runWriteback();
    expect(stdout).toContain("left alone — fn-bye is deferred");
    expect(calls()).toEqual([]);
  });

  test("releases the claim of an in_progress bead when no PR was opened", async () => {
    installFakeBd("in_progress");
    const { stdout, exitCode } = await runWriteback();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("claim released (status=open, no assignee)");
    const recorded = calls();
    expect(recorded.some((c) => c.startsWith("note fn-bye bead-work run: PR none — failed"))).toBe(
      true,
    );
    expect(recorded).toContain("update fn-bye --status open --assignee ");
  });

  test("keeps the claim of an in_progress bead whose PR went green", async () => {
    installFakeBd("in_progress");
    writeFileSync(join(artifacts, ".pr-url"), "https://example/pr/6\n");
    writeFileSync(join(artifacts, ".ci-final-status"), "PASS\n");
    const { stdout } = await runWriteback();
    expect(stdout).toContain("claim retained");
    expect(calls().some((c) => c.includes("--status open"))).toBe(false);
    expect(calls().some((c) => c.includes("— success —"))).toBe(true);
  });

  test("keeps the claim when a PR is open and the repo has no CI to gate on", async () => {
    installFakeBd("in_progress");
    writeFileSync(join(artifacts, ".pr-url"), "https://example/pr/6\n");
    writeFileSync(join(artifacts, ".ci-final-status"), "UNKNOWN\n");
    const { stdout } = await runWriteback();
    expect(stdout).toContain("claim retained");
    expect(calls().some((c) => c.includes("--status open"))).toBe(false);
    expect(calls().some((c) => c.includes("no CI"))).toBe(true);
  });
});
