import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import type { BdIssue, Measured } from "../src/bd";
import {
  ago,
  assigneeView,
  beadTimeline,
  composeAttention,
  composeBacklog,
  composeInspect,
  composeInspectNeedsBd,
  composeLadders,
  composeNoTrackerPulse,
  composePulse,
  composeRecommend,
  composeShipped,
  composeWip,
  damGroups,
  declaredDownstream,
  epicGate,
  firstSentence,
  flightStage,
  ladderOrder,
  lifecycleOf,
  lifecycleTone,
  prLabel,
  recommendNext,
  shippedPR,
  shortPerson,
  signalOf,
  stageChip,
  stageSplit,
  unlockChain,
  unlockLevels,
} from "../src/board";
import { type ProjectMeasurement, parseRunNote } from "../src/measure";

const project = { id: "p1", name: "demo", rootPath: "/tmp/demo" };

function ok<T>(data: T): Measured<T> {
  return { ok: true, data };
}

const validBoard = expectView("rib:beads:test", "board");

function fullMeasurement(): ProjectMeasurement {
  return {
    project,
    asOf: "2026-08-09T12:00:00.000Z",
    bd: ok({ version: "1.2.2", supported: true }),
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
    // The chart window: the 7-day close plus one only the fortnight sees.
    closedFortnight: ok([
      {
        id: "tl-g",
        title: "Done",
        status: "closed",
        priority: 2,
        closed_at: "2026-08-08T10:00:00Z",
      },
      {
        id: "tl-old",
        title: "Done before the week",
        status: "closed",
        priority: 2,
        created_at: "2026-07-20T09:00:00Z",
        closed_at: "2026-07-30T10:00:00Z",
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
      { id: "tl-b", title: "Ready one", status: "open", priority: 0, dependent_count: 3 },
    ]),
    epicChildren: ok({}),
    latestComment: ok({}),
    runInfo: ok({ "tl-a": ok(undefined) }),
    prInfo: ok({ "tl-a": ok(undefined) }),
  };
}

// Override the in-progress set AND its per-bead run envelopes together — a
// bead without an envelope alarms on its card, which is correct in production
// and noise in a test about something else.
function setWip(m: ProjectMeasurement, items: BdIssue[]): void {
  m.inProgress = ok(items);
  m.runInfo = ok(Object.fromEntries(items.map((i) => [i.id, ok(undefined)])));
  m.prInfo = ok(Object.fromEntries(items.map((i) => [i.id, ok(undefined)])));
}

describe("recommendNext / unlockChain", () => {
  test("leverage outranks priority; runner-up is named", () => {
    const { pick, runnerUp } = recommendNext([
      { id: "hot", title: "P0 but isolated", status: "open", priority: 0, dependent_count: 0 },
      { id: "lever", title: "P2 but frees three", status: "open", priority: 2, dependent_count: 3 },
    ]);
    expect(pick?.id).toBe("lever");
    expect(runnerUp?.id).toBe("hot");
  });

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

  test("unlockLevels walks every hop, not just two", () => {
    const blocked = [
      { id: "b1", title: "hop1", status: "open", priority: 1, blocked_by: ["rec"] },
      { id: "b2", title: "hop2", status: "open", priority: 1, blocked_by: ["b1"] },
      { id: "b3", title: "hop3", status: "open", priority: 1, blocked_by: ["b2"] },
      { id: "off", title: "unrelated", status: "open", priority: 1, blocked_by: ["x"] },
    ];
    expect(unlockLevels("rec", blocked).map((l) => l.map((b) => b.id))).toEqual([
      ["b1"],
      ["b2"],
      ["b3"],
    ]);
  });

  test("a dependency cycle terminates instead of walking forever", () => {
    const blocked = [
      { id: "b1", title: "hop1", status: "open", priority: 1, blocked_by: ["rec"] },
      { id: "b2", title: "hop2", status: "open", priority: 1, blocked_by: ["b1"] },
      // b1 also waits on b2 — bd permits this; the walk must not revisit.
      { id: "b1b", title: "loop", status: "open", priority: 1, blocked_by: ["b2", "rec"] },
    ];
    const levels = unlockLevels("rec", blocked);
    expect(
      levels
        .flat()
        .map((b) => b.id)
        .sort(),
    ).toEqual(["b1", "b1b", "b2"]);
  });
});

describe("bead grammar", () => {
  const issue = (over: Partial<BdIssue> = {}): BdIssue => ({
    id: "x",
    title: "t",
    status: "open",
    priority: 2,
    ...over,
  });

  test("blocked is a condition, so it never becomes a lifecycle value", () => {
    expect(lifecycleOf(issue({ status: "blocked" }))).toBe("open");
    expect(lifecycleOf(issue({ status: "in_progress" }))).toBe("in_progress");
    expect(lifecycleOf(issue({ status: "deferred" }))).toBe("deferred");
  });

  test("the dot is the lane and never an alarm", () => {
    expect(lifecycleTone("open")).toBe("accent");
    expect(lifecycleTone("in_progress")).toBe("info");
    expect(lifecycleTone("closed")).toBe("ok");
    expect(lifecycleTone("deferred")).toBe("neutral");
  });

  test("a bead carries at most one signal, most pressing first", () => {
    expect(signalOf(issue())).toBeUndefined();
    expect(signalOf(issue({ priority: 0 }))?.label).toBe("P0");
    expect(signalOf(issue({ priority: 1 }), { waitingOn: ["a", "b"] })?.label).toBe("waits on 2");
    expect(signalOf(issue(), { waitingOn: ["a"], mergePending: true })?.label).toBe(
      "merged · close pending",
    );
    expect(signalOf(issue(), { staleDays: 9 })?.label).toBe("stale 9d");
    expect(signalOf(issue({ status: "deferred" }))?.label).toBe("on hold");
  });

  test("an email shows as its local part, a display name as written", () => {
    expect(shortPerson("daniel.scholl@example.com")).toBe("daniel.scholl");
    expect(shortPerson("Daniel Scholl")).toBe("Daniel Scholl");
    expect(shortPerson(undefined)).toBeUndefined();
  });

  test("evidence lines keep the first sentence", () => {
    expect(firstSentence("Merged via PR #11: detail route. Also tidied CSS.")).toBe(
      "Merged via PR #11: detail route.",
    );
    expect(firstSentence("Bumped v1.2.3 in package.json")).toBe("Bumped v1.2.3 in package.json");
  });

  test("ages are coarse", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    expect(ago("2026-08-09T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-08-09T11:15:00Z", now)).toBe("45m");
    expect(ago("2026-08-09T09:00:00Z", now)).toBe("3h");
    expect(ago("2026-08-07T12:00:00Z", now)).toBe("2d");
    expect(ago(undefined, now)).toBeUndefined();
  });

  test("declared downstream reads through the backlog when the row lacks it", () => {
    const index = new Map([["x", issue({ dependent_count: 4 })]]);
    expect(declaredDownstream(issue(), index)).toBe(4);
    expect(declaredDownstream(issue({ dependent_count: 1 }), index)).toBe(1);
    expect(declaredDownstream(issue({ id: "unknown" }), index)).toBe(0);
  });

  test("assigneeView hoists one owner in short form and marks gaps in a mix", () => {
    expect(assigneeView([issue({ assignee: "dan@x.dev" }), issue({ owner: "dan@x.dev" })])).toEqual(
      { sharedTitle: "All claimed by dan", perItem: false, markUnassigned: false },
    );
    expect(assigneeView([issue(), issue()])).toEqual({ perItem: false, markUnassigned: false });
    expect(assigneeView([issue({ assignee: "dan" }), issue()])).toEqual({
      perItem: true,
      markUnassigned: true,
    });
  });
});

