import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the scrub-trailers and dependency-audit node bash against a real
// throwaway git repo, so the history rewrite and the manifest diff are
// exercised the way a run sees them.

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

async function git(args: string[], cwd = repo): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function commit(message: string, file: string, content: string): Promise<void> {
  writeFileSync(join(repo, file), content);
  await git(["add", file]);
  await git(["commit", "-q", "-m", message]);
}

async function runNode(
  id: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", "-c", await nodeScript(id)], {
    cwd: repo,
    env: { ...process.env, KEELSON_ARTIFACTS_DIR: artifacts, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "beads-commit-guards-"));
  repo = join(sandbox, "repo");
  artifacts = join(sandbox, "artifacts");
  mkdirSync(repo);
  mkdirSync(artifacts);
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.name", "Dev"]);
  await git(["config", "user.email", "dev@example.com"]);
  await commit("chore: init", "README.md", "hello\n");
  await commit(
    "chore: manifest",
    "package.json",
    '{\n  "name": "x",\n  "devDependencies": {\n    "vite": "1.0.0"\n  }\n}\n',
  );
  await git(["checkout", "-q", "-b", "feature/x"]);
  writeFileSync(join(artifacts, ".default-branch"), "main\n");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("scrub-trailers", () => {
  test("drops attribution trailers and keeps trees, authors, and dates", async () => {
    await commit(
      "feat: one\n\nBody line.\n\nCo-authored-by: Copilot <copilot@github.com>",
      "a.txt",
      "a\n",
    );
    await commit(
      "fix: two\n\nGenerated with Claude Code\nClaude-Session: https://x",
      "b.txt",
      "b\n",
    );
    await commit("docs: clean", "c.txt", "c\n");
    const treeBefore = await git(["rev-parse", "HEAD^{tree}"]);
    const authorDate = await git(["log", "-1", "--format=%aD", "HEAD~2"]);

    const { stdout, exitCode } = await runNode("scrub-trailers");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TRAILER_SCRUB: rewrote 2 commit(s)");

    const log = await git(["log", "--format=%B", "main..HEAD"]);
    expect(log).not.toMatch(/co-authored-by/i);
    expect(log).not.toMatch(/generated with/i);
    expect(log).not.toMatch(/claude-session/i);
    expect(log).toContain("Body line.");
    expect(await git(["rev-parse", "HEAD^{tree}"])).toBe(treeBefore);
    expect(await git(["log", "-1", "--format=%aD", "HEAD~2"])).toBe(authorDate);
    expect(await git(["log", "-1", "--format=%an", "HEAD~2"])).toBe("Dev");
    expect((await git(["rev-list", "--count", "main..HEAD"])).trim()).toBe("3");
  });

  test("leaves a clean branch untouched", async () => {
    await commit("feat: plain", "a.txt", "a\n");
    const head = await git(["rev-parse", "HEAD"]);
    const { stdout, exitCode } = await runNode("scrub-trailers");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TRAILER_SCRUB: clean");
    expect(await git(["rev-parse", "HEAD"])).toBe(head);
  });

  test("with SCRUB_PUSHED rewrites pushed commits and force-pushes the head branch", async () => {
    const remote = join(sandbox, "remote.git");
    await git(["init", "-q", "--bare", remote], sandbox);
    await git(["remote", "add", "origin", remote]);
    await git(["push", "-q", "-u", "origin", "main"]);
    await commit("feat: pushed\n\nCo-authored-by: Copilot <copilot@github.com>", "a.txt", "a\n");
    await git(["push", "-q", "-u", "origin", "feature/x"]);

    const plain = await runNode("scrub-trailers");
    expect(plain.stdout).toContain("TRAILER_SCRUB: clean — no commits to inspect");

    const forced = await runNode("scrub-trailers-final", { SCRUB_PUSHED: "1" });
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("rewrote 1 commit(s)");
    expect(forced.stdout).toContain("force-pushed");
    const remoteMsg = await git(["log", "-1", "--format=%B", "feature/x"], remote);
    expect(remoteMsg).not.toMatch(/co-authored-by/i);
    expect(await git(["rev-parse", "HEAD"])).toBe(await git(["rev-parse", "feature/x"], remote));
  });
});

describe("dependency-audit", () => {
  test("reports none when no manifest changed", async () => {
    await commit("feat: code only", "a.txt", "a\n");
    const { stdout, exitCode } = await runNode("dependency-audit");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("DEPENDENCY_CHANGES: none");
    expect(readFileSync(join(artifacts, "dependency-changes.md"), "utf-8")).toContain(
      "No dependency manifest",
    );
  });

  test("flags an added package the plan never named as UNPLANNED", async () => {
    writeFileSync(join(artifacts, "plan.md"), "### Task 1: add a test\nUse vite only.\n");
    await commit(
      "test: add browser test",
      "package.json",
      '{\n  "name": "x",\n  "devDependencies": {\n    "vite": "1.0.0",\n    "playwright-core": "1.50.0"\n  }\n}\n',
    );
    const { stdout, exitCode } = await runNode("dependency-audit-final");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("DEPENDENCY_CHANGES: 1 manifest file(s) changed — package.json");
    expect(stdout).toContain("unplanned added lines: 1");
    const report = readFileSync(join(artifacts, "dependency-changes.md"), "utf-8");
    expect(report).toContain("playwright-core");
    expect(report).toContain("UNPLANNED");
  });

  test("an addition the plan names is not flagged", async () => {
    writeFileSync(
      join(artifacts, "plan.md"),
      "### Task 1: wire playwright-core for the smoke test\n",
    );
    await commit(
      "test: add browser test",
      "package.json",
      '{\n  "name": "x",\n  "devDependencies": {\n    "vite": "1.0.0",\n    "playwright-core": "1.50.0"\n  }\n}\n',
    );
    const { stdout } = await runNode("dependency-audit");
    expect(stdout).toContain("unplanned added lines: 0");
    expect(readFileSync(join(artifacts, "dependency-changes.md"), "utf-8")).toContain(
      "(named in plan.md)",
    );
  });
});
