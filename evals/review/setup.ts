// Builds the review-lens eval into a scratch directory:
//
//   bun evals/review/setup.ts <dir> [--effort <level>] [--model <class or id>]
//   cd <dir>/repo
//   export KEELSON_WORKFLOWS_DIR=$PWD/.keelson/workflows KEELSON_SERVER_URL=http://127.0.0.1:9
//   keelson eval run ../beads-review-lens.eval.yaml --out ../results/baseline.json
//
// <dir>/repo is a git repository with the fixture on `main` and one branch per
// case; its .keelson/workflows/ holds a workflow whose lens node is copied
// from workflows/beads-work.yml, so the eval grades the prompt beads-work
// ships. The case file and the grader sit outside the repo, where the lens's
// read tools do not look.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CASES, type ReviewCase } from "./cases.ts";

const HERE = import.meta.dir;
const LENS_NODE = "review-correctness";
export const WORKFLOW_NAME = "beads-review-lens";

export interface SetupOptions {
  effort?: string;
  // A model class or id for the lens, replacing its per-provider pins.
  model?: string;
}

function git(repo: string, ...args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

function applyCase(repo: string, c: ReviewCase): void {
  for (const edit of c.edits ?? []) {
    const path = join(repo, edit.file);
    const before = readFileSync(path, "utf8");
    const count = before.split(edit.find).length - 1;
    if (count !== 1) {
      throw new Error(`${c.id}: expected one match in ${edit.file}, found ${count}: ${edit.find}`);
    }
    writeFileSync(
      path,
      before.replace(edit.find, () => edit.replace),
    );
  }
  for (const [file, content] of Object.entries(c.writes ?? {})) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
}

// "path:from-to" for each accepted span, resolved against the case's files.
export function resolveAccept(repo: string, c: ReviewCase): string {
  return (c.accept ?? [])
    .map((a) => {
      const lines = readFileSync(join(repo, a.file), "utf8").split("\n");
      const from = lines.findIndex((line) => line.includes(a.needle));
      if (from < 0) throw new Error(`${c.id}: needle not found in ${a.file}: ${a.needle}`);
      let to = from;
      if (a.until !== undefined) {
        const until = a.until;
        to = lines.findIndex((line, i) => i >= from && line.includes(until));
        if (to < 0) throw new Error(`${c.id}: until not found in ${a.file}: ${until}`);
      }
      return `${a.file}:${from + 1}-${to + 1}`;
    })
    .join(",");
}

export function buildWorkflow(opts: SetupOptions = {}): Record<string, unknown> {
  const source = Bun.YAML.parse(
    readFileSync(join(HERE, "..", "..", "workflows", "beads-work.yml"), "utf8"),
  ) as { model?: string; nodes: Array<Record<string, unknown>> };
  const lens = source.nodes.find((node) => node.id === LENS_NODE);
  if (!lens) throw new Error(`beads-work.yml has no ${LENS_NODE} node`);
  return {
    name: WORKFLOW_NAME,
    description: [
      "Use when: Grading the beads-work correctness reviewer against the seeded review cases.",
      'Triggers: "keelson eval run beads-review-lens.eval.yaml".',
      "Does: Checks out one case branch of the fixture, captures its diff, and runs the correctness lens copied from beads-work.",
      "NOT for: Reviewing a real branch; beads-work does that.",
    ].join("\n"),
    ...(source.model !== undefined ? { model: source.model } : {}),
    nodes: [
      {
        id: "capture-diff",
        bash: [
          "set -euo pipefail",
          'git checkout -q "case/$KEELSON_INPUTS_case"',
          'git diff main...HEAD --stat > "$KEELSON_ARTIFACTS_DIR/diff-stat.txt"',
          'git diff main...HEAD > "$KEELSON_ARTIFACTS_DIR/diff.patch"',
          'cat "$KEELSON_ARTIFACTS_DIR/diff-stat.txt"',
          "",
        ].join("\n"),
      },
      {
        ...lens,
        depends_on: ["capture-diff"],
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        ...(opts.model !== undefined ? { model: opts.model, model_by_provider: undefined } : {}),
      },
    ],
  };
}

export function buildCaseFile(expectations: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    name: WORKFLOW_NAME,
    workflow: WORKFLOW_NAME,
    reps: 1,
    node: LENS_NODE,
    split: {
      train: CASES.filter((c) => c.split === "train").map((c) => c.id),
      test: CASES.filter((c) => c.split === "test").map((c) => c.id),
    },
    grader: { type: "bash", timeout_ms: 30000 },
    cases: CASES.map((c) => ({
      id: c.id,
      inputs: { case: c.id },
      expect: {
        script: "bun ../grade/grade.ts",
        kind: c.kind,
        accept: expectations.get(c.id) ?? "",
      },
    })),
  };
}

export function setup(dir: string, opts: SetupOptions = {}): { repo: string; caseFile: string } {
  const root = resolve(dir);
  const repo = join(root, "repo");
  if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(HERE, "base"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "review-eval@example.com");
  git(repo, "config", "user.name", "review-eval");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: ledgerd 1.4.0");

  const expectations = new Map<string, string>();
  for (const c of CASES) {
    git(repo, "checkout", "-q", "-b", `case/${c.id}`, "main");
    applyCase(repo, c);
    expectations.set(c.id, resolveAccept(repo, c));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", c.subject);
  }
  git(repo, "checkout", "-q", "main");

  mkdirSync(join(repo, ".keelson", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".git", "info", "exclude"), ".keelson/\n");
  writeFileSync(
    join(repo, ".keelson", "workflows", `${WORKFLOW_NAME}.yaml`),
    Bun.YAML.stringify(buildWorkflow(opts), null, 2),
  );
  mkdirSync(join(root, "grade"), { recursive: true });
  cpSync(join(HERE, "grade.ts"), join(root, "grade", "grade.ts"));
  const caseFile = join(root, `${WORKFLOW_NAME}.eval.yaml`);
  writeFileSync(caseFile, Bun.YAML.stringify(buildCaseFile(expectations), null, 2));
  return { repo, caseFile };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--effort" || arg === "--model") flags[arg.slice(2)] = args[++i] ?? "";
    else dir = arg;
  }
  if (!dir || Object.values(flags).some((value) => value === "")) {
    console.error(
      "usage: bun evals/review/setup.ts <dir> [--effort <level>] [--model <class or id>]",
    );
    process.exit(2);
  }
  const out = setup(dir, flags);
  console.log(`fixture: ${out.repo}\ncases:   ${out.caseFile}`);
  console.log(
    `run:     cd ${out.repo} && KEELSON_WORKFLOWS_DIR=${out.repo}/.keelson/workflows KEELSON_SERVER_URL=http://127.0.0.1:9 keelson eval run ../${WORKFLOW_NAME}.eval.yaml --out ../results/<label>.json`,
  );
}