describe("header", () => {
  test("one sentence says the week, above the flow strip", () => {
    const pulse = composePulse(fullMeasurement());
    expect(() => validBoard(pulse)).not.toThrow();
    const strip = pulse.sections[0];
    if (strip?.kind !== "segments") throw new Error("no strip");
    // 1 closed this week, 1 claimed, and tl-f.1 (deferred) plus the epic are
    // not counted as left to do.
    expect(strip.title).toBe("This week: 1 shipped · 1 in flight · 1 left to do");
    expect(pulse.header?.chip).toBe("bd 1.2.2 · measured 12:00Z");
    expect(pulse.header?.status?.tone).toBe("ok");
  });

  test("the header renders without bd's summary", () => {
    const m = fullMeasurement();
    m.summary = { ok: false, error: "bd status: exit 1" };
    const pulse = composePulse(m);
    expect(() => validBoard(pulse)).not.toThrow();
    expect(pulse.sections[0]?.kind).toBe("segments");
  });

  test("a bd below the floor is one header line, and panels point at it", () => {
    const m = fullMeasurement();
    m.bd = ok({ version: "1.0.4", supported: false });
    const floor = "bd 1.0.4 is older than 1.2+";
    m.runInfo = { ok: false, error: floor };
    m.prInfo = { ok: false, error: floor };
    m.epicChildren = { ok: false, error: floor };
    m.epics = { ok: false, error: "exit 1" };
    const pulse = composePulse(m);
    expect(() => validBoard(pulse)).not.toThrow();
    const flat = JSON.stringify(pulse);
    expect(flat).toContain("bd too old");
    expect(flat).toContain("bd 1.0.4 is on PATH and the board needs 1.2+");
    expect(flat).not.toContain("Hatched segments");
    expect(pulse.header?.status?.tone).toBe("error");
    for (const view of [composeAttention(m, {}), composeLadders(m, {}), composeWip(m, {})]) {
      expect(() => validBoard(view)).not.toThrow();
      const rows = JSON.stringify(view);
      expect(rows).toContain("needs bd 1.2+. See the header.");
      expect(rows).not.toContain("could not be measured");
    }
    // Attention folds every failure into one row, raw errors kept behind it.
    const att = composeAttention(m, {});
    const alarms = att.sections[0];
    if (alarms?.kind !== "rows") throw new Error("no alarm rows");
    expect(alarms.items).toHaveLength(1);
    expect(alarms.items[0]?.detail).toContain("epic closeout eligibility: exit 1");
    expect(composeInspectNeedsBd(m).sections).toHaveLength(1);
  });

  test("gh failing every lookup is one header line, not an alarm per card", () => {
    const m = fullMeasurement();
    const url = "https://github.com/acme/demo/pull/9";
    m.runInfo = ok({ "tl-a": ok({ prUrl: url }) });
    m.prInfo = ok({ "tl-a": { ok: false, error: "gh: not logged in" } });
    const pulse = composePulse(m);
    expect(pulse.header?.chip).toContain("gh failing");
    expect(JSON.stringify(pulse)).toContain("gh: not logged in");
    expect(JSON.stringify(composeWip(m, {}))).not.toContain("UNMEASURED PR");
    expect(JSON.stringify(composeAttention(m, {}))).not.toContain("PR state for some beads");
  });

  test("a scope without a tracker renders the map, not a fake backlog", () => {
    const view = composeNoTrackerPulse("demo", [{ name: "tracked" }]);
    expect(() => validBoard(view)).not.toThrow();
    expect(JSON.stringify(view)).toContain("tracked");
  });
});

