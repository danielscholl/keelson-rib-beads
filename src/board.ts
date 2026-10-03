// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The Beads surface reads in the order the operator acts: the tracker strip,
// the Overview, Now (In flight, Next up, Your calls), then the epic wave map
// (map.ts), then Backlog and Shipped. The Overview's flow strip says the
// totals once, and reports a shared cause (an old bd, a failing gh) once
// instead of letting every panel alarm on its own.
//
// Every bead renders in one shape. A card when there is evidence to show:
// lane dot, full title, a meta line that leads with the id as bd prints it,
// at most one signal pill, and the evidence (close reason, newest comment,
// run remark) as the card's reason line. A row when a list is dense and has
// no evidence: lane dot, title, then id and signal on the right. The dot is
// the lane (to do, in flight, done) and nothing else; waiting, staleness and
// merge drift are signals, never colours.

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type {
  BdComment,
  BdEpicRow,
  BdIssue,
  BdLinked,
  BdSummary,
  BeadRunInfo,
  Measured,
} from "./bd";
import { bdFloorLabel, unmeasured } from "./bd";
import type { EpicMember, ProjectMeasurement, SweepProgress } from "./measure";
import {
  bdBelowFloor,
  byPriorityThenAge,
  parseRunNote,
  parseRunNotes,
  STALE_DAYS,
} from "./measure";
import { isMergedPR, type PrInfo } from "./pr";
import { type LiveRun, RUN_PHASES } from "./runs";

const CALLS_CAP = 8;
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
  // Live beads-work runs on this panel's tracker, newest first.
  runs?: readonly LiveRun[];
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

// Beads only a person can finish: a decision, or work labelled for its owner.
// An agent run must never be pointed at one.
export const HUMAN_LABELS = ["owner", "human"] as const;

export function isHumanCall(i: { issue_type?: string; labels?: readonly string[] }): boolean {
  if (i.issue_type === "decision") return true;
  return (i.labels ?? []).some((l) => (HUMAN_LABELS as readonly string[]).includes(l));
}

