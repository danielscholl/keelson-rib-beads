// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The Beads surface reads in the order the operator acts: Now (In flight,
// Next up, Needs you), then the epic wave map (map.ts), then Backlog and
// Shipped. A header sentence says the totals once in words above the flow
// strip, and reports a shared cause (an old bd, a failing gh) once instead of
// letting every panel alarm on its own.
//
// Every bead renders in one shape. A card when there is evidence to show:
// lane dot, full title, a meta line that leads with the id as bd prints it,
// at most one signal pill, and the evidence (close reason, newest comment,
// run remark) as the card's reason line. A row when a list is dense and has
// no evidence: lane dot, title, then id and signal on the right. The dot is
// the lane (to do, in flight, done) and nothing else; waiting, staleness and
// merge drift are signals, never colours.

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { BdComment, BdEpicRow, BdIssue, BdLinked, BeadRunInfo, Measured } from "./bd";
import { bdFloorLabel, unmeasured } from "./bd";
import type { EpicMember, ProjectMeasurement } from "./measure";
import { bdBelowFloor, byPriorityThenAge, parseRunNote, STALE_DAYS } from "./measure";
import { isMergedPR, type PrInfo } from "./pr";

const ATTENTION_CAP = 8;
const SHIPPED_CAP = 12;
const BACKLOG_CAP = 80;
const PARA_CAP = 24;
const TITLE_BUDGET = 140;

type Board = CanvasBoardView;
type BoardSection = CanvasBoardView["sections"][number];
// A `columns` section nests LEAF sections only — no columns inside columns.
type LeafSection = Extract<
  BoardSection,
  { kind: "columns" }
>["columns"][number]["sections"][number];
type CardItem = Extract<BoardSection, { kind: "cards" }>["items"][number];
type RowItem = Extract<BoardSection, { kind: "rows" }>["items"][number];
type Pill = NonNullable<CardItem["pill"]>;

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
// in_progress` and `bd show` carry `assignee` (a display name). Always read
// both, in that order, or owned work reads as unclaimed.
export function personOf(i: BdIssue): string | undefined {
  const raw = (i.assignee ?? i.owner ?? "").trim();
  return raw.length > 0 ? raw : undefined;
}

// An email shows as its local part; a display name as written.
export function shortPerson(person: string | undefined): string | undefined {
  if (!person) return undefined;
  const at = person.indexOf("@");
  return at > 0 ? person.slice(0, at) : person;
}

// Where a bead sits in its own life. `blocked` is bd's status name but a
// condition, so it folds to `open` and reappears as a signal.
export type Lifecycle = "open" | "in_progress" | "deferred" | "closed";

export function lifecycleOf(i: { status: string }): Lifecycle {
  switch (i.status) {
    case "in_progress":
      return "in_progress";
    case "deferred":
      return "deferred";
    case "closed":
      return "closed";
    default:
      return "open";
  }
}

// The lane colour: to do, in flight, done. On hold is to do with no urgency.
export function lifecycleTone(l: Lifecycle): CanvasTone {
  if (l === "in_progress") return "info";
  if (l === "closed") return "ok";
  if (l === "deferred") return "neutral";
  return "accent";
}

// One tone per flow stage, shared by the header strip and the stage meters,
// so a colour means the same lane on every structured panel.
export const STAGE_TONE = {
  waiting: "neutral",
  ready: "accent",
  working: "info",
  review: "brand",
  done: "ok",
} as const satisfies Record<string, CanvasTone>;

// A sibling prints as `.5` beside a bead that already shows the shared
// prefix; anything outside that prefix keeps the id as bd prints it.
export function shortId(id: string, parent: string | undefined): string {
  return parent && id.startsWith(`${parent}.`) ? id.slice(parent.length) : id;
}

// Only a numeric suffix marks a child (`epic.5`); a dot inside a prefix
// (`my.app-12`) is part of the id.
export function parentIdOf(id: string): string | undefined {
  return /^(.+)\.\d+$/.exec(id)?.[1];
}

// `bd blocked` rows carry no `dependent_count` (verified live), while `bd
// list` carries it for the whole backlog, so leverage reads through the
// backlog for blocked beads.
export function backlogIndex(m: ProjectMeasurement): ReadonlyMap<string, BdIssue> {
  return new Map((m.backlog.ok ? m.backlog.data : []).map((i) => [i.id, i]));
}

export function declaredDownstream(i: BdIssue, index: ReadonlyMap<string, BdIssue>): number {
  return i.dependent_count ?? index.get(i.id)?.dependent_count ?? 0;
}

// Who owns the visible work, said in the fewest places that stay truthful:
// one owner hoists to the panel title, nobody assigned says nothing, and a
// mix goes per bead with the unassigned ones marked.
export interface AssigneeView {
  sharedTitle?: string;
  perItem: boolean;
  markUnassigned: boolean;
}

export function assigneeView(items: readonly BdIssue[]): AssigneeView {
  const people = items.map((i) => shortPerson(personOf(i)));
  const named = people.filter((p): p is string => p !== undefined);
  if (named.length === 0) return { perItem: false, markUnassigned: false };
  const uniform = named.length === people.length && named.every((p) => p === named[0]);
  if (uniform)
    return { sharedTitle: `All claimed by ${named[0]}`, perItem: false, markUnassigned: false };
  return { perItem: true, markUnassigned: true };
}

// The recommendation: leverage first (dependent_count — finishing it frees
// the most stuck work), priority second, age third. ONE pick with a named
// runner-up: a queue of twelve is a report, not a decision.
export function recommendNext(ready: BdIssue[]): { pick?: BdIssue; runnerUp?: BdIssue } {
  const ranked = [...ready].sort((a, b) => {
    const la = a.dependent_count ?? 0;
    const lb = b.dependent_count ?? 0;
    if (la !== lb) return lb - la;
    return byPriorityThenAge(a, b);
  });
  return { pick: ranked[0], runnerUp: ranked[1] };
}

// Who waits on this bead, by name, walked hop by hop off the blocked union's
// blocked_by edges. `seen` closes the walk against cycles, which bd permits.
// Bounded by the union, so it undercounts rather than invents.
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
// bead with a linked PR is "in review"; unknown and number-only PR notes
// remain in progress until there is a navigable PR.

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
export function stageChip(info: BeadRunInfo, pr?: PrInfo): string {
  if (!info.prUrl) return "in progress";
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
    (entry.data?.prUrl ? inReview : working).push(i);
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
// The blocked union names each bead's blockers. This groups it the other
// way: by blocker, with what finishing it would release. The epic map tags a
// bead with its dam.
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
}

export function damGroups(blocked: BdIssue[], index: ReadonlyMap<string, BdIssue>): Dam[] {
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
  }));
  // Ranked by held count; leverage and priority break ties with the same
  // keys every panel shows.
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
// The raw error goes in `detail`, a disclosure, so a long log line never
// crushes the alarm sentence. Below the bd version floor any failure is
// suspect, so the panel points at the header, which names the cause once.
function alarmRow(what: string, error: string, m?: Pick<ProjectMeasurement, "bd">): RowItem {
  const floor = m ? bdBelowFloor(m) : undefined;
  if (floor) {
    return {
      icon: "⚠",
      chip: { label: "UNMEASURED", tone: "error" },
      text: `${capitalize(what)} needs bd ${bdFloorLabel()}. See the header.`,
      ...(error.includes(floor) ? {} : { detail: error.slice(0, 1000) }),
    };
  }
  return {
    icon: "⚠",
    chip: { label: "UNMEASURED", tone: "error" },
    text: `${capitalize(what)} could not be measured. This is not an empty panel.`,
    detail: error.slice(0, 1000),
  };
}

