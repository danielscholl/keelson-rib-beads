import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import type { BdIssue, Measured } from "../src/bd";
import {
  ago,
  assigneeView,
  beadTimeline,
  commonPriority,
  composeBacklog,
  composeInspect,
  composeInspectNeedsBd,
  composeMeasuringPulse,
  composePulse,
  composeRecommend,
  composeShipped,
  composeTrackers,
  composeWip,
  composeYourCalls,
  criteriaItems,
  damGroups,
  declaredDownstream,
  epicGate,
  epicNodes,
  epicViews,
  firstSentence,
  flightStage,
  isHumanCall,
  lifecycleOf,
  lifecycleTone,
  parentIdOf,
  prLabel,
  recommendNext,
  runRows,
  shippedPR,
  shortId,
  shortPerson,
  signalOf,
  stageBar,
  stageChip,
  stageSplit,
  unlockChain,
  unlockLevels,
} from "../src/board";
import { type ProjectMeasurement, parseRunNote, parseRunNotes } from "../src/measure";
import type { LiveRun } from "../src/runs";

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

describe("priority pills", () => {
  test("the priority most of a set shares is common only when it strictly leads", () => {
    expect(commonPriority([{ priority: 1 }, { priority: 1 }, { priority: 2 }])).toBe(1);
    expect(commonPriority([{ priority: 1 }, { priority: 2 }])).toBeUndefined();
    expect(commonPriority([{}, {}, { priority: 1 }])).toBe(2);
    expect(commonPriority([])).toBeUndefined();
  });

  test("P1 shows only where it stands out; P0 always shows", () => {
    const bead = (priority: number): BdIssue => ({ id: "x", title: "x", status: "open", priority });
    expect(signalOf(bead(1), { commonPriority: 1 })).toBeUndefined();
    expect(signalOf(bead(1), { commonPriority: 2 })?.label).toBe("P1");
    expect(signalOf(bead(0), { commonPriority: 0 })?.label).toBe("P0");
  });
});

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
  test("the flow strip says the totals once, measured on the local clock", () => {
    const pulse = composePulse(fullMeasurement());
    expect(() => validBoard(pulse)).not.toThrow();
    const strip = pulse.sections[0];
    if (strip?.kind !== "segments") throw new Error("no strip");
    expect(strip.title).toBeUndefined();
    expect(pulse.header?.chip).toMatch(/^bd 1\.2\.2 · measured \d\d:\d\d$/);
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
    const wip = composeWip(m, {});
    expect(() => validBoard(wip)).not.toThrow();
    expect(JSON.stringify(wip)).toContain("needs bd 1.2+. See the header.");
    expect(JSON.stringify(wip)).not.toContain("could not be measured");
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
    expect(JSON.stringify(pulse)).not.toContain("PR state could not be read");
  });

  test("agent housekeeping is one quiet line, never a card per bead", () => {
    const m = fullMeasurement();
    m.stale = ok([{ id: "tl-s", title: "Quiet", status: "in_progress", priority: 2 }]);
    const flat = JSON.stringify(composePulse(m));
    expect(flat).toContain("Housekeeping: 1 stale claim · 1 epic ready for closeout.");
    m.stale = ok([]);
    m.epics = ok([]);
    expect(JSON.stringify(composePulse(m))).not.toContain("Housekeeping");
  });

  test("a first sweep fills a meter as each read lands", () => {
    const view = composeMeasuringPulse("demo", { done: 4, total: 12, label: "blocked work" });
    expect(() => validBoard(view)).not.toThrow();
    const strip = view.sections[0];
    if (strip?.kind !== "segments") throw new Error("no meter");
    expect(strip.title).toBe("Measuring demo: reading blocked work…");
    expect(strip.items.map((i) => i.n)).toEqual([4, 8]);
    expect(view.header?.chip).toBe("first sweep · 4 of 12");
  });

  test("a refresh over the last good sweep says so on the chip, not in place of the board", () => {
    const pulse = composePulse(fullMeasurement(), { done: 3, total: 12, label: "ready queue" });
    expect(pulse.header?.chip).toContain("refreshing · 3 of 12");
    expect(pulse.header?.chip).not.toContain("measured");
    expect(pulse.sections[0]?.kind).toBe("segments");
  });
});

