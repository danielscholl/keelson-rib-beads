import { describe, expect, test } from "bun:test";
import type { RibExec } from "@keelson/shared";
import { BdClient, type BdIssue } from "../src/bd";
import { GhClient } from "../src/pr";
import { syncMergedPRs } from "../src/sync";

const project = { id: "p", name: "Project", rootPath: "/repo" };
const url = "https://github.com/acme/demo/pull/";
const mergedAt = "2026-09-22T01:02:03Z";
const link = (n: number) => `bead-work run: PR ${url}${n} — success`;

function tracker(rows: BdIssue[], notes: Record<string, string>, states: Record<number, string>) {
  const issues = new Map(rows.map((row) => [row.id, { ...row }]));
  const writes: string[][] = [];
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  let onShow: ((id: string) => void) | undefined;
  let noWrite = false;
  let failClose: string | undefined;
  const exec = {
    runJSON: async (command: string, args: string[], opts: { cwd: string }) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "gh") {
        const prUrl = args[2] ?? "";
        const number = Number(prUrl.split("/").at(-1));
        return {
          ok: true,
          data: {
            url: prUrl,
            state: states[number] ?? "OPEN",
            mergedAt: states[number] === "MERGED" ? mergedAt : null,
            body: "",
          },
        };
      }
      if (args[1] === "list") {
        return {
          ok: true,
          data: [...issues.values()].filter((row) => row.status !== "closed"),
        };
      }
      if (args[1] === "show") {
        const id = args[2] ?? "";
        onShow?.(id);
        const row = issues.get(id);
        return { ok: true, data: row ? [{ ...row, notes: notes[id] }] : [] };
      }
      if (args[1] === "ready") {
        return {
          ok: true,
          data: [...issues.values()].filter(
            (row) =>
              row.status === "open" &&
              (row.blocked_by ?? []).every((blocker) => issues.get(blocker)?.status === "closed"),
          ),
        };
      }
      return { ok: true, data: [] };
    },
    runText: async (command: string, args: string[], opts: { cwd: string }) => {
      calls.push({ command, args, cwd: opts.cwd });
      writes.push(args);
      if (failClose === args[1]) return { ok: false, error: "write failed" };
      if (!noWrite && args[0] === "close") {
        const row = issues.get(args[1] ?? "");
        if (row) row.status = "closed";
      }
      return { ok: true, data: "ok" };
    },
  } as unknown as RibExec;
  return {
    bd: new BdClient(exec),
    gh: new GhClient(exec),
    issues,
    writes,
    calls,
    setOnShow(fn: (id: string) => void) {
      onShow = fn;
    },
    setNoWrite(value: boolean) {
      noWrite = value;
    },
    setFailClose(id: string) {
      failClose = id;
    },
  };
}

function row(id: string, status = "in_progress", extra: Partial<BdIssue> = {}): BdIssue {
  return { id, title: id, priority: 2, status, ...extra };
}

describe("confirmed merged PR reconciliation", () => {
  test("preview lists merge proof and skips unmerged PRs without writing", async () => {
    const t = tracker(
      [row("cos-hjf.1"), row("cos-hjf.2", "open", { blocked_by: ["cos-hjf.1"] })],
      { "cos-hjf.1": link(1), "cos-hjf.2": link(2) },
      { 1: "MERGED", 2: "CLOSED" },
    );
    const preview = await syncMergedPRs(t.bd, t.gh, project, { confirm: false });
    expect(preview).toEqual({
      results: [
        { id: "cos-hjf.1", status: "would_close", prUrl: `${url}1`, mergedAt },
        { id: "cos-hjf.2", status: "skipped", reason: "PR is CLOSED, not merged" },
      ],
    });
    expect(t.writes).toEqual([]);
    expect(t.issues.get("cos-hjf.1")?.status).toBe("in_progress");
  });

  test("closes merged claimed and open beads with the exact reason; second run is a no-op", async () => {
    const t = tracker(
      [
        row("cos-hjf.1"),
        row("cos-hjf.2", "open", { blocked_by: ["cos-hjf.1"] }),
        row("cos-hjf.3", "open", { blocked_by: ["cos-hjf.2"] }),
        row("epic", "deferred"),
      ],
      { "cos-hjf.1": link(1), "cos-hjf.2": link(2), "cos-hjf.3": "bead-work run: PR none" },
      { 1: "MERGED", 2: "MERGED" },
    );
    const before = await t.bd.readJSON<BdIssue[]>("/repo", ["ready"]);
    expect(before.ok && before.data.map((bead) => bead.id)).not.toContain("cos-hjf.3");
    const result = await syncMergedPRs(t.bd, t.gh, project, { confirm: true });
    expect(result.results.map((entry) => entry.status)).toEqual(["closed", "closed", "skipped"]);
    expect(t.writes).toEqual([
      ["close", "cos-hjf.1", "--reason", `Merged via ${url}1`],
      ["close", "cos-hjf.2", "--reason", `Merged via ${url}2`],
    ]);
    const after = await t.bd.readJSON<BdIssue[]>("/repo", ["ready"]);
    expect(after.ok && after.data.map((bead) => bead.id)).toContain("cos-hjf.3");
    expect((await syncMergedPRs(t.bd, t.gh, project, { confirm: true })).results).toEqual([
      { id: "cos-hjf.3", status: "skipped", reason: "No recorded PR" },
    ]);
    expect(t.writes).toHaveLength(2);
    expect(
      t.calls.filter((call) => call.command === "bd").every((call) => call.cwd === "/repo"),
    ).toBe(true);
  });

  test("a changed status or latest PR note is skipped before closing", async () => {
    const notes = { a: link(1), b: link(2) };
    const t = tracker([row("a"), row("b")], notes, { 1: "MERGED", 2: "MERGED" });
    const counts = new Map<string, number>();
    t.setOnShow((id) => {
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      if (count === 2 && id === "a") t.issues.get(id)!.status = "deferred";
      if (count === 2 && id === "b") notes.b = `${link(2)}\n${link(3)}`;
    });
    const report = await syncMergedPRs(t.bd, t.gh, project, { confirm: true });
    expect(report.results).toEqual([
      { id: "a", status: "skipped", reason: "Status changed to deferred" },
      { id: "b", status: "skipped", reason: "Recorded PR changed" },
    ]);
    expect(t.writes).toEqual([]);
  });

  test("reports partial write failures and exit-zero without actual closure", async () => {
    const t = tracker(
      [row("a"), row("b")],
      { a: link(1), b: link(2) },
      { 1: "MERGED", 2: "MERGED" },
    );
    t.setFailClose("a");
    t.setNoWrite(true);
    const report = await syncMergedPRs(t.bd, t.gh, project, { confirm: true });
    expect(report.results).toEqual([
      { id: "a", status: "error", reason: "bd close: write failed" },
      { id: "b", status: "error", reason: "bd close did not close bead (in_progress)" },
    ]);
  });
});