function failedBoard(what: string, error: string, m?: Pick<ProjectMeasurement, "bd">): Board {
  return board([{ kind: "rows", items: [alarmRow(what, error, m)] }]);
}

function quiet(text: string, glyph: CanvasTone = "neutral"): BoardSection {
  return { kind: "rows", items: [{ glyph, text }] };
}

// The rib's explicit empty signal: zero sections hides the region entirely.
const HIDDEN: Board = { view: "board", sections: [] };

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const clampTitle = (raw: string, budget: number = TITLE_BUDGET): string => {
  if (raw.length <= budget) return raw;
  const cut = raw.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
};

// The first sentence of a close reason or comment, which on the trackers
// measured names the PR and what it delivered; the inspector holds the rest.
export function firstSentence(text: string, cap = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = /[.!?](?=\s+[A-Z(“"'`])/.exec(flat);
  const sentence = end ? flat.slice(0, end.index + 1) : flat;
  return clampTitle(sentence, cap);
}

// Elapsed time, coarse on purpose: a row says how long, not when.
export function ago(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return undefined;
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Days are elapsed 24h windows from asOf, the arithmetic every age uses.
function dayLabel(iso: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? "?"} ${Number(iso.slice(8, 10))}`;
}

function stamp(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()] ?? "?"} ${d.getUTCDate()} ${hh}:${mm}Z`;
}

function clock(iso: string | undefined): string {
  return stamp(iso).split(" ").pop() ?? "";
}

// The PR a closed bead shipped through: the run note first, then any GitHub
// PR URL in the close reason.
export function shippedPR(i: BdIssue): string | undefined {
  const run = parseRunNote(i.notes);
  if (run?.prUrl) return run.prUrl;
  return /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/.exec(i.close_reason ?? "")?.[0];
}

// How far along a claim is, from the evidence the tracker and GitHub hold:
// claimed, PR open (with draft, CI and review state when gh answered), or a
// verified merge waiting on the close.
export function flightStage(
  i: BdIssue,
  info: BeadRunInfo | undefined,
  pr: PrInfo | undefined,
  now: Date,
): string {
  if (info?.prUrl) {
    if (pr && isMergedPR(pr)) return "merged · close pending";
    return [
      "PR open",
      ...(pr?.draft ? ["draft"] : []),
      ...(pr?.checks ? [`CI ${pr.checks}`] : []),
      ...(pr?.review ? [pr.review] : []),
    ].join(" · ");
  }
  if (info?.prState === "number-only") return `PR #${info.prNumber} · link unknown`;
  if (info?.prState === "unknown") return "PR state unknown";
  const since = ago(i.started_at, now);
  if (since === "just now") return "claimed just now";
  return since ? `claimed ${since} ago` : "claimed · time not recorded";
}

// The one signal a bead carries, most pressing first. Most beads carry none.
export interface SignalContext {
  waitingOn?: readonly string[];
  handPaused?: boolean;
  staleDays?: number;
  closeout?: boolean;
  mergePending?: boolean;
}

export function signalOf(i: BdIssue, c: SignalContext = {}): Pill | undefined {
  if (c.mergePending) return { label: "merged · close pending", tone: "warn" };
  if (c.waitingOn?.length) return { label: `waits on ${c.waitingOn.length}`, tone: "caution" };
  if (c.handPaused) return { label: "paused by hand", tone: "caution" };
  if (c.staleDays !== undefined) return { label: `stale ${c.staleDays}d`, tone: "warn" };
  if (c.closeout) return { label: "closeout review", tone: "warn" };
  if (i.status === "deferred") return { label: "on hold", tone: "neutral" };
  if (i.priority === 0) return { label: "P0", tone: "error" };
  if (i.priority === 1) return { label: "P1", tone: "warn" };
  return undefined;
}

interface BeadCardOptions {
  meta?: (string | undefined | false)[];
  signal?: Pill;
  evidence?: { label?: string; text: string };
  fields?: NonNullable<CardItem["fields"]>;
  actions?: CardItem["actions"];
  footnote?: string;
  selectedId?: string;
  tone?: CanvasTone;
}

// The card form of a bead. The id leads the meta line in bd's own spelling,
// never truncated; the title wraps instead of clamping.
function beadCard(
  i: { id: string; title: string; status: string },
  o: BeadCardOptions = {},
): CardItem {
  const meta = [i.id, ...(o.meta ?? [])].filter((x): x is string => Boolean(x));
  return {
    title: clampTitle(i.title),
    dot: o.tone ?? lifecycleTone(lifecycleOf(i)),
    ...(o.signal ? { pill: o.signal } : {}),
    selected: o.selectedId === i.id,
    action: { type: "select-bead", payload: { id: i.id } },
    fields: [{ value: meta.join(" · ") }, ...(o.fields ?? [])],
    ...(o.evidence ? { reason: o.evidence } : {}),
    ...(o.actions ? { actions: o.actions } : {}),
    ...(o.footnote ? { footnote: o.footnote } : {}),
  };
}

// The row form of a bead, for dense lists with no evidence line.
function beadRow(
  i: { id: string; title: string; status: string },
  trailing: (string | undefined | false)[],
  ctx: PanelContext,
  tone?: CanvasTone,
): RowItem {
  return {
    glyph: tone ?? lifecycleTone(lifecycleOf(i)),
    text: i.title,
    trailing: [i.id, ...trailing].filter((x): x is string => Boolean(x)).join(" · "),
    action: { type: "select-bead", payload: { id: i.id } },
    selected: ctx.selectedId === i.id,
  };
}

function prField(url: string): NonNullable<CardItem["fields"]>[number] {
  return { label: "PR", value: prLabel(url), href: url };
}

function commentEvidence(c: BdComment, now: Date): { label: string; text: string } {
  const who = shortPerson(c.author) ?? "comment";
  const when = ago(c.created_at, now);
  return { label: when ? `${who} · ${when} ago` : who, text: firstSentence(c.text) };
}

function latestCommentOf(m: ProjectMeasurement, id: string): BdComment | undefined {
  if (!m.latestComment.ok) return undefined;
  const entry = m.latestComment.data[id];
  return entry?.ok ? entry.data : undefined;
}

function staleDaysOf(m: ProjectMeasurement, i: BdIssue, now: Date): number | undefined {
  if (!m.stale.ok || !m.stale.data.some((s) => s.id === i.id)) return undefined;
  const at = i.updated_at ?? i.started_at;
  if (!at) return STALE_DAYS;
  return Math.max(STALE_DAYS, Math.floor((now.getTime() - new Date(at).getTime()) / 86_400_000));
}

// ── Header: one sentence with the week's totals, the flow strip, and the
// preflight, so one cause reads as one line.
export function composePulse(m: ProjectMeasurement): Board {
  const floor = bdBelowFloor(m);
  const split = stageSplit(m);
  // The strip is a distribution, so its populations must be disjoint: a
  // claimed bead that is also blocked counts once, under in progress.
  const wipIds = new Set(m.inProgress.ok ? m.inProgress.data.map((i) => i.id) : []);
  const waiting =
    m.blocked.ok && m.inProgress.ok ? m.blocked.data.filter((b) => !wipIds.has(b.id)).length : null;
  const segments: Extract<BoardSection, { kind: "segments" }>["items"] = [
    { label: "Waiting", n: waiting, tone: STAGE_TONE.waiting },
    { label: "Ready", n: m.ready.ok ? m.ready.data.length : null, tone: STAGE_TONE.ready },
    {
      label: "In progress",
      n: split.ok ? split.data.working.length : null,
      tone: STAGE_TONE.working,
    },
    {
      label: "In review",
      n: split.ok ? split.data.inReview.length : null,
      tone: STAGE_TONE.review,
    },
    {
      label: "Done 7d",
      n: m.recentlyClosed.ok ? m.recentlyClosed.data.length : null,
      tone: STAGE_TONE.done,
    },
  ];
  const count = (x: Measured<unknown[]>): string => (x.ok ? String(x.data.length) : "?");
  // The sentence reads the same populations the strip draws, in the order
  // the operator acts on them.
  const sentence = `${count(m.inProgress)} in flight · ${count(m.ready)} ready to start · ${waiting ?? "?"} waiting · ${count(m.recentlyClosed)} shipped this week`;

  const preflight: RowItem[] = [];
  if (floor && m.bd.ok && m.bd.data) {
    preflight.push({
      icon: "⚠",
      chip: { label: "bd too old", tone: "error" },
      text: `bd ${m.bd.data.version} is on PATH and the board needs ${bdFloorLabel()}. Epics, run notes, PR state and the inspector wait on it; upgrade the beads CLI and the board fills in.`,
    });
  }
  const gh = ghHealth(m);
  if (gh.failing) {
    preflight.push({
      icon: "⚠",
      chip: { label: "gh failing", tone: "error" },
      text: "Every PR lookup failed, so merge, CI and review state are unverified. PR links still come from the run notes.",
      ...(gh.error ? { detail: gh.error.slice(0, 1000) } : {}),
    });
  }
  const flowFailures = [
    ...(m.blocked.ok ? [] : [`waiting: ${m.blocked.error}`]),
    ...(m.ready.ok ? [] : [`ready: ${m.ready.error}`]),
    ...(split.ok || (floor && split.error.includes(floor)) ? [] : [`stage split: ${split.error}`]),
    ...(m.recentlyClosed.ok ? [] : [`closes: ${m.recentlyClosed.error}`]),
  ];
  if (flowFailures.length && !floor) {
    preflight.push({
      icon: "⚠",
      chip: { label: "UNMEASURED", tone: "error" },
      text: "Hatched segments could not be measured. Never read them as zero.",
      detail: flowFailures.join("\n").slice(0, 1000),
    });
  }

  const chip = [
    m.bd.ok && m.bd.data ? `bd ${m.bd.data.version}` : m.bd.ok ? "bd version unknown" : undefined,
    gh.label,
    `measured ${m.asOf.slice(11, 16)}Z`,
  ].filter(Boolean);
  return board(
    [
      { kind: "segments", title: sentence, items: segments },
      ...(preflight.length ? [{ kind: "rows" as const, items: preflight }] : []),
    ],
    {
      status: { label: m.project.name, tone: floor || gh.failing ? "error" : "ok" },
      chip: chip.join(" · "),
    },
  );
}

// gh is healthy when at least one recorded PR answered; it is failing when
// there were PRs to read and none did. No PRs to read says nothing.
function ghHealth(m: ProjectMeasurement): { label?: string; failing: boolean; error?: string } {
  if (!m.prInfo.ok) return { failing: false };
  const lookups = Object.entries(m.prInfo.data).filter(([id]) => {
    const run = runInfoOf(m, id);
    return Boolean(run?.prUrl);
  });
  if (lookups.length === 0) return { failing: false };
  const failed = lookups.filter(([, e]) => !e.ok);
  if (failed.length === lookups.length) {
    const first = failed[0]?.[1];
    return {
      label: "gh failing",
      failing: true,
      ...(first && !first.ok ? { error: first.error } : {}),
    };
  }
  return { label: "gh ok", failing: false };
}

// ── Next up: one confident pick, why, and the runner-up.
export function composeRecommend(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.ready.ok) return failedBoard("the ready queue", m.ready.error, m);
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const { pick, runnerUp } = recommendNext(m.ready.data);
  if (!pick) {
    return board([
      quiet(
        "Nothing is ready to start. Everything open is blocked or on hold; Needs you shows what would release work.",
        "warn",
      ),
    ]);
  }
  // Two leverage numbers that can disagree: declared downstream (everything
  // that hangs off this bead, what the ranking uses) and releases now (the
  // measured blocked edges that go ready the moment it closes).
  const levels = unlockLevels(pick.id, blocked);
  const downstream = pick.dependent_count ?? 0;
  const releasesNow = levels[0]?.length ?? 0;
  const why =
    downstream > 0 || releasesNow > 0
      ? `${downstream} downstream · releases ${releasesNow} now`
      : "picked on priority · nothing waits on it";
  const mergedPick = mergedPR(m.prInfo, pick.id);
  const fields: NonNullable<CardItem["fields"]> = [];
  // The chain, hop by hop, so the leverage claim is auditable. Past a
  // handful the first hop stays verbatim and deeper levels compress.
  const short = (id: string) => shortId(id, parentIdOf(pick.id));
  if (levels.length > 0) {
    const CHAIN_ID_CAP = 8;
    const total = levels.reduce((a, lvl) => a + lvl.length, 0);
    if (total <= CHAIN_ID_CAP) {
      const hops = levels.map((lvl) => lvl.map((b) => short(b.id)).join(", "));
      fields.push({ label: "unlocks", value: hops.join(" → ") });
    } else {
      const first = levels[0] ?? [];
      const firstShown = first.slice(0, CHAIN_ID_CAP);
      const firstText =
        firstShown.map((b) => short(b.id)).join(", ") +
        (first.length > firstShown.length ? ` +${first.length - firstShown.length} more` : "");
      const deeper = total - first.length;
      const deeperLevels = levels.length - 1;
      const tail = deeper > 0 ? ` → … ${deeper} more across ${plural(deeperLevels, "level")}` : "";
      fields.push({ label: "unlocks", value: `${firstText}${tail}` });
    }
  }
  return board([
    {
      kind: "cards",
      items: [
        beadCard(pick, {
          meta: [
            mergedPick ? "merged PR · still ready in bd" : "ready",
            shortPerson(personOf(pick)) ?? "unclaimed",
            `P${pick.priority}`,
          ],
          ...(mergedPick ? { signal: { label: "merged · close pending", tone: "warn" } } : {}),
          evidence: { label: "why", text: why },
          fields,
          selectedId: ctx.selectedId,
          actions: [
            { type: "select-bead", label: "Inspect", payload: { id: pick.id } },
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
            ? `runner-up: ${short(runnerUp.id)} · ${clampTitle(runnerUp.title, 80)}`
            : "runner-up: none, the ready queue holds nothing else",
        }),
      ],
    },
  ]);
}

// ── In flight: every claim, how far along it is, and the newest evidence.
// bd attributes every claim to a human even when a bead-work run holds it,
// so the title counts runs whenever a run note exists.
export function composeWip(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.inProgress.ok) return failedBoard("in-flight work", m.inProgress.error, m);
  const now = new Date(m.asOf);
  if (m.inProgress.data.length === 0) {
    return board([quiet("Nothing is claimed. Next up has the pick.")]);
  }
  const floor = bdBelowFloor(m);
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const blockers = new Map<string, string[]>(blocked.map((b) => [b.id, b.blocked_by ?? []]));
  const people = assigneeView(m.inProgress.data);
  const runCount = m.inProgress.data.filter((i) => runInfoOf(m, i.id) !== undefined).length;
  const otherCount = m.inProgress.data.length - runCount;
  const title =
    runCount > 0
      ? [
          plural(runCount, "bead-work run"),
          ...(otherCount > 0 ? [plural(otherCount, "other claim")] : []),
        ].join(" · ")
      : people.sharedTitle;
  const cards = [...m.inProgress.data].sort(byPriorityThenAge).map((i): CardItem => {
    const entry = m.runInfo.ok ? m.runInfo.data[i.id] : undefined;
    const info = entry?.ok ? entry.data : undefined;
    const pr = info?.prUrl ? livePR(m, i.id) : undefined;
    // Card-level degrade: this bead's reads failed, its siblings stay measured.
    const runError = floor
      ? undefined
      : !m.runInfo.ok
        ? m.runInfo.error
        : entry
          ? entry.ok
            ? undefined
            : entry.error
          : "no run-note envelope for this bead";
    const prError = floor || ghHealth(m).failing ? undefined : prFailure(m, i.id);
    const person = shortPerson(personOf(i));
    const comment = latestCommentOf(m, i.id);
    const evidence = comment
      ? commentEvidence(comment, now)
      : info?.note
        ? { label: `run ${info.outcome ?? "note"}`, text: firstSentence(info.note) }
        : undefined;
    const releases = unlockLevels(i.id, blocked)[0] ?? [];
    const card = beadCard(i, {
      meta: [
        people.perItem
          ? (person ?? (people.markUnassigned ? "unassigned" : undefined))
          : !info && runCount > 0
            ? person
            : undefined,
        flightStage(i, info, pr, now),
      ],
      signal: signalOf(i, {
        mergePending: Boolean(mergedPR(m.prInfo, i.id)),
        waitingOn: blockers.get(i.id),
        staleDays: staleDaysOf(m, i, now),
      }),
      ...(evidence ? { evidence } : {}),
      fields: [
        ...(info?.prUrl ? [prField(info.prUrl)] : []),
        ...(releases.length
          ? [
              {
                label: "releases",
                value: releases.map((b) => shortId(b.id, parentIdOf(i.id))).join(", "),
              },
            ]
          : []),
        ...(runError
          ? [{ value: `UNMEASURED run note: ${runError}`.slice(0, 120), tone: "error" as const }]
          : []),
        ...(prError
          ? [{ value: `UNMEASURED PR: ${prError}`.slice(0, 120), tone: "error" as const }]
          : []),
      ],
      selectedId: ctx.selectedId,
    });
    // The meter reads the run note, so an unread note draws no meter.
    return entry?.ok ? { ...card, bar: stageBar(info, pr) } : card;
  });
  return board([
    ...(floor
      ? [{ kind: "rows" as const, items: [alarmRow("run notes and PR state", floor, m)] }]
      : []),
    { kind: "cards", ...(title ? { title } : {}), items: cards },
  ]);
}

// A claim's three recorded stops as a meter: claimed, PR open, merged. A stop
// not reached stays neutral and says so in its label.
export function stageBar(
  info: BeadRunInfo | undefined,
  pr: PrInfo | undefined,
): NonNullable<CardItem["bar"]> {
  const reached = [true, Boolean(info?.prUrl), Boolean(pr && isMergedPR(pr))];
  const names = ["claimed", "PR open", "merged"];
  const last = reached.lastIndexOf(true);
  return {
    label: "stage",
    trailing: `${last + 1} of ${names.length}`,
    segments: names.map((name, at) => ({
      label: at <= last ? name : `${name}, not yet`,
      n: 1,
      tone: at <= last ? (at === 2 ? STAGE_TONE.done : STAGE_TONE.working) : STAGE_TONE.waiting,
    })),
  };
}

function livePR(m: ProjectMeasurement, id: string): PrInfo | undefined {
  if (!m.prInfo.ok) return undefined;
  const entry = m.prInfo.data[id];
  return entry?.ok ? entry.data : undefined;
}

// ── Needs you: the operator's queue, most actionable first — merged PRs
// waiting on a close, reviews to merge, hand-paused work, stale claims, and
// epic closeouts. Only actions: a dam is ordinary sequencing, so it rides the
// epic map as a tag on the bead that holds the work.
export function composeAttention(m: ProjectMeasurement, ctx: PanelContext): Board {
  const now = new Date(m.asOf);
  const floor = bdBelowFloor(m);
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const sections: BoardSection[] = [];
  const failures: { what: string; error: string }[] = [];
  // Every input this panel folds in alarms on failure, since a section that
  // renders nothing would read as a clean board.
  const alarm = (what: string, error: string) => {
    failures.push({ what, error });
  };

  if (!m.prInfo.ok) {
    alarm("PR merge state", m.prInfo.error);
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
        title: "Merged, close pending",
        items: drift.map(({ i, pr }) =>
          beadCard(i, {
            meta: [
              `merged ${ago(pr.mergedAt, now) ?? ""} ago`,
              `bead still ${i.status.replace("_", " ")}`,
            ],
            signal: { label: "reconcile", tone: "warn" },
            fields: [prField(pr.url)],
            actions: [reconcileAction(m.project.id)],
            selectedId: ctx.selectedId,
          }),
        ),
      });
    }
    if (!m.backlog.ok) alarm("merge drift", m.backlog.error);
    if (!ghHealth(m).failing) {
      const failures = Object.entries(m.prInfo.data)
        .filter(([, entry]) => !entry.ok)
        .map(([id, entry]) => `${id}: ${entry.ok ? "" : entry.error}`);
      if (failures.length) alarm("PR state for some beads", failures.join("\n"));
    }
  }
  if (!m.blocked.ok) alarm("the blocked union", m.blocked.error);

  // Review to merge: the act only a human can do, on GitHub.
  const split = stageSplit(m);
  if (!split.ok) {
    alarm("review-stage work", split.error);
  } else {
    const reviews = split.data.inReview.filter((i) => !mergedPR(m.prInfo, i.id));
    if (reviews.length > 0) {
      sections.push({
        kind: "cards",
        title: "Review to merge",
        items: reviews.map((i) => {
          const info = runInfoOf(m, i.id);
          const pr = livePR(m, i.id);
          return beadCard(i, {
            meta: [flightStage(i, info, pr, now), ago(i.updated_at, now)],
            ...(pr?.checks === "failing"
              ? { signal: { label: "CI failing", tone: "error" as const } }
              : pr?.review === "changes requested"
                ? { signal: { label: "changes requested", tone: "warn" as const } }
                : {}),
            fields: info?.prUrl ? [prField(info.prUrl)] : [],
            selectedId: ctx.selectedId,
          });
        }),
      });
    }
  }

  // Paused by hand: status-blocked with no dependency edge.
  const paused = blocked.filter((i) => !i.blocked_by?.length);
  if (paused.length > 0) {
    sections.push({
      kind: "cards",
      title: "Paused by hand",
      items: paused.slice(0, ATTENTION_CAP).map((i) =>
        beadCard(i, {
          meta: [
            shortPerson(personOf(i)),
            ago(i.updated_at, now) && `paused ${ago(i.updated_at, now)}`,
          ],
          signal: { label: "paused by hand", tone: "caution" },
          selectedId: ctx.selectedId,
        }),
      ),
    });
  }

  if (!m.stale.ok) alarm("stale claims", m.stale.error);
  const staleItems = m.stale.ok ? m.stale.data : [];
  if (staleItems.length > 0) {
    sections.push({
      kind: "cards",
      title: `Stale claims, quiet ${STALE_DAYS}d+`,
      items: staleItems.map((i) => {
        const comment = latestCommentOf(m, i.id);
        return beadCard(i, {
          meta: [shortPerson(personOf(i)), "verify or release"],
          signal: signalOf(i, { staleDays: staleDaysOf(m, i, now) ?? STALE_DAYS }),
          ...(comment ? { evidence: commentEvidence(comment, now) } : {}),
          selectedId: ctx.selectedId,
        });
      }),
    });
  }

  // Epic closeouts: a review ask, never a close button. Closing is a
  // merge-time human act with a written reason.
  if (!m.epics.ok) {
    alarm("epic closeout eligibility", m.epics.error);
  } else {
    const eligible = m.epics.data.filter((r) => r.eligible_for_close);
    if (eligible.length > 0)
      sections.push({
        kind: "cards",
        title: "Epic closeout review",
        items: eligible.map((r) => ({
          ...beadCard(r.epic, {
            meta: ["epic", `${r.closed_children}/${r.total_children} done`],
            signal: { label: "closeout review", tone: "warn" },
            selectedId: ctx.selectedId,
          }),
          ...(r.total_children > 0
            ? { bar: { value: r.closed_children, total: r.total_children } }
            : {}),
        })),
      });
  }

  // Below the version floor the failures share one cause, so they share a row.
  const alarms: RowItem[] = floor
    ? failures.length
      ? [
          alarmRow(
            "this panel",
            failures
              .filter((f) => !f.error.includes(floor))
              .map((f) => `${f.what}: ${f.error}`)
              .join("\n") || floor,
            m,
          ),
        ]
      : []
    : failures.map((f) => alarmRow(f.what, f.error, m));
  if (sections.length === 0 && alarms.length === 0) {
    // Every check ran and found nothing, so the panel says which checks.
    return board([
      quiet("Nothing needs you.", "ok"),
      {
        kind: "rows",
        items: [
          "Merged PRs to reconcile",
          "Reviews to merge",
          "Paused by hand",
          "Stale claims",
          "Epic closeouts",
        ].map((text) => ({ text, trailing: "0" })),
      },
    ]);
  }
  return board([...(alarms.length ? [{ kind: "rows" as const, items: alarms }] : []), ...sections]);
}