describe("Next up", () => {
  test("the pick explains itself, leads its meta with the id, and carries both actions", () => {
    const rec = composeRecommend(fullMeasurement(), {});
    expect(() => validBoard(rec)).not.toThrow();
    const card = rec.sections[0];
    if (card?.kind !== "cards") throw new Error("no cards");
    const pick = card.items[0];
    expect(pick?.title).toBe("Ready one");
    expect(pick?.pill).toBeUndefined();
    expect(pick?.fields?.[0]?.value).toBe("tl-b · ready · unclaimed · P0");
    expect(pick?.reason?.text).toBe("3 downstream · releases 1 now");
    expect(pick?.fields?.[1]).toEqual({ label: "unlocks", value: "tl-d → tl-h" });
    expect(pick?.footnote).toBe("runner-up: tl-c · Ready two");
    expect(pick?.actions?.map((a) => a.type)).toEqual(["select-bead", "claim-bead"]);
  });

  test("a deep unlock chain compresses past the first hop", () => {
    const m = fullMeasurement();
    m.ready = ok([{ id: "tl-b", title: "Ready one", status: "open", priority: 0 }]);
    m.blocked = ok([
      { id: "tl-c1", title: "A", status: "open", priority: 1, blocked_by: ["tl-b"] },
      { id: "tl-c2", title: "B", status: "open", priority: 1, blocked_by: ["tl-b"] },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `tl-d${i}`,
        title: `Deep ${i}`,
        status: "open",
        priority: 2,
        blocked_by: ["tl-c1"],
      })),
    ]);
    const flat = JSON.stringify(composeRecommend(m, {}));
    expect(flat).toContain("tl-c1, tl-c2 → … 10 more across 1 level");
    expect(flat).not.toContain("tl-d7");
  });

  test("an empty ready queue says so", () => {
    const m = fullMeasurement();
    m.ready = ok([]);
    expect(JSON.stringify(composeRecommend(m, {}))).toContain("Nothing is ready to start");
  });
});

describe("In flight", () => {
  test("an empty claim set is a quiet row", () => {
    const m = fullMeasurement();
    setWip(m, []);
    const wip = composeWip(m, {});
    expect(() => validBoard(wip)).not.toThrow();
    expect(JSON.stringify(wip)).toContain("Nothing is claimed");
  });

  test("a claim reads its stage from started_at and its evidence from the newest comment", () => {
    const m = fullMeasurement();
    setWip(m, [
      {
        id: "tl-a",
        title: "In flight",
        status: "in_progress",
        priority: 2,
        assignee: "dan@x.dev",
        started_at: "2026-08-09T09:00:00Z",
        comment_count: 2,
      },
    ]);
    m.latestComment = ok({
      "tl-a": ok({
        author: "dan@x.dev",
        text: "Starfield done. Wiring the API next.",
        created_at: "2026-08-09T11:00:00Z",
      }),
    });
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBe("All claimed by dan");
    const card = cards.items[0];
    expect(card?.dot).toBe("info");
    expect(card?.fields?.[0]?.value).toBe("tl-a · claimed 3h ago");
    expect(card?.reason).toEqual({ label: "dan · 1h ago", text: "Starfield done." });
  });

  test("a claim older than started_at says its time was not recorded", () => {
    const m = fullMeasurement();
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.items[0]?.fields?.[0]?.value).toContain("claimed · time not recorded");
  });

  test("an open PR shows its live CI and review state and links out", () => {
    const m = fullMeasurement();
    const url = "https://github.com/acme/demo/pull/64";
    m.runInfo = ok({ "tl-a": ok({ prUrl: url, outcome: "success", note: "draft reviewed" }) });
    m.prInfo = ok({
      "tl-a": ok({
        url,
        state: "OPEN",
        mergedAt: null,
        checks: "passing",
        review: "review required",
      }),
    });
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBe("1 bead-work run");
    const card = cards.items[0];
    expect(card?.fields?.[0]?.value).toBe("tl-a · PR open · CI passing · review required");
    expect(card?.fields?.[1]).toEqual({ label: "PR", value: "demo#64", href: url });
    expect(card?.reason).toEqual({ label: "run success", text: "draft reviewed" });
  });

  test("a claimed bead that also waits carries the waiting as its signal", () => {
    const m = fullMeasurement();
    setWip(m, [{ id: "tl-d", title: "Dep blocked", status: "in_progress", priority: 2 }]);
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.items[0]?.dot).toBe("info");
    expect(cards.items[0]?.pill?.label).toBe("waits on 1");
  });

  test("mixed owners keep the owner on each card and mark the unassigned", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "tl-g", title: "One", status: "in_progress", priority: 2, assignee: "dan" },
      { id: "tl-i", title: "Two", status: "in_progress", priority: 2 },
    ]);
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBeUndefined();
    expect(cards.items[0]?.fields?.[0]?.value).toContain("dan");
    expect(cards.items[1]?.fields?.[0]?.value).toContain("unassigned");
  });

  test("one failed run envelope alarms one card, not the panel", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "tl-r", title: "Fine", status: "in_progress", priority: 1 },
      { id: "tl-x", title: "Unread", status: "in_progress", priority: 1 },
    ]);
    m.runInfo = ok({
      "tl-r": ok(undefined),
      "tl-x": { ok: false, error: "bd show tl-x: exit 1" },
    });
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(JSON.stringify(cards.items[0])).not.toContain("UNMEASURED");
    expect(JSON.stringify(cards.items[1])).toContain("UNMEASURED run note");
  });
});

