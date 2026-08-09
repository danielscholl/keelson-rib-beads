import { describe, expect, test } from "bun:test";
import type { BdIssue } from "../src/bd";
import { byPriorityThenAge, recentCloses, subtractInProgress, unionBlocked } from "../src/measure";

function issue(id: string, extra: Partial<BdIssue> = {}): BdIssue {
  return { id, title: id, status: "open", priority: 2, ...extra };
}

describe("measure helpers", () => {
  test("blocked is the union of the two disjoint queries, deduped by id", () => {
    const dep = [issue("a", { priority: 1 }), issue("b")];
    const status = [issue("b"), issue("c", { priority: 0 })];
    const ids = unionBlocked(dep, status).map((i) => i.id);
    expect(ids).toEqual(["c", "a", "b"]);
  });

  test("ready subtracts work already in flight", () => {
    const ready = [issue("a"), issue("b")];
    const wip = [issue("b", { status: "in_progress" })];
    expect(subtractInProgress(ready, wip).map((i) => i.id)).toEqual(["a"]);
  });

  test("priority sorts first, then age surfaces older work", () => {
    const rows = [
      issue("young", { priority: 1, created_at: "2026-08-01" }),
      issue("old", { priority: 1, created_at: "2026-07-01" }),
      issue("hot", { priority: 0, created_at: "2026-08-09" }),
    ];
    expect([...rows].sort(byPriorityThenAge).map((i) => i.id)).toEqual(["hot", "old", "young"]);
  });

  test("recent closes filter to the window and sort newest first", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const closed = [
      issue("recent", { closed_at: "2026-08-08T00:00:00Z" }),
      issue("newer", { closed_at: "2026-08-09T00:00:00Z" }),
      issue("ancient", { closed_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(recentCloses(closed, now).map((i) => i.id)).toEqual(["newer", "recent"]);
  });
});