// ── Epics: what the wave map (map.ts) draws for each open epic. A member's
// wave is one more than the deepest wave among its open blockers, so a
// column says how many steps a bead is from startable.
export type EpicLane = "working" | "review" | "ready" | "waiting" | "hold";

export interface EpicNode {
  member: EpicMember;
  lane: EpicLane;
  wave: number;
  // Open blockers that are members of the same epic: the edges the map draws.
  deps: string[];
  // Open blockers from outside the epic, named on the bead since no edge can
  // reach them.
  external: string[];
  handPaused: boolean;
  pick: boolean;
  dam?: Dam;
}

export interface EpicView {
  row: BdEpicRow;
  nodes: EpicNode[];
  done: EpicMember[];
  gate?: EpicGate;
  counts?: { review: number; working: number; ready: number; waiting: number };
}

const LANE_RANK: Record<EpicLane, number> = {
  working: 0,
  review: 1,
  ready: 2,
  waiting: 3,
  hold: 4,
};

export function epicNodes(
  epicId: string,
  members: readonly EpicMember[],
  blockedBy: ReadonlyMap<string, readonly string[]>,
  lanes: {
    readyIds: ReadonlySet<string>;
    reviewIds: ReadonlySet<string>;
    pickId?: string;
    dams?: ReadonlyMap<string, Dam>;
  },
): EpicNode[] {
  const open = members.filter((c) => c.status !== "closed");
  const openIds = new Set(open.map((c) => c.id));
  const closedIds = new Set(members.filter((c) => c.status === "closed").map((c) => c.id));
  const edges = new Map(
    open.map((c) => {
      const all = (blockedBy.get(c.id) ?? []).filter(
        (d) => d !== epicId && d !== c.id && !closedIds.has(d),
      );
      return [
        c.id,
        { deps: all.filter((d) => openIds.has(d)), external: all.filter((d) => !openIds.has(d)) },
      ];
    }),
  );
  const memo = new Map<string, number>();
  // `trail` closes the walk against cycles, which bd permits.
  const wave = (id: string, trail: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0;
    trail.add(id);
    const e = edges.get(id);
    const inside = e?.deps.length ? 1 + Math.max(...e.deps.map((d) => wave(d, trail))) : 0;
    trail.delete(id);
    const w = Math.max(inside, e?.external.length ? 1 : 0);
    memo.set(id, w);
    return w;
  };
  const nodes = open.map((member): EpicNode => {
    const e = edges.get(member.id) ?? { deps: [], external: [] };
    const waits = e.deps.length + e.external.length > 0;
    const handPaused = member.status === "blocked" && !waits;
    const lane: EpicLane =
      member.status === "in_progress"
        ? lanes.reviewIds.has(member.id)
          ? "review"
          : "working"
        : member.status === "deferred"
          ? "hold"
          : !waits && !handPaused && lanes.readyIds.has(member.id)
            ? "ready"
            : "waiting";
    const dam = lanes.dams?.get(member.id);
    return {
      member,
      lane,
      wave: wave(member.id, new Set()),
      deps: e.deps,
      external: e.external,
      handPaused,
      pick: member.id === lanes.pickId,
      ...(dam ? { dam } : {}),
    };
  });
  return nodes.sort((a, b) => {
    if (a.wave !== b.wave) return a.wave - b.wave;
    if (a.lane !== b.lane) return LANE_RANK[a.lane] - LANE_RANK[b.lane];
    if (a.pick !== b.pick) return a.pick ? -1 : 1;
    const ha = a.dam?.held.length ?? 0;
    const hb = b.dam?.held.length ?? 0;
    if (ha !== hb) return hb - ha;
    const pa = a.member.priority ?? 2;
    const pb = b.member.priority ?? 2;
    if (pa !== pb) return pa - pb;
    return a.member.id.localeCompare(b.member.id, undefined, { numeric: true });
  });
}

