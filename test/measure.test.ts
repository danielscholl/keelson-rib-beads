import { describe, expect, test } from "bun:test";
import type { RibExec } from "@keelson/shared";
import { BdClient, type BdIssue } from "../src/bd";
import {
  byPriorityThenAge,
  measureProject,
  parseRunNote,
  recentCloses,
  subtractInProgress,
  unionBlocked,
} from "../src/measure";
import { GhClient } from "../src/pr";

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

describe("run notes and project PR measurement", () => {
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

  describe("project PR measurement", () => {
    const project = { id: "p", name: "Project", rootPath: "/repo" };
    const url = "https://github.com/acme/demo/pull/42";

    function fake(backlog: BdIssue[], notes: Record<string, string>, failures: string[] = []) {
      const calls: { command: string; args: string[]; cwd: string }[] = [];
      const exec = {
        runJSON: async (command: string, args: string[], opts: { cwd: string }) => {
          calls.push({ command, args, cwd: opts.cwd });
          if (command === "gh") {
            const requested = args[2];
            if (requested === `${url.replace(/42$/, "43")}`) {
              return { ok: false, error: "rate limit" };
            }
            return {
              ok: true,
              data: {
                url: requested,
                state: "MERGED",
                mergedAt: "2026-09-22T01:02:03Z",
                body: "",
              },
            };
          }
          const cmd = args[1];
          if (failures.includes(cmd ?? "")) return { ok: false, error: `${cmd} failed` };
          if (cmd === "show") {
            const id = args[2] ?? "";
            if (failures.includes(id)) return { ok: false, error: `show ${id} failed` };
            return { ok: true, data: [{ ...issue(id), notes: notes[id] }] };
          }
          if (cmd === "status") return { ok: true, data: { summary: {} } };
          if (cmd === "list" && args.includes("in_progress")) {
            return { ok: true, data: backlog.filter((bead) => bead.status === "in_progress") };
          }
          if (cmd === "list" && args.includes("closed")) return { ok: true, data: [] };
          if (cmd === "list" && args.includes("blocked")) return { ok: true, data: [] };
          if (cmd === "list") return { ok: true, data: backlog };
          return { ok: true, data: [] };
        },
        runText: async () => {
          throw new Error("read-only sweep must not mutate bd");
        },
      } as unknown as RibExec;
      return { bd: new BdClient(exec), gh: new GhClient(exec), calls };
    }

    test("scans every open and claimed bead, including blocked work beyond 12", async () => {
      const backlog = [
        ...Array.from({ length: 14 }, (_, n) =>
          issue(`tl-${n}`, { status: n % 2 ? "open" : "in_progress", blocked_by: ["root"] }),
        ),
        issue("tl-deferred", { status: "deferred" }),
      ];
      const notes = Object.fromEntries(
        backlog.map((bead) => [bead.id, `bead-work run: PR ${url} — success`]),
      );
      notes["tl-13"] = `bead-work run: PR ${url}\nbead-work run: PR none — failed`;
      const { bd, gh, calls } = fake(backlog, notes);
      const m = await measureProject(bd, project, () => new Date("2026-09-23T00:00:00Z"), gh);
      expect(m.runInfo.ok).toBe(true);
      expect(m.prInfo.ok).toBe(true);
      if (!m.runInfo.ok || !m.prInfo.ok) return;
      expect(Object.keys(m.runInfo.data)).toHaveLength(14);
      expect(m.runInfo.data["tl-13"]).toEqual({
        ok: true,
        data: { prState: "none", outcome: "failed" },
      });
      expect(m.prInfo.data["tl-13"]).toEqual({ ok: true, data: undefined });
      expect(m.prInfo.data["tl-12"]?.ok).toBe(true);
      expect(calls.filter((call) => call.command === "gh")).toHaveLength(1);
      expect(calls.filter((call) => call.args[1] === "show")).toHaveLength(14);
      expect(calls.every((call) => call.cwd === "/repo")).toBe(true);
    });

    test("keeps per-bead show and gh failures distinct from missing PRs", async () => {
      const backlog = [
        issue("tl-bad", { status: "open" }),
        issue("tl-gh", { status: "in_progress" }),
        issue("tl-none"),
        issue("tl-malformed"),
      ];
      const { bd, gh } = fake(
        backlog,
        {
          "tl-gh": `bead-work run: PR ${url.replace(/42$/, "43")} — success`,
          "tl-malformed": "bead-work run: PR https://example.com/not-a-pr — success",
        },
        ["tl-bad"],
      );
      const m = await measureProject(bd, project, undefined, gh);
      if (!m.prInfo.ok) throw new Error(m.prInfo.error);
      expect(m.prInfo.data["tl-bad"]?.ok).toBe(false);
      expect(m.prInfo.data["tl-gh"]).toEqual({
        ok: false,
        error: `gh pr view ${url.replace(/42$/, "43")}: rate limit`,
      });
      expect(m.prInfo.data["tl-none"]).toEqual({ ok: true, data: undefined });
      expect(m.prInfo.data["tl-malformed"]?.ok).toBe(false);
    });

    test("a failed list marks both note and PR scans unmeasured", async () => {
      const { bd, gh } = fake([], {}, ["list"]);
      const m = await measureProject(bd, project, undefined, gh);
      expect(m.runInfo.ok).toBe(false);
      expect(m.prInfo.ok).toBe(false);
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

  test("keeps unknown and number-only PR notes distinct from linked PRs", () => {
    expect(parseRunNote("bead-work run: PR unknown — failed — state uncertain")).toEqual({
      prState: "unknown",
      outcome: "failed",
      note: "state uncertain",
    });
    expect(parseRunNote("bead-work run: PR #42 — cancelled — claim retained")).toEqual({
      prState: "number-only",
      prNumber: "42",
      outcome: "cancelled",
      note: "claim retained",
    });
    expect(parseRunNote("bead-work run: PR none — failed")).toEqual({
      prState: "none",
      outcome: "failed",
    });
    expect(parseRunNote("bead-work run: PR garbage — failed")).toBeUndefined();
  });

  test("the last note controls review status even if an older note had a URL", () => {
    expect(
      parseRunNote(
        "bead-work run: PR https://github.com/acme/demo/pull/9 — success\nbead-work run: PR unknown — failed",
      ),
    ).toEqual({ prState: "unknown", outcome: "failed" });
  });
});