describe("Needs you", () => {
  test("dams stay rows with comparable meters and open the inspector", () => {
    const att = composeAttention(fullMeasurement(), {});
    expect(() => validBoard(att)).not.toThrow();
    const dams = att.sections.find((s) => s.kind === "rows" && s.title?.startsWith("Dams"));
    if (dams?.kind !== "rows") throw new Error("no dams");
    expect(dams.items[0]?.trailing).toBe("tl-b · holds 1 · 2 transitive · startable");
    expect(dams.items[0]?.bar).toEqual({ value: 1, total: 1 });
    expect(dams.items[0]?.action?.type).toBe("select-bead");
  });

  test("hand-paused work, stale claims and closeouts are bead cards with one signal", () => {
    const m = fullMeasurement();
    m.stale = ok([
      {
        id: "tl-s",
        title: "Quiet",
        status: "in_progress",
        priority: 2,
        owner: "sam@x.dev",
        updated_at: "2026-07-30T12:00:00Z",
      },
    ]);
    const att = composeAttention(m, { selectedId: "tl-e" });
    expect(() => validBoard(att)).not.toThrow();
    const byTitle = (t: string) => att.sections.find((s) => s.kind === "cards" && s.title === t);
    const paused = byTitle("Paused by hand");
    const stale = byTitle("Stale claims, quiet 7d+");
    const closeout = byTitle("Epic closeout review");
    if (paused?.kind !== "cards" || stale?.kind !== "cards" || closeout?.kind !== "cards")
      throw new Error("missing sections");
    expect(paused.items[0]?.selected).toBe(true);
    expect(paused.items[0]?.pill?.label).toBe("paused by hand");
    expect(stale.items[0]?.pill?.label).toBe("stale 10d");
    expect(stale.items[0]?.fields?.[0]?.value).toBe("tl-s · sam · verify or release");
    expect(closeout.items[0]?.pill?.label).toBe("closeout review");
    expect(closeout.items[0]?.bar).toEqual({ value: 4, total: 4 });
    expect(JSON.stringify(closeout)).not.toContain("claim-bead");
  });

  test("failed inputs alarm instead of reading as a clean board", () => {
    const m = fullMeasurement();
    m.stale = { ok: false, error: "bd stale: exit 1" };
    m.epics = { ok: false, error: "bd epic status: exit 1" };
    const flat = JSON.stringify(composeAttention(m, {}));
    expect(flat).toContain("Stale claims could not be measured");
    expect(flat).toContain("Epic closeout eligibility could not be measured");
  });

  test("a measured zero says nothing needs you", () => {
    const m = fullMeasurement();
    m.blocked = ok([]);
    m.epics = ok([]);
    const flat = JSON.stringify(composeAttention(m, {}));
    expect(flat).toContain("Nothing needs you");
  });
});

