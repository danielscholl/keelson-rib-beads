// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The Beads surface is an overview + inspector: each panel owns one stable
// spatial role, composed from a shared measurement. Order of attention — the
// operator's questions, most urgent first: pulse (with the flow strip) →
// agents at work vs needs-a-human → one recommendation (explained,
// actionable) → portfolio vs momentum → the selected-bead inspector → the
// Plan inventory. Selecting any card (action `select-bead`) opens the inspector in
// the canvas drawer (in view no matter how deep the click was) and pins it to
// the Selected-bead panel; long descriptions live THERE, never stretched
// inside the inventory.
//
// Visual grammar (operator feedback, 2026-08-09). Two channels, never one:
// colour and the leading dot carry LIFECYCLE (accent startable, ok in
// progress, info on hold) while every conditional signal — waiting on N, N
// downstream, bug, paused by hand, closeout review — goes to the trailing
// DECISION RAIL. Blocking is a condition, so it never tints a dot; that
// conflation is what made one bead read green in one panel and red in
// another. Priority is a quiet `P0`–`P4`, ids are neutral chips, the title is
// the scan target, and the rail is empty on most beads by design.

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { BdEpicRow, BdIssue, BdLinked, BeadRunInfo, Measured } from "./bd";
import { unmeasured } from "./bd";
import type { ProjectMeasurement } from "./measure";
import { byPriorityThenAge, FLOW_WINDOW_DAYS, RECENT_CLOSE_DAYS, STALE_DAYS } from "./measure";
import { isMergedPR, type PrInfo } from "./pr";

const ATTENTION_CAP = 8;
const DAMS_CAP = 5;
const MOMENTUM_CAP = 12;
const PLAN_CAP = 80;
const PARA_CAP = 24;

type Board = CanvasBoardView;
type BoardSection = CanvasBoardView["sections"][number];
// A `columns` section nests LEAF sections only — no columns inside columns.
type LeafSection = Extract<
  BoardSection,
  { kind: "columns" }
>["columns"][number]["sections"][number];
// One card item as the canvas schema defines it — wider than any single
// composer's literal, so a card carrying `actions` sits in the same array as
// one that does not.
type CardItem = Extract<BoardSection, { kind: "cards" }>["items"][number];

// What the composers need beyond the measurement itself.
export interface PanelContext {
  selectedId?: string;
}

// The CLI's own status legend: ○ open ◐ in_progress ● blocked ✓ closed ❄ deferred.
export function statusGlyph(status: string): string {
  switch (status) {
    case "in_progress":
      return "◐";
    case "blocked":
      return "●";
    case "closed":
      return "✓";
    case "deferred":
      return "❄";
    default:
      return "○";
  }
}

// bd spells the same human two ways depending on which query answered: `bd
// list` and `bd ready` carry `owner` (an email), while `bd list --status
// in_progress` and `bd show` carry `assignee` (a display name). Measured on
// the live tracker, `bd ready` returned 26 of 31 rows with an owner and only
// one with an assignee — so reading `assignee` alone reported work as
// unclaimed when it was owned. Always read both, in that order.
export function personOf(i: BdIssue): string | undefined {
  const raw = (i.assignee ?? i.owner ?? "").trim();
  return raw.length > 0 ? raw : undefined;
}

// ── Two channels, deliberately separate ──────────────────────────────────
//
// LIFECYCLE is where a bead sits in its own life: exactly one value, always
// present. CONDITION is what the dependency graph is doing to it: zero or one,
// and it overlays ANY lifecycle. A bead can be in progress AND waiting.
//
// Conflating them is what made the same bead render green under In progress
// and red under Needs attention — it looked like a contradiction because one
// dot was being asked to answer two questions. `blocked` is bd's status name
// but it is a condition, so it folds to `open` here and re-appears in the
// rail. `ready` likewise never becomes a lifecycle value: it is the ABSENCE of
// a waiting condition, and it was only ever restating the queue the bead was
// already listed in.
export type Lifecycle = "open" | "in_progress" | "deferred" | "closed";

export function lifecycleOf(i: BdIssue): Lifecycle {
  switch (i.status) {
    case "in_progress":
      return "in_progress";
    case "deferred":
      return "deferred";
    case "closed":
      return "closed";
    // "blocked" lands here on purpose — see above.
    default:
      return "open";
  }
}

// `error` is deliberately absent: alarm belongs to the waiting CONDITION in
// the rail, never to a lifecycle value. Startable open work keeps the accent.
export function lifecycleTone(l: Lifecycle, startable: boolean): CanvasTone | undefined {
  if (l === "in_progress") return "ok";
  if (l === "deferred") return "info";
  if (l === "closed") return "neutral";
  return startable ? "accent" : undefined;
}

// The default lifecycle carries no word — every other one does, so no state
// ever rests on colour alone.
export function lifecycleChip(l: Lifecycle): string | undefined {
  if (l === "in_progress") return "in progress";
  if (l === "deferred") return "on hold";
  if (l === "closed") return "closed";
  return undefined;
}

// `bd blocked` rows carry no `dependent_count` at all (verified live: 0 of 3),
// while `bd list` carries it for the whole backlog. Panels built from the
// blocked union therefore have to read leverage through the backlog, or they
// would report every blocked bead as having no downstream work.
export function backlogIndex(m: ProjectMeasurement): ReadonlyMap<string, BdIssue> {
  return new Map((m.backlog.ok ? m.backlog.data : []).map((i) => [i.id, i]));
}

export function declaredDownstream(i: BdIssue, index: ReadonlyMap<string, BdIssue>): number {
  return i.dependent_count ?? index.get(i.id)?.dependent_count ?? 0;
}

// ── The decision rail ────────────────────────────────────────────────────
//
// One predictable trailing location for the signals that are exceptional —
// never a reserved column per signal, which is the disease this replaces: four
// mostly-empty columns cost every row their width to pay off on a handful.
// Empty on most beads, and that emptiness is the feature.
//
// Fixed order, so the eye learns one scan path.
export interface RailContext {
  waitingOn?: readonly string[];
  downstream?: number;
  handPaused?: boolean;
  closeout?: boolean;
  mergePending?: boolean;
}

export function decisionRail(i: BdIssue, c: RailContext = {}): string[] {
  const rail: string[] = [];
  // Type keys on the typed field, never `labels` — a bead can carry a "bug"
  // label while typed a task, and the label is the looser claim.
  if (i.issue_type === "bug") rail.push("bug");
  if (i.issue_type === "epic") rail.push("epic");
  if (c.waitingOn?.length) rail.push(`waiting on ${c.waitingOn.join(", ")}`);
  else if (c.handPaused) rail.push("paused by hand");
  if ((c.downstream ?? 0) > 0) rail.push(`${c.downstream} downstream`);
  if (c.closeout) rail.push("closeout review");
  if (c.mergePending) rail.push("merged PR · close pending");
  return rail;
}

// Who owns the visible work, said in the fewest places that stay truthful.
// Repeating one name on every card is noise; assuming one name is a bug the
// day a second person appears. So the shape of the answer follows the data:
//
//   everyone the same   → hoist to the panel title, cards say nothing
//   nobody assigned     → say nothing at all; unassigned is the backlog default
//   mixed or several    → per card, and the unassigned ones are MARKED, because
//                         a gap beside assigned siblings is itself the signal
export interface AssigneeView {
  sharedTitle?: string;
  perItem: boolean;
  markUnassigned: boolean;
}

export function assigneeView(items: readonly BdIssue[]): AssigneeView {
  const people = items.map((i) => personOf(i));
  const named = people.filter((p): p is string => p !== undefined);
  if (named.length === 0) return { perItem: false, markUnassigned: false };
  const uniform = named.length === people.length && named.every((p) => p === named[0]);
  if (uniform)
    return { sharedTitle: `All claimed by ${named[0]}`, perItem: false, markUnassigned: false };
  return { perItem: true, markUnassigned: true };
}

// P0 is a fire, P1 urgent, P2 normal, everything after that is backlog noise.
export function priorityTone(priority: number | undefined): CanvasTone {
  if (priority === 0) return "error";
  if (priority === 1) return "warn";
  if (priority === 2) return "info";
  return "neutral";
}

// The Plan tree, mirroring `bd list`: parentage comes from dotted ids
// (tl-65z.6 belongs under tl-65z) plus explicit parent-child edges (epic
// membership — `childToParent`, from bd show's dependents). Roots order by
// priority; a root's children stay attached to it as a group.
export interface PlanGroup {
  root: BdIssue;
  children: BdIssue[];
}

export function planGroups(
  backlog: BdIssue[],
  childToParent?: ReadonlyMap<string, string>,
): PlanGroup[] {
  const byId = new Map(backlog.map((i) => [i.id, i]));
  const children = new Map<string, BdIssue[]>();
  const roots: BdIssue[] = [];
  for (const issue of backlog) {
    const dot = issue.id.lastIndexOf(".");
    const parentId = (dot > 0 ? issue.id.slice(0, dot) : undefined) ?? childToParent?.get(issue.id);
    if (parentId && parentId !== issue.id && byId.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(issue);
      children.set(parentId, siblings);
    } else {
      roots.push(issue);
    }
  }
  roots.sort(byPriorityThenAge);
  return roots.map((root) => ({
    root,
    children: (children.get(root.id) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1)),
  }));
}

