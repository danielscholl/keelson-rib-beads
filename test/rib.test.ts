import { describe, expect, test } from "bun:test";
import rib from "../src/index";
import { BOARD_KEY } from "../src/keys";

describe("rib contract shape", () => {
  test("id and displayName satisfy the contract", () => {
    expect(rib.id).toBe("beads");
    expect(rib.displayName).toBe("Beads");
  });

  test("every published key lives under the rib namespace", () => {
    for (const view of rib.views ?? []) {
      expect(view.key.startsWith("rib:beads")).toBe(true);
    }
  });

  test("the surface binds the board key", () => {
    const surface = rib.surfaces?.[0];
    expect(surface?.id).toBe("beads");
    expect(surface?.layout.header?.key).toBe(BOARD_KEY);
  });

  test("docs are contributed inline", () => {
    const docs = rib.contributeDocs?.({ getExec: () => ({}) as never });
    expect(docs?.[0]?.title).toBe("Beads");
    expect(docs?.[0]?.content).toContain("beads_ready");
  });
});
