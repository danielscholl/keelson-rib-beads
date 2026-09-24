import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import type { BdIssue, Measured } from "../src/bd";
import {
  assigneeView,
  composeAttention,
  composeInspect,
  composeMomentum,
  composeNoTrackerPulse,
  composePlan,
  composePortfolio,
  composePulse,
  composeRecommend,
  composeWip,
  damGroups,
  decisionRail,
  declaredDownstream,
  epicGate,
  fallbackSelectedId,
  lifecycleChip,
  lifecycleOf,
  lifecycleTone,
  priorityTone,
  prLabel,
  recommendNext,
  stageChip,
  stageSplit,
  statusGlyph,
  unlockChain,
  unlockLevels,
} from "../src/board";
import { type ProjectMeasurement, parseRunNote } from "../src/measure";

const project = { id: "p1", name: "demo", rootPath: "/tmp/demo" };

function ok<T>(data: T): Measured<T> {
  return { ok: true, data };
}

const validBoard = expectView("rib:beads:test", "board");

// The fixture's summary, narrowed — tests tweak one field of it to prove the
// pulse reads its measured arrays rather than these numbers.
function summaryOf(m: ProjectMeasurement) {
  if (!m.summary.ok) throw new Error("fixture summary is unmeasured");
  return m.summary.data;
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
    runInfo: ok({ "tl-a": ok(undefined) }),
  };
}