describe("Epics", () => {
  function epicBoard(): ProjectMeasurement {
    const m = fullMeasurement();
    m.epics = ok([
      {
        epic: { id: "cx", title: "Cosmos v1", status: "open", priority: 1 },
        total_children: 5,
        closed_children: 2,
        eligible_for_close: false,
      },
    ]);
    m.epicChildren = ok({
      cx: [
        { id: "cx.1", title: "Scaffold", status: "closed" },
        { id: "cx.2", title: "Endpoint", status: "closed" },
        { id: "cx.5", title: "Share sheet", status: "open" },
        { id: "cx.4", title: "Detail view", status: "open" },
        { id: "cx.3", title: "Landing page", status: "in_progress" },
      ],
    });
    m.blocked = ok([
      { id: "cx.5", title: "Share sheet", status: "open", priority: 2, blocked_by: ["cx.4"] },
    ]);
    m.ready = ok([{ id: "cx.4", title: "Detail view", status: "open", priority: 2 }]);
    setWip(m, [{ id: "cx.3", title: "Landing page", status: "in_progress", priority: 2 }]);
    return m;
  }

  test("the ladder lists done, in flight, the pick, then what waits", () => {
    const view = composeLadders(epicBoard(), {});
    expect(() => validBoard(view)).not.toThrow();
    const [head, rungs] = view.sections;
    if (head?.kind !== "cards" || rungs?.kind !== "rows") throw new Error("wrong shapes");
    expect(head.items[0]?.fields?.[0]?.value).toBe("cx · 2 of 5 done · 1 in flight");
    expect(rungs.items.map((r) => r.trailing)).toEqual([
      "cx.1 · done",
      "cx.2 · done",
      "cx.3 · in flight",
      "cx.4 · ready · next up",
      "cx.5 · waits on cx.4",
    ]);
    expect(rungs.items.map((r) => r.glyph)).toEqual(["ok", "ok", "info", "accent", "accent"]);
  });

  test("a long run of done children folds into one row", () => {
    const m = epicBoard();
    const members = Array.from({ length: 6 }, (_, i) => ({
      id: `cx.${i + 10}`,
      title: `Done ${i}`,
      status: "closed",
    }));
    m.epicChildren = ok({ cx: members });
    const rungs = composeLadders(m, {}).sections[1];
    if (rungs?.kind !== "rows") throw new Error("no rungs");
    expect(rungs.items).toHaveLength(1);
    expect(rungs.items[0]?.text).toBe("6 done");
  });

  test("ladderOrder puts deeper waits later", () => {
    const members = [
      { id: "c", title: "c", status: "open" },
      { id: "b", title: "b", status: "open" },
      { id: "a", title: "a", status: "open" },
    ];
    const edges = new Map<string, readonly string[]>([
      ["c", ["b"]],
      ["b", ["a"]],
    ]);
    expect(ladderOrder(members, edges).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("no open epics hides the panel; unmeasured epics alarm", () => {
    const m = fullMeasurement();
    m.epics = ok([]);
    expect(composeLadders(m, {}).sections).toHaveLength(0);
    m.epics = { ok: false, error: "exit 1" };
    expect(JSON.stringify(composeLadders(m, {}))).toContain("UNMEASURED");
  });

  test("unmeasured membership keeps the meters and says why the rungs are missing", () => {
    const m = epicBoard();
    m.epicChildren = { ok: false, error: "bd show cx: exit 1" };
    const view = composeLadders(m, {});
    expect(() => validBoard(view)).not.toThrow();
    expect(JSON.stringify(view)).toContain("Epic membership could not be measured");
    expect(view.sections.some((s) => s.kind === "cards")).toBe(true);
  });
});

describe("Backlog", () => {
  test("open beads group by priority; epics, claims and ladder children stay out", () => {
    const m = fullMeasurement();
    m.backlog = ok([
      { id: "tl-f", title: "S1", status: "open", priority: 1, issue_type: "epic" },
      { id: "tl-f.1", title: "Child", status: "open", priority: 2 },
      { id: "tl-a", title: "Claimed", status: "in_progress", priority: 1 },
      { id: "tl-b", title: "Ready one", status: "open", priority: 0, dependent_count: 3 },
      { id: "tl-d", title: "Dep blocked", status: "open", priority: 2 },
      { id: "tl-z", title: "Later", status: "deferred", priority: 3, owner: "sam@x.dev" },
    ]);
    m.epicChildren = ok({ "tl-f": [{ id: "tl-f.1", title: "Child", status: "open" }] });
    const view = composeBacklog(m, {});
    expect(() => validBoard(view)).not.toThrow();
    expect(view.sections.map((s) => s.title)).toEqual([
      "P0 · urgent · 1",
      "P2 · normal · 1",
      "P3 · low · 1",
    ]);
    const rows = view.sections.flatMap((s) => (s.kind === "rows" ? s.items : []));
    expect(rows.map((r) => r.trailing)).toEqual([
      "tl-b · 3 downstream",
      "tl-d · waits on tl-b",
      "tl-z · sam · on hold",
    ]);
    expect(rows[2]?.glyph).toBe("neutral");
  });

  test("unmeasured membership falls back to dotted ids rather than dropping beads", () => {
    const m = fullMeasurement();
    m.backlog = ok([
      { id: "tl-f", title: "S1", status: "open", priority: 1, issue_type: "epic" },
      { id: "tl-f.1", title: "Child", status: "open", priority: 2 },
      { id: "tl-q", title: "Loose", status: "open", priority: 2 },
    ]);
    m.epicChildren = { ok: false, error: "exit 1" };
    const flat = JSON.stringify(composeBacklog(m, {}));
    expect(flat).toContain("tl-q");
    expect(flat).not.toContain("tl-f.1");
  });

  test("an empty backlog says where the work went", () => {
    const m = fullMeasurement();
    m.backlog = ok([]);
    expect(JSON.stringify(composeBacklog(m, {}))).toContain("Nothing loose");
  });
});

describe("Shipped", () => {
  test("pace compares this week with last, and each close carries its PR and reason", () => {
    const m = fullMeasurement();
    m.closedFortnight = ok([
      {
        id: "tl-g",
        title: "Done",
        status: "closed",
        priority: 2,
        assignee: "Dan",
        created_at: "2026-08-05T10:00:00Z",
        closed_at: "2026-08-09T10:15:00Z",
        close_reason: "Merged via PR #11: detail route. Four criteria enforced in CI.",
        notes: "bead-work run: PR https://github.com/acme/demo/pull/11 — success — reviewed",
      },
      {
        id: "tl-old",
        title: "Done before the week",
        status: "closed",
        priority: 2,
        created_at: "2026-07-20T09:00:00Z",
        closed_at: "2026-07-30T10:00:00Z",
      },
    ]);
    const view = composeShipped(m, {});
    expect(() => validBoard(view)).not.toThrow();
    const stats = view.sections[0];
    if (stats?.kind !== "stats") throw new Error("no stats");
    expect(stats.items[0]).toMatchObject({
      label: "Shipped this week",
      value: 1,
      sub: "last week 1",
    });
    expect(stats.items[0]?.delta?.direction).toBe("flat");
    expect(stats.items[1]).toMatchObject({ label: "Created this week", value: 1 });
    const today = view.sections[1];
    if (today?.kind !== "cards") throw new Error("no day group");
    expect(today.title).toBe("Today");
    const card = today.items[0];
    expect(card?.dot).toBe("ok");
    expect(card?.fields?.[0]?.value).toBe("tl-g · Dan · 10:15Z");
    expect(card?.fields?.[1]).toEqual({
      label: "PR",
      value: "demo#11",
      href: "https://github.com/acme/demo/pull/11",
    });
    expect(card?.reason?.text).toBe("Merged via PR #11: detail route.");
    const older = view.sections[2];
    if (older?.kind !== "cards") throw new Error("no older group");
    expect(older.title).toBe("Jul 30");
    expect(older.items[0]?.reason?.text).toBe("Closed without a written reason.");
  });

  test("a PR URL in the close reason stands in for a missing run note", () => {
    expect(
      shippedPR({
        id: "x",
        title: "x",
        status: "closed",
        priority: 2,
        close_reason: "Merged via https://github.com/acme/demo/pull/7",
      }),
    ).toBe("https://github.com/acme/demo/pull/7");
  });

  test("a quiet fortnight still shows pace; failed closes alarm", () => {
    const m = fullMeasurement();
    m.closedFortnight = ok([]);
    const quiet = JSON.stringify(composeShipped(m, {}));
    expect(quiet).toContain("Nothing closed in the last 14 days");
    expect(quiet).toContain("Shipped this week");
    m.closedFortnight = { ok: false, error: "bd list: exit 1" };
    expect(JSON.stringify(composeShipped(m, {}))).toContain("UNMEASURED");
  });

  test("a capped feed says it is truncated", () => {
    const m = fullMeasurement();
    m.closedFortnight = ok(
      Array.from({ length: 15 }, (_, i) => ({
        id: `tl-c${i}`,
        title: `Close ${i}`,
        status: "closed",
        priority: 2,
        closed_at: "2026-08-09T10:00:00Z",
      })),
    );
    expect(JSON.stringify(composeShipped(m, {}))).toContain("Showing the newest 12 of 15");
  });
});

describe("inspector", () => {
  const bead = (over: Partial<BdIssue> = {}): BdIssue => ({
    id: "cx.4",
    title: "Detail view",
    status: "open",
    priority: 2,
    created_at: "2026-08-01T10:00:00Z",
    created_by: "Dan",
    ...over,
  });

  test("an epic edge is membership, never something the bead waits on", () => {
    const view = composeInspect(
      ok(
        bead({
          dependencies: [
            { id: "cx", title: "Cosmos v1", status: "open", dependency_type: "parent-child" },
            { id: "cx.3", title: "Landing", status: "closed", dependency_type: "blocks" },
            { id: "cx.2", title: "Endpoint", status: "open", dependency_type: "blocks" },
          ],
        }),
      ),
      [],
    );
    expect(() => validBoard(view)).not.toThrow();
    const flat = JSON.stringify(view);
    expect(flat).toContain('"text":"epic","trailing":"cx · Cosmos v1"');
    const waits = JSON.stringify(
      (view.sections[0]?.kind === "columns" ? view.sections[0].columns[0]?.sections : [])?.find(
        (s) => s.title === "Waits on",
      ),
    );
    expect(waits).toContain("cx.2");
    expect(waits).not.toContain("Cosmos v1");
    expect(waits).not.toContain("cx.3");
  });

  test("the history runs created, claimed, plan, PR, comments, closed", () => {
    const rows = beadTimeline(
      bead({
        status: "closed",
        assignee: "Dan",
        started_at: "2026-08-02T10:00:00Z",
        closed_at: "2026-08-04T10:00:00Z",
        close_reason: "Merged via PR #11: detail route.",
        notes:
          "bead-work plan: approved — approve\nbead-work run: PR https://github.com/acme/demo/pull/11 — success — reviewed",
        dependencies: [{ id: "cx", dependency_type: "parent-child" }],
      }),
      [{ author: "Dan", text: "Wired the chills toggle.", created_at: "2026-08-03T10:00:00Z" }],
      undefined,
    );
    expect(rows.map((r) => r.icon)).toEqual(["+", "◐", "☰", "↗", "“", "✓"]);
    expect(rows[0]?.text).toBe("Created by Dan in epic cx");
    expect(rows[2]?.text).toBe("Plan approved");
    expect(rows[3]?.href).toBe("https://github.com/acme/demo/pull/11");
    expect(rows[4]?.text).toBe("Dan: Wired the chills toggle.");
    expect(rows[5]?.text).toBe("Closed: Merged via PR #11: detail route.");
  });

  test("a stop the tracker did not record renders hollow and says so", () => {
    const rows = beadTimeline(bead({ status: "in_progress", assignee: "Dan" }), [], undefined);
    expect(rows[1]).toEqual({ icon: "○", text: "Claimed by Dan, time not recorded" });
    const closed = beadTimeline(
      bead({ status: "closed", closed_at: "2026-08-04T10:00:00Z" }),
      [],
      undefined,
    );
    expect(closed.at(-1)?.text).toBe("Closed without a written reason");
  });

  test("a live merged PR shows on the PR stop", () => {
    const url = "https://github.com/acme/demo/pull/11";
    const rows = beadTimeline(bead({ notes: `bead-work run: PR ${url} — success` }), [], {
      url,
      state: "MERGED",
      mergedAt: "2026-08-05T10:00:00Z",
    });
    expect(rows.find((r) => r.icon === "↗")?.trailing).toBe("merged Aug 5 10:00Z");
  });

  test("a startable bead offers the claim; a blocked one offers the pick instead", () => {
    const start = JSON.stringify(composeInspect(ok(bead()), []));
    expect(start).toContain("claim-bead");
    const pick = { id: "tl-b", title: "Ready one", status: "open", priority: 0 };
    const blocked = composeInspect(ok(bead()), [{ ...bead(), blocked_by: ["cx.2"] }], pick);
    expect(() => validBoard(blocked)).not.toThrow();
    const flat = JSON.stringify(blocked);
    expect(flat).toContain('"disabled":true');
    expect(flat).toContain("Start tl-b instead");
  });

  test("an epic is never offered as work, and lists its children", () => {
    const view = composeInspect(
      ok(
        bead({
          id: "cx",
          issue_type: "epic",
          dependents: [
            { id: "cx.1", title: "Scaffold", status: "closed", dependency_type: "parent-child" },
          ],
        }),
      ),
      [],
    );
    const flat = JSON.stringify(view);
    expect(flat).not.toContain("claim-bead");
    expect(flat).toContain("Children");
    expect(flat).not.toContain("Unlocks when done");
  });

  test("a merged open bead reconciles and never starts", () => {
    const url = "https://github.com/acme/demo/pull/2";
    const view = composeInspect(ok(bead()), [], undefined, {
      projectId: "p1",
      prInfo: ok({ "cx.4": ok({ url, state: "MERGED", mergedAt: "2026-08-08T10:00:00Z" }) }),
    });
    expect(() => validBoard(view)).not.toThrow();
    const flat = JSON.stringify(view);
    expect(flat).toContain("sync-merged-beads");
    expect(flat).not.toContain("claim-bead");
  });

  test("nothing selected invites a click; a failed show alarms", () => {
    expect(JSON.stringify(composeInspect(undefined, []))).toContain("Nothing selected");
    expect(JSON.stringify(composeInspect({ ok: false, error: "exit 1" }, []))).toContain(
      "UNMEASURED",
    );
  });
});

describe("the derived review stage", () => {
  const info = (over: Partial<{ prUrl: string; outcome: string; note: string }> = {}) => ({
    prUrl: "https://github.com/acme/demo/pull/64",
    ...over,
  });

  test("stageSplit divides the in-progress set by run-note presence", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "tl-r", title: "Reviewed", status: "in_progress", priority: 1 },
      { id: "tl-w", title: "Working", status: "in_progress", priority: 1 },
    ]);
    m.runInfo = ok({ "tl-r": ok(info()), "tl-w": ok(undefined) });
    const split = stageSplit(m);
    if (!split.ok) throw new Error("split should measure");
    expect(split.data.inReview.map((i) => i.id)).toEqual(["tl-r"]);
    expect(split.data.working.map((i) => i.id)).toEqual(["tl-w"]);
  });

  test("number-only and unknown PRs stay in progress without dead links", () => {
    for (const [token, stage] of [
      ["#42", "PR #42 · link unknown"],
      ["unknown", "PR state unknown"],
    ]) {
      const m = fullMeasurement();
      m.runInfo = ok({ "tl-a": ok(parseRunNote(`bead-work run: PR ${token} — cancelled`)) });
      const split = stageSplit(m);
      if (!split.ok) throw new Error("split should measure");
      expect(split.data.inReview).toHaveLength(0);
      const cards = composeWip(m, {}).sections[0];
      if (cards?.kind !== "cards") throw new Error("no cards");
      expect(cards.items[0]?.fields?.[0]?.value).toContain(stage);
      expect(cards.items[0]?.fields?.some((f) => f.href)).toBe(false);
    }
  });

  test("stageSplit refuses partial answers", () => {
    const outer = fullMeasurement();
    outer.runInfo = { ok: false, error: "sweep died" };
    expect(stageSplit(outer).ok).toBe(false);
    const inner = fullMeasurement();
    inner.runInfo = ok({ "tl-a": { ok: false, error: "bd show tl-a: exit 1" } });
    expect(stageSplit(inner).ok).toBe(false);
    const missing = fullMeasurement();
    missing.runInfo = ok({});
    expect(stageSplit(missing).ok).toBe(false);
  });

  test("only verified PR evidence can mark a bead merged", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const i = { id: "x", title: "x", status: "in_progress", priority: 2 };
    expect(stageChip(info({ outcome: "merged, CI green" }))).toBe("in review");
    expect(flightStage(i, info({ outcome: "merged" }), undefined, now)).toBe("PR open");
    expect(
      flightStage(
        i,
        info(),
        { url: info().prUrl, state: "MERGED", mergedAt: "2026-08-08T10:00:00Z" },
        now,
      ),
    ).toBe("merged · close pending");
  });

  test("prLabel compacts a GitHub PR url and passes anything else through", () => {
    expect(prLabel("https://github.com/acme/demo/pull/64")).toBe("demo#64");
    expect(prLabel("https://example.com/mr/7")).toBe("example.com/mr/7");
  });
});

