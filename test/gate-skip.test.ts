import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs validate, revalidate and post-fix-validate against a real throwaway
// repo with a verify.sh that counts its own runs, so a skipped rerun shows
// up as an unchanged count.

async function nodeScript(id: string): Promise<string> {
  const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
  const workflow = Bun.YAML.parse(yaml) as { nodes: { id: string; bash?: string }[] };
  const node = workflow.nodes.find((n) => n.id === id);
  if (!node?.bash) throw new Error(`${id} node has no bash body`);
  return node.bash;
}

let sandbox: string;
let repo: string;
let artifacts: string;
let counter: string;

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function writeVerify(exitCode = 0, extra = ""): void {
  writeFileSync(
    join(artifacts, "verify.sh"),
    `#!/usr/bin/env bash\necho run >> "${counter}"\n${extra}\nexit ${exitCode}\n`,
  );
}

function verifyRuns(): number {
  if (!existsSync(counter)) return 0;
  return readFileSync(counter, "utf-8").split("\n").filter(Boolean).length;
}

async function runNode(id: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", "-c", await nodeScript(id)], {
    cwd: repo,
    env: { ...process.env, KEELSON_ARTIFACTS_DIR: artifacts },
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

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "beads-gate-skip-"));
  repo = join(sandbox, "repo");
  artifacts = join(sandbox, "artifacts");
  counter = join(sandbox, "verify-runs");
  mkdirSync(repo);
  mkdirSync(artifacts);
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.name", "Dev"]);
  await git(["config", "user.email", "dev@example.com"]);
  writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
  await git(["add", "app.ts"]);
  await git(["commit", "-q", "-m", "chore: init"]);
  writeVerify();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("gate reruns on an unchanged tree", () => {
  test("revalidate and post-fix-validate reuse a validate pass on the same tree", async () => {
    expect((await runNode("validate")).stdout).toContain("VALIDATION_STATUS: PASS");
    const revalidate = await runNode("revalidate");
    expect(revalidate.exitCode).toBe(0);
    expect(revalidate.stdout).toContain("Unchanged since validate passed");
    expect(revalidate.stdout).toContain("VALIDATION_STATUS: PASS");
    const postFix = await runNode("post-fix-validate");
    expect(postFix.stdout).toContain("Unchanged since validate passed");
    expect(postFix.stdout).toContain("VALIDATION_STATUS: PASS");
    expect(verifyRuns()).toBe(1);
  });

  test("a fixer commit makes revalidate run the checks", async () => {
    await runNode("validate");
    writeFileSync(join(repo, "app.ts"), "export const x = 2;\n");
    await git(["commit", "-qam", "fix: lint"]);
    const revalidate = await runNode("revalidate");
    expect(revalidate.stdout).toContain("=== PROJECT CHECKS ===");
    expect(revalidate.stdout).toContain("VALIDATION_STATUS: PASS");
    expect(verifyRuns()).toBe(2);
    // revalidate's own pass now covers post-fix-validate.
    expect((await runNode("post-fix-validate")).stdout).toContain(
      "Unchanged since revalidate passed",
    );
    expect(verifyRuns()).toBe(2);
  });

  test("an uncommitted edit or an untracked file is a different tree", async () => {
    await runNode("validate");
    writeFileSync(join(repo, "app.ts"), "export const x = 3;\n");
    await runNode("revalidate");
    expect(verifyRuns()).toBe(2);
    writeFileSync(join(repo, "new.ts"), "export {};\n");
    await runNode("post-fix-validate");
    expect(verifyRuns()).toBe(3);
  });

  test("an extended verify.sh runs again", async () => {
    await runNode("validate");
    writeVerify(0, "echo extra-check");
    const revalidate = await runNode("revalidate");
    expect(revalidate.stdout).toContain("extra-check");
    expect(verifyRuns()).toBe(2);
  });

  test("a failed validate leaves nothing to reuse", async () => {
    writeVerify(1);
    expect((await runNode("validate")).stdout).toContain("VALIDATION_STATUS: FAIL");
    expect(existsSync(join(artifacts, ".gate-pass"))).toBe(false);
    const revalidate = await runNode("revalidate");
    expect(revalidate.exitCode).toBe(1);
    expect(revalidate.stdout).toContain("refusing to create PR");
    expect(verifyRuns()).toBe(2);
  });

  test("a failing revalidate clears the pass so post-fix-validate reruns", async () => {
    await runNode("validate");
    writeFileSync(join(repo, "app.ts"), "export const x = 4;\n");
    writeVerify(1);
    expect((await runNode("revalidate")).exitCode).toBe(1);
    expect(existsSync(join(artifacts, ".gate-pass"))).toBe(false);
  });
});
