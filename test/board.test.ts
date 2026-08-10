import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import type { BdIssue, Measured } from "../src/bd";
import {
  assigneeView,
  composeAttention,
  composeClosed,
  composeInspect,
  composeNoTrackerPulse,
  composePlan,
  composePulse,
  composeRecommend,
  composeWip,
  decisionRail,
  declaredDownstream,
  fallbackSelectedId,
  lifecycleChip,
  lifecycleOf,
  lifecycleTone,
  priorityTone,
  recommendNext,
  statusGlyph,
  unlockChain,
  unlockLevels,
} from "../src/board";
import type { ProjectMeasurement } from "../src/measure";

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
  };
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
  test("pulse carries the four current-state tiles and open-count context", () => {
    const pulse = composePulse(fullMeasurement());
    expect(() => validBoard(pulse)).not.toThrow();
    expect(pulse.header?.chip).toContain("6 open");
    const stats = pulse.sections[0];
    if (stats?.kind !== "stats") throw new Error("no stats");
    expect(stats.items.map((i) => i.label)).toEqual([
      // "Startable", not "Ready now": the measured population already excludes
      // epics and subtracts claimed work, so the label names what you can pick
      // up. "Waiting", not "Blocked": it counts the blocked union, which
      // overlaps In progress because blocking is a condition, not a state.
      "Startable",
      "In progress",
      "Waiting on deps",
      // No stale tile: it is an exception, not a standing measure, so it lives
      // in Needs attention — and alarms there when unmeasured.
      "Closed this week",
    ]);
    // Every tile is one line — no `sub` anywhere — which is what compresses
    // the strip.
    expect(stats.items.every((i) => i.sub === undefined)).toBe(true);
  });

  test("a failed tile alarms instead of borrowing bd's differently-defined count", () => {
    const m = fullMeasurement();
    // bd's own summary counts a different population: ready_issues includes
    // epics and does not subtract in-progress. Substituting it here would
    // answer a different question than the label asks.
    m.summary = ok({ ...summaryOf(m), ready_issues: 4711 });
    m.ready = { ok: false, error: "bd ready: exit 1" };
    const stats = composePulse(m).sections[0];
    if (stats?.kind !== "stats") throw new Error("no stats");
    const startable = stats.items[0];
    expect(startable?.value).toBe("?");
    expect(startable?.tone).toBe("error");
    expect(JSON.stringify(stats)).not.toContain("4711");
  });

  test("the in-progress tile counts the measured list, not the summary field", () => {
    const m = fullMeasurement();
    // Same question, two sources with different failure modes — read the one
    // every other panel reads.
    m.summary = ok({ ...summaryOf(m), in_progress_issues: 9 });
    const stats = composePulse(m).sections[0];
    if (stats?.kind !== "stats") throw new Error("no stats");
    expect(stats.items[1]?.value).toBe(1);
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
    m.inProgress = ok([]);
    const wip = composeWip(m, {});
    expect(() => validBoard(wip)).not.toThrow();
    expect(JSON.stringify(wip)).toContain("No work currently claimed");
  });

  test("a claimed bead that is also blocked says both, and drops the repeated owner", () => {
    const m = fullMeasurement();
    // tl-d is in the blocked union; claim it so it appears in both panels.
    m.inProgress = ok([
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
    m.inProgress = ok([
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
    m.inProgress = ok([
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
    m.inProgress = ok([
      { id: "tl-g", title: "One", status: "in_progress", priority: 2, assignee: "dan" },
      { id: "tl-i", title: "Two", status: "in_progress", priority: 2, assignee: "sam" },
    ]);
    const cards = composeWip(m, {}).sections[0];
    if (cards?.kind !== "cards") throw new Error("no cards");
    expect(cards.title).toBeUndefined();
    expect(JSON.stringify(cards.items[0])).toContain("dan");
    expect(JSON.stringify(cards.items[1])).toContain("sam");
  });

  test("attention splits blockers of active work from the rest", () => {
    const m = fullMeasurement();
    m.inProgress = ok([
      { id: "tl-d", title: "Dep blocked", status: "in_progress", priority: 1, assignee: "dan" },
    ]);
    const att = composeAttention(m, {});
    expect(() => validBoard(att)).not.toThrow();
    const [first, second] = att.sections;
    if (first?.kind !== "cards" || second?.kind !== "cards") throw new Error("no cards");
    expect(first.title).toBe("Blocking active work");
    expect(first.items.map((i) => i.pill?.label)).toEqual(["tl-d"]);
    expect(JSON.stringify(first.items[0])).toContain("in progress");
    expect(JSON.stringify(first.items[0])).toContain("waiting on tl-b");
    expect(second.title).toBe("Other blocked work");
    expect(second.items.map((i) => i.pill?.label)).not.toContain("tl-d");
  });

  test("with no active work blocked, attention keeps a single undivided list", () => {
    const att = composeAttention(fullMeasurement(), {});
    const [first] = att.sections;
    if (first?.kind !== "cards") throw new Error("no cards");
    expect(first.title).not.toBe("Blocking active work");
    expect(JSON.stringify(att)).not.toContain("in progress");
  });

  test("attention ranks by the same downstream number the rail shows", () => {
    const m = fullMeasurement();
    // `bd blocked` carries no dependent_count, so leverage has to be read
    // through the backlog — and the rank must use the figure on screen, not a
    // measured in-edge count that appears nowhere.
    m.backlog = ok([
      { id: "tl-d", title: "Dep blocked", status: "open", priority: 1, dependent_count: 1 },
      { id: "tl-e", title: "Hand blocked", status: "blocked", priority: 2, dependent_count: 5 },
    ]);
    const att = composeAttention(m, { selectedId: "tl-e" });
    if (att.sections[0]?.kind !== "cards") throw new Error("no cards");
    const items = att.sections[0].items;
    expect(items[0]?.pill?.label).toBe("tl-e");
    expect(items[0]?.selected).toBe(true);
    expect(JSON.stringify(items[0])).toContain("5 downstream");
    expect(JSON.stringify(att)).toContain("paused by hand");
  });

  test("a failed stale query alarms instead of reading as a clean board", () => {
    const m = fullMeasurement();
    m.blocked = ok([]);
    m.stale = { ok: false, error: "bd stale: exit 1" };
    const flat = JSON.stringify(composeAttention(m, {}));
    // The all-clear would otherwise fire on an unmeasured signal — the exact
    // regression that moving stale off the Pulse could have introduced.
    expect(flat).toContain("UNMEASURED");
    expect(flat).not.toContain("Nothing is blocked or stale");
  });

  test("a measured zero still says the board is clean", () => {
    const m = fullMeasurement();
    m.blocked = ok([]);
    m.stale = ok([]);
    expect(JSON.stringify(composeAttention(m, {}))).toContain("Nothing is blocked or stale");
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

  test("standalone rows disclose their body inline, since a row cannot be selected", () => {
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
    const [rows] = composePlan(m, {}).sections;
    if (rows?.kind !== "rows") throw new Error("no rows");
    const byId = (id: string) => rows.items.find((i) => i.chip?.label === id);
    expect(byId("tl-doc")?.detail).toBe("Why it exists.\n\nHow we know it is done.");
    // Nothing to disclose means no empty disclosure affordance.
    expect(byId("tl-bare")?.detail).toBeUndefined();
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
    m.inProgress = ok([
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

  test("closed hides itself when the week was quiet", () => {
    const m = fullMeasurement();
    m.recentlyClosed = ok([]);
    expect(composeClosed(m).sections.length).toBe(0);
    expect(composeClosed(fullMeasurement()).sections.length).toBe(1);
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
