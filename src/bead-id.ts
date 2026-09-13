// One grammar for bead ids, shared by the TypeScript side and the bash
// `grep -oE` in workflows/beads-work.yml (test/bead-id.test.ts pins them
// equal). `bd create --parent` mints dotted child ids (`fn-8kx.1`, and
// `fn-8kx.1.2` a level deeper); a pattern that stops at the dot claims the
// parent epic instead of the child.
export const BEAD_ID_PATTERN = "[a-z][a-z0-9]*-[a-z0-9]+(\\.[0-9]+)*";

const BEAD_ID_RE = new RegExp(BEAD_ID_PATTERN);

/** The first bead id in a free-form argument string, or undefined. */
export function extractBeadId(text: string | undefined | null): string | undefined {
  return text?.match(BEAD_ID_RE)?.[0];
}
