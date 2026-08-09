import { describe, expect, test } from "bun:test";
import rib from "../src/index";
import { ALL_KEYS, INSPECT_KEY, PLAN_KEY, PULSE_KEY } from "../src/keys";

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

  test("the surface lays out the stable panel roles", () => {
    const surface = rib.surfaces?.[0];
    expect(surface?.id).toBe("beads");
    expect(surface?.layout.header?.key).toBe(PULSE_KEY);
    const rowKeys = surface?.layout.rows.map((r) => r.columns.map((c) => c.key));
    // Plan and inspector share a row — the overview + inspector pair.
    expect(rowKeys?.[2]).toEqual([PLAN_KEY, INSPECT_KEY]);
    // The momentum strip starts collapsed.
    expect(surface?.layout.rows[3]?.columns[0]?.collapsed).toBe(true);
    // Every declared view key is registered as a panel.
    expect(rib.views?.map((v) => v.key).sort()).toEqual([...ALL_KEYS].sort());
  });

  test("the surface opts into the host project picker", () => {
    expect(rib.surfaces?.[0]?.projectScoped).toBe(true);
  });

  test("select-project and select-bead succeed; unknown actions fail closed", async () => {
    const ctx = { getExec: () => ({}) as never };
    const good = await rib.onAction?.({ type: "select-project", payload: { scopeId: "p1" } }, ctx);
    expect(good?.ok).toBe(true);
    const pick = await rib.onAction?.({ type: "select-bead", payload: { id: "tl-x" } }, ctx);
    expect(pick?.ok).toBe(true);
    // claim-bead with no scoped beads project fails closed, never throws.
    const claim = await rib.onAction?.({ type: "claim-bead", payload: { id: "tl-x" } }, ctx);
    expect(claim?.ok).toBe(false);
    const bad = await rib.onAction?.({ type: "explode" }, ctx);
    expect(bad?.ok).toBe(false);
  });

  test("docs are contributed inline", () => {
    const docs = rib.contributeDocs?.({ getExec: () => ({}) as never });
    expect(docs?.[0]?.title).toBe("Beads");
    expect(docs?.[0]?.content).toContain("beads_ready");
  });
});
