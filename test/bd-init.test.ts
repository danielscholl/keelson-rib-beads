import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibExec, RibExecOptions } from "@keelson/shared";
import { runText } from "@keelson/shared/exec";
import { BdClient, discoverBeadsProjects, resolveRegisteredProject } from "../src/bd";

const roots: string[] = [];

function project(name = "demo") {
  const rootPath = mkdtempSync(join(tmpdir(), "beads-init-demo-"));
  roots.push(rootPath);
  return { id: `project-${name}`, name, rootPath, createdAt: "2026-01-01T00:00:00Z" };
}

const emptyStatus = {
  summary: {
    total_issues: 0,
    open_issues: 0,
    ready_issues: 0,
    blocked_issues: 0,
    in_progress_issues: 0,
    closed_issues: 0,
  },
};

function initFixture() {
  const demo = project();
  const calls: { cmd: string; args: string[]; opts?: RibExecOptions }[] = [];
  const state = {
    top: realpathSync(demo.rootPath),
    dirty: "",
    gitError: "",
    initError: "",
    throwInit: false,
    createTracker: true,
    head: "",
    newHead: "",
    prefix: { key: "issue_prefix", value: "cos" } as unknown,
    status: emptyStatus as unknown,
    readError: "",
  };
  const exec: RibExec = {
    async runText(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      if (cmd === "git") {
        if (state.gitError) return { ok: false, code: 128, error: state.gitError };
        if (args.includes("--show-toplevel")) return { ok: true, data: state.top };
        if (args[0] === "status") return { ok: true, data: state.dirty };
        return { ok: true, data: state.head, exitCode: state.head ? 0 : 1 };
      }
      if (args[0] !== "init") return { ok: true, data: "updated" };
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (state.createTracker) {
        mkdirSync(join(opts!.cwd!, ".beads"));
        writeFileSync(join(opts!.cwd!, ".beads", "config.yaml"), "issue-prefix: cos\n");
      }
      writeFileSync(join(opts!.cwd!, ".gitignore"), "# bd init entries\n");
      if (state.newHead) state.head = state.newHead;
      if (state.throwInit) throw new Error("sample exec exception");
      return state.initError
        ? { ok: false, code: 1, error: state.initError }
        : { ok: true, data: "" };
    },
    async runJSON<T>(cmd: string, args: string[], opts?: RibExecOptions) {
      calls.push({ cmd, args, opts });
      if (state.readError) return { ok: false, code: 1, error: state.readError };
      return {
        ok: true,
        data: (args.includes("config")
          ? state.prefix
          : args.includes("status")
            ? state.status
            : []) as T,
      };
    },
  };
  return { demo, calls, state, exec, bd: new BdClient(exec) };
}

