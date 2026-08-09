import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import type { Measured } from "../src/bd";
import {
  composeBoard,
  composeNoTrackerBoard,
  priorityTone,
  recommendNext,
  statusGlyph,
  unlockChain,
} from "../src/board";
import { BOARD_KEY } from "../src/keys";
import type { ProjectMeasurement } from "../src/measure";

const project = { id: "p1", name: "demo", rootPath: "/tmp/demo" };

function ok<T>(data: T): Measured<T> {
  return { ok: true, data };
}

function fullMeasurement(): ProjectMeasurement {
  return {
    project,
    asOf: "2026-08-09T12:00:00.000Z",
    summary: ok({
      total_issues: 10,
      open_issues: 6,
      ready_issues: 3,
      blocked_issues: 2,
      in_progress_issues: 1,
      closed_issues: 3,
    }),
    inProgress: ok([
      {
        id: "tl-a",
        title: "In flight",
        status: "in_progress",
        priority: 1,
        assignee: "dan",
        updated_at: "2026-08-07T12:00:00Z",
      },
    ]),
    ready: ok([
      { id: "tl-b", title: "Ready one", status: "open", priority: 0, dependent_count: 3 },
      { id: "tl-c", title: "Ready two", status: "open", priority: 2, dependent_count: 0 },
    ]),
    blocked: ok([
      { id: "tl-d", title: "Dep blocked", status: "open", priority: 1, blocked_by: ["tl-b"] },
      { id: "tl-e", title: "Hand blocked", status: "blocked", priority: 2 },
      { id: "tl-h", title: "Second hop", status: "open", priority: 2, blocked_by: ["tl-d"] },
    ]),
    epics: ok([
      {
        epic: { id: "tl-f", title: "S1", status: "open", priority: 1 },
        total_children: 4,
        closed_children: 4,
        eligible_for_close: true,
      },
    ]),
    recentlyClosed: ok([
      {
        id: "tl-g",
        title: "Done",
        status: "closed",
        priority: 2,
        closed_at: "2026-08-08T10:00:00Z",
      },
    ]),
    stale: ok([]),
    backlog: ok([
      {
        id: "tl-f",
        title: "S1",
        status: "open",
        priority: 1,
        issue_type: "epic",
        description: "The epic body.",
      },
      {
        id: "tl-f.1",
        title: "First child",
        status: "deferred",
        priority: 2,
        acceptance_criteria: "It works.",
      },
      { id: "tl-b", title: "Ready one", status: "open", priority: 0 },
    ]),
  };
}

describe("recommendNext", () => {
  test("leverage outranks priority; runner-up is named", () => {
    const { pick, runnerUp } = recommendNext([
      { id: "hot", title: "P0 but isolated", status: "open", priority: 0, dependent_count: 0 },
      { id: "lever", title: "P2 but frees three", status: "open", priority: 2, dependent_count: 3 },
    ]);
    expect(pick?.id).toBe("lever");
    expect(runnerUp?.id).toBe("hot");
  });
});

describe("unlockChain", () => {
  test("names the first and second hop from blocked_by edges", () => {
    const blocked = [
      { id: "b1", title: "hop1", status: "open", priority: 1, blocked_by: ["rec"] },
      { id: "b2", title: "hop2", status: "open", priority: 1, blocked_by: ["b1"] },
      { id: "b3", title: "other", status: "open", priority: 1, blocked_by: ["x"] },
    ];
    const chain = unlockChain("rec", blocked);
    expect(chain.first.map((b) => b.id)).toEqual(["b1"]);
    expect(chain.second.map((b) => b.id)).toEqual(["b2"]);
  });
});