// The recommendation: leverage first (dependent_count — finishing it frees
// the most stuck work), priority second, age third. Deliberately ONE pick
// with a named runner-up: a queue of twelve is a report, not a decision.
export function recommendNext(ready: BdIssue[]): { pick?: BdIssue; runnerUp?: BdIssue } {
  const ranked = [...ready].sort((a, b) => {
    const la = a.dependent_count ?? 0;
    const lb = b.dependent_count ?? 0;
    if (la !== lb) return lb - la;
    return byPriorityThenAge(a, b);
  });
  return { pick: ranked[0], runnerUp: ranked[1] };
}

// The inspector's resting state was a dead panel one click from useful, and
// "Nothing selected" is a neutral answer to a board that already has an
// opinion. So when nothing has been chosen it shows the pick.
//
// Deliberately narrow: this never writes `selectedBeadId` and never feeds the
// `selected` flags on the other panels. A selection ring means "you clicked
// this" — if the fallback lit one, the ring would claim a click that never
// happened, and every panel would disagree about what "selected" means.
// Epics cannot appear here: the ready queue already excludes them.
export function fallbackSelectedId(m: ProjectMeasurement): string | undefined {
  return m.ready.ok ? recommendNext(m.ready.data).pick?.id : undefined;
}

// Who waits on this bead, by name — read off the blocked union's blocked_by
// edges so the recommendation is explainable, never magical. Walked hop by
// hop to exhaustion: the first level is what finishing this bead releases
// immediately, every later level comes free as each hop clears. `seen` closes
// the walk against dependency cycles, which bd permits.
//
// Bounded by the blocked union we measured — a bead nobody reported blocked
// cannot appear here — so this undercounts rather than invents, which is the
// direction a leverage claim should err.
export function unlockLevels(id: string, blocked: BdIssue[]): BdIssue[][] {
  const levels: BdIssue[][] = [];
  const seen = new Set<string>([id]);
  let frontier = new Set<string>([id]);
  while (frontier.size > 0) {
    const next = blocked.filter(
      (b) => !seen.has(b.id) && b.blocked_by?.some((dep) => frontier.has(dep)),
    );
    if (next.length === 0) break;
    for (const b of next) seen.add(b.id);
    levels.push(next);
    frontier = new Set(next.map((b) => b.id));
  }
  return levels;
}

// The first two hops, named — the shape the panels read.
export function unlockChain(
  id: string,
  blocked: BdIssue[],
): { first: BdIssue[]; second: BdIssue[] } {
  const levels = unlockLevels(id, blocked);
  return { first: levels[0] ?? [], second: levels[1] ?? [] };
}

// ── The derived review stage ─────────────────────────────────────────────
//
// Close is a merge-time human act, so between "in progress" and "closed"
// sits a stage bd cannot name: implemented, PR open, waiting on a human to
// merge. The evidence is the bead-work note convention, nothing else — a
// bead with a parsed run note is "in review"; without one it is working.

// One bead's run note, if its envelope measured. Card-level reads use this;
// aggregates must go through stageSplit, which refuses partial answers.
export function runInfoOf(m: ProjectMeasurement, id: string): BeadRunInfo | undefined {
  if (!m.runInfo.ok) return undefined;
  const entry = m.runInfo.data[id];
  return entry?.ok ? entry.data : undefined;
}

function mergedPR(
  prInfo: ProjectMeasurement["prInfo"] | undefined,
  id: string,
): (PrInfo & { state: "MERGED"; mergedAt: string }) | undefined {
  if (!prInfo?.ok) return undefined;
  const entry = prInfo.data[id];
  return entry?.ok && entry.data && isMergedPR(entry.data) ? entry.data : undefined;
}

function prFailure(m: ProjectMeasurement, id: string): string | undefined {
  if (!m.prInfo.ok) return m.prInfo.error;
  const entry = m.prInfo.data[id];
  return !entry ? `no PR envelope for ${id}` : entry.ok ? undefined : entry.error;
}

function reconcileAction(projectId: string) {
  return {
    type: "sync-merged-beads" as const,
    label: "Reconcile merged PRs",
    tone: "brand" as const,
    payload: { projectId },
    confirm: {
      subject: "Merged PRs",
      title: "Close beads with verified merged PRs?",
      body: "Rechecks the selected project and closes eligible beads with reason Merged via <canonical PR URL>. Unmerged, changed, and paused beads stay open.",
      confirmLabel: "Reconcile",
    },
  };
}

// Run outcome is historical; only a verified live merge can change this word.
export function stageChip(_info: BeadRunInfo, pr?: PrInfo): string {
  return pr && isMergedPR(pr) ? "merged — close pending" : "in review";
}

// The in-progress set split by review stage. Ok only when the set AND every
// per-bead envelope measured: an aggregate over a partially-measured set
// would claim "nothing is in review" on the strength of a failed bd show.
export function stageSplit(
  m: ProjectMeasurement,
): Measured<{ inReview: BdIssue[]; working: BdIssue[] }> {
  if (!m.inProgress.ok) return m.inProgress;
  if (!m.runInfo.ok) return m.runInfo;
  const inReview: BdIssue[] = [];
  const working: BdIssue[] = [];
  for (const i of m.inProgress.data) {
    const entry = m.runInfo.data[i.id];
    if (!entry) return unmeasured(`no run-note envelope for ${i.id}`);
    if (!entry.ok) return unmeasured(`run note for ${i.id}: ${entry.error}`);
    (entry.data ? inReview : working).push(i);
  }
  return { ok: true, data: { inReview, working } };
}

