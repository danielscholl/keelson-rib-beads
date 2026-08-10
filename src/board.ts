// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The Beads surface is an overview + inspector: each panel owns one stable
// spatial role, composed from a shared measurement. Order of attention:
// pulse → one recommendation (explained, actionable) → in-flight vs
// needs-attention → the selected-bead inspector → the Plan inventory →
// momentum. Selecting any card (action `select-bead`) opens the inspector in
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
import type { BdEpicRow, BdIssue, BdLinked, Measured } from "./bd";
import type { ProjectMeasurement } from "./measure";
import { byPriorityThenAge, STALE_DAYS } from "./measure";

const ATTENTION_CAP = 8;
const CLOSED_CAP = 8;
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

function board(sections: BoardSection[], header?: Board["header"]): Board {
  return { view: "board", ...(header ? { header } : {}), sections };
}

// A panel whose measurement failed must alarm, never render empty-healthy.
function failedBoard(what: string, error: string): Board {
  return board([
    {
      kind: "rows",
      items: [
        {
          icon: "⚠",
          chip: { label: "UNMEASURED", tone: "error" },
          text: `${what} could not be measured — this is not an empty-and-healthy panel.`,
          trailing: error.slice(0, 120),
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

// Every tile counts the population the rib measured, never bd's own summary
// number standing in for it. The two answer different questions: on the live
// tracker `summary.ready_issues` reads 35 (epics included, in-progress not
// subtracted) against a measured 31, and `summary.blocked_issues` is not the
// dep-blocked ∪ status-blocked union at all. Substituting one for the other on
// failure would quietly answer a different question than the label asks —
// a softer form of the empty-but-healthy board this surface exists to prevent.
// So a failed measurement shows `?` in an alarm tone and stays honest.
function measuredTile(
  label: string,
  measured: Measured<readonly unknown[]>,
  tone: CanvasTone,
  alarmWhenPositive = false,
): { label: string; value: number | string; tone: CanvasTone } {
  if (!measured.ok) return { label, value: "?", tone: "error" };
  const n = measured.data.length;
  return { label, value: n, tone: alarmWhenPositive && n === 0 ? "neutral" : tone };
}

// ── Pulse: the current-state numbers, plus scope + open-count context.
export function composePulse(m: ProjectMeasurement): Board {
  if (!m.summary.ok) return failedBoard("the KPI summary", m.summary.error);
  const s = m.summary.data;
  return board(
    [
      {
        kind: "stats",
        // No `sub` line anywhere: the second line cost every tile its height
        // for text the label can carry itself. What the sub used to define is
        // folded into the label — the stale tile states its own threshold — so
        // the strip loses a row without losing a measurement.
        //
        // "Startable", not "Ready now": the measured population already
        // excludes epics (structure is never work) and subtracts what is
        // already claimed, so the label names what you could actually pick up.
        //
        // "Waiting on deps", not "Blocked": this counts the blocked union,
        // which includes claimed beads that also appear in the In progress
        // tile. Blocking is a condition that overlays any lifecycle state, so
        // the overlap is correct rather than double-counting — but the word
        // "blocked" reads as an exclusive state and made it look like a bug.
        items: [
          // Four tiles, not five: stale claims are an exception, not a
          // standing measure of the project, so they surface in Needs
          // attention when nonzero (and alarm there when unmeasured) rather
          // than holding a permanent tile that reads 0 on a healthy board.
          measuredTile("Startable", m.ready, "accent"),
          measuredTile("In progress", m.inProgress, "ok"),
          measuredTile("Waiting on deps", m.blocked, "error", true),
          measuredTile("Closed this week", m.recentlyClosed, "neutral"),
        ],
      },
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
  const fields: { label?: string; value?: string }[] = [
    {
      value: `ready · ${personOf(pick) ?? "unclaimed"} · P${pick.priority} · ${leverage}`,
    },
  ];
  // The chain itself, hop by hop — one arrow per level, names inside a level
  // comma-joined. This is what makes the leverage claim auditable at a glance
  // instead of a number you have to trust.
  if (levels.length > 0) {
    const hops = levels.map((lvl) => lvl.map((b) => b.id).join(", "));
    fields.push({ value: [pick.id, ...hops].join(" → ") });
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
            {
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

// ── In progress: kept visible even when empty — a predictable location —
// but compact (one quiet row) rather than a dead zone.
export function composeWip(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.inProgress.ok) return failedBoard("in-progress work", m.inProgress.error);
  const now = new Date(m.asOf);
  if (m.inProgress.data.length === 0) {
    return board([
      {
        kind: "rows",
        items: [{ glyph: "ok", text: "No work currently claimed — start the recommended bead." }],
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
  return board([
    {
      kind: "cards",
      ...(people.sharedTitle ? { title: people.sharedTitle } : {}),
      items: m.inProgress.data.map((i): CardItem => {
        const person = personOf(i);
        const meta = [
          `P${i.priority}`,
          "in progress",
          daysAgo(i.updated_at, now),
          // An unassigned bead beside assigned siblings is worth marking; an
          // all-unassigned panel is just the backlog default and says nothing.
          ...(people.perItem ? [person ?? (people.markUnassigned ? "unassigned" : "")] : []),
        ].filter(Boolean);
        const rail = decisionRail(i, {
          waitingOn: blockers.get(i.id),
          downstream: declaredDownstream(i, index),
        });
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
            ...(rail.length ? [{ value: rail.join(" · ") }] : []),
          ],
        };
      }),
    },
  ]);
}

// ── Needs attention: blocked ranked by consequence (what the most other
// work waits on first), stale claims in the same queue.
export function composeAttention(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.blocked.ok) return failedBoard("the blocked union", m.blocked.error);
  const now = new Date(m.asOf);
  const blocked = m.blocked.data;
  const index = backlogIndex(m);
  const activeIds = new Set(m.inProgress.ok ? m.inProgress.data.map((i) => i.id) : []);
  // Active-but-stuck sorts first, ahead of the leverage ranking: the cap is
  // applied after this, and a claimed bead nobody can proceed on must never be
  // the row the cap hides.
  //
  // The leverage key is DECLARED downstream — the same number the rail shows.
  // It used to be a measured count of in-edges within the blocked union, which
  // ranked rows by a figure that appeared nowhere on screen; the order and the
  // evidence disagreed, which is the confusion the two-metric split exists to
  // end. `bd blocked` carries no dependent_count, hence the backlog join.
  const ranked = [...blocked].sort((a, b) => {
    const aa = activeIds.has(a.id) ? 1 : 0;
    const ab = activeIds.has(b.id) ? 1 : 0;
    if (aa !== ab) return ab - aa;
    const da = declaredDownstream(a, index);
    const db = declaredDownstream(b, index);
    if (da !== db) return db - da;
    return byPriorityThenAge(a, b);
  });
  const shown = ranked.slice(0, ATTENTION_CAP);
  const staleItems = m.stale.ok ? m.stale.data : [];
  // A measured zero is quiet; a failed measurement must not be. Without this
  // branch a dead `bd stale` renders as "nothing is stale" — the exact
  // empty-but-healthy lie this surface exists to refuse, and moving stale off
  // the Pulse into a conditional is precisely how it would have crept back in.
  if (m.stale.ok && shown.length === 0 && staleItems.length === 0) {
    return board([
      { kind: "rows", items: [{ glyph: "ok", text: "Nothing is blocked or stale." }] },
    ]);
  }
  // Work someone has already claimed and cannot proceed on outranks a blocker
  // on unclaimed work: one has a person stalled behind it, the other does not.
  // Splitting them also explains the overlap with In progress — a bead in both
  // panels is claimed AND waiting, and the section title says so.
  const blockingActive = shown.filter((i) => activeIds.has(i.id));
  const otherBlocked = shown.filter((i) => !activeIds.has(i.id));
  const blockedCard = (i: BdIssue, active: boolean): CardItem => {
    const rail = decisionRail(i, {
      waitingOn: i.blocked_by,
      downstream: declaredDownstream(i, index),
      handPaused: !i.blocked_by?.length,
    });
    const meta = [
      `P${i.priority}`,
      // Lifecycle, honestly: a claimed bead that is waiting stays `in progress`
      // here, exactly as it reads in the In progress panel. The rail carries
      // the waiting. Same bead, same words, two panels — no contradiction left
      // to explain away with a label.
      ...(active ? ["in progress"] : []),
    ];
    return {
      title: clampTitle(i.title, BAND_TITLE_BUDGET),
      pill: { label: i.id, tone: "neutral" as const },
      dot: active ? ("ok" as const) : undefined,
      selected: ctx.selectedId === i.id,
      action: { type: "select-bead", payload: { id: i.id } },
      fields: [{ value: meta.join(" · ") }, ...(rail.length ? [{ value: rail.join(" · ") }] : [])],
    };
  };
  // A single-column list: two-up tiles truncated both the title and the
  // waiting-on explanation, and this panel scans top-to-bottom anyway.
  const sections: BoardSection[] = [];
  if (blockingActive.length > 0)
    sections.push({
      kind: "cards",
      title: "Blocking active work",
      items: blockingActive.map((i) => blockedCard(i, true)),
    });
  if (otherBlocked.length > 0)
    sections.push({
      kind: "cards",
      ...(blockingActive.length > 0
        ? { title: "Other blocked work" }
        : blocked.length > shown.length
          ? { title: `Top ${shown.length} of ${blocked.length} blocked` }
          : {}),
      items: otherBlocked.map((i) => blockedCard(i, false)),
    });
  // Stale left the Pulse because it is an exception, not a standing measure —
  // but a conditional that renders nothing on failure is indistinguishable
  // from a clean board, so its failure alarms here instead.
  if (!m.stale.ok)
    sections.push({
      kind: "rows",
      items: [
        {
          icon: "⚠",
          chip: { label: "UNMEASURED", tone: "error" },
          text: "stale claims could not be measured — this is not an empty-and-healthy panel.",
          trailing: m.stale.error.slice(0, 120),
        },
      ],
    });
  if (staleItems.length > 0)
    sections.push({
      kind: "cards",
      ...(sections.length > 0 ? { title: `Stale ${STALE_DAYS}d+` } : {}),
      items: staleItems.map((i) => ({
        title: clampTitle(i.title, BAND_TITLE_BUDGET),
        pill: { label: i.id, tone: "neutral" as const },
        dot: "warn" as const,
        selected: ctx.selectedId === i.id,
        action: { type: "select-bead", payload: { id: i.id } },
        fields: [{ value: `claimed but ${daysAgo(i.updated_at, now)} — verify or release` }],
      })),
    });
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
  // The cost is real and bounded to this section: `rows` items carry no
  // `action`, so these do not open the inspector the way a card does. `detail`
  // buys most of it back — the body discloses inline, under the row — but a
  // bead whose only home is here cannot be selected, so the legend below stops
  // promising that for everything.
  if (room() > 0 && singles.length > 0) {
    const tail = singles.slice(0, room());
    sections.push({
      kind: "rows",
      title: "Standalone work",
      items: tail.map((i) => {
        const dot = lifecycleTone(lifecycleOf(i), readyIds.has(i.id));
        const body = [i.description, i.acceptance_criteria].filter(Boolean).join("\n\n");
        // A row DOES have a right-aligned slot, so here the rail is literal:
        // meta first, exceptions last, in the same order the cards use.
        return {
          ...(dot ? { glyph: dot } : {}),
          chip: { label: i.id, tone: "neutral" as const },
          text: i.title,
          trailing: [meta(i), ...railOf(i)].join(" · "),
          ...(body ? { detail: body.slice(0, 4000) } : {}),
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
        text: `Dot color is lifecycle: teal startable · green in progress · blue on hold. The trailing note is the exception — waiting on, N downstream, bug, closeout review — and most beads have none. ▸ panels are epics (their beads inside), └ marks a bead under the parent leading its box. P0 is most urgent, P4 least. Click a card to open it in the inspector; standalone rows expand in place.${shown < total ? ` Showing ${shown} of ${total}.` : ""}`,
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
          text: "Nothing selected yet — this is what the board recommends starting. Click any card to inspect that bead instead.",
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
            ? `All ${p.total_children} children are closed. Review this epic against its own acceptance criteria — closing is a merge-time act with a written reason, and the board will not do it for you.`
            : "An epic is structure, not work — start one of its children instead.",
          ...(p ? { trailing: `${p.closed_children}/${p.total_children} done` } : {}),
        },
      ],
    });
  } else if (i.status !== "closed" && i.status !== "in_progress") {
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
              ? [claim(recommended.id, `Start ${recommended.id} instead`)]
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

// ── Momentum: closes from the last week. The region itself starts collapsed.
export function composeClosed(m: ProjectMeasurement): Board {
  if (!m.recentlyClosed.ok) return failedBoard("recent closes", m.recentlyClosed.error);
  if (m.recentlyClosed.data.length === 0) return HIDDEN;
  return board([
    {
      kind: "rows",
      items: m.recentlyClosed.data.slice(0, CLOSED_CAP).map((i) => ({
        icon: "✓",
        chip: { label: i.id, tone: "neutral" },
        text: i.title,
        trailing: (i.closed_at ?? "").slice(0, 10),
      })),
    },
  ]);
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