// Open epics, where the work is first, then what is nearly landed, parked
// epics last. Callers check m.epics.ok first.
export function epicViews(m: ProjectMeasurement): EpicView[] {
  if (!m.epics.ok) return [];
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const wipIds = new Set(m.inProgress.ok ? m.inProgress.data.map((i) => i.id) : []);
  const blockedBy = new Map<string, readonly string[]>(
    blocked.map((b) => [b.id, b.blocked_by ?? []]),
  );
  const split = stageSplit(m);
  const stagesMeasured = m.epicChildren.ok && m.ready.ok && split.ok;
  const readyIds = new Set(m.ready.ok ? m.ready.data.map((i) => i.id) : []);
  const reviewIds = new Set(split.ok ? split.data.inReview.map((i) => i.id) : []);
  const pickId = m.ready.ok ? recommendNext(m.ready.data).pick?.id : undefined;
  const dams = new Map(damGroups(blocked, backlogIndex(m)).map((d) => [d.blockerId, d]));
  const views = m.epics.data
    .filter((r) => r.epic.status !== "closed")
    .map((row) => {
      const members = m.epicChildren.ok ? (m.epicChildren.data[row.epic.id] ?? []) : [];
      const childIds = members.map((c) => c.id);
      const nodes = epicNodes(row.epic.id, members, blockedBy, {
        readyIds,
        reviewIds,
        pickId,
        dams,
      });
      const inLane = (lane: EpicLane) => nodes.filter((n) => n.lane === lane).length;
      const gate =
        m.blocked.ok && childIds.length > 0 ? epicGate(childIds, blockedBy, wipIds) : undefined;
      const view: EpicView = {
        row,
        nodes,
        done: members.filter((c) => c.status === "closed"),
        ...(gate ? { gate } : {}),
        ...(stagesMeasured
          ? {
              counts: {
                review: inLane("review"),
                working: inLane("working"),
                ready: inLane("ready"),
                waiting: Math.max(
                  0,
                  row.total_children -
                    row.closed_children -
                    inLane("review") -
                    inLane("working") -
                    inLane("ready"),
                ),
              },
            }
          : {}),
      };
      return view;
    });
  const inFlight = (v: EpicView) => v.nodes.filter((n) => wipIds.has(n.member.id)).length;
  const ratio = (v: EpicView) =>
    v.row.total_children > 0 ? v.row.closed_children / v.row.total_children : 0;
  return views.sort((a, b) => {
    if (inFlight(a) !== inFlight(b)) return inFlight(b) - inFlight(a);
    if (ratio(a) !== ratio(b)) return ratio(b) - ratio(a);
    return byPriorityThenAge(a.row.epic, b.row.epic);
  });
}

