import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function nodeScript(id: string): Promise<string> {
  const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
  const workflow = Bun.YAML.parse(yaml) as { nodes: { id: string; bash?: string }[] };
  const node = workflow.nodes.find((n) => n.id === id);
  if (!node?.bash) throw new Error(`${id} node has no bash body`);
  return node.bash;
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "beads-must-fix-count-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

async function runCount(
  env: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("KEELSON_NODE_")) base[key] = value;
  }
  const proc = Bun.spawn(["bash", "-c", await nodeScript("must-fix-count")], {
    cwd: sandbox,
    env: { ...base, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), exitCode };
}

const triage = (mustFix: string) => `{"ship_ready":true,"summary":"x","must_fix":${mustFix}}`;

describe("beads-work must-fix-count node", () => {
  test("an empty must_fix list prints 0", async () => {
    const result = await runCount({ KEELSON_NODE_triage_OUTPUT: triage("[]") });
    expect(result).toEqual({ stdout: "0", exitCode: 0 });
  });

  test("a non-empty must_fix list prints its length", async () => {
    const items = '[{"title":"a"},{"title":"b"},{"title":"c"}]';
    const result = await runCount({ KEELSON_NODE_triage_OUTPUT: triage(items) });
    expect(result).toEqual({ stdout: "3", exitCode: 0 });
  });

  test("output that is not a usable triage object prints unknown", async () => {
    const cases: Record<string, string> = {
      prose: "Everything looks fine to me.",
      blank: "",
      "whitespace only": "  \n",
      "non-object json": "[1,2]",
      "null must_fix": triage("null"),
      "missing must_fix": '{"ship_ready":true,"summary":"x"}',
      "non-array must_fix": triage('"none"'),
    };
    for (const [label, output] of Object.entries(cases)) {
      const result = await runCount({ KEELSON_NODE_triage_OUTPUT: output });
      expect({ label, ...result }).toEqual({ label, stdout: "unknown", exitCode: 0 });
    }
  });

  test("no triage output at all prints unknown", async () => {
    const result = await runCount({});
    expect(result).toEqual({ stdout: "unknown", exitCode: 0 });
  });

  test("the output file takes precedence over the env var", async () => {
    const file = join(sandbox, "triage.json");
    writeFileSync(file, triage('[{"title":"a"}]'));
    const result = await runCount({
      KEELSON_NODE_triage_OUTPUT_FILE: file,
      KEELSON_NODE_triage_OUTPUT: triage("[]"),
    });
    expect(result).toEqual({ stdout: "1", exitCode: 0 });
  });

  test("a missing output file falls back to the env var", async () => {
    const result = await runCount({
      KEELSON_NODE_triage_OUTPUT_FILE: join(sandbox, "absent.json"),
      KEELSON_NODE_triage_OUTPUT: triage("[]"),
    });
    expect(result).toEqual({ stdout: "0", exitCode: 0 });
  });
});