describe("composeBoard", () => {
  test("a full measurement renders a schema-valid decision surface", () => {
    const board = composeBoard([fullMeasurement()]);
    expect(() => expectView(BOARD_KEY, "board")(board)).not.toThrow();
    expect(board.header?.status?.tone).toBe("ok");
    expect(board.header?.chip).toContain("6 open");
    const kinds = board.sections.map((s) => s.kind);
    // Order of attention: pulse, recommendation, in-flight/attention pair, plan.
    expect(kinds.slice(0, 3)).toEqual(["stats", "cards", "columns"]);
  });

  test("the recommendation is leverage-first and explains its chain", () => {
    const board = composeBoard([fullMeasurement()]);
    const rec = board.sections.find((s) => s.kind === "cards");
    if (rec?.kind !== "cards") throw new Error("no recommendation card");
    expect(rec.items[0]?.title).toBe("Ready one");
    const flat = JSON.stringify(rec);
    expect(flat).toContain("unlocks 3 other beads");
    expect(flat).toContain("tl-d (Dep blocked)");
    expect(flat).toContain("→ then tl-h");
    expect(flat).toContain("runner-up: tl-c");
  });

  test("in-flight and needs-attention ride side by side", () => {
    const board = composeBoard([fullMeasurement()]);
    const pair = board.sections.find((s) => s.kind === "columns");
    if (pair?.kind !== "columns") throw new Error("no columns pair");
    expect(pair.columns[0]?.sections[0]?.kind).toBe("cards");
    const attention = pair.columns[1]?.sections[0];
    if (attention?.kind !== "rows") throw new Error("no attention rows");
    const flat = JSON.stringify(attention);
    expect(flat).toContain("waiting on tl-b");
    expect(flat).toContain("paused by hand — no blocking dependency");
    // Consequence ranking: tl-d (waited on by tl-h) outranks the hand-paused row.
    expect(attention.items[0]?.chip?.label).toBe("tl-d");
  });

  test("the plan nests children, carries epic progress, and marks ready rows", () => {
    const board = composeBoard([fullMeasurement()]);
    const plan = board.sections.find(
      (s) => s.kind === "rows" && (s.title ?? "").startsWith("Plan"),
    );
    if (plan?.kind !== "rows") throw new Error("no plan section");
    const texts = plan.items.map((i) => `${i.icon}${i.text}`);
    expect(texts).toEqual(["○Ready one", "▸[epic] S1", "❄└ First child"]);
    expect(plan.items[0]?.trailing).toBe("P0 · ready");
    expect(plan.items[0]?.glyph).toBe("accent");
    expect(plan.items[1]?.trailing).toBe("4/4 done");
    expect(plan.items[1]?.detail).toBe("The epic body.");
    expect(plan.items[2]?.trailing).toContain("on hold");
    expect(plan.items[2]?.detail).toContain("— acceptance —");
  });

  test("a failed section alarms instead of rendering empty-and-healthy", () => {
    const m = fullMeasurement();
    m.blocked = { ok: false, error: "bd blocked: exit 1" };
    const board = composeBoard([m]);
    expect(board.header?.status?.tone).toBe("error");
    expect(JSON.stringify(board)).toContain("UNMEASURED");
    expect(() => expectView(BOARD_KEY, "board")(board)).not.toThrow();
  });

  test("an empty ready queue says so instead of recommending nothing silently", () => {
    const m = fullMeasurement();
    m.ready = ok([]);
    const board = composeBoard([m]);
    expect(JSON.stringify(board)).toContain("Nothing is ready to start");
  });

  test("a scope without a tracker renders the map, not a fake backlog", () => {
    const board = composeNoTrackerBoard("default", [{ name: "ed-insights-platform" }]);
    expect(board.header?.status?.label).toBe("no beads tracker in default");
    expect(JSON.stringify(board)).toContain("ed-insights-platform");
    expect(() => expectView(BOARD_KEY, "board")(board)).not.toThrow();
  });

  test("no beads projects renders the first-run journey, not an empty board", () => {
    const board = composeBoard([]);
    expect(board.sections[0]?.kind).toBe("journey");
    expect(() => expectView(BOARD_KEY, "board")(board)).not.toThrow();
  });

  test("multiple projects prefix their sections", () => {
    const a = fullMeasurement();
    const b = { ...fullMeasurement(), project: { id: "p2", name: "other", rootPath: "/tmp/o" } };
    const board = composeBoard([a, b]);
    expect(JSON.stringify(board)).toContain("other — At a glance");
  });

  test("status glyphs and priority tones stay stable", () => {
    expect(statusGlyph("deferred")).toBe("❄");
    expect(statusGlyph("in_progress")).toBe("◐");
    expect(priorityTone(0)).toBe("error");
    expect(priorityTone(3)).toBe("neutral");
  });
});
