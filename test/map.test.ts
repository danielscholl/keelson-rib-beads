import { describe, expect, test } from "bun:test";
import type { Measured } from "../src/bd";
import { composeEpicMap, esc } from "../src/map";
import type { ProjectMeasurement } from "../src/measure";

function ok<T>(data: T): Measured<T> {
  return { ok: true, data };
}

// One epic, five children: two closed, one claimed, one ready, one waiting
// on the ready one.
function epicMeasurement(): ProjectMeasurement {
  const claimed = { id: "cx.3", title: "Landing page", status: "in_progress", priority: 2 };
  return {
    project: { id: "p1", name: "demo", rootPath: "/tmp/demo" },
    asOf: "2026-08-09T12:00:00.000Z",
    bd: ok({ version: "1.2.2", supported: true }),
    summary: ok({
      total_issues: 6,
      open_issues: 3,
      ready_issues: 1,
      blocked_issues: 1,
      in_progress_issues: 1,
      closed_issues: 2,
    }),
    inProgress: ok([claimed]),
    ready: ok([{ id: "cx.4", title: "Detail view", status: "open", priority: 1 }]),
    blocked: ok([
      { id: "cx.5", title: "Share <sheet>", status: "open", priority: 2, blocked_by: ["cx.4"] },
    ]),
    epics: ok([
      {
        epic: { id: "cx", title: "Cosmos v1", status: "open", priority: 1 },
        total_children: 5,
        closed_children: 2,
        eligible_for_close: false,
      },
    ]),
    recentlyClosed: ok([]),
    closedFortnight: ok([]),
    stale: ok([]),
    backlog: ok([]),
    epicChildren: ok({
      cx: [
        { id: "cx.1", title: "Scaffold", status: "closed" },
        { id: "cx.2", title: "Endpoint", status: "closed" },
        { id: "cx.5", title: "Share <sheet>", status: "open" },
        { id: "cx.4", title: "Detail view", status: "open", priority: 1 },
        { id: "cx.3", title: "Landing page", status: "in_progress" },
      ],
    }),
    latestComment: ok({}),
    runInfo: ok({ "cx.3": ok(undefined) }),
    prInfo: ok({ "cx.3": ok(undefined) }),
  };
}

const chipIds = (html: string): string[] =>
  [...html.matchAll(/class="chip [a-z]+" data-id="([^"]+)"/g)].map((match) => match[1] ?? "");

describe("epic wave map", () => {
  test("open children sit in wave columns; the epic id prints once and children print short", () => {
    const html = composeEpicMap(epicMeasurement());
    expect(html).toContain("cx · 2 of 5 done · 1 in flight · 1 ready · 1 waiting");
    expect(html).toContain("Wave 1 <span>· 2 · unblocked</span>");
    expect(html).toContain("Wave 2 <span>· 1</span>");
    expect(chipIds(html)).toEqual(["cx.3", "cx.4", "cx.5"]);
    // The edge the frame draws, and its text form for a stacked narrow frame.
    expect(html).toContain('data-id="cx.5" data-deps="cx.4"');
    expect(html).toContain("waits on .4");
    expect(html).toContain('<span class="tag next">next up</span>');
    expect(html).toContain("Done · 2");
  });

  test("a wave with no bead draws no column; the rest keep their numbers", () => {
    const m = epicMeasurement();
    m.inProgress = ok([]);
    m.ready = ok([]);
    m.blocked = ok([
      { id: "cx.3", title: "Landing page", status: "open", priority: 2, blocked_by: ["far-1"] },
      { id: "cx.4", title: "Detail view", status: "open", priority: 1, blocked_by: ["far-1"] },
      { id: "cx.5", title: "Share <sheet>", status: "open", priority: 2, blocked_by: ["cx.4"] },
    ]);
    const html = composeEpicMap(m);
    expect(html).not.toContain("Wave 1 ");
    expect(html).toContain("Wave 2 <span>· 2</span>");
    expect(html).toContain("Wave 3 <span>· 1</span>");
    expect(html).toContain("min-width:428px");
  });

  test("P1 tags drop when most of the epic is P1; P0 stays", () => {
    const m = epicMeasurement();
    expect(composeEpicMap(m)).toContain('<span class="tag p">P1</span>');
    m.epicChildren = ok({
      cx: [
        { id: "cx.3", title: "Landing page", status: "in_progress", priority: 1 },
        { id: "cx.4", title: "Detail view", status: "open", priority: 1 },
        { id: "cx.5", title: "Share", status: "open", priority: 0 },
      ],
    });
    const html = composeEpicMap(m);
    expect(html).not.toContain('<span class="tag p">P1</span>');
    expect(html).toContain('<span class="tag p p0">P0</span>');
  });

  test("tracker text is escaped everywhere it lands", () => {
    const m = epicMeasurement();
    if (!m.epics.ok || !m.epicChildren.ok) throw new Error("fixture");
    const epic = m.epics.data[0];
    if (epic) epic.epic.title = '<img src=x onerror="alert(1)">';
    const html = composeEpicMap(m);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<sheet>");
    expect(html).toContain("Share &lt;sheet&gt;");
    expect(esc(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  test("selection is not in the markup, so a click never changes the fragment", () => {
    const html = composeEpicMap(epicMeasurement());
    expect(html).not.toContain(' sel"');
    expect(html).toContain('keelson.action("select-bead"');
    expect(html).not.toContain("claim-bead");
  });

  test("no open epic is an empty fragment, which hides the region", () => {
    const m = epicMeasurement();
    m.epics = ok([]);
    expect(composeEpicMap(m)).toBe("");
  });

  test("a failed read alarms instead of drawing an empty or misleading map", () => {
    const m = epicMeasurement();
    m.epics = { ok: false, error: "bd epic status: exit 1" };
    expect(composeEpicMap(m)).toContain("UNMEASURED");
    expect(composeEpicMap(m)).toContain("This is not an empty panel");

    const noEdges = epicMeasurement();
    noEdges.blocked = { ok: false, error: "bd blocked: exit 1" };
    expect(composeEpicMap(noEdges)).toContain("Do not trust the columns");

    const noStage = epicMeasurement();
    noStage.runInfo = { ok: false, error: "bd show: exit 1" };
    expect(composeEpicMap(noStage)).toContain("Review stage could not be measured");

    const noMembers = epicMeasurement();
    noMembers.epicChildren = { ok: false, error: "bd show cx: exit 1" };
    const html = composeEpicMap(noMembers);
    expect(html).toContain("Epic membership could not be measured");
    expect(html).toContain("cx · 2 of 5 done");
    expect(chipIds(html)).toEqual([]);
  });

  test("below the bd floor the map points at the header", () => {
    const m = epicMeasurement();
    m.bd = ok({ version: "1.0.4", supported: false });
    m.epics = { ok: false, error: "exit 1" };
    const html = composeEpicMap(m);
    expect(html).toContain("See the header.");
    expect(html).not.toContain("could not be measured");
  });
});