// A compact face for a PR link: owner/repo/pull/N → "repo#N".
export function prLabel(url: string): string {
  const gh = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  return gh ? `${gh[1]}#${gh[2]}` : url.replace(/^https?:\/\//, "").slice(0, 40);
}

// ── Dams ─────────────────────────────────────────────────────────────────
//
// The blocked union names each bead's blockers, which meant the same dam
// printed once per held bead and never once as itself. This groups the union
// the other way: by blocker, ranked by what finishing it would release.
export interface Dam {
  blockerId: string;
  // The backlog row when the blocker is open work; absent when the union
  // names an id the open backlog does not carry (bd stays authoritative that
  // the edge holds, so the dam still renders — by id only).
  blocker?: BdIssue;
  // Direct holds within the blocked union.
  held: BdIssue[];
  // The full BFS release count (unlockLevels) — what clears as hops clear.
  transitive: number;
  startable: boolean;
}

export function damGroups(
  blocked: BdIssue[],
  index: ReadonlyMap<string, BdIssue>,
  readyIds: ReadonlySet<string>,
): Dam[] {
  const held = new Map<string, BdIssue[]>();
  for (const b of blocked) {
    for (const dep of b.blocked_by ?? []) {
      // Structure is never a dam: a parent-child edge (the child's `parent`),
      // an epic standing as blocker (epics only block epics), or a blocker
      // already closed (defensive — bd should not report one) all drop out.
      if ((b.parent ?? index.get(b.id)?.parent) === dep) continue;
      const blocker = index.get(dep);
      if (blocker?.issue_type === "epic") continue;
      if (blocker?.status === "closed") continue;
      const list = held.get(dep) ?? [];
      list.push(b);
      held.set(dep, list);
    }
  }
  const dams: Dam[] = [...held.entries()].map(([blockerId, heldList]) => ({
    blockerId,
    blocker: index.get(blockerId),
    held: heldList,
    transitive: unlockLevels(blockerId, blocked).flat().length,
    startable: readyIds.has(blockerId),
  }));
  // Held count is the on-screen rank; leverage and priority break ties with
  // the same keys every other panel shows.
  dams.sort((a, b) => {
    if (a.held.length !== b.held.length) return b.held.length - a.held.length;
    const da = a.blocker?.dependent_count ?? 0;
    const db = b.blocker?.dependent_count ?? 0;
    if (da !== db) return db - da;
    if (a.blocker && b.blocker) return byPriorityThenAge(a.blocker, b.blocker);
    return a.blockerId < b.blockerId ? -1 : 1;
  });
  return dams;
}

// What a parked epic is parked BEHIND: among its blocked children, the most
// common blocker from outside the epic. Intra-epic edges are ordering, not a
// gate. `all` — every blocked child shares that blocker and nothing in the
// epic is in flight — is what earns the flat "gated on" wording; a partial
// hold says how many instead.
export interface EpicGate {
  blockerId: string;
  count: number;
  all: boolean;
}

export function epicGate(
  childIds: readonly string[],
  blockedBy: ReadonlyMap<string, readonly string[]>,
  wipIds: ReadonlySet<string>,
): EpicGate | undefined {
  const inside = new Set(childIds);
  const counts = new Map<string, number>();
  let blockedChildren = 0;
  for (const id of childIds) {
    const deps = blockedBy.get(id);
    if (!deps?.length) continue;
    // A child blocked only by its siblings is internal ordering — the chain
    // still resolves to whatever holds the boundary bead, so only edges that
    // cross the epic's boundary count toward the gate.
    const external = deps.filter((dep) => !inside.has(dep));
    if (external.length === 0) continue;
    blockedChildren += 1;
    for (const dep of external) counts.set(dep, (counts.get(dep) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (!top) return undefined;
  const inFlight = childIds.some((id) => wipIds.has(id));
  return {
    blockerId: top[0],
    count: top[1],
    all: !inFlight && top[1] === blockedChildren,
  };
}

function board(sections: BoardSection[], header?: Board["header"]): Board {
  return { view: "board", ...(header ? { header } : {}), sections };
}

// A panel whose measurement failed must alarm, never render empty-healthy.
// The raw error goes in `detail` (a disclosure), not `trailing`: trailing
// shares the row's line with `text`, and a long log line crushes the alarm
// sentence to a one-character sliver in a half-width column.
function failedBoard(what: string, error: string): Board {
  return board([
    {
      kind: "rows",
      items: [
        {
          icon: "⚠",
          chip: { label: "UNMEASURED", tone: "error" },
          text: `${what} could not be measured — this is not an empty-and-healthy panel.`,
          detail: error.slice(0, 1000),
        },
      ],
    },
  ]);
}

// The rib's explicit empty signal: zero sections hides the region entirely.
const HIDDEN: Board = { view: "board", sections: [] };

function daysAgo(iso: string | undefined, now: Date): string {
  if (!iso) return "age unknown";
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
  if (days === 0) return "touched today";
  return `quiet ${days}d`;
}

// ── Pulse: the flow strip IS the pulse. The four stat tiles it once carried
// each restated a strip population — kept only because a segment had no
// unmeasured affordance while a tile could show `?`. Now `n: null` renders a
// hatched slot (unmeasured is not zero), so the strip carries its own
// fail-closed reading per stage and the tiles retire whole, per the board
// guidance: don't repeat one fact across sections. The counts still read
// from the strip's own legend.
export function composePulse(m: ProjectMeasurement): Board {
  if (!m.summary.ok) return failedBoard("the KPI summary", m.summary.error);
  const s = m.summary.data;
  // The strip is a distribution, so its populations must be disjoint — which
  // the panels deliberately are not (a claimed bead can sit in the blocked
  // union too; that overlap is the two-channel grammar). For the strip only,
  // the overlap folds INTO "In progress": the waiting still shows on the
  // bead's own card as a rail, so no signal is lost, and the segments sum to
  // a population instead of double-counting one bead across two stages.
  // "Done 7d" is a window, not a stage, and its label says so.
  const split = stageSplit(m);
  // Each stage measures independently: a failed input hatches ITS segment
  // while the rest keep answering. "Waiting" needs the claimed-set
  // subtraction, so it hatches when either the blocked union or the
  // in-progress list is unmeasured.
  //
  // The stages are one ordered flow, so they wear the ordinal ramp
  // (light→dark tracks waiting→done) rather than five unrelated semantic
  // hues — "waiting" must not borrow the tone that elsewhere means
  // "nothing to say", nor "done" the brand hue.
  const wipIds = new Set(m.inProgress.ok ? m.inProgress.data.map((i) => i.id) : []);
  const segments: Extract<BoardSection, { kind: "segments" }>["items"] = [
    {
      label: "Waiting",
      n:
        m.blocked.ok && m.inProgress.ok
          ? m.blocked.data.filter((b) => !wipIds.has(b.id)).length
          : null,
      tone: "ramp-1",
    },
    { label: "Ready", n: m.ready.ok ? m.ready.data.length : null, tone: "ramp-2" },
    { label: "In progress", n: split.ok ? split.data.working.length : null, tone: "ramp-3" },
    { label: "In review", n: split.ok ? split.data.inReview.length : null, tone: "ramp-4" },
    {
      label: "Done 7d",
      n: m.recentlyClosed.ok ? m.recentlyClosed.data.length : null,
      tone: "ramp-5",
    },
  ];
  const flowFailures = [
    ...(m.blocked.ok ? [] : [`waiting: ${m.blocked.error}`]),
    ...(m.ready.ok ? [] : [`ready: ${m.ready.error}`]),
    ...(split.ok ? [] : [`stage split: ${split.error}`]),
    ...(m.recentlyClosed.ok ? [] : [`closes: ${m.recentlyClosed.error}`]),
  ];
  // The caption names the strip's population and its exclusions, because the
  // header chip counts a DIFFERENT population (bd's open count includes the
  // epics the strip excludes as structure) and a numerate reader's first move
  // is to reconcile the two. Only a fully measured strip claims a total; the
  // exclusion clauses degrade independently, Plan-style, when their source
  // is unmeasured.
  const allMeasured = segments.every((s) => s.n !== null);
  const flowTotal = segments.reduce((a, s) => a + (s.n ?? 0), 0);
  const epicCount = m.epics.ok ? m.epics.data.length : 0;
  const deferredCount = m.backlog.ok
    ? m.backlog.data.filter((i) => i.status === "deferred").length
    : 0;
  const stripTitle = allMeasured
    ? [
        `Flow — ${flowTotal} work item${flowTotal === 1 ? "" : "s"}`,
        ...(epicCount > 0 ? [`${epicCount} epic${epicCount === 1 ? "" : "s"} excluded`] : []),
        ...(deferredCount > 0 ? [`${deferredCount} deferred not shown`] : []),
      ].join(" · ")
    : undefined;
  return board(
    [
      // A `segments` SECTION, not `header.segments`: the surface renders
      // header segments legend-only in the region head, while a section gets
      // the full-width proportional strip (with its own count legend).
      { kind: "segments", ...(stripTitle ? { title: stripTitle } : {}), items: segments },
      // The hatch says WHICH stage is unmeasured; this line says WHY.
      ...(flowFailures.length === 0
        ? []
        : ([
            {
              kind: "rows",
              items: [
                {
                  icon: "⚠",
                  chip: { label: "UNMEASURED", tone: "error" },
                  text: "hatched segments could not be measured — never read them as zero.",
                  detail: flowFailures.join("\n").slice(0, 1000),
                },
              ],
            },
          ] satisfies BoardSection[])),
    ],
    {
      status: { label: m.project.name, tone: "ok" },
      chip: `${s.open_issues} open · measured ${m.asOf.slice(0, 16).replace("T", " ")}Z`,
    },
  );
}

// ── Recommended next: one confident pick with its unlock chain and actions.
export function composeRecommend(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.ready.ok) return failedBoard("the ready queue", m.ready.error);
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const { pick, runnerUp } = recommendNext(m.ready.data);
  if (!pick) {
    return board([
      {
        kind: "rows",
        items: [
          {
            glyph: "warn",
            text: "Nothing is ready to start — everything open is blocked or deferred. See Needs attention for what would release work.",
          },
        ],
      },
    ]);
  }
  // Two metrics, deliberately not one word. They answer different questions
  // and can legitimately disagree, so forcing them into a single "unlocks N"
  // meant the headline and the evidence beneath it contradicted each other:
  //
  //   downstream — declared `dependent_count`. Everything that hangs off this
  //     bead, ever. Complete, authoritative, and what recommendNext ranks on.
  //   releases now — measured blocked edges that go ready the moment this
  //     closes. Explains the immediate consequence and is what the hop chain
  //     audits. Bounded by the blocked union, so it undercounts, never invents.
  //
  // The case that broke the single word now reads honestly:
  // `3 downstream · releases 0 now` — the leverage is real but deferred.
  const levels = unlockLevels(pick.id, blocked);
  const downstream = pick.dependent_count ?? 0;
  const releasesNow = levels[0]?.length ?? 0;
  const leverage =
    downstream > 0 || releasesNow > 0
      ? `${downstream} downstream · releases ${releasesNow} now`
      : "nothing waits on it — picked on priority";
  const mergedPick = mergedPR(m.prInfo, pick.id);
  const fields: { label?: string; value?: string }[] = [
    {
      value: `${mergedPick ? "merged PR · close pending (still ready in bd)" : "ready"} · ${personOf(pick) ?? "unclaimed"} · P${pick.priority} · ${leverage}`,
    },
  ];
  // The chain itself, hop by hop — one arrow per level, names inside a level
  // comma-joined. This is what makes the leverage claim auditable at a glance
  // instead of a number you have to trust. At a glance is the constraint: a
  // deep graph turns the full BFS into three lines of ids, so past a handful
  // the first hop stays verbatim (it is what "releases N now" audits) and
  // the deeper levels compress to a count.
  if (levels.length > 0) {
    const CHAIN_ID_CAP = 8;
    const total = levels.reduce((a, lvl) => a + lvl.length, 0);
    if (total <= CHAIN_ID_CAP) {
      const hops = levels.map((lvl) => lvl.map((b) => b.id).join(", "));
      fields.push({ value: [pick.id, ...hops].join(" → ") });
    } else {
      const first = levels[0] ?? [];
      const firstShown = first.slice(0, CHAIN_ID_CAP);
      const firstText =
        firstShown.map((b) => b.id).join(", ") +
        (first.length > firstShown.length ? ` +${first.length - firstShown.length} more` : "");
      const deeper = total - first.length;
      const deeperLevels = levels.length - 1;
      const tail =
        deeper > 0
          ? ` → … ${deeper} more across ${deeperLevels} level${deeperLevels === 1 ? "" : "s"}`
          : "";
      fields.push({ value: `${pick.id} → ${firstText}${tail}` });
    }
  }
  return board([
    {
      kind: "cards",
      items: [
        {
          title: pick.title,
          pill: { label: pick.id, tone: "neutral" },
          dot: "accent",
          stacked: true,
          selected: ctx.selectedId === pick.id,
          fields,
          actions: [
            {
              type: "select-bead",
              label: "Inspect",
              payload: { id: pick.id },
            },
            mergedPick
              ? reconcileAction(m.project.id)
              : {
                  type: "claim-bead",
                  label: "Start this bead",
                  tone: "brand",
                  payload: { id: pick.id },
                  confirm: {
                    subject: pick.id,
                    title: "Claim this bead?",
                    body: `Runs bd update ${pick.id} --claim: assigns it to you and sets it in progress.`,
                    confirmLabel: "Claim it",
                  },
                },
          ],
          footnote: runnerUp
            ? `runner-up: ${runnerUp.id} — ${clampTitle(runnerUp.title)}`
            : "the ready queue holds nothing else",
        },
      ],
    },
  ]);
}

// ── Agents at work: the in-flight band, joined to what bead-work runs
// reported. bd attributes every claim to a human (`assignee`) even when a
// workflow run holds the bead, so the card says "bead-work run" whenever a
// run note exists — attribution follows the evidence, not the field. Kept
// visible even when empty — a predictable location — but compact (one quiet
// row) rather than a dead zone.
export function composeWip(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.inProgress.ok) return failedBoard("in-progress work", m.inProgress.error);
  const now = new Date(m.asOf);
  if (m.inProgress.data.length === 0) {
    return board([
      {
        kind: "rows",
        items: [
          { glyph: "ok", text: "No agent or human holds a claim — start the recommended bead." },
        ],
      },
    ]);
  }
  // A claimed bead can also sit in the blocked union — active AND waiting.
  // Both are true at once, which is exactly why they are separate channels
  // now: the lifecycle stays `in progress`, and the waiting shows in the rail.
  const blockers = new Map<string, string[]>(
    (m.blocked.ok ? m.blocked.data : []).map((b) => [b.id, b.blocked_by ?? []]),
  );
  const index = backlogIndex(m);
  const people = assigneeView(m.inProgress.data);
  // bd attributes every claim to a human, so the hoisted "All claimed by
  // <name>" would shout the exact misattribution this panel exists to end
  // the moment a run note proves an agent holds the bead. When any note
  // exists the title counts the actors honestly instead, and the no-note
  // claims keep their human name down on the card.
  const runCount = m.inProgress.data.filter((i) => runInfoOf(m, i.id) !== undefined).length;
  const otherCount = m.inProgress.data.length - runCount;
  const title =
    runCount > 0
      ? [
          `${runCount} bead-work run${runCount === 1 ? "" : "s"}`,
          ...(otherCount > 0 ? [`${otherCount} other claim${otherCount === 1 ? "" : "s"}`] : []),
        ].join(" · ")
      : people.sharedTitle;
  return board([
    {
      kind: "cards",
      ...(title ? { title } : {}),
      items: m.inProgress.data.map((i): CardItem => {
        const person = personOf(i);
        const entry = m.runInfo.ok ? m.runInfo.data[i.id] : undefined;
        const info = entry?.ok ? entry.data : undefined;
        // Card-level degrade: this bead's show failed, so this card alarms
        // its run line while its siblings stay measured. A missing envelope
        // is the same alarm — "no note" is a measurement, absence is not.
        const runError = !m.runInfo.ok
          ? m.runInfo.error
          : entry
            ? entry.ok
              ? undefined
              : entry.error
            : "no run-note envelope for this bead";
        const prError = prFailure(m, i.id);
        const meta = [
          `P${i.priority}`,
          // The derived stage replaces the flat "in progress" word: a run
          // note means implemented-and-waiting-on-a-human, which is the state
          // close-on-merge otherwise hides.
          info ? stageChip(info, mergedPR(m.prInfo, i.id)) : "in progress",
          daysAgo(i.updated_at, now),
          ...(info ? ["bead-work run"] : []),
          // An unassigned bead beside assigned siblings is worth marking; an
          // all-unassigned panel is just the backlog default and says nothing.
          // When the hoist gave way to the run count, a no-note claim keeps
          // its human name here — the run cards deliberately do not.
          ...(people.perItem
            ? [person ?? (people.markUnassigned ? "unassigned" : "")]
            : !info && runCount > 0 && person
              ? [person]
              : []),
        ].filter(Boolean);
        const rail = decisionRail(i, {
          waitingOn: blockers.get(i.id),
          downstream: declaredDownstream(i, index),
          mergePending: Boolean(mergedPR(m.prInfo, i.id)),
        });
        const runLine = info ? [info.outcome, info.note].filter(Boolean).join(" — ") : "";
        return {
          title: clampTitle(i.title, BAND_TITLE_BUDGET),
          pill: { label: i.id, tone: "neutral" as const },
          // Lifecycle only. Stuck-ness is the rail's job now — a warn dot here
          // was the lifecycle channel answering a condition's question.
          dot: "ok" as const,
          selected: ctx.selectedId === i.id,
          action: { type: "select-bead", payload: { id: i.id } },
          fields: [
            { value: meta.join(" · ") },
            ...(info && info.prUrl !== "none" && !prError
              ? [{ label: "PR", value: prLabel(info.prUrl), href: info.prUrl }]
              : []),
            ...(runLine ? [{ value: `run: ${runLine}`.slice(0, 140) }] : []),
            ...(runError
              ? [
                  {
                    value: `UNMEASURED — run note: ${runError}`.slice(0, 120),
                    tone: "error" as const,
                  },
                ]
              : []),
            ...(prError
              ? [
                  {
                    value: `UNMEASURED — PR: ${prError}`.slice(0, 120),
                    tone: "error" as const,
                  },
                ]
              : []),
            ...(rail.length ? [{ value: rail.join(" · ") }] : []),
          ],
        };
      }),
    },
  ]);
}

// ── Needs a human: the operator's queue, most actionable first — PRs
// waiting on a merge, then the dams (blockers aggregated by what they hold),
// then hand-paused work, stale claims, and epic closeouts. The per-bead
// blocked listing this replaces printed the same dam once per held bead —
// eleven mentions, zero aggregation — so the grouping IS the redesign.
export function composeAttention(m: ProjectMeasurement, ctx: PanelContext): Board {
  const now = new Date(m.asOf);
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const index = backlogIndex(m);
  const readyIds = new Set(m.ready.ok ? m.ready.data.map((i) => i.id) : []);
  const sections: BoardSection[] = [];
  // A measured zero is quiet; a failed measurement must not be. A conditional
  // section that renders nothing on failure is indistinguishable from a clean
  // board, so every input this panel folds in alarms inline on failure.
  const alarmRow = (what: string, error: string): BoardSection => ({
    kind: "rows",
    items: [
      {
        icon: "⚠",
        chip: { label: "UNMEASURED", tone: "error" },
        text: `${what} could not be measured — this is not an empty-and-healthy panel.`,
        detail: error.slice(0, 1000),
      },
    ],
  });

  // Merge drift is independent of the blocked query and of note outcome prose.
  if (!m.prInfo.ok) {
    sections.push(alarmRow("PR merge state", m.prInfo.error));
  } else {
    const drift = m.backlog.ok
      ? m.backlog.data.flatMap((i) => {
          const pr = mergedPR(m.prInfo, i.id);
          return pr && (i.status === "open" || i.status === "in_progress") ? [{ i, pr }] : [];
        })
      : [];
    if (drift.length > 0) {
      sections.push({
        kind: "cards",
        title: "Merged PRs — close pending",
        items: drift.map(
          ({ i, pr }): CardItem => ({
            title: clampTitle(i.title, BAND_TITLE_BUDGET),
            pill: { label: i.id, tone: "neutral" },
            dot: "warn",
            fields: [
              { label: "PR", value: prLabel(pr.url), href: pr.url },
              { value: `merged ${pr.mergedAt} · bead still ${i.status}` },
            ],
            actions: [
              { type: "select-bead", label: "Inspect", payload: { id: i.id } },
              reconcileAction(m.project.id),
            ],
          }),
        ),
      });
    }
    if (!m.backlog.ok) sections.push(alarmRow("merge drift backlog", m.backlog.error));
    const failures = Object.entries(m.prInfo.data)
      .filter(([, entry]) => !entry.ok)
      .map(([id, entry]) => `${id}: ${entry.ok ? "" : entry.error}`);
    if (failures.length)
      sections.push(alarmRow("PR merge state for some beads", failures.join("\n")));
  }
  if (!m.blocked.ok) sections.push(alarmRow("the blocked union", m.blocked.error));

  // (a) Review to merge — the human act only a human can do. The whole row
  // links to the PR: merging happens there, not in the inspector.
  const split = stageSplit(m);
  if (!split.ok) {
    sections.push(alarmRow("review-stage work", split.error));
  } else if (split.data.inReview.some((i) => !mergedPR(m.prInfo, i.id))) {
    sections.push({
      kind: "rows",
      title: "Review to merge",
      items: split.data.inReview
        .filter((i) => !mergedPR(m.prInfo, i.id))
        .map((i) => {
          const info = runInfoOf(m, i.id);
          return {
            glyph: "info" as const,
            chip: { label: i.id, tone: "neutral" as const },
            text: i.title,
            ...(info && info.prUrl !== "none" && !prFailure(m, i.id) ? { href: info.prUrl } : {}),
            trailing: [info ? stageChip(info) : "in review", daysAgo(i.updated_at, now)].join(
              " · ",
            ),
          };
        }),
    });
  } else if (split.data.working.length > 0) {
    // The predictable location states its emptiness: while claims are still
    // working, the review slot is the next thing that will ask for a human,
    // so it holds its place instead of vanishing.
    const n = split.data.working.length;
    sections.push({
      kind: "rows",
      title: "Review to merge",
      items: [
        {
          glyph: "neutral" as const,
          text: `Nothing waits on a merge yet — ${n} claim${n === 1 ? "" : "s"} still working.`,
        },
      ],
    });
  }

  // (b) Dams — ranked by held count. One ROW per dam, not a card: this
  // section's question is "which dam is biggest", and a per-row meter makes
  // that comparison pre-attentive where four lines of card prose made it a
  // reading exercise. The meter is {value, total} against the LARGEST dam
  // shown (dams sort held-desc, so index 0 carries the max) — a shared total
  // is what keeps fill lengths comparable across rows; per-row segments
  // would normalize every dam to full width and lose exactly that. The held
  // ids move to the inspector, one click away — the row keeps the counts.
  const dams = damGroups(blocked, index, readyIds);
  if (dams.length > 0) {
    const maxHeld = Math.max(1, dams[0]?.held.length ?? 1);
    sections.push({
      kind: "rows",
      title: dams.length > DAMS_CAP ? `Dams — top ${DAMS_CAP} of ${dams.length}` : "Dams",
      items: dams.slice(0, DAMS_CAP).map((d) => {
        const dot = d.blocker ? lifecycleTone(lifecycleOf(d.blocker), d.startable) : undefined;
        const rank = [
          ...(d.blocker ? [`P${d.blocker.priority}`] : []),
          `holds ${d.held.length} now`,
          ...(d.transitive > d.held.length ? [`${d.transitive} transitive`] : []),
          ...(d.startable ? ["startable now"] : []),
        ];
        return {
          ...(dot ? { glyph: dot } : {}),
          chip: { label: d.blockerId, tone: "neutral" as const },
          text: d.blocker ? clampTitle(d.blocker.title, BAND_TITLE_BUDGET) : d.blockerId,
          bar: { value: d.held.length, total: maxHeld },
          trailing: rank.join(" · "),
          action: { type: "select-bead" as const, payload: { id: d.blockerId } },
          selected: ctx.selectedId === d.blockerId,
        };
      }),
    });
  }

  // (c) Paused by hand — status-blocked with no dependency edge: someone
  // stopped this on purpose, and only a person can decide to resume it.
  const paused = blocked.filter((i) => !i.blocked_by?.length);
  if (paused.length > 0) {
    sections.push({
      kind: "cards",
      title: "Paused by hand",
      items: paused.slice(0, ATTENTION_CAP).map(
        (i): CardItem => ({
          title: clampTitle(i.title, BAND_TITLE_BUDGET),
          pill: { label: i.id, tone: "neutral" as const },
          selected: ctx.selectedId === i.id,
          action: { type: "select-bead", payload: { id: i.id } },
          fields: [{ value: [`P${i.priority}`, "paused by hand"].join(" · ") }],
        }),
      ),
    });
  }

  // (d) Stale claims.
  const staleItems = m.stale.ok ? m.stale.data : [];
  if (!m.stale.ok) sections.push(alarmRow("stale claims", m.stale.error));
  if (staleItems.length > 0)
    sections.push({
      kind: "cards",
      title: `Stale ${STALE_DAYS}d+`,
      items: staleItems.map((i) => ({
        title: clampTitle(i.title, BAND_TITLE_BUDGET),
        pill: { label: i.id, tone: "neutral" as const },
        dot: "warn" as const,
        selected: ctx.selectedId === i.id,
        action: { type: "select-bead", payload: { id: i.id } },
        fields: [{ value: `claimed but ${daysAgo(i.updated_at, now)} — verify or release` }],
      })),
    });

  // (e) Epic closeouts — a review ask, never a close button: closing is a
  // merge-time human act with a written reason, so the action inspects.
  if (!m.epics.ok) {
    sections.push(alarmRow("epic closeout eligibility", m.epics.error));
  } else {
    const eligible = m.epics.data.filter((r) => r.eligible_for_close);
    if (eligible.length > 0)
      sections.push({
        kind: "cards",
        title: "Epic closeout review",
        items: eligible.map(
          (r): CardItem => ({
            title: clampTitle(r.epic.title, BAND_TITLE_BUDGET),
            pill: { label: r.epic.id, tone: "neutral" as const },
            dot: "warn" as const,
            selected: ctx.selectedId === r.epic.id,
            ...(r.total_children > 0
              ? { bar: { value: r.closed_children, total: r.total_children } }
              : {}),
            action: { type: "select-bead", payload: { id: r.epic.id } },
            fields: [
              {
                value: `epic · ${r.closed_children}/${r.total_children} done · closeout review`,
              },
            ],
          }),
        ),
      });
  }

  // Sections can only be empty when every input measured (each failure alarms
  // above), so an empty panel is a real all-clear — except for the theoretical
  // bead whose every edge was structural: that one still renders in the Plan
  // with its rail, and the count here keeps this panel from hiding it.
  if (sections.length === 0) {
    if (blocked.length === 0) {
      return board([
        {
          kind: "rows",
          items: [
            {
              glyph: "ok",
              text: "Nothing needs a human — no reviews waiting, no dams, no stale claims, no closeouts.",
            },
          ],
        },
      ]);
    }
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: `${blocked.length} blocked bead${blocked.length === 1 ? "" : "s"} carry only structural edges — they render in the Plan with their rails.`,
        },
      ],
    });
  }
  return board(sections);
}