describe("verified merge drift on the board", () => {
  const url = (n: number) => `https://github.com/acme/demo/pull/${n}`;
  const pr = (n: number) => ({
    url: url(n),
    state: "MERGED" as const,
    mergedAt: "2026-08-08T10:00:00Z",
  });

  function mergedBoard(): ProjectMeasurement {
    const m = fullMeasurement();
    if (!m.backlog.ok || !m.inProgress.ok) throw new Error("fixture not measured");
    m.backlog = ok([
      ...m.backlog.data,
      ...m.inProgress.data,
      { id: "tl-f.2", title: "Second child", status: "open", priority: 1 },
    ]);
    m.epicChildren = ok({ "tl-f": [{ id: "tl-f.2", title: "Second child", status: "open" }] });
    m.runInfo = ok({ "tl-a": ok({ prUrl: url(1), outcome: "success" }) });
    m.prInfo = ok({ "tl-a": ok(pr(1)), "tl-b": ok(pr(2)), "tl-f.2": ok(pr(3)) });
    return m;
  }

  test("Needs you leads with merges to reconcile, with the scoped confirmed action", () => {
    const att = composeAttention(mergedBoard(), {});
    expect(() => validBoard(att)).not.toThrow();
    const drift = att.sections[0];
    if (drift?.kind !== "cards") throw new Error("no drift cards");
    expect(drift.title).toBe("Merged, close pending");
    expect(drift.items.map((i) => i.fields?.[0]?.value?.toString().split(" · ")[0])).toEqual([
      "tl-b",
      "tl-a",
      "tl-f.2",
    ]);
    const action = drift.items[0]?.actions?.[0];
    expect(action?.type).toBe("sync-merged-beads");
    expect(action?.payload).toEqual({ projectId: "p1" });
    expect(drift.items[0]?.fields?.[1]?.href).toBe(url(2));
    expect(JSON.stringify(att)).not.toContain('"title":"Review to merge"');
  });

  test("a merged open bead reads as close pending everywhere and cannot be started", () => {
    const m = mergedBoard();
    const views = [composeBacklog(m, {}), composeWip(m, {}), composeRecommend(m, {})];
    for (const view of views) expect(() => validBoard(view)).not.toThrow();
    const [backlog, wip, rec] = views.map((v) => JSON.stringify(v));
    expect(backlog).toContain("tl-b · merged · close pending");
    expect(wip).toContain("merged · close pending");
    expect(rec).toContain("sync-merged-beads");
    expect(rec).not.toContain("claim-bead");
  });

  test("partial PR failures and a failed blocked query alarm without hiding drift", () => {
    const m = mergedBoard();
    m.prInfo = ok({
      "tl-a": ok(pr(1)),
      "tl-b": { ok: false, error: "gh rate limit" },
      "tl-f.2": ok(undefined),
    });
    m.blocked = { ok: false, error: "bd blocked failed" };
    const flat = JSON.stringify(composeAttention(m, {}));
    expect(flat).toContain("Merged, close pending");
    expect(flat).toContain("gh rate limit");
    expect(flat).toContain("bd blocked failed");
  });

  test("note wording cannot move an unmerged PR into close pending", () => {
    const m = mergedBoard();
    m.runInfo = ok({ "tl-a": ok({ prUrl: url(1), outcome: "merged" }) });
    m.prInfo = ok({ "tl-a": ok({ url: url(1), state: "OPEN", mergedAt: null }) });
    const flat = JSON.stringify(composeAttention(m, {}));
    expect(flat).not.toContain("Merged, close pending");
    expect(flat).toContain("Review to merge");
    expect(JSON.stringify(composeWip(m, {}))).not.toContain("merged · close pending");
  });
});

