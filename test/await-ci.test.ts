import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the await-ci node's bash against a fake `forge` on PATH, so the
// classification of gh's exit codes is exercised the way the node sees it.

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
  sandbox = mkdtempSync(join(tmpdir(), "beads-await-ci-"));
  artifacts = join(sandbox, "artifacts");
  binDir = join(sandbox, "bin");
  mkdirSync(artifacts);
  mkdirSync(binDir);
  writeFileSync(join(artifacts, ".pr-number"), "6\n");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function installFakeForge(body: string): void {
  const path = join(binDir, "forge");
  writeFileSync(path, `#!/bin/bash\necho x >> "${join(sandbox, "calls")}"\n${body}\n`);
  chmodSync(path, 0o755);
}

function callCount(): number {
  try {
    return readFileSync(join(sandbox, "calls"), "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function runNode(id = "await-ci"): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", "-c", await nodeScript(id)], {
    cwd: sandbox,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      KEELSON_ARTIFACTS_DIR: artifacts,
      KEELSON_CI_RECHECK_INTERVAL: "0",
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

describe("beads-work CI gates", () => {
  test("gh's 'no checks reported' exit reads as no CI, not a failed forge call", async () => {
    installFakeForge(`echo "no checks reported on the 'feature/x' branch" >&2; exit 1`);
    const { stdout, exitCode } = await runNode();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("CI_STATUS: UNKNOWN");
    expect(stdout).toContain("no CI checks reported for PR #6");
    expect(stdout).not.toContain("forge call failed");
    expect(callCount()).toBe(3);
  });

  test("any other forge failure still reports a failed call after the full re-poll", async () => {
    installFakeForge(`echo "connection refused" >&2; exit 1`);
    const { stdout, exitCode } = await runNode();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("forge call failed");
    expect(stdout).toContain("connection refused");
    expect(callCount()).toBe(6);
  });

  test("finalize-pr leaves the draft with a no-CI reason on the same gh exit", async () => {
    writeFileSync(join(artifacts, ".ci-final-status"), "PASS\n");
    installFakeForge(`echo "no checks reported on the 'feature/x' branch" >&2; exit 1`);
    const { stdout, exitCode } = await runNode("finalize-pr");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("PR_STATE: DRAFT");
    expect(stdout).toContain("no CI to gate on");
    expect(stdout).not.toContain("forge call failed");
  });
});

describe("finalize-pr after the final trailer-scrub force-push", () => {
  const PUSHED = "b".repeat(40);

  // `watch` and `head` are bash snippets run on each --required --watch call
  // and each headRefOid lookup; $n is that call's 1-based index.
  function installFinalizeForge({
    watch,
    head = `echo ${PUSHED}`,
  }: {
    watch: string;
    head?: string;
  }): void {
    const log = join(sandbox, "forge.log");
    installFakeForge(`
echo "$*" >> "${log}"
nth() { grep -cF -e "$1" "${log}"; }
case "$*" in
  *"--json headRefOid"*) n=$(nth headRefOid); ${head} ;;
  *"--required --watch"*) n=$(nth "--required --watch"); ${watch} ;;
  "pr checks 6 --json state"*) echo 2 ;;
  "pr checks 6 --json name,bucket,state"*) echo '[{"name":"Typecheck and test","bucket":"pass","state":"SUCCESS"}]' ;;
  "pr required-checks"*) echo "Typecheck and test" ;;
  "pr view 6 --json body"*) echo "pending CI" ;;
  "pr edit"*|"pr ready"*) ;;
esac`);
  }

  function forgeCalls(match: string): number {
    try {
      return readFileSync(join(sandbox, "forge.log"), "utf-8")
        .split("\n")
        .filter((line) => line.includes(match)).length;
    } catch {
      return 0;
    }
  }

  function finalStatus(): string {
    return readFileSync(join(artifacts, ".ci-final-status"), "utf-8").trim();
  }

  const noChecks = `echo "no checks reported on the 'keelson/beads-work/x' branch"; exit 1`;

  test("a watch that first sees no checks re-polls and then promotes", async () => {
    installFinalizeForge({
      watch: `if [ "$n" -lt 3 ]; then ${noChecks}; fi; echo "All checks were successful"`,
    });
    const { stdout, exitCode } = await runNode("finalize-pr");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("PR_STATE: READY");
    expect(stdout).not.toContain("Final CI still red");
    expect(finalStatus()).toBe("PASS");
    expect(forgeCalls("--required --watch")).toBe(3);
  });

  test("a watch that never sees checks is bounded and never reads as green", async () => {
    installFinalizeForge({ watch: noChecks });
    const { stdout, exitCode } = await runNode("finalize-pr");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("PR_STATE: DRAFT");
    expect(stdout).toContain("never registered");
    expect(finalStatus()).toBe("UNKNOWN");
    expect(forgeCalls("pr ready")).toBe(0);
    expect(forgeCalls("--required --watch")).toBe(6);
  });

  test("a genuinely red watch is not retried", async () => {
    installFinalizeForge({ watch: `echo "Typecheck and test  fail"; exit 1` });
    const { stdout } = await runNode("finalize-pr");
    expect(stdout).toContain("Final CI still red");
    expect(finalStatus()).toBe("FAIL");
    expect(forgeCalls("--required --watch")).toBe(1);
  });

  test("checks are counted only once the PR head is the force-pushed commit", async () => {
    writeFileSync(join(artifacts, ".scrub-pushed-head"), `${PUSHED}\n`);
    installFinalizeForge({
      watch: `echo "All checks were successful"`,
      head: `if [ "$n" -lt 3 ]; then echo ${"a".repeat(40)}; else echo ${PUSHED}; fi`,
    });
    const { stdout } = await runNode("finalize-pr");
    expect(stdout).toContain("PR_STATE: READY");
    expect(forgeCalls("--json headRefOid")).toBe(3);
    expect(forgeCalls("pr checks 6 --json state")).toBe(3);
  });

  test("a PR head that never reaches the force-pushed commit leaves a draft without watching", async () => {
    writeFileSync(join(artifacts, ".scrub-pushed-head"), `${PUSHED}\n`);
    installFinalizeForge({
      watch: `echo "All checks were successful"`,
      head: `echo ${"a".repeat(40)}`,
    });
    const { stdout } = await runNode("finalize-pr");
    expect(stdout).toContain("PR_STATE: DRAFT");
    expect(stdout).toContain("never reached the force-pushed");
    expect(finalStatus()).toBe("UNKNOWN");
    expect(forgeCalls("--required --watch")).toBe(0);
  });
});