async function realGitInitFixture() {
  const fixture = initFixture();
  const { demo, exec } = fixture;
  const cwd = realpathSync(demo.rootPath);
  const git = async (args: string[]) => {
    const result = await runText("git", args, { cwd });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Sample Operator"]);
  await git(["config", "user.email", "sample@example.invalid"]);
  const realGitExec: RibExec = {
    runJSON: exec.runJSON,
    async runText(cmd, args, opts) {
      if (cmd === "git") return runText(cmd, args, opts);
      const result = await exec.runText(cmd, args, opts);
      if (args[0] === "init") {
        await git(["config", "beads.role", "maintainer"]);
        await git(["add", ".beads/config.yaml", ".gitignore"]);
        await git(["commit", "--quiet", "-m", "chore(beads): initialize sample tracker"]);
      }
      return result;
    },
  };
  return { ...fixture, cwd, git, bd: new BdClient(realGitExec) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("registered project resolution", () => {
  test("resolves an exact ID or unique name without a tracker", () => {
    const demo = project();
    const expected = {
      ok: true as const,
      data: { id: demo.id, name: demo.name, rootPath: demo.rootPath },
    };
    expect(resolveRegisteredProject([demo], demo.id)).toEqual(expected);
    expect(resolveRegisteredProject([demo], demo.name)).toEqual(expected);
    expect(existsSync(join(demo.rootPath, ".beads"))).toBe(false);
  });

  test("IDs take precedence over matching names", () => {
    const demo = project();
    const other = { ...project("other"), name: demo.id };
    const result = resolveRegisteredProject([other, demo], demo.id);
    expect(result.ok && result.data.id).toBe(demo.id);
  });

  test("ambiguous names require an ID", () => {
    const demo = project();
    const other = { ...project("other"), name: demo.name };
    const result = resolveRegisteredProject([demo, other], "demo");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("exact project ID");
    expect(resolveRegisteredProject([demo, other], other.id).ok).toBe(true);
  });

  test("rejects missing registry, empty selectors, unknown names and paths", () => {
    const demo = project();
    expect(resolveRegisteredProject(undefined, "demo").ok).toBe(false);
    expect(resolveRegisteredProject([], "demo").ok).toBe(false);
    for (const selector of ["", " ", "unknown", demo.rootPath, "/unregistered/path"]) {
      expect(resolveRegisteredProject([demo], selector).ok).toBe(false);
    }
  });
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

  describe("queued initialization", () => {
    test.each([
      undefined,
      "cos",
      "cos; echo sample",
    ])("uses explicit argv/cwd, disabled telemetry and sandboxed measured reads: %s", async (prefix) => {
      const { demo, calls, bd } = initFixture();
      const result = await bd.init(demo, prefix);
      expect(result).toEqual({
        ok: true,
        data: {
          result: "initialized",
          project: { id: demo.id, name: demo.name },
          path: join(realpathSync(demo.rootPath), ".beads"),
          prefix: "cos",
          status: emptyStatus,
        },
      });
      const bdCalls = calls.filter((call) => call.cmd === "bd");
      expect(bdCalls.map((call) => call.args)).toEqual([
        [
          "init",
          "--quiet",
          "--skip-agents",
          "--skip-hooks",
          "--non-interactive",
          ...(prefix === undefined ? [] : ["--prefix", prefix]),
        ],
        ["--sandbox", "config", "get", "issue_prefix", "--json"],
        ["--sandbox", "status", "--json"],
      ]);
      for (const call of bdCalls) {
        expect(call.opts).toEqual({
          cwd: realpathSync(demo.rootPath),
          timeoutMs: 30_000,
          env: { BD_DISABLE_METRICS: "1", OTEL_SDK_DISABLED: "true" },
        });
      }
    });

    test("existing trackers only read actual metadata, ignoring another requested prefix", async () => {
      const { demo, calls, bd, state } = initFixture();
      mkdirSync(join(demo.rootPath, ".beads"));
      writeFileSync(join(demo.rootPath, ".beads", "keep"), "sample existing tracker");
      state.dirty = " M README.md\n";
      state.gitError = "not a git repository";
      const result = await bd.init(demo, "different");
      expect(result.ok && result.data.result).toBe("existing");
      expect(result.ok && result.data.prefix).toBe("cos");
      expect(calls.map((call) => call.args[1])).toEqual(["config", "status"]);
      expect(readFileSync(join(demo.rootPath, ".beads", "keep"), "utf8")).toBe(
        "sample existing tracker",
      );
    });

    test("rejects non-Git roots, nested roots and an empty prefix before bd writes", async () => {
      for (const kind of ["non-git", "nested", "empty-prefix"]) {
        const { demo, bd, state, calls } = initFixture();
        if (kind === "non-git") state.gitError = "not a git repository";
        if (kind === "nested") state.top = realpathSync(project("ancestor").rootPath);
        const result = await bd.init(demo, kind === "empty-prefix" ? "" : undefined);
        expect(result.ok).toBe(false);
        expect(calls.some((call) => call.cmd === "bd")).toBe(false);
        expect(existsSync(join(demo.rootPath, ".beads"))).toBe(false);
      }
    });

    test.each([
      "M  README.md\n",
      " M README.md\n",
      "?? sample.txt\n",
    ])("refuses a staged, unstaged or untracked file: %s", async (dirty) => {
      const { demo, bd, state, calls } = initFixture();
      state.dirty = dirty;
      const result = await bd.init(demo);
      expect(!result.ok && result.error).toContain("clean Git working tree and index");
      expect(calls.some((call) => call.cmd === "bd")).toBe(false);
    });

    test.each([
      undefined,
      "sample ignores\n",
    ])("failed init restores the immediate .gitignore copy and permits retry: %s", async (ignore) => {
      const { demo, bd, state } = initFixture();
      const ignorePath = join(demo.rootPath, ".gitignore");
      if (ignore !== undefined) writeFileSync(ignorePath, ignore);
      state.initError = "sample init failure";
      const result = await bd.init(demo);
      expect(!result.ok && result.error).toContain("sample init failure");
      expect(existsSync(join(demo.rootPath, ".beads"))).toBe(false);
      if (ignore === undefined) expect(existsSync(ignorePath)).toBe(false);
      else expect(readFileSync(ignorePath, "utf8")).toBe(ignore);
      state.initError = "";
      expect((await bd.init(demo)).ok).toBe(true);
    });

    test("timeout and thrown exec errors clean up newly created tracker files", async () => {
      for (const kind of ["timeout", "throw"]) {
        const { demo, bd, state } = initFixture();
        state.initError = kind === "timeout" ? "command timed out" : "";
        state.throwInit = kind === "throw";
        const result = await bd.init(demo);
        expect(!result.ok && result.error).toContain(
          kind === "timeout" ? "timed out" : "sample exec exception",
        );
        expect(existsSync(join(demo.rootPath, ".beads"))).toBe(false);
      }
    });

    test("missing tracker and invalid/failed metadata cannot report success", async () => {
      for (const kind of ["missing", "prefix", "status", "read"]) {
        const { demo, bd, state } = initFixture();
        if (kind === "missing") state.createTracker = false;
        if (kind === "prefix") state.prefix = { key: "issue_prefix", value: "" };
        if (kind === "status") state.status = { summary: { total_issues: 0 } };
        if (kind === "read") state.readError = "sample metadata read failure";
        expect((await bd.init(demo)).ok).toBe(false);
        expect(existsSync(join(demo.rootPath, ".beads"))).toBe(false);
      }
    });

    test("a failed read never deletes or repairs a pre-existing tracker", async () => {
      const { demo, bd, state } = initFixture();
      mkdirSync(join(demo.rootPath, ".beads"));
      writeFileSync(join(demo.rootPath, ".beads", "keep"), "sample");
      state.readError = "sample read failure";
      expect((await bd.init(demo)).ok).toBe(false);
      expect(readFileSync(join(demo.rootPath, ".beads", "keep"), "utf8")).toBe("sample");
    });

    test.each([
      "",
      "a".repeat(40),
    ])("reports a new commit without rewriting history: %s", async (head) => {
      const { demo, bd, state, calls } = initFixture();
      state.head = head;
      state.newHead = "b".repeat(40);
      state.initError = "sample init failure";
      const result = await bd.init(demo);
      expect(!result.ok && result.error).toContain(`made commit ${state.newHead}`);
      expect(state.head).toBe(state.newHead);
      expect(readFileSync(join(demo.rootPath, ".beads", "config.yaml"), "utf8")).toBe(
        "issue-prefix: cos\n",
      );
      expect(readFileSync(join(demo.rootPath, ".gitignore"), "utf8")).toBe("# bd init entries\n");
      expect(
        calls.filter((call) => call.cmd === "git").every((call) => !call.args.includes("reset")),
      ).toBe(true);
    });

    test("preserves newly created files when the post-init HEAD read fails", async () => {
      const { demo, exec, state } = initFixture();
      state.initError = "sample init failure";
      const bd = new BdClient({
        ...exec,
        async runText(cmd, args, opts) {
          const result = await exec.runText(cmd, args, opts);
          if (cmd === "bd" && args[0] === "init") state.gitError = "sample HEAD read failure";
          return result;
        },
      });
      const result = await bd.init(demo);
      expect(!result.ok && result.error).toContain("sample init failure");
      expect(!result.ok && result.error).toContain(
        "Git commit state could not be read: sample HEAD read failure",
      );
      expect(readFileSync(join(demo.rootPath, ".beads", "config.yaml"), "utf8")).toBe(
        "issue-prefix: cos\n",
      );
      expect(readFileSync(join(demo.rootPath, ".gitignore"), "utf8")).toBe("# bd init entries\n");
    });

    test("concurrent init, another project's read and a write cannot interleave", async () => {
      const { demo, bd, calls } = initFixture();
      const other = project("other");
      const [first, read, second, write] = await Promise.all([
        bd.init(demo),
        bd.readJSON(other.rootPath, ["ready"]),
        bd.init(demo, "different"),
        bd.mutate(other.rootPath, ["update", "cos-hjf.1", "--status", "open"]),
      ]);
      expect(first.ok && first.data.result).toBe("initialized");
      expect(read.ok).toBe(true);
      expect(second.ok && second.data.result).toBe("existing");
      expect(write.ok).toBe(true);
      expect(
        calls.filter((call) => call.cmd === "bd").map((call) => call.args[1] ?? call.args[0]),
      ).toEqual(["--quiet", "config", "status", "ready", "config", "status", "cos-hjf.1"]);
    });

    test("the happy path uses a clean real Git repository and accepts bd's local effects", async () => {
      const { demo, bd, calls, cwd, git } = await realGitInitFixture();
      expect(await git(["status", "--porcelain"])).toBe("");
      const result = await bd.init(demo, "cos");
      expect(result.ok && result.data.result).toBe("initialized");
      expect(await git(["status", "--porcelain"])).toBe("");
      expect((await git(["config", "--get", "beads.role"])).trim()).toBe("maintainer");
      expect((await git(["log", "-1", "--format=%s"])).trim()).toBe(
        "chore(beads): initialize sample tracker",
      );
      expect((await bd.readJSON(cwd, ["ready"])).ok).toBe(true);
      expect((await bd.init(demo, "different")).ok).toBe(true);
      expect(calls.filter((call) => call.args[0] === "init")).toHaveLength(1);
    });

    test.each([
      undefined,
      "sample ignores\n",
    ])("metadata failure preserves committed tracker files in real Git: %s", async (ignore) => {
      const { demo, bd, state, cwd, git } = await realGitInitFixture();
      if (ignore !== undefined) {
        writeFileSync(join(cwd, ".gitignore"), ignore);
        await git(["add", ".gitignore"]);
        await git(["commit", "--quiet", "-m", "chore: add sample ignores"]);
      }
      state.readError = "sample metadata read failure";
      const result = await bd.init(demo, "cos");
      const head = (await git(["rev-parse", "HEAD"])).trim();
      expect(!result.ok && result.error).toContain("prefix read failed: sample metadata read failure");
      expect(!result.ok && result.error).toContain(`made commit ${head}`);
      expect(readFileSync(join(cwd, ".beads", "config.yaml"), "utf8")).toBe("issue-prefix: cos\n");
      expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("# bd init entries\n");
      expect(await git(["status", "--porcelain"])).toBe("");
      expect((await git(["log", "-1", "--format=%s"])).trim()).toBe(
        "chore(beads): initialize sample tracker",
      );
    });
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