// ── Selected: the bead last picked in the wave map, with the Inspect action.
// The host does not act on an open-canvas reply to a frame-relayed action, so
// the map can select but cannot open the drawer; this structured card can.
export function composeSelected(m: ProjectMeasurement, selectedId: string | undefined): Board {
  if (!m.epics.ok || !m.epics.data.some((r) => r.epic.status !== "closed")) return HIDDEN;
  if (!selectedId) {
    return board([quiet("Select a bead in the map to see it here and open the inspector.")]);
  }
  const members = m.epicChildren.ok ? Object.values(m.epicChildren.data).flat() : [];
  const known =
    backlogIndex(m).get(selectedId) ??
    members.find((c) => c.id === selectedId) ??
    m.epics.data.find((r) => r.epic.id === selectedId)?.epic;
  // An id this sweep does not carry shows by id alone, with no status claimed.
  const issue = known ?? { id: selectedId, title: selectedId, status: "open" };
  return board([
    {
      kind: "cards",
      items: [
        beadCard(issue, {
          meta: [known ? issue.status.replace("_", " ") : "not in this sweep"],
          ...(known ? {} : { tone: "neutral" as const }),
          selectedId,
          actions: [{ type: "select-bead", label: "Inspect", payload: { id: selectedId } }],
        }),
      ],
    },
  ]);
}