// Override the in-progress set AND its per-bead run envelopes together — a
// bead without an envelope alarms on its card, which is correct in production
// and noise in a test about something else.
function setWip(m: ProjectMeasurement, items: BdIssue[]): void {
  m.inProgress = ok(items);
  m.runInfo = ok(Object.fromEntries(items.map((i) => [i.id, ok(undefined)])));
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

describe("lifecycle and the decision rail", () => {
  const issue = (over: Partial<BdIssue> = {}): BdIssue => ({
    id: "x",
    title: "t",
    status: "open",
    priority: 1,
    ...over,
  });

  test("blocked is a condition, so it never becomes a lifecycle value", () => {
    expect(lifecycleOf(issue({ status: "blocked" }))).toBe("open");
    expect(lifecycleOf(issue({ status: "in_progress" }))).toBe("in_progress");
    expect(lifecycleOf(issue({ status: "deferred" }))).toBe("deferred");
  });

  test("alarm belongs to the condition, never to a lifecycle tone", () => {
    expect(lifecycleTone("open", true)).toBe("accent");
    expect(lifecycleTone("open", false)).toBeUndefined();
    expect(lifecycleTone("in_progress", false)).toBe("ok");
    // No lifecycle value may claim `error` — that tone is the rail's.
    for (const l of ["open", "in_progress", "deferred", "closed"] as const) {
      expect(lifecycleTone(l, false)).not.toBe("error");
    }
  });

  test("every non-default lifecycle carries a word, so none rests on colour", () => {
    expect(lifecycleChip("open")).toBeUndefined();
    expect(lifecycleChip("in_progress")).toBe("in progress");
    expect(lifecycleChip("deferred")).toBe("on hold");
  });

  test("the rail is empty for an unexceptional bead", () => {
    expect(decisionRail(issue(), { downstream: 0 })).toEqual([]);
  });

  test("the rail keeps one fixed order so the eye learns one scan path", () => {
    expect(
      decisionRail(issue({ issue_type: "bug" }), { waitingOn: ["a", "b"], downstream: 3 }),
    ).toEqual(["bug", "waiting on a, b", "3 downstream"]);
  });

  test("a hand-paused bead is distinguished from a dependency-blocked one", () => {
    expect(decisionRail(issue(), { handPaused: true })).toEqual(["paused by hand"]);
    // A real blocker wins — "paused by hand" means precisely "no edge".
    expect(decisionRail(issue(), { waitingOn: ["a"], handPaused: true })).toEqual(["waiting on a"]);
  });

  test("the type chip reads the typed field, never a label", () => {
    expect(decisionRail(issue({ issue_type: "bug" }))).toContain("bug");
    // Beads exist that carry a `bug` label while typed a task — the label is
    // the looser claim and must not drive the chip.
    expect(decisionRail(issue({ issue_type: "task", labels: ["bug"] }))).toEqual([]);
  });

  test("declared downstream reads through the backlog when the row lacks it", () => {
    // `bd blocked` rows carry no dependent_count at all.
    const index = new Map([["x", issue({ dependent_count: 4 })]]);
    expect(declaredDownstream(issue(), index)).toBe(4);
    expect(declaredDownstream(issue({ dependent_count: 1 }), index)).toBe(1);
    expect(declaredDownstream(issue({ id: "unknown" }), index)).toBe(0);
  });

  test("assigneeView picks a shape per the data, not per today's tracker", () => {
    expect(assigneeView([issue({ assignee: "dan" }), issue({ owner: "dan" })])).toEqual({
      sharedTitle: "All claimed by dan",
      perItem: false,
      markUnassigned: false,
    });
    expect(assigneeView([issue(), issue()])).toEqual({ perItem: false, markUnassigned: false });
    expect(assigneeView([issue({ assignee: "dan" }), issue()])).toEqual({
      perItem: true,
      markUnassigned: true,
    });
    expect(assigneeView([issue({ assignee: "dan" }), issue({ assignee: "sam" })])).toEqual({
      perItem: true,
      markUnassigned: true,
    });
  });
});

describe("panel composers", () => {
  test("pulse is the strip alone — the stat tiles are retired", () => {
    const pulse = composePulse(fullMeasurement());
    expect(() => validBoard(pulse)).not.toThrow();
    expect(pulse.header?.chip).toContain("6 open");
    // The tiles each restated a strip population; with per-segment
    // unmeasured (n: null) the strip carries its own fail-closed reading and
    // nothing repeats the fact.
    expect(pulse.sections.some((s) => s.kind === "stats")).toBe(false);
  });

  test("the strip counts measured populations, never bd's summary fields", () => {
    const m = fullMeasurement();
    // bd's own summary counts a different population: ready_issues includes
    // epics and does not subtract in-progress. Substituting it here would
    // answer a different question than the label asks.
    m.summary = ok({ ...summaryOf(m), ready_issues: 4711, in_progress_issues: 9 });
    const pulse = composePulse(m);
    const strip = pulse.sections[0];
    if (strip?.kind !== "segments") throw new Error("no strip");
    expect(strip.items.find((s) => s.label === "Ready")?.n).toBe(2);
    expect(strip.items.find((s) => s.label === "In progress")?.n).toBe(1);
    expect(JSON.stringify(pulse.sections)).not.toContain("4711");
  });

  test("the strip caption names its population and the exclusions", () => {
    const pulse = composePulse(fullMeasurement());
    const strip = pulse.sections[0];
    if (strip?.kind !== "segments") throw new Error("no strip");
    // 3+2+1+0+1 across the five stages; one epic (structure, not work) and
    // one deferred bead sit outside the strip — the caption reconciles the
    // strip against the header's differently-scoped open count.
    expect(strip.title).toBe("Flow — 7 work items · 1 epic excluded · 1 deferred not shown");
  });

  test("a partially measured strip claims no total", () => {
    const m = fullMeasurement();
    m.runInfo = { ok: false, error: "bd show tl-a: exit 1" };
    const strip = composePulse(m).sections[0];
    if (strip?.kind !== "segments") throw new Error("no strip");
    expect(strip.title).toBeUndefined();
  });

  test("a deep unlock chain compresses past the first hop", () => {
    const m = fullMeasurement();
    m.ready = ok([{ id: "tl-b", title: "Ready one", status: "open", priority: 0 }]);
    m.blocked = ok([
      { id: "tl-c1", title: "First hop A", status: "open", priority: 1, blocked_by: ["tl-b"] },
      { id: "tl-c2", title: "First hop B", status: "open", priority: 1, blocked_by: ["tl-b"] },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `tl-d${i}`,
        title: `Deep ${i}`,
        status: "open",
        priority: 2,
        blocked_by: ["tl-c1"],
      })),
    ]);
    const flat = JSON.stringify(composeRecommend(m, {}));
    // First hop verbatim (it audits "releases 2 now"); the ten deeper ids
    // become a count instead of three lines of wallpaper.
    expect(flat).toContain("tl-b → tl-c1, tl-c2 → … 10 more across 1 level");
    expect(flat).not.toContain("tl-d7");
  });

  test("the recommendation explains its chain and carries both actions", () => {
    const rec = composeRecommend(fullMeasurement(), {});
    expect(() => validBoard(rec)).not.toThrow();
    const flat = JSON.stringify(rec);
    expect(flat).toContain("Ready one");
    // Two metrics, deliberately disagreeing: tl-b declares 3 dependents, but
    // only tl-d is currently blocked on it. One word could never have carried
    // "the leverage is real but most of it is deferred".
    expect(flat).toContain("3 downstream · releases 1 now");
    expect(flat).toContain("tl-b → tl-d → tl-h");
    expect(flat).toContain("runner-up: tl-c");
    expect(flat).toContain("select-bead");
    expect(flat).toContain("claim-bead");
    // Signal row + chain line only: the labelled three-field stack is what
    // made this panel tall.
    const card = rec.sections[0];
    if (card?.kind !== "cards") throw new Error("no cards");
    expect(card.items[0]?.fields?.length).toBe(2);
  });

  test("an empty ready queue says so instead of recommending nothing silently", () => {
    const m = fullMeasurement();
    m.ready = ok([]);
    expect(JSON.stringify(composeRecommend(m, {}))).toContain("Nothing is ready to start");
  });

  test("empty in-progress stays visible as a compact notice", () => {
    const m = fullMeasurement();
    setWip(m, []);
    const wip = composeWip(m, {});
    expect(() => validBoard(wip)).not.toThrow();
    expect(JSON.stringify(wip)).toContain("No agent or human holds a claim");
  });

  test("a claimed bead that is also blocked says both, and drops the repeated owner", () => {
    const m = fullMeasurement();
    // tl-d is in the blocked union; claim it so it appears in both panels.
    setWip(m, [
      { id: "tl-d", title: "Dep blocked", status: "in_progress", priority: 1, assignee: "dan" },
      { id: "tl-g", title: "Other work", status: "in_progress", priority: 2, assignee: "dan" },
    ]);
    const wip = composeWip(m, {});
    expect(() => validBoard(wip)).not.toThrow();
    const cards = wip.sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    // One shared owner is stated once in the title, not on every card.
    expect(cards.title).toBe("All claimed by dan");
    expect(JSON.stringify(cards.items)).not.toContain("dan");
    // Two channels, not one overloaded dot: the lifecycle stays `in progress`
    // for BOTH beads, and only the rail distinguishes them. This is the shape
    // that ends the green-here/red-there contradiction — the waiting is a
    // condition, so it never touches the lifecycle tone.
    expect(JSON.stringify(cards.items[0])).toContain("in progress");
    expect(JSON.stringify(cards.items[0])).toContain("waiting on tl-b");
    expect(cards.items[0]?.dot).toBe("ok");
    expect(JSON.stringify(cards.items[1])).not.toContain("waiting on");
    expect(cards.items[1]?.dot).toBe("ok");
  });

  test("an unassigned bead beside assigned siblings is marked, not left blank", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "tl-g", title: "One", status: "in_progress", priority: 2, assignee: "dan" },
      { id: "tl-i", title: "Two", status: "in_progress", priority: 2 },
    ]);
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBeUndefined();
    expect(JSON.stringify(cards.items[1])).toContain("unassigned");
  });

  test("an all-unassigned panel says nothing about owners", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "tl-g", title: "One", status: "in_progress", priority: 2 },
      { id: "tl-i", title: "Two", status: "in_progress", priority: 2 },
    ]);
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    // Unassigned is the backlog default — marking every row would be noise.
    expect(cards.title).toBeUndefined();
    expect(JSON.stringify(cards.items)).not.toContain("unassigned");
  });

  test("mixed owners keep the owner on each card", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "tl-g", title: "One", status: "in_progress", priority: 2, assignee: "dan" },
      { id: "tl-i", title: "Two", status: "in_progress", priority: 2, assignee: "sam" },
    ]);
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBeUndefined();
    expect(JSON.stringify(cards.items[0])).toContain("dan");
    expect(JSON.stringify(cards.items[1])).toContain("sam");
  });

  test("attention aggregates blockers into dam rows with comparable meters", () => {
    const att = composeAttention(fullMeasurement(), {});
    expect(() => validBoard(att)).not.toThrow();
    const dams = att.sections.find((s) => s.kind === "rows" && s.title?.startsWith("Dams"));
    if (dams?.kind !== "rows") throw new Error("no dams");
    // tl-b holds tl-d directly and releases tl-h a hop later; tl-d holds tl-h.
    // Held count ranks, leverage (tl-b declares 3 downstream) breaks the tie
    // it doesn't have to here — and the numbers on screen ARE the rank keys.
    expect(dams.items[0]?.chip?.label).toBe("tl-b");
    const first = JSON.stringify(dams.items[0]);
    expect(first).toContain("holds 1 now");
    expect(first).toContain("2 transitive");
    expect(first).toContain("startable now");
    // The meter shares one total (the largest dam) so fill lengths compare
    // across rows; the held ids live in the inspector now, not the row.
    expect(dams.items[0]?.bar).toEqual({ value: 1, total: 1 });
    expect(first).not.toContain("held:");
    expect(dams.items[1]?.chip?.label).toBe("tl-d");
    // The dam opens the inspector — finishing it is the point.
    expect(dams.items[0]?.action?.type).toBe("select-bead");
  });

  test("hand-paused work is its own queue, never silently missing from dams", () => {
    const att = composeAttention(fullMeasurement(), { selectedId: "tl-e" });
    const paused = att.sections.find((s) => s.kind === "cards" && s.title === "Paused by hand");
    if (paused?.kind !== "cards") throw new Error("no paused section");
    expect(paused.items.map((i) => i.pill?.label)).toEqual(["tl-e"]);
    expect(paused.items[0]?.selected).toBe(true);
    expect(JSON.stringify(paused.items[0])).toContain("paused by hand");
  });

  test("a bead in review renders as a merge ask linking to its PR", () => {
    const m = fullMeasurement();
    m.runInfo = ok({
      "tl-a": ok({
        prUrl: "https://github.com/acme/demo/pull/64",
        outcome: "success",
        note: "CI green",
      }),
    });
    const att = composeAttention(m, {});
    const review = att.sections[0];
    if (review?.kind !== "rows") throw new Error("no review section");
    expect(review.title).toBe("Review to merge");
    expect(review.items[0]?.chip?.label).toBe("tl-a");
    expect(review.items[0]?.href).toBe("https://github.com/acme/demo/pull/64");
    expect(review.items[0]?.trailing).toContain("in review");
  });

  test("an unmeasured stage split alarms in attention rather than hiding reviews", () => {
    const m = fullMeasurement();
    m.runInfo = { ok: false, error: "bd show tl-a: exit 1" };
    const flat = JSON.stringify(composeAttention(m, {}));
    expect(flat).toContain("UNMEASURED");
    expect(flat).toContain("review-stage work");
  });

  test("epic closeouts queue for a human with a meter, never a close button", () => {
    const att = composeAttention(fullMeasurement(), {});
    const closeout = att.sections.find(
      (s) => s.kind === "cards" && s.title === "Epic closeout review",
    );
    if (closeout?.kind !== "cards") throw new Error("no closeout section");
    expect(closeout.items[0]?.pill?.label).toBe("tl-f");
    expect(closeout.items[0]?.bar).toEqual({ value: 4, total: 4 });
    expect(closeout.items[0]?.dot).toBe("warn");
    expect(closeout.items[0]?.action?.type).toBe("select-bead");
    expect(JSON.stringify(att)).not.toContain("claim-bead");
  });

  test("unmeasured epics alarm in attention instead of dropping closeouts", () => {
    const m = fullMeasurement();
    m.epics = { ok: false, error: "bd epic status: exit 1" };
    const flat = JSON.stringify(composeAttention(m, {}));
    expect(flat).toContain("UNMEASURED");
    expect(flat).toContain("epic closeout eligibility");
  });

  test("a failed stale query alarms instead of reading as a clean board", () => {
    const m = fullMeasurement();
    m.blocked = ok([]);
    m.epics = ok([]);
    m.stale = { ok: false, error: "bd stale: exit 1" };
    const flat = JSON.stringify(composeAttention(m, {}));
    // The all-clear would otherwise fire on an unmeasured signal — the exact
    // regression that moving stale off the Pulse could have introduced.
    expect(flat).toContain("UNMEASURED");
    expect(flat).not.toContain("Nothing needs a human");
  });

  test("a measured zero still says the board is clean", () => {
    const m = fullMeasurement();
    m.blocked = ok([]);
    m.stale = ok([]);
    m.epics = ok([]);
    setWip(m, []);
    expect(JSON.stringify(composeAttention(m, {}))).toContain("Nothing needs a human");
  });

  test("the review slot holds its place while claims are still working", () => {
    const att = composeAttention(fullMeasurement(), {});
    const review = att.sections[0];
    if (review?.kind !== "rows") throw new Error("no review slot");
    // The predictable location states its emptiness rather than vanishing.
    expect(review.title).toBe("Review to merge");
    expect(review.items[0]?.text).toBe("Nothing waits on a merge yet — 1 claim still working.");
  });

  test("the plan renders epics as titled panels and singles under standalone work", () => {
    const plan = composePlan(fullMeasurement(), { selectedId: "tl-b" });
    expect(() => validBoard(plan)).not.toThrow();
    const epicPanel = plan.sections.find((s) => s.kind === "cards");
    const standalone = plan.sections.find(
      (s) => s.kind === "rows" && s.title === "Standalone work",
    );
    const legend = plan.sections.at(-1);
    if (epicPanel?.kind !== "cards" || standalone?.kind !== "rows") throw new Error("wrong shapes");
    // The epic is structure: it lives in the panel title with its meter, the
    // children are the cards.
    expect(epicPanel.title).toContain("▸ S1");
    expect(epicPanel.title).toContain("4/4 done");
    expect(epicPanel.title).toContain("needs closeout review");
    // Auto-fit grid only. `boxed` insets the one-line meta as a pill stack and
    // `columns` pins each card to a fixed-height seat — both measured on the
    // surface as dead space under a card built to stay short.
    expect(epicPanel.grid).toBe(true);
    expect(epicPanel.boxed).toBeUndefined();
    expect(epicPanel.columns).toBeUndefined();
    // The eligible epic leads its own group so the review action has a home.
    expect(epicPanel.items.map((i) => i.title)).toEqual(["S1", "First child"]);
    // The long tail is a dense feed, not more grid: id chip, full title, and
    // the state annotation on one line.
    expect(standalone.title).toBe("Standalone work");
    expect(standalone.items[0]?.chip?.label).toBe("tl-b");
    expect(standalone.items[0]?.text).toBe("Ready one");
    expect(standalone.items[0]?.glyph).toBe("accent");
    // Meta then rail, in the same order the cards use — a row has a real
    // right-aligned slot, so here the rail is literal rather than positional.
    expect(standalone.items[0]?.trailing).toBe("P0 · 3 downstream");
    expect(legend?.kind).toBe("rows");
  });

  test("standalone rows select into the inspector like any card", () => {
    const m = fullMeasurement();
    m.backlog = ok([
      {
        id: "tl-doc",
        title: "Documented bead",
        status: "open",
        priority: 1,
        description: "Why it exists.",
        acceptance_criteria: "How we know it is done.",
      },
      { id: "tl-bare", title: "Undocumented bead", status: "open", priority: 1 },
    ]);
    const [rows] = composePlan(m, { selectedId: "tl-doc" }).sections;
    if (rows?.kind !== "rows") throw new Error("no rows");
    const byId = (id: string) => rows.items.find((i) => i.chip?.label === id);
    // Rows carry the cards click contract (keelson 0.102): the tail selects
    // instead of disclosing inline — action and detail are mutually
    // exclusive, and the inspector is strictly richer than the old detail.
    expect(byId("tl-doc")?.action).toEqual({ type: "select-bead", payload: { id: "tl-doc" } });
    expect(byId("tl-doc")?.detail).toBeUndefined();
    expect(byId("tl-doc")?.selected).toBe(true);
    expect(byId("tl-bare")?.selected).toBe(false);
  });

  const long =
    "Stop the loader writing literal 'NaN' into nullable text columns before the audit runs";

  // Clamping is a card concern: a card wraps, so an unbudgeted title is what
  // makes it tall. These beads are epic children so they land in a card grid.
  function planCards(titles: Record<string, string>) {
    const m = fullMeasurement();
    m.backlog = ok([
      { id: "tl-f", title: "S1", status: "open", priority: 1, issue_type: "epic" },
      ...Object.entries(titles).map(([id, title]) => ({
        id,
        title,
        status: "open",
        priority: 1,
      })),
    ]);
    m.epicChildren = ok({ "tl-f": Object.keys(titles) });
    // No closeout row in front — these tests are about the title budget only.
    m.epics = ok([]);
    const cards = composePlan(m, {}).sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards");
    return cards.items.map((i) => i.title);
  }

  test("a long title is clamped so a card stays about three rows tall", () => {
    const [clamped, hardCut] = planCards({
      "tl-long": long,
      "tl-run": "supercalifragilisticexpialidocious".repeat(4),
    });
    // Budgeted, ellipsized, and broken on a word — the inspector holds the rest.
    expect(clamped?.length).toBeLessThanOrEqual(65);
    expect(clamped?.endsWith("…")).toBe(true);
    expect(long.startsWith(clamped?.slice(0, -1) ?? "")).toBe(true);
    expect(clamped).not.toContain(" …");
    // A single unbroken token has no word to break on, so it is cut mid-word
    // rather than allowed to escape the budget.
    expect(hardCut?.length).toBeLessThanOrEqual(65);
  });

  test("a title inside the budget is left exactly as authored", () => {
    expect(planCards({ "tl-s": "Short enough" })[0]).toBe("Short enough");
  });

  test("the dense standalone row keeps the whole title — one line does not wrap", () => {
    const m = fullMeasurement();
    m.backlog = ok([{ id: "tl-long", title: long, status: "open", priority: 1 }]);
    const [rows] = composePlan(m, {}).sections;
    if (rows?.kind !== "rows") throw new Error("no rows");
    expect(rows.items[0]?.text).toBe(long);
  });

  test("parent-child links pull epic members into the epic panel", () => {
    const m = fullMeasurement();
    // tl-b carries no dotted id; only the parent-child edge places it.
    m.epicChildren = ok({ "tl-f": ["tl-b"] });
    const plan = composePlan(m, {});
    const cards = plan.sections.filter((s) => s.kind === "cards");
    const epicPanel = cards[0];
    if (epicPanel?.kind !== "cards") throw new Error("no cards");
    expect(epicPanel.items.map((i) => i.title)).toEqual(["S1", "Ready one", "First child"]);
    // Nothing is left standalone — one card section only.
    expect(cards.length).toBe(1);
  });

  test("a satisfied dependency is not listed as something the bead waits on", () => {
    const issue: BdIssue = {
      id: "tl-13j",
      title: "Backfill",
      status: "open",
      priority: 0,
      dependencies: [
        { id: "tl-2tc", title: "Membership windows", status: "closed" },
        { id: "tl-open", title: "Still open", status: "open" },
        { id: "tl-unknown", title: "No status recorded" },
      ],
    };
    const flat = JSON.stringify(composeInspect(ok(issue), []));
    // Closed edges are done — listing them under "Waits on" beside an enabled
    // Start button tells you to start and to wait at the same time.
    expect(flat).not.toContain("tl-2tc");
    expect(flat).toContain("tl-open");
    // Unknown status is kept: absence of proof is not proof of completion.
    expect(flat).toContain("tl-unknown");
  });

  test("the plan counts epics rendered as group titles as shown", () => {
    const plan = composePlan(fullMeasurement(), {});
    const legend = plan.sections.at(-1);
    if (legend?.kind !== "rows") throw new Error("no legend");
    // The fixture's three backlog beads are one epic (a group title), its
    // child, and one standalone — nothing is truncated, so the caption must
    // not warn about hidden work.
    expect(legend.items[0]?.text).not.toContain("Showing");
  });

  test("an epic with no open children asks for review, never offers a close", () => {
    const plan = composePlan(fullMeasurement(), {});
    const notice = plan.sections[0];
    if (notice?.kind !== "rows") throw new Error("no closeout notice");
    expect(notice.items[0]?.chip?.label).toBe("closeout review");
    expect(notice.items[0]?.trailing).toBe("tl-f");
    const epicPanel = plan.sections.find((s) => s.kind === "cards");
    if (epicPanel?.kind !== "cards") throw new Error("no cards");
    const review = epicPanel.items[0];
    expect(review?.pill?.label).toBe("tl-f");
    expect(review?.actions?.[0]?.label).toBe("Review epic");
    expect(review?.actions?.[0]?.type).toBe("select-bead");
    // Closed children are evidence, not authorization — the rib never offers
    // the close, and closing is a merge-time act with a written reason.
    expect(JSON.stringify(plan)).not.toContain("claim-bead");
  });

  test("a claimed epic is marked structural rather than hidden", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "tl-f", title: "S1", status: "in_progress", priority: 0, issue_type: "epic" },
    ]);
    expect(JSON.stringify(composeWip(m, {}))).toContain("epic");
  });

  test("the inspector will not offer to start an epic", () => {
    const epic: BdIssue = {
      id: "tl-f",
      title: "S1",
      status: "open",
      priority: 1,
      issue_type: "epic",
    };
    const view = composeInspect(ok(epic), [], undefined, {
      epicRow: { epic, total_children: 4, closed_children: 4, eligible_for_close: true },
    });
    const flat = JSON.stringify(view);
    expect(flat).not.toContain("claim-bead");
    expect(flat).toContain("merge-time act");
  });

  test("the recommendation names the owner when bd only carried one", () => {
    const m = fullMeasurement();
    // `bd ready` returns `owner` (an email), not `assignee` — reading assignee
    // alone reported owned work as unclaimed.
    m.ready = ok([
      { id: "tl-b", title: "Ready one", status: "open", priority: 0, owner: "dan@example.com" },
    ]);
    const flat = JSON.stringify(composeRecommend(m, {}));
    expect(flat).toContain("dan@example.com");
    expect(flat).not.toContain("unclaimed");
  });

  test("a failed measurement alarms instead of rendering empty-and-healthy", () => {
    const m = fullMeasurement();
    m.blocked = { ok: false, error: "bd blocked: exit 1" };
    const att = composeAttention(m, {});
    expect(JSON.stringify(att)).toContain("UNMEASURED");
    expect(() => validBoard(att)).not.toThrow();
  });

  test("the inspector renders prose, links, and a claim action", () => {
    const inspect = composeInspect(
      ok({
        id: "tl-b",
        title: "Ready one",
        status: "open",
        priority: 0,
        description: "First paragraph.\n\nSecond paragraph.",
        acceptance_criteria: "It measures true.",
        dependents: [{ id: "tl-d", title: "Dep blocked" }],
      }),
      [],
    );
    expect(() => validBoard(inspect)).not.toThrow();
    // Facts left, prose right: the full-width band splits 1:2 internally.
    expect(inspect.sections[0]?.kind).toBe("columns");
    const flat = JSON.stringify(inspect);
    expect(flat).toContain("First paragraph.");
    expect(flat).toContain("Second paragraph.");
    expect(flat).toContain("It measures true.");
    expect(flat).toContain("tl-d — Dep blocked");
    expect(flat).toContain("claim-bead");
  });

  test("a blocked bead cannot be started; the board's pick is offered instead", () => {
    const inspect = composeInspect(
      ok({
        id: "tl-ch3",
        title: "Collect workflow",
        status: "open",
        priority: 0,
        dependencies: [
          { id: "tl-0yr", title: "scrape reports" },
          { id: "tl-btz", title: "fixtures" },
          { id: "tl-4nx", title: "gate" },
        ],
      }),
      [{ id: "tl-ch3", title: "Collect workflow", status: "open", priority: 0 }],
      { id: "tl-4nx", title: "GATE", status: "open", priority: 0 },
    );
    expect(() => validBoard(inspect)).not.toThrow();
    const flat = JSON.stringify(inspect);
    expect(flat).toContain("Blocked by 3 beads");
    expect(flat).toContain("Start tl-4nx instead");
    const cols = inspect.sections[0];
    if (cols?.kind !== "columns") throw new Error("no columns");
    const actions = cols.columns[0]?.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions");
    expect(actions.items[0]?.label).toBe("Start this bead");
    expect(actions.items[0]?.disabled).toBe(true);
  });

  test("the inspector rests on the board's pick when nothing was clicked", () => {
    const m = fullMeasurement();
    expect(fallbackSelectedId(m)).toBe("tl-b");
    const pick = m.ready.ok ? m.ready.data[0] : undefined;
    if (!pick) throw new Error("fixture pick");
    const view = composeInspect(ok(pick), [], pick, { preselected: true });
    const flat = JSON.stringify(view);
    // Shown, but never impersonating a click the operator did not make.
    expect(flat).toContain("the board's pick");
    expect(flat).toContain("Nothing selected yet");
  });

  test("an explicitly inspected bead says nothing about being a pick", () => {
    const m = fullMeasurement();
    const pick = m.ready.ok ? m.ready.data[0] : undefined;
    if (!pick) throw new Error("fixture pick");
    expect(JSON.stringify(composeInspect(ok(pick), [], pick))).not.toContain("the board's pick");
  });

  test("an unmeasured ready queue has no pick to fall back to", () => {
    const m = fullMeasurement();
    m.ready = { ok: false, error: "bd ready: exit 1" };
    expect(fallbackSelectedId(m)).toBeUndefined();
  });

  test("the fallback never lights a selection ring on any panel", () => {
    // The ring means "you clicked this". A preselected bead has been clicked
    // by nobody, so with an empty PanelContext no panel may claim one.
    const m = fullMeasurement();
    for (const view of [composePlan(m, {}), composeWip(m, {}), composeRecommend(m, {})]) {
      expect(JSON.stringify(view)).not.toContain('"selected":true');
    }
  });

  test("the empty inspector invites a selection", () => {
    expect(JSON.stringify(composeInspect(undefined, []))).toContain("Nothing selected");
  });

  test("the portfolio renders one meter per epic that opens the inspector", () => {
    const m = fullMeasurement();
    m.epicChildren = ok({ "tl-f": ["tl-a"] });
    const portfolio = composePortfolio(m, {});
    expect(() => validBoard(portfolio)).not.toThrow();
    const cards = portfolio.sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    const epic = cards.items[0];
    expect(epic?.pill?.label).toBe("tl-f");
    // The meter is the flow strip's vocabulary at epic scale — same
    // stage→tone mapping, mirrored order (done anchors left, darkest).
    expect(epic?.bar).toEqual({
      segments: [
        { label: "done", n: 4, tone: "ramp-5" },
        { label: "in review", n: 0, tone: "ramp-4" },
        { label: "in progress", n: 1, tone: "ramp-3" },
        { label: "ready", n: 0, tone: "ramp-2" },
        { label: "waiting", n: 0, tone: "ramp-1" },
      ],
    });
    // warn, not ok: an all-closed epic is an ask on a human's time.
    expect(epic?.dot).toBe("warn");
    expect(epic?.action?.type).toBe("select-bead");
    const flat = JSON.stringify(epic);
    expect(flat).toContain("4/4 done");
    expect(flat).toContain("1 in progress");
    expect(flat).toContain("needs closeout review");
    expect(JSON.stringify(portfolio)).not.toContain("claim-bead");
  });

  test("the portfolio sorts where the agents are first and says why parked epics wait", () => {
    const m = fullMeasurement();
    m.epics = ok([
      {
        epic: { id: "ep-parked", title: "Parked", status: "open", priority: 1 },
        total_children: 2,
        closed_children: 0,
        eligible_for_close: false,
      },
      {
        epic: { id: "ep-near", title: "Nearly landed", status: "open", priority: 2 },
        total_children: 4,
        closed_children: 3,
        eligible_for_close: false,
      },
      {
        epic: { id: "ep-active", title: "Active", status: "open", priority: 3 },
        total_children: 3,
        closed_children: 0,
        eligible_for_close: false,
      },
    ]);
    // ep-active holds the in-flight bead; ep-parked's children sit in the
    // blocked union — tl-d held from outside (tl-b), tl-h by its sibling.
    m.epicChildren = ok({ "ep-active": ["tl-a"], "ep-parked": ["tl-d", "tl-h"] });
    const cards = composePortfolio(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    // bd's order was parked, near, active — the board's order is the story:
    // where the agents are, then what's nearly landed, parked last.
    expect(cards.items.map((i) => i.pill?.label)).toEqual(["ep-active", "ep-near", "ep-parked"]);
    expect(JSON.stringify(cards.items[0])).toContain("1 in progress");
    expect(JSON.stringify(cards.items[2])).toContain("gated on tl-b");
  });

  test("unmeasured epic membership drops the in-flight clause, not the meter", () => {
    const m = fullMeasurement();
    m.epicChildren = { ok: false, error: "bd show tl-f: exit 1" };
    const flat = JSON.stringify(composePortfolio(m, {}));
    expect(flat).toContain("4/4 done");
    expect(flat).not.toContain("in progress");
  });

  test("an unmeasured stage set degrades the meter to the plain fill", () => {
    const m = fullMeasurement();
    m.epicChildren = ok({ "tl-f": ["tl-a"] });
    m.runInfo = { ok: false, error: "bd show tl-a: exit 1" };
    const cards = composePortfolio(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    // Stage composition needs the review split; without it the meter says
    // done/total honestly instead of guessing stages.
    expect(cards.items[0]?.bar).toEqual({ value: 4, total: 4 });
  });

  test("the portfolio fails closed and hides only on a measured empty", () => {
    const m = fullMeasurement();
    m.epics = { ok: false, error: "bd epic status: exit 1" };
    expect(JSON.stringify(composePortfolio(m, {}))).toContain("UNMEASURED");
    const empty = fullMeasurement();
    empty.epics = ok([]);
    expect(composePortfolio(empty, {}).sections.length).toBe(0);
  });

  test("momentum interleaves closes, touches, and new beads newest first", () => {
    const m = fullMeasurement();
    m.backlog = ok([
      {
        id: "tl-new",
        title: "Fresh bead",
        status: "open",
        priority: 2,
        created_at: "2026-08-09T09:00:00Z",
      },
      // A new epic is structure, not momentum.
      {
        id: "tl-epic",
        title: "Fresh epic",
        status: "open",
        priority: 2,
        issue_type: "epic",
        created_at: "2026-08-09T09:00:00Z",
      },
    ]);
    const momentum = composeMomentum(m);
    expect(() => validBoard(momentum)).not.toThrow();
    // One section per day, newest first — the day is a header, not a suffix
    // repeated on every line. asOf is 08-09: the create (09:00 today) beats
    // the close (08-08) beats the touch (08-07).
    const days = momentum.sections.filter((s) => s.kind === "rows");
    expect(days.map((s) => s.title)).toEqual(["Today", "Yesterday", "Aug 7"]);
    if (days[0]?.kind !== "rows" || days[1]?.kind !== "rows" || days[2]?.kind !== "rows")
      throw new Error("no day rows");
    expect(days[0].items[0]?.chip?.label).toBe("tl-new");
    expect(days[0].items[0]?.icon).toBe("+");
    expect(days[0].items[0]?.trailing).toBe("new");
    expect(days[1].items[0]?.chip?.label).toBe("tl-g");
    expect(days[1].items[0]?.icon).toBe("✓");
    expect(days[1].items[0]?.trailing).toBe("closed");
    expect(days[2].items[0]?.chip?.label).toBe("tl-a");
    expect(days[2].items[0]?.icon).toBe("◐");
    // "touched", never "claimed": bd records no claim time.
    expect(days[2].items[0]?.trailing).toBe("touched");
    expect(JSON.stringify(momentum)).not.toContain("tl-epic");
  });

  test("momentum lists each bead once — the most final event wins", () => {
    const m = fullMeasurement();
    // tl-a is in progress AND created inside the window: one line, the touch.
    m.backlog = ok([
      {
        id: "tl-a",
        title: "In flight",
        status: "in_progress",
        priority: 1,
        created_at: "2026-08-06T09:00:00Z",
      },
    ]);
    const items = composeMomentum(m).sections.flatMap((s) => (s.kind === "rows" ? s.items : []));
    expect(items.filter((i) => i.chip?.label === "tl-a").length).toBe(1);
    expect(items.find((i) => i.chip?.label === "tl-a")?.icon).toBe("◐");
  });

  test("a capped momentum feed says it is truncated", () => {
    const m = fullMeasurement();
    m.recentlyClosed = ok(
      Array.from({ length: 15 }, (_, i) => ({
        id: `tl-c${i}`,
        title: `Close ${i}`,
        status: "closed",
        priority: 2,
        closed_at: `2026-08-08T${String(10 + Math.floor(i / 10))}:${String(i % 10)}0:00Z`,
      })),
    );
    const flat = JSON.stringify(composeMomentum(m));
    expect(flat).toContain("showing 12 of");
  });

  test("momentum leads with the closed-vs-created chart over the fortnight", () => {
    const m = fullMeasurement();
    m.backlog = ok([
      {
        id: "tl-new",
        title: "Fresh bead",
        status: "open",
        priority: 2,
        created_at: "2026-08-09T09:00:00Z",
      },
      // Epics are structure, not momentum — excluded from Created too.
      {
        id: "tl-epic",
        title: "Fresh epic",
        status: "open",
        priority: 2,
        issue_type: "epic",
        created_at: "2026-08-09T09:00:00Z",
      },
    ]);
    const momentum = composeMomentum(m);
    const chart = momentum.sections[0];
    if (chart?.kind !== "chart") throw new Error("no chart");
    expect(chart.mark).toBe("bar");
    const closed = chart.series.find((s) => s.label === "Closed");
    const created = chart.series.find((s) => s.label === "Created");
    if (!closed || !created) throw new Error("missing series");
    // 14 buckets each, oldest leftmost, quiet days a real 0 — never null.
    expect(closed.points.length).toBe(14);
    expect(created.points.length).toBe(14);
    // tl-g closed 08-08 10:00 against asOf 08-09 12:00 = 1 elapsed day back;
    // tl-old closed 07-30 lands 10 back; the rest of the row is zeros.
    expect(closed.points[12]?.y).toBe(1);
    expect(closed.points[3]?.y).toBe(1);
    expect(closed.points.reduce((a, p) => a + p.y, 0)).toBe(2);
    // The fresh bead counts on today's bucket; the epic does not.
    expect(created.points[13]?.y).toBe(1);
    expect(created.points.reduce((a, p) => a + p.y, 0)).toBe(1);
  });

  test("an unmeasured backlog drops the Created series, not the chart", () => {
    const m = fullMeasurement();
    m.backlog = { ok: false, error: "bd list: exit 1" };
    const chart = composeMomentum(m).sections[0];
    if (chart?.kind !== "chart") throw new Error("no chart");
    expect(chart.series.map((s) => s.label)).toEqual(["Closed"]);
  });

  test("momentum feed rows select into the inspector", () => {
    const m = fullMeasurement();
    const items = composeMomentum(m, { selectedId: "tl-g" }).sections.flatMap((s) =>
      s.kind === "rows" ? s.items : [],
    );
    const close = items.find((i) => i.chip?.label === "tl-g");
    expect(close?.action).toEqual({ type: "select-bead", payload: { id: "tl-g" } });
    expect(close?.selected).toBe(true);
    expect(items.find((i) => i.chip?.label === "tl-a")?.selected).toBe(false);
  });

  test("momentum fails closed on closes and alarms partially on the rest", () => {
    const m = fullMeasurement();
    m.recentlyClosed = { ok: false, error: "bd list --status closed: exit 1" };
    expect(JSON.stringify(composeMomentum(m))).toContain("UNMEASURED");
    const partial = fullMeasurement();
    partial.backlog = { ok: false, error: "bd list: exit 1" };
    const flat = JSON.stringify(composeMomentum(partial));
    // The measured feeds still render; the missing one alarms inline.
    expect(flat).toContain("tl-g");
    expect(flat).toContain("new beads could not be measured");
  });

  test("momentum hides itself only on a measured quiet fortnight", () => {
    const m = fullMeasurement();
    m.recentlyClosed = ok([]);
    m.closedFortnight = ok([]);
    setWip(m, []);
    m.backlog = ok([]);
    expect(composeMomentum(m).sections.length).toBe(0);
    // A week-quiet feed with fortnight-old closes still charts the shape.
    const older = fullMeasurement();
    older.recentlyClosed = ok([]);
    setWip(older, []);
    older.backlog = ok([]);
    const sections = composeMomentum(older).sections;
    expect(sections[0]?.kind).toBe("chart");
  });

  test("a scope without a tracker renders the map, not a fake backlog", () => {
    const pulse = composeNoTrackerPulse("default", [{ name: "ed-insights-platform" }]);
    expect(pulse.header?.status?.label).toBe("no beads tracker in default");
    expect(JSON.stringify(pulse)).toContain("ed-insights-platform");
    expect(() => validBoard(pulse)).not.toThrow();
  });

  test("status glyphs and priority tones stay stable", () => {
    expect(statusGlyph("deferred")).toBe("❄");
    expect(statusGlyph("in_progress")).toBe("◐");
    expect(priorityTone(0)).toBe("error");
    expect(priorityTone(3)).toBe("neutral");
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
    for (const [token, label] of [
      ["#42", "#42 (URL unknown)"],
      ["unknown", "unknown"],
    ]) {
      const m = fullMeasurement();
      m.runInfo = ok({ "tl-a": ok(parseRunNote(`bead-work run: PR ${token} — cancelled`)) });
      const split = stageSplit(m);
      if (!split.ok) throw new Error("split should measure");
      expect(split.data.inReview).toHaveLength(0);
      expect(split.data.working.map((i) => i.id)).toEqual(["tl-a"]);
      const strip = composePulse(m).sections[0];
      if (strip?.kind !== "segments") throw new Error("no flow strip");
      expect(strip.items.find((s) => s.label === "In review")?.n).toBe(0);
      const review = composeAttention(m, {}).sections[0];
      if (review?.kind !== "rows") throw new Error("no review section");
      expect(review.items[0]?.href).toBeUndefined();
      const cards = composeWip(m, {}).sections[0];
      if (cards?.kind !== "cards") throw new Error("no agents section");
      expect(cards.items[0]?.fields?.find((field) => field.label === "PR")).toEqual({
        label: "PR",
        value: label,
      });
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

  test("a merged outcome keeps the review stage but says the close is pending", () => {
    expect(stageChip(info({ outcome: "success" }))).toBe("in review");
    expect(stageChip(info())).toBe("in review");
    expect(stageChip(info({ outcome: "merged, CI green" }))).toBe("merged — close pending");
  });

  test("agents cards carry the stage, the PR link, and the run attribution", () => {
    const m = fullMeasurement();
    m.runInfo = ok({
      "tl-a": ok(info({ outcome: "success", note: "draft PR reviewed" })),
    });
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    const flat = JSON.stringify(cards.items[0]);
    expect(flat).toContain("in review");
    expect(flat).toContain("bead-work run");
    expect(flat).toContain("demo#64");
    expect(flat).toContain("https://github.com/acme/demo/pull/64");
    expect(flat).toContain("success — draft PR reviewed");
    expect(cards.items[0]?.action?.type).toBe("select-bead");
  });

  test("the agents title counts runs honestly instead of repeating bd's human", () => {
    const m = fullMeasurement();
    setWip(m, [
      { id: "tl-r", title: "Run-held", status: "in_progress", priority: 1, assignee: "dan" },
      { id: "tl-w", title: "Hand-held", status: "in_progress", priority: 1, assignee: "dan" },
    ]);
    m.runInfo = ok({
      "tl-r": ok({ prUrl: "https://github.com/acme/demo/pull/5" }),
      "tl-w": ok(undefined),
    });
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    // bd says "dan" holds both; the note proves a run holds one. The hoist
    // would repeat the misattribution, so the title counts actors instead.
    expect(cards.title).toBe("1 bead-work run · 1 other claim");
    expect(JSON.stringify(cards.items[0])).not.toContain("dan");
    expect(JSON.stringify(cards.items[1])).toContain("dan");
  });

  test("an all-runs panel drops the human name entirely", () => {
    const m = fullMeasurement();
    m.runInfo = ok({ "tl-a": ok({ prUrl: "https://github.com/acme/demo/pull/5" }) });
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBe("1 bead-work run");
    expect(JSON.stringify(cards)).not.toContain("dan");
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
    expect(JSON.stringify(cards.items[1])).toContain("UNMEASURED — run note");
  });

  test("prLabel compacts a GitHub PR url and passes anything else through", () => {
    expect(prLabel("https://github.com/acme/demo/pull/64")).toBe("demo#64");
    expect(prLabel("https://example.com/mr/7")).toBe("example.com/mr/7");
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
