import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BEAD_ID_PATTERN, extractBeadId } from "../src/bead-id";

const WORKFLOW = join(import.meta.dir, "..", "workflows", "beads-work.yml");

// The grep -oE pattern the claim node applies to $KEELSON_ARGUMENTS.
function workflowPattern(): string {
  const src = readFileSync(WORKFLOW, "utf8");
  const m = src.match(/grep -oE '([^']+)' \| head -1/);
  if (!m?.[1]) throw new Error("beads-work.yml claim node no longer greps the bead id");
  return m[1];
}

function shellExtract(pattern: string, args: string): string {
  const res = Bun.spawnSync([
    "bash",
    "-c",
    `printf '%s' "$1" | grep -oE "$2" | head -1 || true`,
    "_",
    args,
    pattern,
  ]);
  return res.stdout.toString().trim();
}

describe("bead id extraction", () => {
  test("a dotted child id resolves to the child, not its parent epic", () => {
    expect(extractBeadId("fn-8kx.1")).toBe("fn-8kx.1");
    expect(extractBeadId("fn-8kx.2")).toBe("fn-8kx.2");
    expect(extractBeadId("fn-8kx.1.3")).toBe("fn-8kx.1.3");
  });

  test("a plain id still resolves", () => {
    expect(extractBeadId("fn-cca")).toBe("fn-cca");
    expect(extractBeadId("tl-2tc")).toBe("tl-2tc");
  });

  test("the id is picked out of a free-form argument string", () => {
    expect(extractBeadId("fix bead fn-8kx.1 please")).toBe("fn-8kx.1");
    expect(extractBeadId("work fn-cca next")).toBe("fn-cca");
  });

  test("a trailing sentence dot is not part of the id", () => {
    expect(extractBeadId("fix fn-8kx.")).toBe("fn-8kx");
    expect(extractBeadId("fix fn-8kx.1.")).toBe("fn-8kx.1");
  });

  test("no id yields undefined", () => {
    expect(extractBeadId("")).toBeUndefined();
    expect(extractBeadId(undefined)).toBeUndefined();
    expect(extractBeadId("work the next bead")).toBeUndefined();
  });
});

describe("beads-work claim node", () => {
  test("greps with the shared bead id grammar", () => {
    expect(workflowPattern()).toBe(BEAD_ID_PATTERN);
  });

  test("the shell pipeline keeps a dotted child id whole", () => {
    const pattern = workflowPattern();
    expect(shellExtract(pattern, "fn-8kx.1")).toBe("fn-8kx.1");
    expect(shellExtract(pattern, "fix bead fn-8kx.2")).toBe("fn-8kx.2");
    expect(shellExtract(pattern, "fn-cca")).toBe("fn-cca");
    expect(shellExtract(pattern, "")).toBe("");
  });
});