// ── Backlog: everything open that is neither in flight nor on an epic's
// map, one row per bead, grouped by priority so the sort order is said
// rather than implied.
export function composeBacklog(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.backlog.ok) return failedBoard("the backlog", m.backlog.error, m);
  const openEpics = new Set(m.backlog.data.filter((i) => i.issue_type === "epic").map((i) => i.id));
  // Epic membership: parent-child edges when measured, else dotted ids, so
  // an unmeasured sweep degrades to a less grouped backlog, never a thinner one.
  const onLadder = new Set<string>();
  if (m.epicChildren.ok) {
    for (const members of Object.values(m.epicChildren.data))
      for (const c of members) onLadder.add(c.id);
  } else {
    for (const i of m.backlog.data) {
      const dot = i.id.lastIndexOf(".");
      if (dot > 0 && openEpics.has(i.id.slice(0, dot))) onLadder.add(i.id);
    }
  }
  const blockers = new Map<string, string[]>(
    (m.blocked.ok ? m.blocked.data : []).map((b) => [b.id, b.blocked_by ?? []]),
  );
  const items = m.backlog.data
    .filter(
      (i) =>
        i.issue_type !== "epic" &&
        i.status !== "in_progress" &&
        i.status !== "closed" &&
        !(onLadder.has(i.id) && m.epics.ok && m.epics.data.length > 0),
    )
    .sort(byPriorityThenAge);
  if (items.length === 0) {
    return board([quiet("Nothing loose. Everything open is on an epic or in flight.")]);
  }
  const shown = items.slice(0, BACKLOG_CAP);
  const sections: BoardSection[] = [];
  const byPriority = new Map<number, BdIssue[]>();
  for (const i of shown) {
    const p = i.priority ?? 2;
    byPriority.set(p, [...(byPriority.get(p) ?? []), i]);
  }
  const PRIORITY_NAME = ["urgent", "high", "normal", "low", "someday"];
  for (const [p, group] of [...byPriority.entries()].sort((a, b) => a[0] - b[0])) {
    sections.push({
      kind: "rows",
      title: `P${p} · ${PRIORITY_NAME[p] ?? "backlog"} · ${group.length}`,
      items: group.map((i) => {
        const waits = blockers.get(i.id) ?? [];
        const signal = mergedPR(m.prInfo, i.id)
          ? "merged · close pending"
          : waits.length
            ? `waits on ${waits.join(", ")}`
            : i.status === "blocked"
              ? "paused by hand"
              : i.status === "deferred"
                ? "on hold"
                : declaredDownstream(i, backlogIndex(m)) > 0
                  ? `${declaredDownstream(i, backlogIndex(m))} downstream`
                  : undefined;
        return beadRow(i, [shortPerson(personOf(i)), signal, i.issue_type === "bug" && "bug"], ctx);
      }),
    });
  }
  if (shown.length < items.length) {
    sections.push({
      kind: "rows",
      items: [{ icon: "…", text: `Showing ${shown.length} of ${items.length}.` }],
    });
  }
  return board(sections);
}

// ── Shipped: this week against last, then every close in the fortnight by
// day with the PR and the close reason's first sentence.
export function composeShipped(m: ProjectMeasurement, ctx: PanelContext = {}): Board {
  if (!m.closedFortnight.ok) return failedBoard("recent closes", m.closedFortnight.error, m);
  const now = new Date(m.asOf);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const closed = [...m.closedFortnight.data].sort((a, b) =>
    (a.closed_at ?? "") > (b.closed_at ?? "") ? -1 : 1,
  );
  const thisWeek = closed.filter((i) => (i.closed_at ?? "") >= weekAgo).length;
  const lastWeek = closed.length - thisWeek;
  const delta = (a: number, b: number) => ({
    text: a === b ? "±0" : a > b ? `+${a - b}` : `−${b - a}`,
    direction: a === b ? ("flat" as const) : a > b ? ("up" as const) : ("down" as const),
    tone: "neutral" as const,
  });
  const stats: Extract<BoardSection, { kind: "stats" }>["items"] = [
    {
      label: "Shipped this week",
      value: thisWeek,
      sub: `last week ${lastWeek}`,
      delta: delta(thisWeek, lastWeek),
    },
  ];
  if (m.backlog.ok) {
    const created = [...m.backlog.data, ...m.closedFortnight.data].filter(
      (i) => i.issue_type !== "epic",
    );
    const seen = new Set<string>();
    let createdThis = 0;
    let createdLast = 0;
    const fortnight = new Date(now.getTime() - 14 * 86_400_000).toISOString();
    for (const i of created) {
      if (seen.has(i.id) || !i.created_at) continue;
      seen.add(i.id);
      if (i.created_at >= weekAgo) createdThis += 1;
      else if (i.created_at >= fortnight) createdLast += 1;
    }
    stats.push({
      label: "Created this week",
      value: createdThis,
      sub: `last week ${createdLast}`,
      delta: delta(createdThis, createdLast),
    });
  } else {
    stats.push({ label: "Created this week", value: null, sub: "backlog unmeasured" });
  }
  if (closed.length === 0) {
    // A quiet fortnight is one line: pace tiles would compare zero with zero.
    const created = stats[1]?.value;
    return board([
      quiet(
        typeof created === "number"
          ? `Nothing closed in the last 14 days. ${created} created this week.`
          : "Nothing closed in the last 14 days. Created this week is unmeasured.",
      ),
    ]);
  }
  const sections: BoardSection[] = [{ kind: "stats", items: stats }];
  const shown = closed.slice(0, SHIPPED_CAP);
  let day: { title: string; items: CardItem[] } | undefined;
  for (const i of shown) {
    const label = i.closed_at ? dayLabel(i.closed_at, now) : "Date not recorded";
    if (!day || day.title !== label) {
      day = { title: label, items: [] };
      sections.push({ kind: "cards", title: day.title, items: day.items });
    }
    const pr = shippedPR(i);
    day.items.push(
      beadCard(i, {
        meta: [i.issue_type === "epic" && "epic", shortPerson(personOf(i)), clock(i.closed_at)],
        evidence: i.close_reason?.trim()
          ? { text: firstSentence(i.close_reason) }
          : { text: "Closed without a written reason." },
        fields: pr ? [prField(pr)] : [],
        selectedId: ctx.selectedId,
      }),
    );
  }
  if (closed.length > shown.length) {
    sections.push({
      kind: "rows",
      items: [
        {
          icon: "…",
          text: `Showing the newest ${shown.length} of ${closed.length} closes in 14 days. beads_list with status closed has the rest.`,
        },
      ],
    });
  }
  return board(sections);
}