describe("the flow strip", () => {
  // The strip is a `segments` SECTION leading the board (the SPA renders
  // sections as the full-width proportional strip; header segments would
  // render legend-only in the region head).
  function stripOf(pulse: ReturnType<typeof composePulse>) {
    const section = pulse.sections[0];
    return section?.kind === "segments" ? section.items : undefined;
  }

  test("the pulse leads with disjoint stage segments", () => {
    const pulse = composePulse(fullMeasurement());
    expect(() => validBoard(pulse)).not.toThrow();
    expect(pulse.header?.segments).toBeUndefined();
    // Fixture: 3 blocked (none claimed), 2 ready, 1 in progress with no run
    // note, 0 in review, 1 closed this week. Disjoint by construction — the
    // claimed-and-blocked overlap folds into In progress for the strip only.
    // Tones are the ordinal ramp: the stages are one progression, and the
    // SPA renders a proportional strip whose fills darken along the flow.
    expect(stripOf(pulse)).toEqual([
      { label: "Waiting", n: 3, tone: "ramp-1" },
      { label: "Ready", n: 2, tone: "ramp-2" },
      { label: "In progress", n: 1, tone: "ramp-3" },
      { label: "In review", n: 0, tone: "ramp-4" },
      { label: "Done 7d", n: 1, tone: "ramp-5" },
    ]);
  });

  test("a claimed-and-blocked bead counts once, under in progress", () => {
    const m = fullMeasurement();
    setWip(m, [{ id: "tl-d", title: "Dep blocked", status: "in_progress", priority: 1 }]);
    const segments = stripOf(composePulse(m));
    expect(segments?.find((s) => s.label === "Waiting")?.n).toBe(2);
    expect(segments?.find((s) => s.label === "In progress")?.n).toBe(1);
  });

  test("a run note moves a bead from in progress to in review", () => {
    const m = fullMeasurement();
    m.runInfo = ok({ "tl-a": ok({ prUrl: "https://github.com/acme/demo/pull/9" }) });
    const segments = stripOf(composePulse(m));
    expect(segments?.find((s) => s.label === "In progress")?.n).toBe(0);
    expect(segments?.find((s) => s.label === "In review")?.n).toBe(1);
  });

  test("an unmeasured input hatches ITS segments; the rest keep answering", () => {
    const m = fullMeasurement();
    m.runInfo = { ok: false, error: "bd show tl-a: exit 1" };
    const pulse = composePulse(m);
    expect(() => validBoard(pulse)).not.toThrow();
    const segments = stripOf(pulse);
    // The stage split is unmeasured, so its two segments carry n: null —
    // the host renders the hatched unmeasured slot, never a fabricated 0.
    expect(segments?.find((s) => s.label === "In progress")?.n).toBeNull();
    expect(segments?.find((s) => s.label === "In review")?.n).toBeNull();
    // The independent populations stay measured.
    expect(segments?.find((s) => s.label === "Ready")?.n).toBe(2);
    expect(segments?.find((s) => s.label === "Done 7d")?.n).toBe(1);
    // The hatch says which; the alarm line says why.
    const flat = JSON.stringify(pulse);
    expect(flat).toContain("UNMEASURED");
    expect(flat).toContain("bd show tl-a");
  });

  test("waiting hatches when the claimed-set subtraction is unmeasured", () => {
    const m = fullMeasurement();
    m.inProgress = { ok: false, error: "bd list: exit 1" };
    const segments = stripOf(composePulse(m));
    // blocked is measured, but Waiting = blocked ∖ claimed needs both.
    expect(segments?.find((s) => s.label === "Waiting")?.n).toBeNull();
    expect(segments?.find((s) => s.label === "In progress")?.n).toBeNull();
    // The fixture's ready list is its own measurement, so it stays a number
    // (in the real sweep measure.ts marks ready unmeasured too — that path
    // nulls it via the same `.ok` read).
    expect(segments?.find((s) => s.label === "Ready")?.n).toBe(2);
    expect(segments?.find((s) => s.label === "Done 7d")?.n).toBe(1);
  });

  test("a fully measured strip carries no alarm line", () => {
    const pulse = composePulse(fullMeasurement());
    expect(JSON.stringify(pulse)).not.toContain("UNMEASURED");
  });
});