// ── The Plan: the one canonical inventory, grouped by hierarchy — a flat
// grid erased the dependency/epic structure that makes beads distinctive.
// Epics render as boxed panels: the epic lives in the section title (with
// its n/m meter), its children are the cards — epics are structure, never
// work items. A non-epic parent leads its own boxed group (it IS work), └
// marking its children. Everything unparented flows under "Standalone work".
// Cards stay short: title, id, state dot, and one line of
// priority · state · leverage. Clicking a card opens the inspector —
// descriptions live there, so the inventory never stretches.
//
// Two section flags are deliberately absent, both measured on the surface:
// `boxed` renders the single meta field as a stacked inset pill (an
// affordance for copyable credential lists, not a one-line state readout),
// and `columns` declares bench capacity — its "set size" is height as well as
// width, so every card holds a fixed seat and short ones sit in dead space.
// Auto-fit `grid` alone lets a card end where its content ends.
//
// Height is then bounded at the source instead: the card owes you enough to
// recognize a bead, not the whole sentence — the inspector one click away
// holds the full title. Budgeting the title to about two wrapped lines keeps
// a card to three rows including its meta line, and uniform title lengths
// make auto-fit rows land level, which is the rhythm `columns` was buying.
//
// The budget is a character count standing in for a line count: the host owns
// the track width, so a narrow surface can still wrap a capped title to three
// lines. It bounds the worst case rather than guaranteeing an exact one.
const PLAN_TITLE_BUDGET = 64;
// The operational band is one or two wide cards, not an auto-fit grid, so it
// has no density pressure to answer for and a title that survives is worth
// more than a level row. Measured across the live tracker's titles (median 60,
// max 107), the Plan's 64 clamps roughly half while this clamps the outliers
// only.
const BAND_TITLE_BUDGET = 96;

