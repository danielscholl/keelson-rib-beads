import { describe, expect, test } from "bun:test";
import type { BdIssue } from "../src/bd";
import {
  byPriorityThenAge,
  parseRunNote,
  recentCloses,
  subtractInProgress,
  unionBlocked,
} from "../src/measure";

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

describe("parseRunNote", () => {
  // The live convention as bead-work writes it (seen verbatim on tl-9ap).
  const live =
    "bead-work run: PR https://github.com/acme/demo/pull/64 — success — draft PR reviewed and CI green; bead stays claimed until merge";

  test("reads the url, outcome, and free text off the convention line", () => {
    expect(parseRunNote(live)).toEqual({
      prUrl: "https://github.com/acme/demo/pull/64",
      outcome: "success",
      note: "draft PR reviewed and CI green; bead stays claimed until merge",
    });
  });

  test("a url-only line still measures", () => {
    expect(parseRunNote("bead-work run: PR https://github.com/acme/demo/pull/9")).toEqual({
      prUrl: "https://github.com/acme/demo/pull/9",
    });
  });

  test("the LAST matching line wins — --append-notes appends", () => {
    const notes = [
      "Some earlier context paragraph.",
      "bead-work run: PR https://github.com/acme/demo/pull/8 — failed — flaky test",
      "More prose in between.",
      live,
    ].join("\n");
    expect(parseRunNote(notes)?.prUrl).toBe("https://github.com/acme/demo/pull/64");
    expect(parseRunNote(notes)?.outcome).toBe("success");
  });

  test("a dash inside the free text survives the split", () => {
    const note = parseRunNote(
      "bead-work run: PR https://x.dev/p/1 — success — re-ran twice — flake cleared",
    );
    expect(note?.note).toBe("re-ran twice — flake cleared");
  });

  test("surrounding whitespace is tolerated", () => {
    expect(parseRunNote("   bead-work run: PR https://x.dev/p/2 — merged   ")).toEqual({
      prUrl: "https://x.dev/p/2",
      outcome: "merged",
    });
  });

  test("anything else under-claims to undefined, never invents", () => {
    expect(parseRunNote(undefined)).toBeUndefined();
    expect(parseRunNote("")).toBeUndefined();
    expect(parseRunNote("MEASURED 2026-08-08: unrelated audit note.")).toBeUndefined();
    // A typo'd marker is a missed join, deliberately — not a guessed one.
    expect(parseRunNote("beadwork run: PR https://x.dev/p/3")).toBeUndefined();
  });
});