describe("dams", () => {
  const row = (over: Partial<BdIssue>): BdIssue => ({
    id: "x",
    title: "t",
    status: "open",
    priority: 1,
    ...over,
  });

  test("structural edges never become dams", () => {
    const blocked = [
      // The child names its epic parent AND a real blocker.
      row({ id: "tl-f.1", blocked_by: ["tl-f", "tl-x"], parent: "tl-f" }),
      // An epic standing as a blocker (epics only block epics) drops too.
      row({ id: "tl-q", blocked_by: ["tl-epic"] }),
      // A closed blocker is defensive: bd should not report one.
      row({ id: "tl-z", blocked_by: ["tl-gone"] }),
    ];
    const index = new Map<string, BdIssue>([
      ["tl-f.1", row({ id: "tl-f.1", parent: "tl-f" })],
      ["tl-f", row({ id: "tl-f", issue_type: "epic" })],
      ["tl-epic", row({ id: "tl-epic", issue_type: "epic" })],
      ["tl-x", row({ id: "tl-x" })],
      ["tl-gone", row({ id: "tl-gone", status: "closed" })],
    ]);
    const dams = damGroups(blocked, index, new Set());
    expect(dams.map((d) => d.blockerId)).toEqual(["tl-x"]);
  });

  test("epicGate names the dominant outside blocker; sibling edges are ordering", () => {
    const edges = (pairs: Record<string, string[]>) =>
      new Map<string, readonly string[]>(Object.entries(pairs));
    expect(
      epicGate(["c1", "c2", "c3"], edges({ c1: ["dam"], c2: ["c1"], c3: ["dam"] }), new Set()),
    ).toEqual({ blockerId: "dam", count: 2, all: true });
    // Two different holders → a count, not a flat "gated on" claim.
    expect(epicGate(["c1", "c2"], edges({ c1: ["dam"], c2: ["other"] }), new Set())?.all).toBe(
      false,
    );
    // In-flight work inside the epic disqualifies "gated" — something moves.
    expect(epicGate(["c1", "c2"], edges({ c1: ["dam"] }), new Set(["c2"]))).toEqual({
      blockerId: "dam",
      count: 1,
      all: false,
    });
    // Only sibling edges → internal ordering, no gate to report.
    expect(epicGate(["c1", "c2"], edges({ c2: ["c1"] }), new Set())).toBeUndefined();
  });

  test("dams rank by held count, then declared leverage", () => {
    const blocked = [
      row({ id: "b1", blocked_by: ["big"] }),
      row({ id: "b2", blocked_by: ["big"] }),
      row({ id: "b3", blocked_by: ["lever"] }),
      row({ id: "b4", blocked_by: ["plain"] }),
    ];
    const index = new Map<string, BdIssue>([
      ["big", row({ id: "big" })],
      ["lever", row({ id: "lever", dependent_count: 9 })],
      ["plain", row({ id: "plain" })],
    ]);
    const dams = damGroups(blocked, index, new Set(["lever"]));
    expect(dams.map((d) => d.blockerId)).toEqual(["big", "lever", "plain"]);
    expect(dams[0]?.held.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(dams[1]?.startable).toBe(true);
    expect(dams[2]?.startable).toBe(false);
  });
});