export const clampTitle = (raw: string, budget: number = PLAN_TITLE_BUDGET): string => {
  if (raw.length <= budget) return raw;
  const cut = raw.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  // Break on a word when one is near the end; mid-word otherwise, so a single
  // long token (a path, an identifier) still gets cut rather than escaping.
  const kept = lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
};

export function composePlan(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.backlog.ok) return failedBoard("the backlog inventory", m.backlog.error);
  if (m.backlog.data.length === 0) return HIDDEN;
  const readyIds = new Set(m.ready.ok ? m.ready.data.map((i) => i.id) : []);
  const epicProgress = new Map<string, BdEpicRow>(
    (m.epics.ok ? m.epics.data : []).map((row) => [row.epic.id, row]),
  );
  const blockers = new Map<string, string[]>(
    (m.blocked.ok ? m.blocked.data : []).map((b) => [b.id, b.blocked_by ?? []]),
  );
  const index = backlogIndex(m);
  // The meta line answers "what is this bead"; the rail answers "why should I
  // look at it". Priority and lifecycle are always-present facts, so they sit
  // in the meta; everything conditional goes right, in one place.
  const meta = (i: BdIssue): string => {
    const life = lifecycleChip(lifecycleOf(i));
    return [`P${i.priority}`, ...(life ? [life] : [])].join(" · ");
  };
  const railOf = (i: BdIssue): string[] =>
    decisionRail(i, {
      waitingOn: blockers.get(i.id),
      // The Plan shows DECLARED downstream only. `releases N now` is measured,
      // volatile and costlier, and it earns its place when weighing one
      // specific action — not while scanning an inventory.
      downstream: declaredDownstream(i, index),
      handPaused: i.status === "blocked" && (blockers.get(i.id)?.length ?? 0) === 0,
      closeout: epicProgress.get(i.id)?.eligible_for_close,
      mergePending: Boolean(mergedPR(m.prInfo, i.id)),
    });
  const card = (i: BdIssue, child = false): CardItem => {
    const dot = lifecycleTone(lifecycleOf(i), readyIds.has(i.id));
    const rail = railOf(i);
    return {
      title: `${child ? "└ " : ""}${clampTitle(i.title)}`,
      pill: { label: i.id, tone: "neutral" as const },
      ...(dot ? { dot } : {}),
      selected: ctx.selectedId === i.id,
      action: { type: "select-bead", payload: { id: i.id } },
      // Cards have no right-aligned slot, so the rail is a POSITION rather
      // than an alignment: always the last field, present only when it has
      // something to say. Fields join inline, so it reads as the tail.
      fields: [{ value: meta(i) }, ...(rail.length ? [{ value: rail.join(" · ") }] : [])],
    };
  };

  // Epic membership edges; when unmeasured the plan degrades to dotted-id
  // parentage — every bead still renders, just less grouped.
  const childToParent = new Map<string, string>();
  if (m.epicChildren.ok) {
    for (const [epicId, childIds] of Object.entries(m.epicChildren.data)) {
      for (const id of childIds) childToParent.set(id, epicId);
    }
  }
  const groups = planGroups(m.backlog.data, childToParent);
  const epicFamilies = groups.filter((g) => g.root.issue_type === "epic");
  const parentFamilies = groups.filter(
    (g) => g.root.issue_type !== "epic" && g.children.length > 0,
  );
  const singles = groups
    .filter((g) => g.root.issue_type !== "epic" && g.children.length === 0)
    .map((g) => g.root);

  const total = m.backlog.data.length;
  const sections: BoardSection[] = [];
  let shown = 0;
  const room = () => PLAN_CAP - shown;
  const push = (title: string | undefined, items: CardItem[]) => {
    if (items.length === 0) return;
    sections.push({
      kind: "cards",
      grid: true,
      ...(title ? { title } : {}),
      items,
    });
    shown += items.length;
  };
  // Closed children are evidence, not authorization: they do not demonstrate
  // that the epic's own acceptance criteria are met, and closing here is a
  // merge-time act carrying a written reason — which is why this rib never
  // auto-closes anything. So the exception asks for a look, never offers the
  // close, and its action is `select-bead` (open the inspector, read it, then
  // decide) rather than the `claim-bead` mutation every other card carries.
  const eligibleEpics = epicFamilies.filter((f) => epicProgress.get(f.root.id)?.eligible_for_close);
  if (eligibleEpics.length > 0) {
    sections.push({
      kind: "rows",
      items: [
        {
          icon: "▸",
          chip: { label: "closeout review", tone: "warn" },
          text: `${eligibleEpics.length} epic${eligibleEpics.length === 1 ? "" : "s"} ${eligibleEpics.length === 1 ? "has" : "have"} no open children left — review ${eligibleEpics.length === 1 ? "it" : "them"} against the epic's own acceptance criteria before closing.`,
          trailing: eligibleEpics.map((f) => f.root.id).join(", "),
        },
      ],
    });
  }
  for (const fam of epicFamilies) {
    if (room() <= 0) break;
    const p = epicProgress.get(fam.root.id);
    const meter = p
      ? ` — ${p.closed_children}/${p.total_children} done${p.eligible_for_close ? " · needs closeout review" : ""}`
      : "";
    // An epic whose open children have all closed still needs a face: the
    // epic card itself stands in so the group never renders empty — and when
    // it is eligible that card is also where the review action lives.
    const items: CardItem[] = fam.children.length
      ? fam.children.slice(0, room()).map((c) => card(c))
      : [card(fam.root)];
    if (p?.eligible_for_close) {
      items.unshift({
        ...card(fam.root),
        fields: [{ value: `epic · ${p.closed_children}/${p.total_children} done` }],
        actions: [{ type: "select-bead", label: "Review epic", payload: { id: fam.root.id } }],
      });
    }
    push(`▸ ${fam.root.title}${meter}`, items);
    // The epic itself is on screen — as the group title, or as the leading
    // review card when eligible (which `push` already counted). Leaving it out
    // of the tally made the caption read "Showing 45 of 50" on a Plan that was
    // hiding nothing, which is a truncation warning that cries wolf.
    if (!p?.eligible_for_close) shown += 1;
  }
  for (const fam of parentFamilies) {
    if (room() <= 0) break;
    push(undefined, [card(fam.root), ...fam.children.map((c) => card(c, true))].slice(0, room()));
  }
  // Standalone work is the long tail — unparented beads with no structure to
  // show. Rendering it as more of the same grid turned the bottom of the page
  // into wallpaper, so it gets the other shape: one dense line per bead,
  // id · title · state, which both compresses the tail and gives the page a
  // second rhythm against the boxed groups above.
  //
  // Rows carry the cards click contract now, so the tail selects into the
  // inspector like everything else — which is strictly more than the old
  // inline `detail` disclosure said (the inspector adds links, actions, and
  // full prose), and `action` and `detail` are mutually exclusive anyway.
  if (room() > 0 && singles.length > 0) {
    const tail = singles.slice(0, room());
    sections.push({
      kind: "rows",
      title: "Standalone work",
      items: tail.map((i) => {
        const dot = lifecycleTone(lifecycleOf(i), readyIds.has(i.id));
        // A row DOES have a right-aligned slot, so here the rail is literal:
        // meta first, exceptions last, in the same order the cards use.
        return {
          ...(dot ? { glyph: dot } : {}),
          chip: { label: i.id, tone: "neutral" as const },
          text: i.title,
          trailing: [meta(i), ...railOf(i)].join(" · "),
          action: { type: "select-bead" as const, payload: { id: i.id } },
          selected: ctx.selectedId === i.id,
        };
      }),
    });
    shown += tail.length;
  }
  sections.push({
    kind: "rows",
    items: [
      {
        icon: "ℹ",
        chip: { label: "how to read this", tone: "neutral" },
        text: `Dot color is lifecycle: teal startable · green in progress · blue on hold. The trailing note is the exception — waiting on, N downstream, bug, closeout review — and most beads have none. ▸ panels are epics (their beads inside), └ marks a bead under the parent leading its box. P0 is most urgent, P4 least. Click any card or row to open it in the inspector.${shown < total ? ` Showing ${shown} of ${total}.` : ""}`,
      },
    ],
  });
  return board(sections);
}