// ── The inspector: one bead in full, in the canvas drawer. Facts and links
// on the left; description, acceptance criteria and the evidence timeline on
// the right.
export interface InspectOptions {
  epicRow?: BdEpicRow;
  prInfo?: ProjectMeasurement["prInfo"];
  projectId?: string;
  comments?: Measured<BdComment[]>;
}

const linkedId = (l: BdLinked): string => l.id ?? l.depends_on_id ?? l.issue_id ?? "?";
const edgeType = (l: BdLinked): string | undefined => l.dependency_type ?? l.type;

// What happened on a bead, oldest first: created, claimed, the plan and run
// notes, comments, and the close. A stop the tracker did not record renders
// hollow and says so rather than borrowing another field's time.
export function beadTimeline(
  i: BdIssue,
  comments: readonly BdComment[],
  pr: PrInfo | undefined,
): RowItem[] {
  interface Stop {
    at?: string;
    order: number;
    row: RowItem;
  }
  const stops: Stop[] = [];
  const epic = (i.dependencies ?? []).find((d) => edgeType(d) === "parent-child");
  stops.push({
    at: i.created_at,
    order: 0,
    row: {
      icon: "+",
      text: [
        `Created${i.created_by ? ` by ${i.created_by}` : ""}`,
        ...(epic ? [`in epic ${linkedId(epic)}`] : []),
      ].join(" "),
      trailing: stamp(i.created_at),
    },
  });
  const claimed = i.status === "in_progress" || i.status === "closed" || Boolean(i.started_at);
  if (claimed) {
    const who = shortPerson(personOf(i));
    stops.push({
      at: i.started_at,
      order: 1,
      row: i.started_at
        ? { icon: "◐", text: `Claimed${who ? ` by ${who}` : ""}`, trailing: stamp(i.started_at) }
        : {
            icon: "○",
            text: `Claimed${who ? ` by ${who}` : ""}, time not recorded`,
          },
    });
  }
  for (const line of (i.notes ?? "").split("\n")) {
    const plan = /^bead-work plan:\s*(.+)$/.exec(line.trim());
    if (plan?.[1]) {
      stops.push({
        at: i.started_at,
        order: 2,
        row: { icon: "☰", text: `Plan ${plan[1].split("—")[0]?.trim() ?? plan[1]}` },
      });
    }
  }
  const run = parseRunNote(i.notes);
  if (run) {
    const face = run.prUrl
      ? `PR ${prLabel(run.prUrl)}`
      : run.prState === "number-only"
        ? `PR #${run.prNumber}, link unknown`
        : run.prState === "unknown"
          ? "PR state unknown"
          : "No PR";
    const live = pr
      ? isMergedPR(pr)
        ? `merged ${stamp(pr.mergedAt)}`
        : [
            pr.state.toLowerCase(),
            ...(pr.draft ? ["draft"] : []),
            ...(pr.checks ? [`CI ${pr.checks}`] : []),
            ...(pr.review ? [pr.review] : []),
          ].join(" · ")
      : undefined;
    stops.push({
      at: undefined,
      order: 3,
      row: {
        icon: "↗",
        text: [face, run.outcome, run.note].filter(Boolean).join(" · "),
        ...(run.prUrl ? { href: run.prUrl } : {}),
        ...(live ? { trailing: live } : {}),
      },
    });
  }
  for (const c of comments) {
    const who = c.author ?? "comment";
    stops.push({
      at: c.created_at,
      order: 4,
      row: {
        icon: "“",
        text: `${who}: ${firstSentence(c.text, 140)}`,
        trailing: stamp(c.created_at),
        ...(c.text.length > 140 || firstSentence(c.text, 140) !== c.text.trim()
          ? { detail: c.text.slice(0, 4000) }
          : {}),
      },
    });
  }
  if (i.status === "closed") {
    const reason = i.close_reason?.trim();
    stops.push({
      at: i.closed_at ?? "9999",
      order: 5,
      row: {
        icon: "✓",
        text: reason ? `Closed: ${firstSentence(reason, 140)}` : "Closed without a written reason",
        ...(i.closed_at ? { trailing: stamp(i.closed_at) } : {}),
        ...(reason && firstSentence(reason, 140) !== reason
          ? { detail: reason.slice(0, 4000) }
          : {}),
      },
    });
  }
  // Untimed stops (plan, run) sit after the claim and before anything later.
  const claimAt = i.started_at ?? i.created_at ?? "";
  return stops
    .map((s) => ({ ...s, key: s.at ?? claimAt }))
    .sort((a, b) => (a.key === b.key ? a.order - b.order : a.key < b.key ? -1 : 1))
    .map((s) => s.row);
}

// Acceptance criteria as one item per criterion. A numbered list written on
// one line splits only where the next number in sequence starts, so a number
// inside a sentence stays in it. A ticked checkbox keeps its tick.
export function criteriaItems(text: string): { text: string; checked: boolean }[] {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .flatMap((line) => {
      if (!/^1[.)]\s/.test(line)) return [line];
      const parts: string[] = [];
      let rest = line;
      for (let n = 2; ; n++) {
        const at = rest.search(new RegExp(`\\s${n}[.)]\\s`));
        if (at < 0) break;
        parts.push(rest.slice(0, at));
        rest = rest.slice(at).trimStart();
      }
      return [...parts, rest];
    });
  return lines
    .map((line) => {
      const body = line.replace(/^(?:[-*•]\s+)?/, "");
      const box = /^\[([ xX])\]\s+/.exec(body);
      return {
        text: (box ? body.slice(box[0].length) : body).replace(/^\d+[.)]\s+/, "").trim(),
        checked: Boolean(box && box[1] !== " "),
      };
    })
    .filter((item) => item.text.length > 0);
}

