import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import type { Measured } from "../src/bd";
import {
  composeAttention,
  composeClosed,
  composeInspect,
  composeNoTrackerPulse,
  composePlan,
  composePulse,
  composeRecommend,
  composeWip,
  priorityTone,
  recommendNext,
  statusGlyph,
  unlockChain,
} from "../src/board";
import type { ProjectMeasurement } from "../src/measure";

const project = { id: "p1", name: "demo", rootPath: "/tmp/demo" };

function ok<T>(data: T): Measured<T> {
  return { ok: true, data };
}

const validBoard = expectView("rib:beads:test", "board");

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
});

describe("panel composers", () => {
  test("pulse carries the five current-state tiles and open-count context", () => {
    const pulse = composePulse(fullMeasurement());
    expect(() => validBoard(pulse)).not.toThrow();
    expect(pulse.header?.chip).toContain("6 open");
    const stats = pulse.sections[0];
    if (stats?.kind !== "stats") throw new Error("no stats");
    expect(stats.items.map((i) => i.label)).toEqual([
      "Ready now",
      "In progress",
      "Blocked",
      "Stale claims",
      "Closed this week",
    ]);
  });

  test("the recommendation explains its chain and carries both actions", () => {
    const rec = composeRecommend(fullMeasurement(), {});
    expect(() => validBoard(rec)).not.toThrow();
    const flat = JSON.stringify(rec);
    expect(flat).toContain("Ready one");
    expect(flat).toContain("unlocks 3 other beads");
    expect(flat).toContain("tl-d (Dep blocked)");
    expect(flat).toContain("→ then tl-h");
    expect(flat).toContain("runner-up: tl-c");
    expect(flat).toContain("select-bead");
    expect(flat).toContain("claim-bead");
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

  test("attention ranks by consequence and marks selection", () => {
    const att = composeAttention(fullMeasurement(), { selectedId: "tl-d" });
    if (att.sections[0]?.kind !== "cards") throw new Error("no cards");
    const items = att.sections[0].items;
    // tl-d is waited on by tl-h, so it outranks the hand-paused row.
    expect(items[0]?.pill?.label).toBe("tl-d");
    expect(items[0]?.selected).toBe(true);
    expect(JSON.stringify(att)).toContain("paused by hand — no blocking dependency");
  });

  test("the plan renders epics as titled panels and singles under standalone work", () => {
    const plan = composePlan(fullMeasurement(), { selectedId: "tl-b" });
    expect(() => validBoard(plan)).not.toThrow();
    const [epicPanel, standalone, legend] = plan.sections;
    if (epicPanel?.kind !== "cards" || standalone?.kind !== "cards") throw new Error("no cards");
    // The epic is structure: it lives in the panel title with its meter, the
    // children are the cards.
    expect(epicPanel.title).toContain("▸ S1");
    expect(epicPanel.title).toContain("4/4 done");
    expect(epicPanel.title).toContain("ready to close out");
    expect(epicPanel.boxed).toBe(true);
    expect(epicPanel.grid).toBe(true);
    expect(epicPanel.items.map((i) => i.title)).toEqual(["First child"]);
    expect(standalone.title).toBe("Standalone work");
    expect(standalone.items[0]?.title).toBe("Ready one");
    expect(standalone.items[0]?.selected).toBe(true);
    expect(standalone.items[0]?.dot).toBe("accent");
    expect(standalone.items[0]?.action?.type).toBe("select-bead");
    // One leverage signal on the card's single meta line.
    expect(JSON.stringify(standalone.items[0])).toContain("unlocks 3");
    expect(legend?.kind).toBe("rows");
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