// The recommendation: leverage first (dependent_count — finishing it frees
// the most stuck work), priority second, age third. ONE pick with a named
// runner-up: a queue of twelve is a report, not a decision. Human calls are
// not agent work, so they are never the pick; Your calls ranks them.
export function recommendNext(ready: BdIssue[]): { pick?: BdIssue; runnerUp?: BdIssue } {
  const ranked = ready
    .filter((i) => !isHumanCall(i))
    .sort((a, b) => {
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

// The beads that go ready the moment `id` closes: open, unclaimed, and held
// by no other open blocker. Structure edges drop out the way damGroups drops
// them.
export function freedBy(
  id: string,
  blocked: BdIssue[],
  index: ReadonlyMap<string, BdIssue>,
): BdIssue[] {
  return blocked.filter((b) => {
    if (b.status !== "open") return false;
    const parent = b.parent ?? index.get(b.id)?.parent;
    const holds = (b.blocked_by ?? []).filter((dep) => {
      if (dep === parent) return false;
      const blocker = index.get(dep);
      return blocker?.issue_type !== "epic" && blocker?.status !== "closed";
    });
    return holds.length > 0 && holds.every((dep) => dep === id);
  });
}

// With nothing ready, the claims whose close frees work, most freed first;
// ties rank the way Next up ranks a pick.
export function nextToUnlock(
  inFlight: BdIssue[],
  blocked: BdIssue[],
  index: ReadonlyMap<string, BdIssue>,
): { claim: BdIssue; freed: BdIssue[] }[] {
  return inFlight
    .map((claim) => ({ claim, freed: freedBy(claim.id, blocked, index) }))
    .filter((c) => c.freed.length > 0)
    .sort((a, b) => {
      if (a.freed.length !== b.freed.length) return b.freed.length - a.freed.length;
      const la = a.claim.dependent_count ?? 0;
      const lb = b.claim.dependent_count ?? 0;
      if (la !== lb) return lb - la;
      return byPriorityThenAge(a.claim, b.claim);
    });
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

// The host's own wall clock: keelson runs on the operator's machine, so its
// zone is the reader's.
export function localClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
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
// The priority most of a set shares, when one strictly leads. A pill for it
// would sit on most of the set and say nothing.
export function commonPriority(items: readonly { priority?: number }[]): number | undefined {
  const counts = new Map<number, number>();
  for (const i of items) counts.set(i.priority ?? 2, (counts.get(i.priority ?? 2) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  return top && (!next || top[1] > next[1]) ? top[0] : undefined;
}

export interface SignalContext {
  // P1 is a signal only where it stands out; P0 always is.
  commonPriority?: number;
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
  if (i.priority === 1 && c.commonPriority !== 1) return { label: "P1", tone: "warn" };
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

// ── Header: the flow strip with the week's totals, and the preflight, so
// one cause reads as one line.
export function composePulse(
  m: ProjectMeasurement,
  refreshing?: SweepProgress,
  runs: readonly LiveRun[] = [],
): Board {
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
  // An empty lane draws nothing and only crowds the legend; an unmeasured
  // one (n: null) always stays so its hatch shows.
  const lanes = segments.some((s) => s.n !== 0) ? segments.filter((s) => s.n !== 0) : segments;

  const preflight: RowItem[] = gateLine(runs);
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
  // Merged on GitHub, still open in bd: one reconcile closes them all, so it
  // is a line and a button here rather than a card per bead.
  const drift =
    m.prInfo.ok && m.backlog.ok
      ? m.backlog.data.filter(
          (i) => (i.status === "open" || i.status === "in_progress") && mergedPR(m.prInfo, i.id),
        )
      : [];
  const partialPR =
    m.prInfo.ok && !gh.failing
      ? Object.entries(m.prInfo.data).flatMap(([id, e]) => (e.ok ? [] : [`${id}: ${e.error}`]))
      : [];
  if (partialPR.length && !floor) {
    preflight.push({
      icon: "⚠",
      chip: { label: "UNMEASURED", tone: "error" },
      text: `PR state could not be read for ${plural(partialPR.length, "bead")}, so a merge waiting to be reconciled may be missing here.`,
      detail: partialPR.join("\n").slice(0, 1000),
    });
  }
  const housekeeping = [
    m.stale.ok && m.stale.data.length > 0 ? plural(m.stale.data.length, "stale claim") : "",
    m.epics.ok && m.epics.data.some((r) => r.eligible_for_close)
      ? `${plural(m.epics.data.filter((r) => r.eligible_for_close).length, "epic")} ready for closeout`
      : "",
  ].filter(Boolean);
  if (housekeeping.length) {
    preflight.push({
      glyph: "neutral",
      text: `Housekeeping: ${housekeeping.join(" · ")}. The beads-groom workflow reports both.`,
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
    refreshing
      ? `refreshing · ${refreshing.done} of ${refreshing.total}`
      : `measured ${localClock(m.asOf)}`,
  ].filter(Boolean);
  return board(
    [
      { kind: "segments", items: lanes },
      ...(preflight.length ? [{ kind: "rows" as const, items: preflight }] : []),
      ...(drift.length
        ? [
            {
              kind: "rows" as const,
              items: [
                {
                  glyph: "warn" as const,
                  chip: { label: "merged", tone: "warn" as const },
                  text: `${plural(drift.length, "bead")} merged on GitHub and still open in bd: ${drift
                    .slice(0, 6)
                    .map((i) => i.id)
                    .join(", ")}${drift.length > 6 ? ` +${drift.length - 6} more` : ""}.`,
                },
              ],
            },
            { kind: "actions" as const, wrap: true, items: [reconcileAction(m.project.id)] },
          ]
        : []),
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
    const calls = m.ready.data.filter(isHumanCall).length;
    const unlock =
      calls === 0 && m.inProgress.ok
        ? nextToUnlock(m.inProgress.data, blocked, backlogIndex(m))
        : [];
    const [first, second] = unlock;
    if (first) {
      const short = (id: string) => shortId(id, parentIdOf(first.claim.id));
      return board([
        {
          kind: "cards",
          title: "Nothing is ready · next to unlock",
          items: [
            beadCard(first.claim, {
              meta: ["in flight", shortPerson(personOf(first.claim)), `P${first.claim.priority}`],
              evidence: {
                label: "why",
                text: `closing it makes ${plural(first.freed.length, "bead")} ready`,
              },
              fields: [{ label: "frees", value: first.freed.map((b) => short(b.id)).join(", ") }],
              selectedId: ctx.selectedId,
              actions: [{ type: "select-bead", label: "Inspect", payload: { id: first.claim.id } }],
              footnote: second
                ? `then: ${short(second.claim.id)} frees ${second.freed.length} · ${clampTitle(second.claim.title, 80)}`
                : "no other claim frees work on its own",
            }),
          ],
        },
      ]);
    }
    return board([
      quiet(
        calls > 0
          ? `Nothing ready is agent work. ${plural(calls, "ready bead")} ${calls === 1 ? "is a call" : "are calls"} for you; Your calls has ${calls === 1 ? "it" : "them"}.`
          : "Nothing is ready to start. Everything open is blocked or on hold; the wave map shows what holds it.",
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
  const runs = ctx.runs ?? [];
  const runOf = (id: string) => runs.find((r) => r.beadId === id);
  const picking = runs.filter((r) => !r.beadId).map(pickingRow);
  if (m.inProgress.data.length === 0) {
    return board(
      picking.length
        ? [{ kind: "rows", items: picking }]
        : [quiet("Nothing is claimed. Next up has the pick.")],
    );
  }
  const floor = bdBelowFloor(m);
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const index = backlogIndex(m);
  const inFlight = new Set(m.inProgress.data.map((i) => i.id));
  // What still holds a claim, minus structure edges, so a claim under an
  // epic never reads as waiting on its own epic.
  const holdsOf = (i: BdIssue): string[] => {
    const parent = i.parent ?? index.get(i.id)?.parent;
    const entry = blocked.find((b) => b.id === i.id);
    return (entry?.blocked_by ?? []).filter((dep) => {
      if (dep === parent) return false;
      const blocker = index.get(dep);
      return blocker?.issue_type !== "epic" && blocker?.status !== "closed";
    });
  };
  const people = assigneeView(m.inProgress.data);
  const common = commonPriority(m.inProgress.data);
  const runCount = m.inProgress.data.filter(
    (i) => runOf(i.id) !== undefined || runInfoOf(m, i.id) !== undefined,
  ).length;
  const otherCount = m.inProgress.data.length - runCount;
  const title =
    runCount > 0 || picking.length > 0
      ? [
          ...(runCount > 0 ? [plural(runCount, "bead-work run")] : []),
          ...(picking.length > 0 ? [`${picking.length} picking`] : []),
          ...(otherCount > 0 ? [plural(otherCount, "other claim")] : []),
        ].join(" · ")
      : people.sharedTitle;
  const cards = [...m.inProgress.data].sort(byPriorityThenAge).map((i): CardItem => {
    const entry = m.runInfo.ok ? m.runInfo.data[i.id] : undefined;
    const info = entry?.ok ? entry.data : undefined;
    const run = runOf(i.id);
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
    const holds = holdsOf(i);
    const short = (id: string) => shortId(id, parentIdOf(i.id));
    const holdText = (id: string) => {
      const title = holds.length === 1 ? index.get(id)?.title : undefined;
      const state = inFlight.has(id) ? " (in flight)" : "";
      return `${short(id)}${title ? ` · ${clampTitle(title, 60)}` : ""}${state}`;
    };
    const card = beadCard(i, {
      meta: [
        people.perItem
          ? (person ?? (people.markUnassigned ? "unassigned" : undefined))
          : !info && !run && runCount > 0
            ? person
            : undefined,
        run ? runMeta(run) : flightStage(i, info, pr, now),
      ],
      signal: signalOf(i, {
        commonPriority: common,
        mergePending: Boolean(mergedPR(m.prInfo, i.id)),
        waitingOn: holds,
        staleDays: staleDaysOf(m, i, now),
      }),
      ...(evidence ? { evidence } : {}),
      fields: [
        // A no-break space: the host lets a field label wrap at phone width.
        ...(holds.length
          ? [
              {
                label: "waits\u00a0on",
                value: holds.map(holdText).join(", "),
                tone: "caution" as const,
              },
            ]
          : []),
        ...(info?.prUrl ? [prField(info.prUrl)] : []),
        ...(releases.length
          ? [{ label: "releases", value: releases.map((b) => short(b.id)).join(", ") }]
          : []),
        ...(runError
          ? [{ value: `UNMEASURED run note: ${runError}`.slice(0, 120), tone: "error" as const }]
          : []),
        ...(prError
          ? [{ value: `UNMEASURED PR: ${prError}`.slice(0, 120), tone: "error" as const }]
          : []),
        ...(run?.error
          ? [{ value: `UNMEASURED run: ${run.error}`.slice(0, 120), tone: "error" as const }]
          : []),
      ],
      ...(run ? { actions: [openRunAction(run)] } : {}),
      selectedId: ctx.selectedId,
    });
    // A live run draws its own meter only from a good read; otherwise the
    // meter reads the run note, so an unread note draws no meter.
    if (run && !run.error) return { ...card, bar: runBar(run) };
    return entry?.ok ? { ...card, bar: stageBar(info, pr) } : card;
  });
  return board([
    ...(floor
      ? [{ kind: "rows" as const, items: [alarmRow("run notes and PR state", floor, m)] }]
      : []),
    ...(picking.length ? [{ kind: "rows" as const, items: picking }] : []),
    { kind: "cards", ...(title ? { title } : {}), items: cards },
  ]);
}

// A claim's three recorded stops as a meter: claimed, PR open, merged. The
// caption names the stop reached and the one after it; a stop not reached
// stays neutral and says so in its label.
export function stageBar(
  info: BeadRunInfo | undefined,
  pr: PrInfo | undefined,
): NonNullable<CardItem["bar"]> {
  const reached = [true, Boolean(info?.prUrl), Boolean(pr && isMergedPR(pr))];
  const names = ["claimed", "PR open", "merged"];
  const last = reached.lastIndexOf(true);
  return {
    label: names[last] ?? "claimed",
    trailing: last + 1 < names.length ? `next: ${names[last + 1]}` : "next: close",
    segments: names.map((name, at) => ({
      label: at <= last ? name : `${name}, not yet`,
      n: 1,
      tone: at <= last ? (at === 2 ? STAGE_TONE.done : STAGE_TONE.working) : STAGE_TONE.waiting,
    })),
  };
}

// A live run's six phases as a meter. The approval stop reads as waiting on
// you while the gate is open, the one phase that waits on a person.
export function runBar(run: LiveRun): NonNullable<CardItem["bar"]> {
  const at = RUN_PHASES.indexOf(run.phase);
  const gate = run.status === "paused";
  const next = RUN_PHASES[at + 1];
  return {
    label: gate ? "waiting on you" : run.phase,
    trailing: next ? `next: ${next}` : "next: writeback",
    segments: RUN_PHASES.map((phase, idx) => ({
      label: idx < at ? phase : idx === at ? `${phase}, now` : `${phase}, not yet`,
      n: 1,
      tone:
        idx < at
          ? STAGE_TONE.working
          : idx === at
            ? gate
              ? "caution"
              : STAGE_TONE.review
            : STAGE_TONE.waiting,
    })),
  };
}

export function runMeta(run: LiveRun): string {
  const since = ago(run.startedAt, new Date(run.readAt));
  return [
    `run ${run.runId.slice(0, 4)}`,
    since === "just now" ? "just started" : since ? `${since} in run` : undefined,
    run.pr ? `PR ${run.pr.startsWith("#") ? run.pr : prLabel(run.pr)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function openRunAction(run: LiveRun) {
  return { type: "open-run", label: "Open run", payload: { runId: run.runId } };
}

// A run that has not named its bead yet is still picking from the ready queue.
function pickingRow(run: LiveRun): RowItem {
  return {
    glyph: STAGE_TONE.working,
    text: "beads-work picking from the ready queue",
    trailing: runMeta(run),
    action: { type: "open-run", payload: { runId: run.runId } },
  };
}

function livePR(m: ProjectMeasurement, id: string): PrInfo | undefined {
  if (!m.prInfo.ok) return undefined;
  const entry = m.prInfo.data[id];
  return entry?.ok ? entry.data : undefined;
}

// ── Your calls: the beads only a person can finish (decisions and work
// labelled owner or human), ranked by how much work waits on each. Agent
// housekeeping (reconciles, stale claims, closeouts) rides the header line,
// and an empty list hides the panel.

// A run paused at its plan gate does nothing until a person answers, so its
// card leads Your calls whatever its bead holds, and opens the run directly.
function gateCard(run: LiveRun, m: ProjectMeasurement, ctx: PanelContext): CardItem {
  const id = run.beadId ?? `run ${run.runId.slice(0, 4)}`;
  const bead = run.beadId ? backlogIndex(m).get(run.beadId) : undefined;
  const waiting = ago(run.gate?.since, new Date(run.readAt));
  const plan = [
    run.gate?.tasks ? plural(run.gate.tasks, "task") : undefined,
    run.gate?.summary ? firstSentence(run.gate.summary, 160) : undefined,
  ].filter((x): x is string => Boolean(x));
  const card = beadCard(
    { id, title: `Approve plan: ${bead?.title ?? id}`, status: "in_progress" },
    {
      meta: [run.beadId ? `run ${run.runId.slice(0, 4)}` : undefined, "plan gate"],
      signal: { label: "run waiting", tone: "caution" },
      ...(plan.length ? { evidence: { label: "plan", text: plan.join(" · ") } } : {}),
      actions: [{ ...openRunAction(run), label: "Review plan", tone: "brand" as const }],
      selectedId: ctx.selectedId,
    },
  );
  return {
    ...card,
    action: { type: "open-run", payload: { runId: run.runId } },
    bar: {
      ...runBar(run),
      label: waiting && waiting !== "just now" ? `waiting on you · ${waiting}` : "waiting on you",
    },
  };
}

function gatesOf(runs: readonly LiveRun[] | undefined): LiveRun[] {
  return (runs ?? [])
    .filter((r) => r.status === "paused" && r.gate && !r.error)
    .sort((a, b) => (a.gate?.since ?? a.startedAt).localeCompare(b.gate?.since ?? b.startedAt));
}

// The Overview's one line for every open plan gate.
function gateLine(runs: readonly LiveRun[]): RowItem[] {
  const gates = gatesOf(runs);
  const first = gates[0];
  if (!first) return [];
  if (gates.length > 1) {
    return [
      {
        glyph: "caution",
        chip: { label: "waiting on you", tone: "caution" },
        text: `${gates.length} beads-work runs wait on your approval. Your calls lists them, oldest first.`,
      },
    ];
  }
  const waiting = ago(first.gate?.since, new Date(first.readAt));
  return [
    {
      glyph: "caution",
      chip: { label: "waiting on you", tone: "caution" },
      text: `A beads-work run waits on your approval for ${first.beadId ?? "its bead"}${waiting && waiting !== "just now" ? `, ${waiting}` : ""}.`,
      trailing: "Review plan ›",
      action: { type: "open-run", payload: { runId: first.runId } },
    },
  ];
}

export function composeYourCalls(m: ProjectMeasurement, ctx: PanelContext): Board {
  // A gate needs no bd read, so it stays offered when the backlog failed.
  const gated = gatesOf(ctx.runs);
  const gates = gated.map((r) => gateCard(r, m, ctx));
  if (!m.backlog.ok) {
    const failed = failedBoard("calls waiting on you", m.backlog.error, m);
    return gates.length
      ? board([
          { kind: "cards", title: `${plural(gates.length, "run")} waiting`, items: gates },
          ...failed.sections,
        ])
      : failed;
  }
  const gatedIds = new Set(gated.map((r) => r.beadId));
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const blockers = new Map<string, string[]>(blocked.map((b) => [b.id, b.blocked_by ?? []]));
  const calls = m.backlog.data
    .filter(
      (i) =>
        i.status !== "closed" && i.issue_type !== "epic" && isHumanCall(i) && !gatedIds.has(i.id),
    )
    .map((i) => {
      const levels = unlockLevels(i.id, blocked);
      return { i, levels, holds: levels.flat().length };
    })
    .sort((a, b) => b.holds - a.holds || byPriorityThenAge(a.i, b.i));
  if (calls.length === 0 && gates.length === 0) return HIDDEN;
  const shown = calls.slice(0, CALLS_CAP);
  const short = (id: string, from: string) => shortId(id, parentIdOf(from));
  const cards = shown.map(({ i, levels, holds }) => {
    const waits = blockers.get(i.id) ?? [];
    const first = levels[0] ?? [];
    const deeper = holds - first.length;
    return beadCard(i, {
      meta: [
        i.issue_type === "decision" ? "decision" : "owner call",
        `P${i.priority}`,
        i.status === "in_progress" ? `on it: ${shortPerson(personOf(i)) ?? "claimed"}` : undefined,
      ],
      signal: waits.length
        ? { label: `waits on ${waits.length}`, tone: "caution" }
        : holds > 0
          ? { label: `holds ${holds}`, tone: "warn" }
          : undefined,
      evidence:
        holds > 0
          ? {
              label: "unblocks",
              text: `${first.map((b) => short(b.id, i.id)).join(", ")}${deeper > 0 ? ` → ${deeper} more behind them` : ""}`,
            }
          : { label: "unblocks", text: "nothing waits on it" },
      selectedId: ctx.selectedId,
    });
  });
  // Distinct, since one bead can wait behind several calls.
  const total = new Set(calls.flatMap((c) => c.levels.flat().map((b) => b.id))).size;
  return board([
    ...(m.blocked.ok
      ? []
      : [
          {
            kind: "rows" as const,
            items: [alarmRow("what each call holds", m.blocked.error, m)],
          },
        ]),
    {
      kind: "cards",
      title: [
        ...(gates.length ? [`${plural(gates.length, "run")} waiting`] : []),
        ...(calls.length ? [plural(calls.length, "call")] : []),
        ...(total > 0 ? [`${plural(total, "bead")} wait on them`] : []),
      ].join(" · "),
      items: [...gates, ...cards],
    },
    ...(calls.length > shown.length
      ? [
          {
            kind: "rows" as const,
            items: [{ icon: "…", text: `Showing ${shown.length} of ${calls.length} calls.` }],
          },
        ]
      : []),
  ]);
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
  // A decision or owner-labelled bead: a person's call, never agent work.
  yours: boolean;
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
    humanIds?: ReadonlySet<string>;
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
      yours: lanes.humanIds?.has(member.id) ?? false,
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
  const humanIds = new Set(m.backlog.ok ? m.backlog.data.filter(isHumanCall).map((i) => i.id) : []);
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
        humanIds,
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
  // Nothing loose hides the panel, so Shipped takes the zone's full width.
  if (items.length === 0) return HIDDEN;
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
// day, one row each with its PR. The close reason lives in the inspector.
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
  let day: { title: string; items: RowItem[] } | undefined;
  for (const i of shown) {
    const label = i.closed_at ? dayLabel(i.closed_at, now) : "Date not recorded";
    if (!day || day.title !== label) {
      day = { title: label, items: [] };
      sections.push({ kind: "rows", title: day.title, items: day.items });
    }
    const pr = shippedPR(i);
    const row = beadRow(i, [pr && prLabel(pr), clock(i.closed_at)], ctx);
    day.items.push(i.issue_type === "epic" ? { ...row, chip: { label: "epic" } } : row);
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
  run?: LiveRun;
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
    ...(l.id === "?"
      ? {}
      : { trailing: "›", action: { type: "select-bead", payload: { id: l.id } } }),
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
  // The bead leads in its board shape: the title as the heading, the id once
  // in a meta line with the facts that fit on it.
  const head: LeafSection = {
    kind: "cards",
    items: [
      {
        title: i.title,
        dot: lifecycleTone(lifecycleOf(i)),
        fields: [
          {
            value: [
              i.id,
              `${statusGlyph(i.status)} ${i.status.replace("_", " ")}`,
              `P${i.priority}`,
              shortPerson(personOf(i)) ?? "unassigned",
              i.issue_type,
            ]
              .filter(Boolean)
              .join(" · "),
          },
          ...(epicEdge
            ? [
                {
                  label: "epic",
                  value: epicEdge.title
                    ? `${linkedId(epicEdge)} · ${epicEdge.title}`
                    : linkedId(epicEdge),
                },
              ]
            : []),
          ...(i.labels?.length ? [{ label: "labels", value: i.labels.join(", ") }] : []),
        ],
      },
    ],
  };
  const left: LeafSection[] = [head];
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
  if (opts.run) {
    left.push({
      kind: "rows",
      items: [
        {
          glyph: opts.run.status === "paused" ? "caution" : STAGE_TONE.working,
          chip: {
            label: opts.run.status === "paused" ? "waiting on you" : opts.run.phase,
            tone: opts.run.status === "paused" ? "caution" : STAGE_TONE.working,
          },
          text: opts.run.error
            ? `A beads-work run holds this bead: ${runMeta(opts.run)}. UNMEASURED run: ${opts.run.error}`.slice(
                0,
                240,
              )
            : `A beads-work run holds this bead: ${runMeta(opts.run)}.`,
        },
      ],
    });
    left.push({ kind: "actions", items: [{ ...openRunAction(opts.run), tone: "brand" as const }] });
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
    const claim = (id: string, label: string) => ({
      type: "claim-bead",
      label,
      tone: "brand" as const,
      payload: { id },
      confirm: {
        subject: id,
        title: "Claim this bead?",
        body: `Runs bd update ${id} --claim: assigns it to you and sets it in progress.`,
        confirmLabel: "Claim it",
      },
    });
    // A blocked bead offers only the alternative; the blocked row says why.
    const items = isBlocked
      ? recommended && recommended.id !== i.id
        ? mergedAlternative
          ? opts.projectId
            ? [reconcileAction(opts.projectId)]
            : []
          : [claim(recommended.id, `Start ${recommended.id} instead`)]
        : []
      : [claim(i.id, "Start this bead")];
    if (items.length) left.push({ kind: "actions", items });
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
      items: criteria.map((c) => ({ icon: c.checked ? "✓" : "•", text: c.text })),
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
  const runs = runRows(i.notes, opts.run?.runId);
  if (runs.length) {
    right.push({ kind: "rows", title: opts.run ? "Earlier runs" : "Runs", items: runs });
  }
  return board([
    {
      kind: "columns",
      columns: [
        { weight: 1, sections: left },
        { weight: 2, sections: right },
      ],
    },
  ]);
}

// Every past run a bead's notes name, newest first, each opening in the run
// drawer. The live run is the line above the actions, so it is not repeated.
export function runRows(notes: string | undefined, liveRunId?: string): RowItem[] {
  // A run can write two notes (its writeback, then a cancel's cleanup); the newest speaks.
  const newest = new Map<string, BeadRunInfo & { runId: string }>();
  for (const r of parseRunNotes(notes)) {
    if (!r.runId || r.runId === liveRunId) continue;
    newest.delete(r.runId);
    newest.set(r.runId, { ...r, runId: r.runId });
  }
  return [...newest.values()].reverse().map((r) => {
    const pr = r.prUrl
      ? `PR ${prLabel(r.prUrl)}`
      : r.prState === "number-only"
        ? `PR #${r.prNumber}`
        : r.prState === "unknown"
          ? "PR state unknown"
          : "no PR";
    const outcome = r.outcome ?? "ended";
    return {
      glyph:
        outcome === "success"
          ? STAGE_TONE.done
          : outcome === "failed"
            ? ("error" as const)
            : STAGE_TONE.waiting,
      text: `${outcome} · ${pr}`,
      trailing: `run ${r.runId.slice(0, 4)} ›`,
      action: { type: "open-run", payload: { runId: r.runId } },
    };
  });
}

// The inspector when bd is below the floor: `bd show --include-dependents`
// would fail on every click, so it says why once.
export function composeInspectNeedsBd(m: Pick<ProjectMeasurement, "bd">): Board {
  const floor = bdBelowFloor(m) ?? "bd is below the supported version";
  return failedBoard("the inspector", floor, m);
}

// ── The tracker strip: one tile per registered project with a beads
// tracker, the selected one ringed. A click switches the whole surface.
export interface TrackerTile {
  id: string;
  name: string;
  // Absent while the first count is still queued behind the selected sweep.
  summary?: Measured<BdSummary>;
  runs?: readonly LiveRun[];
}

function tileCounts(summary: Measured<BdSummary> | undefined): NonNullable<CardItem["fields"]> {
  if (!summary) return [{ value: "counting…" }];
  if (!summary.ok) return [{ value: "UNMEASURED", tone: "error" }];
  const s = summary.data;
  // One field per count, so a narrow tile wraps between phrases. Ready leads
  // because it is the count an operator acts on.
  return [
    {
      value: `${s.ready_issues} ready`,
      ...(s.ready_issues > 0 ? { tone: "accent" as const } : {}),
    },
    { value: `${s.in_progress_issues} in flight` },
    { value: `${s.open_issues} open` },
    { value: `${s.closed_issues} closed` },
  ];
}

// Named only while a run is live, so a quiet tracker reads as it always has.
function tileRuns(runs: readonly LiveRun[] | undefined): NonNullable<CardItem["fields"]> {
  if (!runs?.length) return [];
  const gates = gatesOf(runs).length;
  return [
    {
      value: `${plural(runs.length, "run")}${gates ? ` · ${gates} waiting on you` : ""}`,
      tone: gates ? ("caution" as const) : ("info" as const),
    },
  ];
}

export function composeTrackers(tiles: readonly TrackerTile[], selectedId?: string): Board {
  if (tiles.length === 0) {
    return board(
      [
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
      { status: { label: "no beads tracker registered", tone: "neutral" } },
    );
  }
  return board([
    {
      kind: "cards",
      grid: true,
      items: tiles.map((t) => ({
        title: t.name,
        dot: t.id === selectedId ? "brand" : "neutral",
        selected: t.id === selectedId,
        action: { type: "select-project", payload: { scopeId: t.id } },
        fields: [...tileCounts(t.summary), ...tileRuns(t.runs)],
      })),
    },
  ]);
}

export const EMPTY_PANEL: Board = HIDDEN;

// ── The first sweep of a newly picked project: the header fills a meter as
// each bd read lands, and the panels name the project being measured instead
// of leaving the previous project's frames in place.
export function composeMeasuringPulse(projectName: string, progress?: SweepProgress): Board {
  const p = progress ?? { done: 0, total: 1, label: "bd" };
  return board(
    [
      {
        kind: "segments",
        title: `Measuring ${projectName}: reading ${p.label}…`,
        items: [
          { label: "Read", n: p.done, tone: STAGE_TONE.working },
          { label: "To go", n: Math.max(0, p.total - p.done), tone: STAGE_TONE.waiting },
        ],
      },
    ],
    {
      status: { label: projectName, tone: "neutral" },
      chip: `first sweep · ${p.done} of ${p.total}`,
    },
  );
}

export function composeMeasuringPanel(projectName: string): Board {
  return board([quiet(`Measuring ${projectName}.`)]);
}

// A sweep that threw (bd could not be run at all) alarms on every panel.
export function composeSweepFailed(error: string): Board {
  return failedBoard("this project", error);
}