// ── The inspector: the selected bead in full — meta, dependency links both
// ways, description and acceptance criteria as wrapped prose. `recommended`
// is the board's current pick, offered as the alternative when the inspected
// bead itself cannot be started.
export interface InspectOptions {
  // Present only when the inspected bead is an epic the measurement knows —
  // it turns the structural notice into a closeout review with real counts.
  epicRow?: BdEpicRow;
  // The bead arrived from the board's recommendation rather than a click, so
  // the panel says so instead of impersonating a selection.
  preselected?: boolean;
  prInfo?: ProjectMeasurement["prInfo"];
  projectId?: string;
}

export function composeInspect(
  issue: Measured<BdIssue> | undefined,
  blocked: BdIssue[],
  recommended?: BdIssue,
  opts: InspectOptions = {},
): Board {
  const { epicRow, preselected } = opts;
  if (!issue) {
    return board([
      {
        kind: "rows",
        items: [
          {
            glyph: "neutral",
            text: "Nothing selected — click any card in the Plan, the recommendation, or Needs attention to inspect it here.",
          },
        ],
      },
    ]);
  }
  if (!issue.ok) return failedBoard("the selected bead", issue.error);
  const i = issue.data;
  const merged =
    i.status === "open" || i.status === "in_progress" ? mergedPR(opts.prInfo, i.id) : undefined;
  const mergedAlternative = recommended && mergedPR(opts.prInfo, recommended.id);
  const linked = (list: readonly BdLinked[] | null | undefined): string[] =>
    (list ?? []).map((l) => {
      const id = l.id ?? l.depends_on_id ?? l.issue_id ?? "?";
      return l.title ? `${id} — ${l.title}` : id;
    });
  // Only dependencies that still hold anything up. `bd show` returns every
  // edge ever declared, closed ones included, so listing them raw put a
  // satisfied dependency under "Waits on" directly beneath an enabled "Start
  // this bead" — the panel telling you to start and to wait in one breath.
  // Unknown status is kept: absence of proof that it is done is not proof.
  const waitsOn = linked((i.dependencies ?? []).filter((d) => d.status !== "closed"));
  const unlocks = linked(i.dependents);
  const blockedEntry = blocked.find((b) => b.id === i.id);
  const blockedBy = blockedEntry?.blocked_by ?? [];
  // Blocked means the union says so OR the status is blocked by hand: either
  // way, starting THIS bead is the wrong move and the action must say so.
  const isBlocked = i.status === "blocked" || blockedEntry !== undefined;
  const blockerCount = blockedBy.length || waitsOn.length;
  const meta: LeafSection = {
    kind: "rows",
    boxed: true,
    items: [
      { text: "status", trailing: `${statusGlyph(i.status)} ${i.status.replace("_", " ")}` },
      { text: "priority", trailing: `P${i.priority}` },
      { text: "owner", trailing: i.assignee ?? i.owner ?? "unassigned" },
      ...(i.issue_type ? [{ text: "type", trailing: i.issue_type }] : []),
      ...(i.labels?.length ? [{ text: "labels", trailing: i.labels.join(", ") }] : []),
      { text: "updated", trailing: (i.updated_at ?? "").slice(0, 10) || "—" },
      ...(i.comment_count ? [{ text: "comments", trailing: String(i.comment_count) }] : []),
    ],
  };
  // The panel is a full-width band: facts and links in a narrow left column,
  // prose given the remaining two-thirds — short and wide, never a tall
  // sliver beside the Plan.
  const left: LeafSection[] = [meta];
  // Nothing was clicked — say so plainly. The panel showing the pick is more
  // useful than an empty neutral state, but it must not read as a selection
  // the operator made, or the next click will feel like it changed nothing.
  if (preselected) {
    left.unshift({
      kind: "rows",
      items: [
        {
          glyph: "accent",
          chip: { label: "the board's pick", tone: "accent" },
          text: merged
            ? "Nothing selected yet — this is the board's pick, but its PR has merged. Reconcile it instead of starting it again."
            : "Nothing selected yet — this is what the board recommends starting. Click any card to inspect that bead instead.",
        },
      ],
    });
  }
  const right: LeafSection[] = [];
  if (isBlocked) {
    left.push({
      kind: "rows",
      items: [
        {
          glyph: "error",
          chip: { label: "blocked", tone: "error" },
          text: blockerCount
            ? `Blocked by ${blockerCount} bead${blockerCount === 1 ? "" : "s"} — listed under “Waits on” below.`
            : "Paused by hand — no blocking dependency recorded.",
        },
      ],
    });
  }
  if (merged) {
    left.push({
      kind: "rows",
      items: [
        {
          glyph: "warn",
          chip: { label: "merged PR · close pending", tone: "warn" },
          text: `PR ${merged.url} merged ${merged.mergedAt}; the bead remains ${i.status}. Reconcile after reviewing the recorded link.`,
          href: merged.url,
        },
      ],
    });
    if (opts.projectId) left.push({ kind: "actions", items: [reconcileAction(opts.projectId)] });
  }
  // An epic is structure, never a work item — so the inspector must not offer
  // to start one. Without this an open epic renders the same "Start this bead"
  // claim button as any task, which is the same contract breach the ready
  // query already prevents with `--exclude-type=epic`.
  if (i.issue_type === "epic") {
    const p = epicRow?.epic.id === i.id ? epicRow : undefined;
    left.push({
      kind: "rows",
      items: [
        {
          glyph: p?.eligible_for_close ? "warn" : "neutral",
          chip: { label: "epic", tone: "neutral" },
          text: p?.eligible_for_close
            ? `All ${p.total_children} children are closed. Review this epic against its own acceptance criteria before manual close${merged ? " or reconciling its own linked PR" : ""}.`
            : "An epic is structure, not work — start one of its children instead.",
          ...(p ? { trailing: `${p.closed_children}/${p.total_children} done` } : {}),
        },
      ],
    });
  } else if (!merged && i.status !== "closed" && i.status !== "in_progress") {
    const claim = (id: string, label: string, disabled?: { reason: string }) => ({
      type: "claim-bead",
      label,
      tone: "brand" as const,
      payload: { id },
      ...(disabled
        ? { disabled: true, reason: disabled.reason }
        : {
            confirm: {
              subject: id,
              title: "Claim this bead?",
              body: `Runs bd update ${id} --claim: assigns it to you and sets it in progress.`,
              confirmLabel: "Claim it",
            },
          }),
    });
    left.push({
      kind: "actions",
      // Starting blocked work is a semantic error, not a preference: the
      // primary action disables itself and offers the board's pick instead.
      items: isBlocked
        ? [
            claim(i.id, "Start this bead", {
              reason: blockerCount
                ? `blocked by ${blockerCount} bead${blockerCount === 1 ? "" : "s"}`
                : "paused by hand",
            }),
            ...(recommended && recommended.id !== i.id
              ? mergedAlternative
                ? opts.projectId
                  ? [reconcileAction(opts.projectId)]
                  : []
                : [claim(recommended.id, `Start ${recommended.id} instead`)]
              : []),
          ]
        : [claim(i.id, "Start this bead")],
    });
  }
  if (waitsOn.length || blockedBy.length) {
    left.push({
      kind: "rows",
      title: "Waits on",
      items: (waitsOn.length ? waitsOn : blockedBy).map((text) => ({ icon: "●", text })),
    });
  }
  if (unlocks.length) {
    left.push({
      kind: "rows",
      title: "Unlocks when done",
      items: unlocks.map((text) => ({ icon: "↗", text })),
    });
  }
  const prose = (label: string, body: string | undefined) => {
    if (!body?.trim()) return;
    const paras = body
      .trim()
      .split(/\n{2,}/)
      .slice(0, PARA_CAP);
    right.push({
      kind: "rows",
      title: label,
      items: paras.map((p) => ({ text: p })),
    });
  };
  prose("Description", i.description);
  prose("Acceptance criteria", i.acceptance_criteria);
  prose("Notes", i.notes);
  if (right.length === 0) {
    right.push({
      kind: "rows",
      items: [{ glyph: "neutral", text: "No description recorded on this bead." }],
    });
  }
  const sections: BoardSection[] = [
    {
      kind: "columns",
      // The trailing empty column caps the reading measure: without it, prose
      // stretches across the whole band on a wide display (~110ch lines). The
      // remaining space stays deliberately unfilled.
      columns: [
        { weight: 1, sections: left },
        { weight: 2, sections: right },
        { weight: 0.8, sections: [] },
      ],
    },
  ];
  return board(sections, {
    status: {
      label: `${i.id} · ${i.status.replace("_", " ")}`,
      tone: i.status === "blocked" ? "error" : i.status === "in_progress" ? "ok" : "neutral",
    },
    chip: i.title.slice(0, 80),
  });
}