describe("tracker strip", () => {
  test("one selectable tile per tracker, counts from bd status", () => {
    const view = composeTrackers(
      [
        {
          id: "a",
          name: "alpha",
          summary: ok({
            total_issues: 32,
            open_issues: 18,
            ready_issues: 4,
            blocked_issues: 14,
            in_progress_issues: 3,
            closed_issues: 11,
          }),
        },
        { id: "b", name: "bravo" },
        { id: "c", name: "charlie", summary: { ok: false, error: "exit 1" } },
      ],
      "a",
    );
    expect(() => validBoard(view)).not.toThrow();
    const tiles = view.sections[0];
    if (tiles?.kind !== "cards") throw new Error("no tiles");
    expect(tiles.grid).toBe(true);
    expect(tiles.items.map((t) => t.selected)).toEqual([true, false, false]);
    expect(tiles.items[1]?.action).toEqual({
      type: "select-project",
      payload: { scopeId: "b" },
    });
    expect(tiles.items[0]?.fields).toEqual([
      { value: "4 ready", tone: "accent" },
      { value: "3 in flight" },
      { value: "18 open" },
      { value: "11 closed" },
    ]);
    expect(tiles.items.slice(1).map((t) => t.fields?.[0]?.value)).toEqual([
      "counting…",
      "UNMEASURED",
    ]);
  });

  test("a tracker with nothing ready keeps the count without the accent", () => {
    const view = composeTrackers([
      {
        id: "a",
        name: "alpha",
        summary: ok({
          total_issues: 2,
          open_issues: 2,
          ready_issues: 0,
          blocked_issues: 2,
          in_progress_issues: 0,
          closed_issues: 0,
        }),
      },
    ]);
    const tiles = view.sections[0];
    if (tiles?.kind !== "cards") throw new Error("no tiles");
    expect(tiles.items[0]?.fields?.[0]).toEqual({ value: "0 ready" });
  });

  test("no tracker registered shows how to get one", () => {
    const view = composeTrackers([]);
    expect(() => validBoard(view)).not.toThrow();
    expect(view.sections[0]?.kind).toBe("journey");
    expect(view.header?.status?.label).toBe("no beads tracker registered");
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

  test("with nothing ready it points at the claim whose close frees the most", () => {
    const m = fullMeasurement();
    m.ready = ok([]);
    setWip(m, [
      { id: "tl-a", title: "Frees two", status: "in_progress", priority: 1, assignee: "dan" },
      { id: "tl-z", title: "Frees one", status: "in_progress", priority: 0, assignee: "dan" },
    ]);
    m.blocked = ok([
      { id: "tl-d", title: "Only a", status: "open", priority: 1, blocked_by: ["tl-a"] },
      { id: "tl-e", title: "Also only a", status: "open", priority: 2, blocked_by: ["tl-a"] },
      { id: "tl-h", title: "a and z", status: "open", priority: 2, blocked_by: ["tl-a", "tl-z"] },
      { id: "tl-i", title: "Only z", status: "open", priority: 2, blocked_by: ["tl-z"] },
      { id: "tl-j", title: "Hand blocked", status: "blocked", priority: 2, blocked_by: ["tl-a"] },
    ]);
    const rec = composeRecommend(m, {});
    expect(() => validBoard(rec)).not.toThrow();
    const section = rec.sections[0];
    if (section?.kind !== "rows") throw new Error("no rows");
    expect(section.title).toBe("Nothing is ready · next to unlock");
    expect(section.items.map((r) => r.text)).toEqual([
      "Closing tl-a frees 2 beads: tl-d, tl-e",
      "Then tl-z frees 1 bead: tl-i",
    ]);
    expect(section.items[0]).toMatchObject({
      trailing: "in flight",
      action: { type: "select-bead", payload: { id: "tl-a" } },
    });
    // The claim's card is In flight's; Next up never draws it twice.
    expect(rec.sections.some((x) => x.kind === "cards")).toBe(false);
  });

  test("an epic or parent blocker never counts as the last hold", () => {
    const m = fullMeasurement();
    m.ready = ok([]);
    m.blocked = ok([
      {
        id: "tl-f.2",
        title: "Under the epic",
        status: "open",
        priority: 1,
        parent: "tl-f",
        blocked_by: ["tl-f", "tl-a"],
      },
    ]);
    expect(JSON.stringify(composeRecommend(m, {}))).toContain("frees 1 bead: tl-f.2");
  });

  test("a ready human call keeps pointing at Your calls", () => {
    const m = fullMeasurement();
    m.ready = ok([
      { id: "tl-q", title: "Pick one", status: "open", priority: 1, issue_type: "decision" },
    ]);
    m.blocked = ok([
      { id: "tl-d", title: "Only a", status: "open", priority: 1, blocked_by: ["tl-a"] },
    ]);
    const flat = JSON.stringify(composeRecommend(m, {}));
    expect(flat).toContain("Your calls has it");
    expect(flat).not.toContain("next to unlock");
  });
});

describe("In flight with live runs", () => {
  const claim: BdIssue = {
    id: "tl-a",
    title: "Solution skeleton",
    status: "in_progress",
    priority: 2,
    assignee: "dan@x.dev",
    started_at: "2026-08-09T11:45:00Z",
  };
  const run: LiveRun = {
    runId: "c2ecde81-0000",
    status: "running",
    phase: "build",
    startedAt: "2026-08-09T11:45:00Z",
    readAt: "2026-08-09T12:00:00Z",
    projectId: "p1",
    beadId: "tl-a",
  };

  test("a live run draws its phase meter, names the run, and offers Open run", () => {
    const m = fullMeasurement();
    setWip(m, [claim]);
    const wip = composeWip(m, { runs: [run] });
    expect(() => validBoard(wip)).not.toThrow();
    const cards = wip.sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBe("1 bead-work run");
    const card = cards.items[0];
    expect(card?.fields?.[0]?.value).toBe("tl-a · run c2ec · 15m in run");
    expect(card?.bar).toMatchObject({ label: "build", trailing: "next: review" });
    const bar = card?.bar;
    if (!bar || !("segments" in bar)) throw new Error("no segments");
    expect(bar.segments.map((s) => s.label)).toEqual([
      "brief",
      "plan",
      "approval",
      "build, now",
      "review, not yet",
      "CI, not yet",
    ]);
    expect(card?.actions).toEqual([
      { type: "open-run", label: "Open run", payload: { runId: run.runId } },
    ]);
  });

  test("an open gate reads as waiting on you", () => {
    const m = fullMeasurement();
    setWip(m, [claim]);
    const cards = composeWip(m, { runs: [{ ...run, status: "paused", phase: "approval" }] })
      .sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    const bar = cards.items[0]?.bar;
    if (!bar || !("segments" in bar)) throw new Error("no segments");
    expect(bar.label).toBe("waiting on you");
    expect(bar.segments[2]).toEqual({ label: "approval, now", n: 1, tone: "caution" });
  });

  test("a failed status read falls back to the claim meter and says why on its card", () => {
    const m = fullMeasurement();
    setWip(m, [claim]);
    const cards = composeWip(m, { runs: [{ ...run, error: "server down" }] }).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    const card = cards.items[0];
    expect(JSON.stringify(card)).toContain("UNMEASURED run: server down");
    expect(card?.bar).toMatchObject({ label: "claimed" });
    const view = composeInspect(ok({ ...claim, dependencies: [] }), [], undefined, {
      run: { ...run, error: "server down" },
    });
    expect(JSON.stringify(view)).toContain("UNMEASURED run: server down");
  });

  test("a run still picking its bead is a row, even with nothing claimed", () => {
    const m = fullMeasurement();
    setWip(m, []);
    const picking = { ...run, beadId: undefined, startedAt: "2026-08-09T11:59:40Z" };
    const wip = composeWip(m, { runs: [picking] });
    expect(() => validBoard(wip)).not.toThrow();
    const flat = JSON.stringify(wip);
    expect(flat).toContain("beads-work picking from the ready queue");
    expect(flat).not.toContain("Nothing is claimed");
  });

  test("the inspector says a run holds the bead and opens it", () => {
    const view = composeInspect(ok({ ...claim, dependencies: [] }), [], undefined, { run });
    expect(() => validBoard(view)).not.toThrow();
    const flat = JSON.stringify(view);
    expect(flat).toContain("A beads-work run holds this bead: run c2ec · 15m in run.");
    expect(flat).toContain('"type":"open-run"');
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

  test("a claim under a minute old reads without a doubled ago", () => {
    const now = new Date("2026-08-09T12:00:20Z");
    const fresh = { id: "tl-a", title: "x", status: "in_progress", priority: 2 };
    expect(
      flightStage({ ...fresh, started_at: "2026-08-09T12:00:00Z" }, undefined, undefined, now),
    ).toBe("claimed just now");
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
    expect(cards.items[0]?.fields?.[1]).toEqual({
      label: "waits\u00a0on",
      value: "tl-b · Ready one",
      tone: "caution",
    });
  });

  test("a claim waiting on another claim says the blocker is in flight; its epic never holds it", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "ep.1", title: "First", status: "in_progress", priority: 1, parent: "ep" },
      { id: "ep.4", title: "Second", status: "in_progress", priority: 1, parent: "ep" },
    ]);
    m.blocked = ok([
      {
        id: "ep.4",
        title: "Second",
        status: "in_progress",
        priority: 1,
        blocked_by: ["ep", "ep.1"],
      },
      { id: "ep.1", title: "First", status: "in_progress", priority: 1, blocked_by: ["ep"] },
    ]);
    m.backlog = ok([
      { id: "ep", title: "Epic", status: "open", priority: 1, issue_type: "epic" },
      { id: "ep.1", title: "First", status: "in_progress", priority: 1, parent: "ep" },
      { id: "ep.4", title: "Second", status: "in_progress", priority: 1, parent: "ep" },
    ]);
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    const byTitle = new Map(cards.items.map((c) => [c.title, c]));
    expect(byTitle.get("First")?.fields?.some((f) => f.label === "waits\u00a0on")).toBe(false);
    // Both claims are P1, so a P1 pill would say nothing.
    expect(byTitle.get("First")?.pill).toBeUndefined();
    expect(byTitle.get("Second")?.fields?.find((f) => f.label === "waits\u00a0on")?.value).toBe(
      ".1 · First (in flight)",
    );
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

describe("run history", () => {
  const notes = [
    "bead-work plan: approved — ok",
    "bead-work run: PR none — cancelled — run run-41d0a; cancelled; ended 2026-09-29T10:00:00Z; claim released",
    "bead-work run: PR https://github.com/acme/demo/pull/12 — failed — PR opened but CI was not green (run 7a1f2b3c-0000)",
    "bead-work run: PR https://github.com/acme/demo/pull/14 — success — draft PR reviewed and CI green (run unknown)",
  ].join("\n");

  test("every run a bead's notes name, newest first, each opening its run", () => {
    expect(parseRunNotes(notes).map((r) => r.runId)).toEqual([
      "run-41d0a",
      "7a1f2b3c-0000",
      undefined,
    ]);
    expect(parseRunNote(notes)?.note).toBe("draft PR reviewed and CI green");
    const rows = runRows(notes);
    expect(rows.map((r) => r.text)).toEqual(["failed · PR demo#12", "cancelled · no PR"]);
    expect(rows[0]).toMatchObject({
      glyph: "error",
      trailing: "run 7a1f ›",
      action: { type: "open-run", payload: { runId: "7a1f2b3c-0000" } },
    });
  });

  test("a run id comes from the note's marker, never from prose", () => {
    const line = (tail: string) => `bead-work run: PR none — failed — ${tail}`;
    expect(parseRunNote(line("CI run 12345678 failed (run c2ecde81-0000)"))?.runId).toBe(
      "c2ecde81-0000",
    );
    expect(parseRunNote(line("re-run 2nd-attempt failed"))?.runId).toBeUndefined();
    expect(parseRunNote(line("flaky (run tests again)"))?.note).toBe("flaky (run tests again)");
  });

  test("a run with two notes is one row, read from the newest", () => {
    const twice = [
      "bead-work run: PR https://github.com/acme/demo/pull/9 — success — green (run aa11bb22-0000)",
      "bead-work run: PR https://github.com/acme/demo/pull/9 — cancelled — run aa11bb22-0000; cancelled; ended x; claim retained",
    ].join("\n");
    expect(runRows(twice).map((r) => r.text)).toEqual(["cancelled · PR demo#9"]);
  });

  test("the inspector lists earlier runs under the live one without repeating it", () => {
    const bead = {
      id: "tl-a",
      title: "x",
      status: "in_progress",
      priority: 2,
      dependencies: [],
      notes: `${notes}\nbead-work run: PR none — failed — retry (run 99aa0000-0000)`,
    };
    const live: LiveRun = {
      runId: "99aa0000-0000",
      status: "running",
      phase: "build",
      startedAt: "2026-08-09T11:45:00Z",
      readAt: "2026-08-09T12:00:00Z",
      beadId: "tl-a",
    };
    const view = composeInspect(ok(bead), [], undefined, { run: live });
    expect(() => validBoard(view)).not.toThrow();
    const flat = JSON.stringify(view);
    expect(flat).toContain('"title":"Earlier runs"');
    expect(flat).not.toContain("run 99aa ›");
    expect(JSON.stringify(composeInspect(ok(bead), []))).toContain('"title":"Runs"');
    expect(JSON.stringify(composeInspect(ok({ ...bead, notes: "" }), []))).not.toContain(
      '"title":"Runs"',
    );
  });
});

describe("plan gates", () => {
  const gate: LiveRun = {
    runId: "a1b2c3d4-0000",
    status: "paused",
    phase: "approval",
    startedAt: "2026-08-09T11:30:00Z",
    readAt: "2026-08-09T12:00:00Z",
    projectId: "p1",
    beadId: "tl-a",
    gate: {
      since: "2026-08-09T11:54:00Z",
      tasks: 7,
      summary: "Six projects under one solution. Scaffolding only.",
    },
  };
  const withBead = (): ProjectMeasurement => {
    const m = fullMeasurement();
    if (m.backlog.ok) {
      m.backlog.data.push({
        id: "tl-a",
        title: "Solution skeleton",
        status: "in_progress",
        priority: 2,
      });
    }
    return m;
  };

  test("an open gate leads In flight and carries the call", () => {
    const m = withBead();
    const other: BdIssue = {
      id: "tl-0",
      title: "Higher priority claim",
      status: "in_progress",
      priority: 0,
    };
    setWip(m, [
      other,
      { id: "tl-a", title: "Solution skeleton", status: "in_progress", priority: 2 },
    ]);
    const view = composeWip(m, { runs: [gate] });
    expect(() => validBoard(view)).not.toThrow();
    const cards = view.sections.find((x) => x.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBe("1 bead-work run · 1 waiting on you · 1 other claim");
    const card = cards.items[0];
    expect(card?.title).toBe("Solution skeleton");
    expect(card?.edge).toBe("caution");
    expect(card?.pill).toEqual({ label: "plan gate", tone: "caution" });
    expect(card?.reason).toEqual({
      label: "plan",
      text: "7 tasks · Six projects under one solution.",
    });
    expect(card?.actions).toEqual([
      { type: "open-run", label: "Review plan", tone: "brand", payload: { runId: gate.runId } },
    ]);
    expect(card?.bar).toMatchObject({ label: "waiting on you · 6m" });
    expect(cards.items[1]?.title).toBe("Higher priority claim");
    expect(cards.items[1]?.edge).toBeUndefined();
  });

  test("Your calls never repeats a gate, and hides with no person's call", () => {
    const m = withBead();
    expect(JSON.stringify(composeYourCalls(m, { runs: [gate] }))).not.toContain("plan gate");
    if (m.backlog.ok) m.backlog.data = m.backlog.data.filter((i) => !isHumanCall(i));
    expect(composeYourCalls(m, { runs: [gate] }).sections).toHaveLength(0);
  });

  test("a gate whose last read failed is not offered as waiting", () => {
    const m = withBead();
    setWip(m, [{ id: "tl-a", title: "Solution skeleton", status: "in_progress", priority: 2 }]);
    const flat = JSON.stringify(composeWip(m, { runs: [{ ...gate, error: "down" }] }));
    expect(flat).not.toContain("Review plan");
    expect(flat).not.toContain("plan gate");
  });

  test("a gate stays offered when the in-flight read failed", () => {
    const m = withBead();
    m.inProgress = { ok: false, error: "bd list: timeout" };
    const view = composeWip(m, { runs: [gate] });
    expect(() => validBoard(view)).not.toThrow();
    const flat = JSON.stringify(view);
    expect(flat).toContain("1 run waiting on you");
    expect(flat).toContain("Review plan");
    expect(flat).toContain("bd list: timeout");
  });

  test("a gate whose bead bd does not show as claimed still gets its card", () => {
    const m = withBead();
    setWip(m, []);
    const cards = composeWip(m, { runs: [gate] }).sections.find((x) => x.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.items[0]?.title).toBe("Solution skeleton");
    expect(cards.items[0]?.action).toEqual({ type: "open-run", payload: { runId: gate.runId } });
    expect(JSON.stringify(composeWip(m, { runs: [gate] }))).not.toContain("Nothing is claimed");
  });

  test("claimed and unclaimed gates share one oldest-first order", () => {
    const m = withBead();
    setWip(m, [
      { id: "tl-0", title: "Plain claim", status: "in_progress", priority: 0 },
      { id: "tl-a", title: "Solution skeleton", status: "in_progress", priority: 2 },
    ]);
    const stray: LiveRun = {
      ...gate,
      runId: "e5f6a7b8-0000",
      beadId: "tl-x",
      gate: { since: "2026-08-09T11:58:00Z" },
    };
    const view = composeWip(m, { runs: [stray, gate] });
    expect(() => validBoard(view)).not.toThrow();
    const cards = view.sections.filter((x) => x.kind === "cards");
    expect(cards).toHaveLength(1);
    const only = cards[0];
    if (only?.kind !== "cards") throw new Error("no cards");
    expect(only.title).toBe("1 bead-work run · 2 waiting on you · 1 other claim");
    expect(only.items.map((c) => c.title)).toEqual(["Solution skeleton", "tl-x", "Plain claim"]);
  });

  test("a gated bead that is also a person's call shows only in In flight", () => {
    const m = withBead();
    if (m.backlog.ok) {
      m.backlog.data = m.backlog.data.map((i) =>
        i.id === "tl-a" ? { ...i, issue_type: "decision" } : i,
      );
    }
    expect(JSON.stringify(composeYourCalls(m, { runs: [gate] }))).not.toContain('"tl-a');
  });

  test("the Overview carries one line for open gates", () => {
    const m = withBead();
    const one = composePulse(m, undefined, [gate]);
    expect(() => validBoard(one)).not.toThrow();
    const flat = JSON.stringify(one);
    expect(flat).toContain("A beads-work run waits on your approval for tl-a, 6m.");
    expect(flat).toContain('"type":"open-run"');
    const two = JSON.stringify(
      composePulse(m, undefined, [gate, { ...gate, runId: "b2", beadId: "tl-b" }]),
    );
    expect(two).toContain("2 beads-work runs wait on your approval. In flight lists them");
    expect(JSON.stringify(composePulse(m))).not.toContain("waits on your approval");
  });

  test("a tracker tile names its live runs and gates, and nothing when quiet", () => {
    const summary = ok({
      total_issues: 3,
      open_issues: 2,
      ready_issues: 1,
      blocked_issues: 0,
      in_progress_issues: 1,
      closed_issues: 1,
    });
    const running: LiveRun = { ...gate, runId: "r2", status: "running", phase: "build" };
    const view = composeTrackers(
      [{ id: "p1", name: "demo", summary, runs: [gate, running] }],
      "p1",
    );
    expect(() => validBoard(view)).not.toThrow();
    expect(JSON.stringify(view)).toContain("2 runs · 1 waiting on you");
    const quiet = JSON.stringify(composeTrackers([{ id: "p1", name: "demo", summary }], "p1"));
    expect(quiet).not.toContain("run");
  });
});

describe("Your calls", () => {
  function withCalls(): ProjectMeasurement {
    const m = fullMeasurement();
    if (!m.backlog.ok) throw new Error("fixture not measured");
    m.backlog = ok([
      ...m.backlog.data,
      {
        id: "tl-o",
        title: "Owner: pick the GitHub home",
        status: "open",
        priority: 0,
        labels: ["owner"],
      },
      {
        id: "tl-q",
        title: "Which identity CI uses",
        status: "open",
        priority: 1,
        issue_type: "decision",
      },
      { id: "tl-l", title: "Owner: low stakes", status: "open", priority: 2, labels: ["human"] },
    ]);
    m.blocked = ok([
      { id: "tl-x", title: "Waits on owner", status: "open", priority: 2, blocked_by: ["tl-q"] },
      { id: "tl-y", title: "Waits on x", status: "open", priority: 2, blocked_by: ["tl-x"] },
    ]);
    return m;
  }

  test("a decision type or an owner or human label is a person's call", () => {
    expect(isHumanCall({ issue_type: "decision" })).toBe(true);
    expect(isHumanCall({ labels: ["factory", "owner"] })).toBe(true);
    expect(isHumanCall({ labels: ["human"] })).toBe(true);
    expect(isHumanCall({ issue_type: "task", labels: ["factory"] })).toBe(false);
  });

  test("no call waiting hides the panel instead of listing zeros", () => {
    const view = composeYourCalls(fullMeasurement(), {});
    expect(view.sections).toHaveLength(0);
  });

  test("calls rank by the work waiting on them and say what they unblock", () => {
    const view = composeYourCalls(withCalls(), { selectedId: "tl-o" });
    expect(() => validBoard(view)).not.toThrow();
    const cards = view.sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBe("3 calls · 2 beads wait on them");
    // tl-x waits on two calls and still counts once.
    const both = withCalls();
    both.blocked = ok([
      {
        id: "tl-x",
        title: "Waits on two",
        status: "open",
        priority: 2,
        blocked_by: ["tl-q", "tl-o"],
      },
    ]);
    const shared = composeYourCalls(both, {}).sections[0];
    if (shared?.kind !== "cards") throw new Error("no cards");
    expect(shared.title).toBe("3 calls · 1 bead wait on them");
    expect(cards.items.map((c) => c.fields?.[0]?.value)).toEqual([
      "tl-q · decision · P1",
      "tl-o · owner call · P0",
      "tl-l · owner call · P2",
    ]);
    expect(cards.items[0]?.pill).toEqual({ label: "holds 2", tone: "warn" });
    expect(cards.items[0]?.reason).toEqual({
      label: "unblocks",
      text: "tl-x → 1 more behind them",
    });
    expect(cards.items[1]?.reason?.text).toBe("nothing waits on it");
    expect(cards.items[1]?.selected).toBe(true);
    expect(JSON.stringify(view)).not.toContain("claim-bead");
  });

  test("a call someone already took says who", () => {
    const m = withCalls();
    if (!m.backlog.ok) throw new Error("fixture not measured");
    m.backlog = ok(
      m.backlog.data.map((i) =>
        i.id === "tl-o" ? { ...i, status: "in_progress", assignee: "dan@x.dev" } : i,
      ),
    );
    expect(JSON.stringify(composeYourCalls(m, {}))).toContain(
      "tl-o · owner call · P0 · on it: dan",
    );
  });

  test("an unmeasured backlog alarms; unmeasured edges alarm above the calls", () => {
    const m = withCalls();
    m.blocked = { ok: false, error: "bd blocked: exit 1" };
    const flat = JSON.stringify(composeYourCalls(m, {}));
    expect(flat).toContain("What each call holds could not be measured");
    expect(flat).toContain("tl-q");
    m.backlog = { ok: false, error: "bd list: exit 1" };
    expect(JSON.stringify(composeYourCalls(m, {}))).toContain("UNMEASURED");
  });

  test("Next up never picks a call, and says so when only calls are ready", () => {
    const m = withCalls();
    m.ready = ok([
      {
        id: "tl-o",
        title: "Owner: pick",
        status: "open",
        priority: 0,
        labels: ["owner"],
        dependent_count: 9,
      },
      { id: "tl-c", title: "Ready two", status: "open", priority: 2 },
    ]);
    expect(JSON.stringify(composeRecommend(m, {}))).toContain('"id":"tl-c"');
    m.ready = ok([
      { id: "tl-o", title: "Owner: pick", status: "open", priority: 0, labels: ["owner"] },
    ]);
    const flat = JSON.stringify(composeRecommend(m, {}));
    expect(flat).toContain("Nothing ready is agent work. 1 ready bead is a call for you");
    expect(flat).not.toContain("claim-bead");
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

  test("the view sorts members into waves and lanes, the pick marked", () => {
    const [view] = epicViews(epicBoard());
    if (!view) throw new Error("no epic view");
    expect(view.done.map((c) => c.id)).toEqual(["cx.1", "cx.2"]);
    expect(view.nodes.map((n) => [n.member.id, n.wave, n.lane])).toEqual([
      ["cx.3", 0, "working"],
      ["cx.4", 0, "ready"],
      ["cx.5", 1, "waiting"],
    ]);
    expect(view.nodes.find((n) => n.member.id === "cx.4")?.pick).toBe(true);
    expect(view.nodes.find((n) => n.member.id === "cx.5")?.deps).toEqual(["cx.4"]);
    expect(view.counts).toEqual({ review: 0, working: 1, ready: 1, waiting: 1 });
  });

  test("a wave is one more than the deepest open blocker; a cycle terminates", () => {
    const members = ["a", "b", "c", "d"].map((id) => ({ id, title: id, status: "open" }));
    const lanes = { readyIds: new Set(["a"]), reviewIds: new Set<string>() };
    const chain = new Map<string, readonly string[]>([
      ["c", ["b", "a"]],
      ["b", ["a"]],
      ["d", ["outside-1"]],
    ]);
    const nodes = epicNodes("e", members, chain, lanes);
    expect(nodes.map((n) => [n.member.id, n.wave])).toEqual([
      ["a", 0],
      ["b", 1],
      ["d", 1],
      ["c", 2],
    ]);
    // An outside blocker has no column to sit in, so the bead names it.
    expect(nodes.find((n) => n.member.id === "d")?.external).toEqual(["outside-1"]);
    const cycle = new Map<string, readonly string[]>([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(() => epicNodes("e", members.slice(0, 2), cycle, lanes)).not.toThrow();
  });

  test("a closed blocker and the epic edge never hold a member back", () => {
    const members = [
      { id: "e.1", title: "one", status: "closed" },
      { id: "e.2", title: "two", status: "open" },
      { id: "e.3", title: "three", status: "blocked" },
    ];
    const edges = new Map<string, readonly string[]>([["e.2", ["e", "e.1"]]]);
    const nodes = epicNodes("e", members, edges, {
      readyIds: new Set(["e.2"]),
      reviewIds: new Set<string>(),
    });
    expect(nodes.map((n) => [n.member.id, n.wave, n.lane, n.handPaused])).toEqual([
      ["e.2", 0, "ready", false],
      ["e.3", 0, "waiting", true],
    ]);
  });

  test("no open epic yields no views", () => {
    const m = fullMeasurement();
    m.epics = ok([]);
    expect(epicViews(m)).toEqual([]);
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

  test("an empty backlog hides the panel", () => {
    const m = fullMeasurement();
    m.backlog = ok([]);
    expect(composeBacklog(m, {}).sections).toHaveLength(0);
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
    if (today?.kind !== "rows") throw new Error("no day group");
    expect(today.title).toBe("Today");
    expect(today.items[0]).toEqual({
      glyph: "ok",
      text: "Done",
      trailing: "tl-g · demo#11 · 10:15Z",
      action: { type: "select-bead", payload: { id: "tl-g" } },
      selected: false,
    });
    expect(JSON.stringify(view)).not.toContain("detail route");
    const older = view.sections[2];
    if (older?.kind !== "rows") throw new Error("no older group");
    expect(older.title).toBe("Jul 30");
    expect(older.items[0]?.trailing).toBe("tl-old · 10:00Z");
  });

  test("a closed epic carries an epic chip", () => {
    const m = fullMeasurement();
    m.closedFortnight = ok([
      {
        id: "tl-f",
        title: "S1",
        status: "closed",
        priority: 1,
        issue_type: "epic",
        closed_at: "2026-08-09T10:00:00Z",
      },
    ]);
    const day = composeShipped(m, {}).sections[1];
    if (day?.kind !== "rows") throw new Error("no day group");
    expect(day.items[0]?.chip).toEqual({ label: "epic" });
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

  test("a quiet fortnight is one line with the week's creates; failed closes alarm", () => {
    const m = fullMeasurement();
    m.closedFortnight = ok([]);
    const view = composeShipped(m, {});
    expect(() => validBoard(view)).not.toThrow();
    expect(view.sections).toHaveLength(1);
    expect(JSON.stringify(view)).toContain(
      "Nothing closed in the last 14 days. 0 created this week.",
    );
    m.backlog = { ok: false, error: "bd list: exit 1" };
    expect(JSON.stringify(composeShipped(m, {}))).toContain("Created this week is unmeasured");
    m.backlog = fullMeasurement().backlog;
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
    expect(flat).toContain('{"label":"epic","value":"cx · Cosmos v1"}');
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
    expect(flat).not.toContain("Start this bead");
    expect(flat).toContain("Start tl-b instead");
    const alone = JSON.stringify(composeInspect(ok(bead()), [{ ...bead(), blocked_by: ["cx.2"] }]));
    expect(alone).not.toContain("claim-bead");
  });

  test("the bead leads with its title and prints its id once", () => {
    const view = composeInspect(ok(bead({ labels: ["ui"] })), []);
    expect(view.header).toBeUndefined();
    const left = view.sections[0]?.kind === "columns" ? view.sections[0].columns[0] : undefined;
    const head = left?.sections[0];
    if (head?.kind !== "cards") throw new Error("no head card");
    expect(head.items[0]?.title).toBe("Detail view");
    expect(head.items[0]?.fields?.[0]?.value).toBe("cx.4 · ○ open · P2 · unassigned");
    expect(head.items[0]?.fields?.[1]).toEqual({ label: "labels", value: "ui" });
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

  test("the header names merges to reconcile once, with the scoped confirmed action", () => {
    const pulse = composePulse(mergedBoard());
    expect(() => validBoard(pulse)).not.toThrow();
    expect(JSON.stringify(pulse)).toContain(
      "3 beads merged on GitHub and still open in bd: tl-b, tl-a, tl-f.2.",
    );
    const actions = pulse.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no reconcile action");
    expect(actions.items[0]?.type).toBe("sync-merged-beads");
    expect(actions.items[0]?.payload).toEqual({ projectId: "p1" });
    expect(actions.items[0]?.confirm).toBeDefined();
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
    const flat = JSON.stringify(composePulse(m));
    expect(flat).toContain("1 bead merged on GitHub and still open in bd: tl-a.");
    expect(flat).toContain("PR state could not be read for 1 bead");
    expect(flat).toContain("gh rate limit");
    expect(flat).toContain("bd blocked failed");
  });

  test("note wording cannot move an unmerged PR into close pending", () => {
    const m = mergedBoard();
    m.runInfo = ok({ "tl-a": ok({ prUrl: url(1), outcome: "merged" }) });
    m.prInfo = ok({ "tl-a": ok({ url: url(1), state: "OPEN", mergedAt: null }) });
    const flat = JSON.stringify(composePulse(m));
    expect(flat).not.toContain("merged on GitHub");
    expect(JSON.stringify(composeWip(m, {}))).toContain("PR open");
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
    // One tone per lane, the same tones the bead dots and the epic map use,
    // so a segment can be told apart without reading the legend.
    // An empty lane (In review here) is left out of the strip.
    expect(stripOf(pulse)).toEqual([
      { label: "Waiting", n: 3, tone: "neutral" },
      { label: "Ready", n: 2, tone: "accent" },
      { label: "In progress", n: 1, tone: "info" },
      { label: "Done 7d", n: 1, tone: "ok" },
    ]);
  });

  test("an all-empty tracker keeps every lane", () => {
    const m = fullMeasurement();
    m.blocked = ok([]);
    m.ready = ok([]);
    setWip(m, []);
    m.recentlyClosed = ok([]);
    expect(stripOf(composePulse(m))?.map((s) => s.n)).toEqual([0, 0, 0, 0, 0]);
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
    expect(segments?.find((s) => s.label === "In progress")).toBeUndefined();
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
    const dams = damGroups(blocked, index);
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
    const dams = damGroups(blocked, index);
    expect(dams.map((d) => d.blockerId)).toEqual(["big", "lever", "plain"]);
    expect(dams[0]?.held.map((b) => b.id)).toEqual(["b1", "b2"]);
  });
});

describe("ids and stages said once", () => {
  test("a sibling prints short beside a bead that shows the shared prefix", () => {
    expect(shortId("keelson-d2u.6", "keelson-d2u")).toBe(".6");
    expect(shortId("other-9", "keelson-d2u")).toBe("other-9");
    expect(shortId("keelson-d2u.6", undefined)).toBe("keelson-d2u.6");
    // A dot inside a prefix is not a parent boundary.
    expect(parentIdOf("my.app-12")).toBeUndefined();
    expect(parentIdOf("keelson-d2u.6")).toBe("keelson-d2u");
    const m = fullMeasurement();
    m.ready = ok([
      { id: "ep.5", title: "Pick", status: "open", priority: 1, dependent_count: 2 },
      { id: "ep.4", title: "Runner", status: "open", priority: 2 },
    ]);
    m.blocked = ok([
      { id: "ep.6", title: "Waits", status: "open", priority: 2, blocked_by: ["ep.5"] },
      { id: "far-1", title: "Elsewhere", status: "open", priority: 2, blocked_by: ["ep.6"] },
    ]);
    const card = composeRecommend(m, {}).sections[0];
    if (card?.kind !== "cards") throw new Error("no pick");
    // The meta line keeps the id as bd prints it; only its siblings shorten.
    expect(card.items[0]?.fields?.[0]?.value).toContain("ep.5");
    expect(card.items[0]?.fields?.find((f) => f.label === "unlocks")?.value).toBe(".6 → far-1");
    expect(card.items[0]?.footnote).toBe("runner-up: .4 · Runner");
  });

  test("a claim carries a three-stop stage meter and what closing it releases", () => {
    const pr = { url: "https://github.com/acme/demo/pull/7", state: "OPEN" as const };
    expect(stageBar(undefined, undefined)).toMatchObject({
      label: "claimed",
      trailing: "next: PR open",
    });
    const open = stageBar({ prUrl: pr.url } as never, pr as never);
    expect(open).toMatchObject({ label: "PR open", trailing: "next: merged" });
    const merged = { ...pr, state: "MERGED" as const, mergedAt: "2026-08-05T10:00:00Z" };
    expect(stageBar({ prUrl: pr.url } as never, merged as never)).toMatchObject({
      label: "merged",
      trailing: "next: close",
    });
    if (!("segments" in open)) throw new Error("no segments");
    expect(open.segments.map((s) => [s.label, s.tone])).toEqual([
      ["claimed", "info"],
      ["PR open", "info"],
      ["merged, not yet", "neutral"],
    ]);
    const m = fullMeasurement();
    m.blocked = ok([
      { id: "tl-z", title: "After", status: "open", priority: 2, blocked_by: ["tl-a"] },
    ]);
    const wip = composeWip(m, {});
    expect(() => validBoard(wip)).not.toThrow();
    const cards = wip.sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.items[0]?.bar).toEqual(stageBar(undefined, undefined));
    expect(cards.items[0]?.fields?.find((f) => f.label === "releases")?.value).toBe("tl-z");
  });

  test("acceptance criteria list one row per criterion", () => {
    const texts = (raw: string) => criteriaItems(raw).map((c) => c.text);
    expect(texts("1. First thing. 2. Second thing. 3. Third.")).toEqual([
      "First thing.",
      "Second thing.",
      "Third.",
    ]);
    // Only the next number in sequence starts an item, so numbers inside a
    // sentence stay in it.
    expect(texts("1. Returns at most 10. Otherwise errors 2. Ship by 2025. Then announce")).toEqual(
      ["Returns at most 10. Otherwise errors", "Ship by 2025. Then announce"],
    );
    expect(texts("1. Requires bd 1. 2 or newer")).toEqual(["Requires bd 1. 2 or newer"]);
    expect(criteriaItems("- [ ] Alpha\n- [x] Beta\n\n* Gamma")).toEqual([
      { text: "Alpha", checked: false },
      { text: "Beta", checked: true },
      { text: "Gamma", checked: false },
    ]);
    // Prose that merely mentions a number stays whole.
    expect(texts("It handles step 2. Then it stops.")).toEqual([
      "It handles step 2. Then it stops.",
    ]);
    expect(criteriaItems("")).toEqual([]);
  });

  test("the inspector's linked beads open in the same drawer", () => {
    const view = composeInspect(
      ok({
        id: "ep.6",
        title: "Waits",
        status: "open",
        priority: 2,
        acceptance_criteria: "1. One. 2. Two.",
        dependencies: [{ id: "ep.5", title: "Pick", status: "open", dependency_type: "blocks" }],
        dependents: [{ id: "ep.9", title: "Later", status: "open", dependency_type: "blocks" }],
      }),
      [],
    );
    expect(() => validBoard(view)).not.toThrow();
    const flat = JSON.stringify(view);
    expect(flat).toContain(
      '"text":"ep.5 · Pick","trailing":"›","action":{"type":"select-bead","payload":{"id":"ep.5"}}',
    );
    expect(flat).toContain(
      '"text":"ep.9 · Later","trailing":"›","action":{"type":"select-bead","payload":{"id":"ep.9"}}',
    );
    expect(flat).toContain('{"icon":"•","text":"One."}');
  });
});
