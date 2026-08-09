import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import type { Measured } from "../src/bd";
import { composeBoard, priorityTone } from "../src/board";
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
      { id: "tl-a", title: "In flight", status: "in_progress", priority: 1, assignee: "dan" },
    ]),
    ready: ok([
      { id: "tl-b", title: "Ready one", status: "open", priority: 0, dependent_count: 3 },
      { id: "tl-c", title: "Ready two", status: "open", priority: 2, dependent_count: 0 },
    ]),
    blocked: ok([
      { id: "tl-d", title: "Dep blocked", status: "open", priority: 1, blocked_by: ["tl-b"] },
      { id: "tl-e", title: "Hand blocked", status: "blocked", priority: 2 },
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
  };
}

describe("composeBoard", () => {
  test("a full measurement renders a schema-valid board", () => {
    const board = composeBoard([fullMeasurement()]);
    // The same producer guard the snapshot registration uses: parsing through
    // the full canvas union is the render gate, run here at test time.
    expect(() => expectView(BOARD_KEY, "board")(board)).not.toThrow();
    expect(board.header?.status?.tone).toBe("ok");
    const kinds = board.sections.map((s) => s.kind);
    expect(kinds).toContain("stats");
    expect(kinds).toContain("cards");
    expect(kinds).toContain("table");
    expect(kinds).toContain("bars");
  });

  test("a failed section alarms instead of rendering empty-and-healthy", () => {
    const m = fullMeasurement();
    m.blocked = { ok: false, error: "bd blocked: exit 1" };
    const board = composeBoard([m]);
    expect(board.header?.status?.tone).toBe("error");
    const flat = JSON.stringify(board);
    expect(flat).toContain("UNMEASURED");
    expect(() => expectView(BOARD_KEY, "board")(board)).not.toThrow();
  });

  test("manual status-blocked rows never render an empty waits-on", () => {
    const board = composeBoard([fullMeasurement()]);
    const flat = JSON.stringify(board);
    expect(flat).toContain("status-blocked (manual)");
    expect(flat).toContain("waits on tl-b");
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
    expect(JSON.stringify(board)).toContain("other — Pulse");
  });

  test("priority tones follow the P0-error convention", () => {
    expect(priorityTone(0)).toBe("error");
    expect(priorityTone(1)).toBe("warn");
    expect(priorityTone(2)).toBe("info");
    expect(priorityTone(3)).toBe("neutral");
  });
});
