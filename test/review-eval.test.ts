import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES } from "../evals/review/cases.ts";
import { grade, parseAccept, parseLocation } from "../evals/review/grade.ts";
import { buildWorkflow, setup, WORKFLOW_NAME } from "../evals/review/setup.ts";

const finding = (location: string, severity = "HIGH", confidence = 90) => ({
  location,
  severity,
  confidence,
});
const output = (...findings: unknown[]) => JSON.stringify({ findings });

describe("review eval fixture", () => {
  let dir: string;
  let built: { repo: string; caseFile: string };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "review-eval-"));
    built = setup(dir);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd: built.repo, stdout: "pipe" });
    return proc.stdout.toString().trim();
  }

  test("every case becomes a branch whose diff against main is not empty", () => {
    for (const c of CASES) {
      expect(git("diff", "--stat", `main...case/${c.id}`)).not.toBe("");
    }
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  test("the case file names every case, and only bug cases carry an accepted span", () => {
    const doc = Bun.YAML.parse(readFileSync(built.caseFile, "utf8")) as {
      workflow: string;
      split: { train: string[]; test: string[] };
      cases: Array<{
        id: string;
        inputs: { case: string };
        expect: { kind: string; accept: string };
      }>;
    };
    expect(doc.workflow).toBe(WORKFLOW_NAME);
    expect(doc.cases.map((c) => c.id)).toEqual(CASES.map((c) => c.id));
    expect([...doc.split.train, ...doc.split.test].sort()).toEqual(CASES.map((c) => c.id).sort());
    for (const c of doc.cases) {
      expect(c.inputs.case).toBe(c.id);
      expect(parseAccept(c.expect.accept).length > 0).toBe(c.expect.kind === "bug");
    }
  });

  test("each split holds bug and clean cases", () => {
    for (const split of ["train", "test"] as const) {
      const kinds = new Set(CASES.filter((c) => c.split === split).map((c) => c.kind));
      expect([...kinds].sort()).toEqual(["bug", "clean"]);
    }
  });

  test("the eval runs the lens beads-work ships, with only its dependency rewired", () => {
    const source = Bun.YAML.parse(readFileSync("workflows/beads-work.yml", "utf8")) as {
      nodes: Array<Record<string, unknown>>;
    };
    const shipped = source.nodes.find((n) => n.id === "review-correctness");
    const written = Bun.YAML.parse(
      readFileSync(join(built.repo, ".keelson", "workflows", `${WORKFLOW_NAME}.yaml`), "utf8"),
    ) as { nodes: Array<Record<string, unknown>> };
    expect(written.nodes[1]).toEqual({ ...shipped, depends_on: ["capture-diff"] });
    const high = buildWorkflow({ effort: "high" }).nodes as Array<Record<string, unknown>>;
    expect(high[1]).toEqual({ ...shipped, depends_on: ["capture-diff"], effort: "high" });
    const light = buildWorkflow({ model: "fast" }).nodes as Array<Record<string, unknown>>;
    expect(light[1]?.model).toBe("fast");
    expect(light[1]?.model_by_provider).toBeUndefined();
  });
});

describe("review eval grader", () => {
  const accept = parseAccept("src/money.ts:7-7,src/handlers.ts:100-110");

  test("a bug case passes on a blocking finding inside an accepted span", () => {
    expect(grade(output(finding("src/money.ts:8")), "bug", accept).pass).toBe(true);
    expect(grade(output(finding("`src/handlers.ts:85-90`")), "bug", accept).pass).toBe(true);
    expect(grade(output(finding("./src/money.ts:7", "CRITICAL", 40)), "bug", accept).pass).toBe(
      true,
    );
  });

  test("a bug case fails on the wrong place, a low severity, or no findings", () => {
    expect(grade(output(finding("src/money.ts:40")), "bug", accept).pass).toBe(false);
    expect(grade(output(finding("src/cache.ts:7")), "bug", accept).pass).toBe(false);
    expect(grade(output(finding("src/money.ts:7", "MEDIUM")), "bug", accept).pass).toBe(false);
    expect(grade(output(), "bug", accept).pass).toBe(false);
  });

  test("a clean case fails only on a blocking finding at triage confidence", () => {
    expect(grade(output(), "clean", []).pass).toBe(true);
    expect(grade(output(finding("src/cache.ts:30", "MEDIUM", 95)), "clean", []).pass).toBe(true);
    expect(grade(output(finding("src/cache.ts:30", "HIGH", 60)), "clean", []).pass).toBe(true);
    expect(grade(output(finding("src/cache.ts:30", "HIGH", 80)), "clean", []).pass).toBe(false);
  });

  test("output that is not a findings object fails either kind", () => {
    expect(grade("I found nothing.", "clean", []).pass).toBe(false);
    expect(grade('{"verdict":"ok"}', "bug", accept).pass).toBe(false);
    expect(grade(`Here it is:\n${output(finding("src/money.ts:7"))}`, "bug", accept).pass).toBe(
      true,
    );
  });

  test("locations parse with or without a line range", () => {
    expect(parseLocation("src/a.ts:12")).toEqual({ file: "src/a.ts", from: 12, to: 12 });
    expect(parseLocation("b/src/a.ts:12-15")).toEqual({ file: "src/a.ts", from: 12, to: 15 });
    expect(parseLocation("src/a.ts")).toBeNull();
    expect(parseLocation(undefined)).toBeNull();
  });
});