// ── Portfolio: one meter per epic — how far along each initiative is, read
// at a glance. Cards, not bars: a bars section carries no action, and every
// meter here must open the inspector (where an eligible epic's closeout
// review already lives).
export function composePortfolio(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.epics.ok) return failedBoard("the epic portfolio", m.epics.error);
  if (m.epics.data.length === 0) return HIDDEN;
  const wipIds = new Set(m.inProgress.ok ? m.inProgress.data.map((i) => i.id) : []);
  const blockedBy = new Map<string, readonly string[]>(
    (m.blocked.ok ? m.blocked.data : []).map((b) => [b.id, b.blocked_by ?? []]),
  );
  // The meter's stage composition — the flow strip's vocabulary at epic
  // scale, same stage→tone mapping, mirrored order: a meter fills from the
  // left with what is furthest along, so done (darkest) anchors left and
  // waiting (lightest) trails. Composition needs every stage set measured;
  // otherwise the meter degrades to the plain done/total fill.
  const split = stageSplit(m);
  const stagesMeasured = m.epicChildren.ok && m.ready.ok && split.ok;
  const readyIds = new Set(m.ready.ok ? m.ready.data.map((i) => i.id) : []);
  const reviewIds = new Set(split.ok ? split.data.inReview.map((i) => i.id) : []);
  const workingIds = new Set(split.ok ? split.data.working.map((i) => i.id) : []);
  const rows = m.epics.data.map((r) => {
    // In-flight children and the gate only when membership measured — the
    // Plan's degrade precedent: the meter stays, the clauses drop.
    const childIds = m.epicChildren.ok ? (m.epicChildren.data[r.epic.id] ?? []) : [];
    const inFlight = m.inProgress.ok ? childIds.filter((id) => wipIds.has(id)).length : 0;
    const gate =
      m.blocked.ok && childIds.length > 0 ? epicGate(childIds, blockedBy, wipIds) : undefined;
    const ratio = r.total_children > 0 ? r.closed_children / r.total_children : 0;
    return { r, childIds, inFlight, gate, ratio };
  });
  // The five-second read is the SORT: where the agents are first, then what
  // is nearly landed, parked epics last. bd's own order buried the one
  // active epic beneath four untouched ones.
  rows.sort((a, b) => {
    if (a.inFlight !== b.inFlight) return b.inFlight - a.inFlight;
    if (a.ratio !== b.ratio) return b.ratio - a.ratio;
    return byPriorityThenAge(a.r.epic, b.r.epic);
  });
  return board([
    {
      kind: "cards",
      items: rows.map(({ r, childIds, inFlight, gate }): CardItem => {
        const meta = [
          `${r.closed_children}/${r.total_children} done`,
          ...(inFlight > 0 ? [`${inFlight} in progress`] : []),
          ...(r.eligible_for_close ? ["needs closeout review"] : []),
          // The rail position: why a parked epic is parked, said once here
          // instead of once per child down in the Plan.
          ...(gate
            ? [
                gate.all
                  ? `gated on ${gate.blockerId}`
                  : `${gate.count} waiting on ${gate.blockerId}`,
              ]
            : []),
        ];
        return {
          title: clampTitle(r.epic.title, BAND_TITLE_BUDGET),
          pill: { label: r.epic.id, tone: "neutral" as const },
          // warn, not ok: an epic with nothing open left is an ask on a
          // human's time, and this rib never closes it for you.
          ...(r.eligible_for_close ? { dot: "warn" as const } : {}),
          selected: ctx.selectedId === r.epic.id,
          ...(r.total_children > 0
            ? {
                bar: (() => {
                  if (!stagesMeasured) return { value: r.closed_children, total: r.total_children };
                  // childIds includes closed children (membership is every
                  // parent-child edge), so the open-stage sets intersect
                  // cleanly. The remainder is blocked or deferred children —
                  // "waiting" in the flow strip's sense, approximately: it
                  // also absorbs any child the open sets don't claim.
                  const inSet = (ids: Set<string>) => childIds.filter((id) => ids.has(id)).length;
                  const review = inSet(reviewIds);
                  const working = inSet(workingIds);
                  const ready = inSet(readyIds);
                  const waiting = Math.max(
                    0,
                    r.total_children - r.closed_children - review - working - ready,
                  );
                  return {
                    segments: [
                      { label: "done", n: r.closed_children, tone: "ramp-5" as const },
                      { label: "in review", n: review, tone: "ramp-4" as const },
                      { label: "in progress", n: working, tone: "ramp-3" as const },
                      { label: "ready", n: ready, tone: "ramp-2" as const },
                      { label: "waiting", n: waiting, tone: "ramp-1" as const },
                    ],
                  };
                })(),
              }
            : {}),
          action: { type: "select-bead", payload: { id: r.epic.id } },
          fields: [{ value: meta.join(" · ") }],
        };
      }),
    },
  ]);
}