export function composeInspect(
  issue: Measured<BdIssue> | undefined,
  blocked: BdIssue[],
  recommended?: BdIssue,
  opts: InspectOptions = {},
): Board {
  const { epicRow } = opts;
  if (!issue) {
    return board([quiet("Nothing selected. Click any bead on the board to open it here.")]);
  }
  if (!issue.ok) return failedBoard("the selected bead", issue.error);
  const i = issue.data;
  const merged =
    i.status === "open" || i.status === "in_progress" ? mergedPR(opts.prInfo, i.id) : undefined;
  const mergedAlternative = recommended && mergedPR(opts.prInfo, recommended.id);
  const linked = (list: readonly BdLinked[]): { id: string; text: string }[] =>
    list.map((l) => ({
      id: linkedId(l),
      text: l.title ? `${linkedId(l)} · ${l.title}` : linkedId(l),
    }));
  // A linked bead opens in this same drawer, so a chain can be walked.
  const linkRow = (icon: string, l: { id: string; text: string }): RowItem => ({
    icon,
    text: l.text,
    ...(l.id === "?" ? {} : { action: { type: "select-bead", payload: { id: l.id } } }),
  });
  // Only blocking edges that still hold. A parent-child edge is membership,
  // and a closed blocker is satisfied; unknown status is kept, since absence
  // of proof that it is done is not proof.
  const deps = i.dependencies ?? [];
  const epicEdge = deps.find((d) => edgeType(d) === "parent-child");
  const waitsOn = linked(
    deps.filter((d) => edgeType(d) !== "parent-child" && d.status !== "closed"),
  );
  const children = (i.dependents ?? []).filter((d) => edgeType(d) === "parent-child");
  const unlocks = linked((i.dependents ?? []).filter((d) => edgeType(d) !== "parent-child"));
  const blockedEntry = blocked.find((b) => b.id === i.id);
  const blockedBy = (blockedEntry?.blocked_by ?? []).filter(
    (id) => id !== linkedId(epicEdge ?? {}),
  );
  const isBlocked =
    i.status === "blocked" ||
    (blockedEntry !== undefined && (blockedBy.length > 0 || waitsOn.length > 0));
  const blockerCount = blockedBy.length || waitsOn.length;
  const meta: LeafSection = {
    kind: "rows",
    boxed: true,
    items: [
      { text: "status", trailing: `${statusGlyph(i.status)} ${i.status.replace("_", " ")}` },
      { text: "priority", trailing: `P${i.priority}` },
      { text: "owner", trailing: shortPerson(personOf(i)) ?? "unassigned" },
      ...(i.issue_type ? [{ text: "type", trailing: i.issue_type }] : []),
      ...(epicEdge
        ? [
            {
              text: "epic",
              trailing: epicEdge.title
                ? `${linkedId(epicEdge)} · ${epicEdge.title}`
                : linkedId(epicEdge),
            },
          ]
        : []),
      ...(i.labels?.length ? [{ text: "labels", trailing: i.labels.join(", ") }] : []),
    ],
  };
  const left: LeafSection[] = [meta];
  const right: LeafSection[] = [];
  if (isBlocked) {
    left.push({
      kind: "rows",
      items: [
        {
          glyph: "error",
          chip: { label: "blocked", tone: "error" },
          text: blockerCount
            ? `Waits on ${plural(blockerCount, "bead")}, listed below.`
            : "Paused by hand. No blocking dependency recorded.",
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
          chip: { label: "merged · close pending", tone: "warn" },
          text: `PR ${prLabel(merged.url)} merged ${stamp(merged.mergedAt)}; the bead is still ${i.status.replace("_", " ")}. Reconcile after reviewing the recorded link.`,
          href: merged.url,
        },
      ],
    });
    if (opts.projectId) left.push({ kind: "actions", items: [reconcileAction(opts.projectId)] });
  }
  // An epic is structure, never a work item, so the inspector never offers
  // to start one.
  if (i.issue_type === "epic") {
    const p = epicRow?.epic.id === i.id ? epicRow : undefined;
    left.push({
      kind: "rows",
      items: [
        {
          glyph: p?.eligible_for_close ? "warn" : "neutral",
          chip: { label: "epic", tone: "neutral" },
          text: p?.eligible_for_close
            ? `All ${p.total_children} children are closed. Review this epic against its own acceptance criteria before closing it by hand${merged ? " or reconciling its own linked PR" : ""}.`
            : "An epic is structure, not work. Start one of its children instead.",
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
      items: isBlocked
        ? [
            claim(i.id, "Start this bead", {
              reason: blockerCount ? `waits on ${plural(blockerCount, "bead")}` : "paused by hand",
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
      items: (waitsOn.length ? waitsOn : blockedBy.map((id) => ({ id, text: id }))).map((l) =>
        linkRow("●", l),
      ),
    });
  }
  if (children.length) {
    left.push({
      kind: "rows",
      title: "Children",
      items: children.map((c) =>
        linkRow(statusGlyph(c.status ?? "open"), {
          id: linkedId(c),
          text: c.title ? `${linkedId(c)} · ${c.title}` : linkedId(c),
        }),
      ),
    });
  }
  if (unlocks.length) {
    left.push({
      kind: "rows",
      title: "Unlocks when done",
      items: unlocks.map((l) => linkRow("↗", l)),
    });
  }
  const prose = (label: string, body: string | undefined) => {
    if (!body?.trim()) return;
    const paras = body
      .trim()
      .split(/\n{2,}/)
      .slice(0, PARA_CAP);
    right.push({ kind: "rows", title: label, items: paras.map((p) => ({ text: p })) });
  };
  prose("Description", i.description);
  const criteria = criteriaItems(i.acceptance_criteria ?? "").slice(0, PARA_CAP);
  if (criteria.length) {
    right.push({
      kind: "rows",
      title: "Acceptance criteria",
      items: criteria.map((c) => ({ icon: c.checked ? "☑" : "☐", text: c.text })),
    });
  }
  // The bead-work lines render in the timeline; anything else a person wrote
  // in notes stays as prose.
  prose(
    "Notes",
    (i.notes ?? "")
      .split("\n")
      .filter((l) => !/^bead-work (run|plan):/.test(l.trim()))
      .join("\n"),
  );
  const comments = opts.comments?.ok ? opts.comments.data : [];
  const pr = opts.prInfo?.ok ? opts.prInfo.data[i.id] : undefined;
  right.push({
    kind: "rows",
    title: "History",
    items: [
      ...beadTimeline(i, comments, pr?.ok ? pr.data : undefined),
      ...(opts.comments && !opts.comments.ok ? [alarmRow("comments", opts.comments.error)] : []),
    ],
  });
  return board(
    [
      {
        kind: "columns",
        columns: [
          { weight: 1, sections: left },
          { weight: 2, sections: right },
        ],
      },
    ],
    {
      status: {
        label: `${i.id} · ${i.status.replace("_", " ")}`,
        tone: lifecycleTone(lifecycleOf(i)),
      },
      chip: clampTitle(i.title, 80),
    },
  );
}

// The inspector when bd is below the floor: `bd show --include-dependents`
// would fail on every click, so it says why once.
export function composeInspectNeedsBd(m: Pick<ProjectMeasurement, "bd">): Board {
  const floor = bdBelowFloor(m) ?? "bd is below the supported version";
  return failedBoard("the inspector", floor, m);
}

// ── Scope resting states, rendered on the header (the one always-on region);
// every other panel hides itself via the zero-section signal.
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
                text: "What is in flight, what is left and what shipped, measured with bd, never inferred.",
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

// ── The first sweep of a newly picked project: the panels name the project
// being measured instead of leaving the previous project's frames in place.
export function composeMeasuringPulse(projectName: string): Board {
  return board([quiet(`Measuring ${projectName}. The panels fill in when bd answers.`)], {
    status: { label: projectName, tone: "neutral" },
    chip: "first sweep running",
  });
}

export function composeMeasuringPanel(projectName: string): Board {
  return board([quiet(`Measuring ${projectName}.`)]);
}

// A sweep that threw (bd could not be run at all) alarms on every panel.
export function composeSweepFailed(error: string): Board {
  return failedBoard("this project", error);
}