// ── Momentum: what happened lately — a closed-vs-created chart over the
// fortnight for the shape, then the event feed for the names, newest first.
export function composeMomentum(m: ProjectMeasurement, ctx: PanelContext = {}): Board {
  if (!m.recentlyClosed.ok) return failedBoard("recent closes", m.recentlyClosed.error);
  const now = new Date(m.asOf);
  const floor = new Date(now.getTime() - RECENT_CLOSE_DAYS * 86_400_000).toISOString();
  interface MomentumEvent {
    at: string;
    icon: string;
    id: string;
    title: string;
    verb: string;
  }
  // recentlyClosed is already the 7-day window (measure.ts owns it).
  const events: MomentumEvent[] = m.recentlyClosed.data.map((i) => ({
    at: i.closed_at ?? "",
    icon: "✓",
    id: i.id,
    title: i.title,
    verb: "closed",
  }));
  const alarms: BoardSection[] = [];
  const seen = new Set(events.map((e) => e.id));
  // "touched", honestly: bd records no started_at, and updated_at moves on
  // any mutation — claim time is not knowable from here, so the feed never
  // claims it. One line per bead, most final event wins: a bead created and
  // already claimed reads as its touch; created and closed inside the window
  // reads as its close (`bd list` scope is non-closed, so no double entry).
  if (m.inProgress.ok) {
    for (const i of m.inProgress.data) {
      if ((i.updated_at ?? "") >= floor && !seen.has(i.id)) {
        seen.add(i.id);
        events.push({
          at: i.updated_at ?? "",
          icon: "◐",
          id: i.id,
          title: i.title,
          verb: "touched",
        });
      }
    }
  } else {
    alarms.push({
      kind: "rows",
      items: [
        {
          icon: "⚠",
          chip: { label: "UNMEASURED", tone: "error" },
          text: "in-progress touches could not be measured — the feed is missing them.",
          trailing: m.inProgress.error.slice(0, 120),
        },
      ],
    });
  }
  if (m.backlog.ok) {
    for (const i of m.backlog.data) {
      // New epics are structure, not momentum — the portfolio carries them.
      if (i.issue_type === "epic") continue;
      if ((i.created_at ?? "") >= floor && !seen.has(i.id)) {
        events.push({ at: i.created_at ?? "", icon: "+", id: i.id, title: i.title, verb: "new" });
      }
    }
  } else {
    alarms.push({
      kind: "rows",
      items: [
        {
          icon: "⚠",
          chip: { label: "UNMEASURED", tone: "error" },
          text: "new beads could not be measured — the feed is missing them.",
          trailing: m.backlog.error.slice(0, 120),
        },
      ],
    });
  }
  events.sort((a, b) => (a.at > b.at ? -1 : 1));
  const shown = events.slice(0, MOMENTUM_CAP);
  const sections: BoardSection[] = [];
  // One header per day instead of "3d ago" repeated on every line. Days are
  // elapsed 24h windows from asOf (the same arithmetic every age label on
  // the board uses), not calendar midnights.
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const dayLabel = (iso: string): string => {
    const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? "?"} ${Number(iso.slice(8, 10))}`;
  };
  type RowItem = Extract<BoardSection, { kind: "rows" }>["items"][number];
  let day: { title: string; items: RowItem[] } | undefined;
  for (const e of shown) {
    const label = dayLabel(e.at);
    if (!day || day.title !== label) {
      day = { title: label, items: [] };
      sections.push({ kind: "rows", title: day.title, items: day.items });
    }
    day.items.push({
      icon: e.icon,
      chip: { label: e.id, tone: "neutral" as const },
      text: e.title,
      trailing: e.verb,
      // Rows carry the cards click contract now — the feed feeds the
      // inspector like every other panel.
      action: { type: "select-bead", payload: { id: e.id } },
      selected: ctx.selectedId === e.id,
    });
  }
  // Truncation says so — a capped feed that reads complete is the quiet
  // sibling of the empty-but-healthy panel.
  if (events.length > shown.length)
    sections.push({
      kind: "rows",
      items: [{ icon: "…", text: `showing ${shown.length} of ${events.length} events this week` }],
    });
  sections.push(...alarms);
  // The chart: closes and creates bucketed into the same elapsed-24h windows
  // the day headers use, oldest day leftmost. Creates read created_at across
  // backlog ∪ recent closes (a bead created and already closed inside the
  // window is only in the closed list) and skip epics like the feed does; a
  // bead created and closed in the window counts once in EACH series — the
  // two measure different verbs. When the backlog is unmeasured the Created
  // series drops and the feed's alarm above already says why.
  const dayIndex = (iso: string): number =>
    Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  const closesPerDay: number[] = new Array(FLOW_WINDOW_DAYS).fill(0);
  const closedRecently = m.closedFortnight.ok ? m.closedFortnight.data : [];
  for (const i of closedRecently) {
    const d = dayIndex(i.closed_at ?? "");
    if (d >= 0 && d < FLOW_WINDOW_DAYS && closesPerDay[d] !== undefined) closesPerDay[d] += 1;
  }
  const createsPerDay: number[] = new Array(FLOW_WINDOW_DAYS).fill(0);
  if (m.backlog.ok) {
    for (const i of [...m.backlog.data, ...closedRecently]) {
      if (i.issue_type === "epic") continue;
      const d = dayIndex(i.created_at ?? "");
      if (d >= 0 && d < FLOW_WINDOW_DAYS && createsPerDay[d] !== undefined) createsPerDay[d] += 1;
    }
  }
  // Calendar labels throughout (today included) so the axis reads uniformly.
  const chartLabel = (daysBack: number): string => {
    const t = new Date(now.getTime() - daysBack * 86_400_000);
    return `${MONTHS[t.getUTCMonth()] ?? "?"} ${t.getUTCDate()}`;
  };
  const daysOldestFirst = Array.from(
    { length: FLOW_WINDOW_DAYS },
    (_, k) => FLOW_WINDOW_DAYS - 1 - k,
  );
  const chartHasData =
    closesPerDay.some((n) => n > 0) || (m.backlog.ok && createsPerDay.some((n) => n > 0));
  const chart: BoardSection[] = chartHasData
    ? [
        {
          kind: "chart",
          title: `Closed vs created — last ${FLOW_WINDOW_DAYS} days`,
          mark: "bar",
          series: [
            {
              label: "Closed",
              points: daysOldestFirst.map((d) => ({
                x: chartLabel(d),
                y: closesPerDay[d] ?? 0,
              })),
            },
            ...(m.backlog.ok
              ? [
                  {
                    label: "Created",
                    points: daysOldestFirst.map((d) => ({
                      x: chartLabel(d),
                      y: createsPerDay[d] ?? 0,
                    })),
                  },
                ]
              : []),
          ],
        },
      ]
    : [];
  // Zero sections only when every input measured and the fortnight was quiet.
  if (sections.length === 0 && chart.length === 0) return HIDDEN;
  return board([...chart, ...sections]);
}

// ── Scope resting states, rendered on the pulse panel (the one always-on
// region); every other panel hides itself via the zero-section signal.
export function composeNoTrackerPulse(
  projectName: string,
  beadsProjects: readonly { name: string }[],
): Board {
  return board(
    beadsProjects.length > 0
      ? [
          {
            kind: "rows",
            title: "Projects with a beads tracker",
            items: beadsProjects.map((p) => ({
              chip: { label: "beads", tone: "accent" },
              text: p.name,
            })),
          },
        ]
      : [
          {
            kind: "journey",
            items: [
              {
                title: "Register a project",
                text: "Add a keelson project whose repository carries a .beads tracker.",
              },
              {
                title: "The board measures it",
                text: "Ready, in-progress, blocked, epics, momentum and stale work — measured with bd, never inferred.",
              },
              {
                title: "Drive work from chat",
                text: "beads_ready picks the queue up; the beads-next workflow recommends what to start first.",
              },
            ],
          },
        ],
    {
      status: { label: `no beads tracker in ${projectName}`, tone: "neutral" },
      chip: "select a beads project in the picker above",
    },
  );
}

export const EMPTY_PANEL: Board = HIDDEN;
