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
// Visual grammar (operator feedback, 2026-08-09): color means STATE (accent
// ready, ok in-progress, error blocked, warn stale), priority is a quiet
// `P0`–`P4` text, ids are neutral chips, and the title is the scan target.

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

// Who waits on this bead, by name — read off the blocked union's blocked_by
// edges so the recommendation is explainable, never magical.
export function unlockChain(
  id: string,
  blocked: BdIssue[],
): { first: BdIssue[]; second: BdIssue[] } {
  const first = blocked.filter((b) => b.blocked_by?.includes(id));
  const firstIds = new Set(first.map((b) => b.id));
  const second = blocked.filter(
    (b) => !firstIds.has(b.id) && b.blocked_by?.some((dep) => firstIds.has(dep)),
  );
  return { first, second };
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

// ── Pulse: the five current-state numbers, plus scope + open-count context.
export function composePulse(m: ProjectMeasurement): Board {
  if (!m.summary.ok) return failedBoard("the KPI summary", m.summary.error);
  const s = m.summary.data;
  const blockedUnion = m.blocked.ok ? m.blocked.data.length : s.blocked_issues;
  const staleCount = m.stale.ok ? m.stale.data.length : 0;
  return board(
    [
      {
        kind: "stats",
        items: [
          {
            label: "Ready now",
            value: m.ready.ok ? m.ready.data.length : s.ready_issues,
            sub: "nothing blocks these",
            tone: "accent",
          },
          { label: "In progress", value: s.in_progress_issues, tone: "ok" },
          {
            label: "Blocked",
            value: blockedUnion,
            sub: "waiting on other work",
            tone: blockedUnion > 0 ? "error" : "neutral",
          },
          {
            label: "Stale claims",
            value: m.stale.ok ? staleCount : "?",
            sub: `quiet ${STALE_DAYS}+ days`,
            tone: staleCount > 0 ? "warn" : "neutral",
          },
          {
            label: "Closed this week",
            value: m.recentlyClosed.ok ? m.recentlyClosed.data.length : "?",
            tone: "neutral",
          },
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
  const chain = unlockChain(pick.id, blocked);
  const unlocks = pick.dependent_count ?? 0;
  const fields: { label?: string; value?: string }[] = [
    {
      label: "why this",
      value:
        unlocks > 0
          ? `highest leverage in the ready queue — finishing it unlocks ${unlocks} other bead${unlocks === 1 ? "" : "s"}`
          : "highest-priority work with nothing blocking it",
    },
  ];
  if (chain.first.length > 0) {
    const hop1 = chain.first.map((b) => `${b.id} (${b.title})`).join(", ");
    const hop2 = chain.second.length ? ` → then ${chain.second.map((b) => b.id).join(", ")}` : "";
    fields.push({ label: "unlocks", value: `${hop1}${hop2}` });
  }
  fields.push({
    label: "status",
    value: `ready · ${pick.assignee ?? "unclaimed"} · P${pick.priority}`,
  });
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
            ? `runner-up: ${runnerUp.id} — ${runnerUp.title}`
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
  return board([
    {
      kind: "cards",
      items: m.inProgress.data.map((i) => ({
        title: i.title,
        pill: { label: i.id, tone: "neutral" },
        dot: "ok",
        selected: ctx.selectedId === i.id,
        action: { type: "select-bead", payload: { id: i.id } },
        fields: [
          { label: "owner", value: i.assignee ?? i.owner ?? "unassigned" },
          { label: "age", value: daysAgo(i.updated_at, now) },
          { label: "priority", value: `P${i.priority}` },
        ],
      })),
    },
  ]);
}

// ── Needs attention: blocked ranked by consequence (what the most other
// work waits on first), stale claims in the same queue.
export function composeAttention(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.blocked.ok) return failedBoard("the blocked union", m.blocked.error);
  const now = new Date(m.asOf);
  const blocked = m.blocked.data;
  const waitedOn = new Map<string, number>();
  for (const b of blocked) {
    for (const dep of b.blocked_by ?? []) waitedOn.set(dep, (waitedOn.get(dep) ?? 0) + 1);
  }
  const ranked = [...blocked].sort((a, b) => {
    const ca = waitedOn.get(a.id) ?? 0;
    const cb = waitedOn.get(b.id) ?? 0;
    if (ca !== cb) return cb - ca;
    return byPriorityThenAge(a, b);
  });
  const shown = ranked.slice(0, ATTENTION_CAP);
  const staleItems = m.stale.ok ? m.stale.data : [];
  if (shown.length === 0 && staleItems.length === 0) {
    return board([
      { kind: "rows", items: [{ glyph: "ok", text: "Nothing is blocked or stale." }] },
    ]);
  }
  // A single-column list: two-up tiles truncated both the title and the
  // waiting-on explanation, and this panel scans top-to-bottom anyway.
  return board([
    {
      kind: "cards",
      ...(blocked.length > shown.length
        ? { title: `Top ${shown.length} of ${blocked.length} blocked` }
        : {}),
      items: [
        ...shown.map((i) => ({
          title: i.title,
          pill: { label: i.id, tone: "neutral" as const },
          dot: "error" as const,
          selected: ctx.selectedId === i.id,
          action: { type: "select-bead", payload: { id: i.id } },
          fields: [
            {
              value: i.blocked_by?.length
                ? `waiting on ${i.blocked_by.join(", ")}`
                : "paused by hand — no blocking dependency",
            },
          ],
        })),
        ...staleItems.map((i) => ({
          title: i.title,
          pill: { label: i.id, tone: "neutral" as const },
          dot: "warn" as const,
          selected: ctx.selectedId === i.id,
          action: { type: "select-bead", payload: { id: i.id } },
          fields: [{ value: `claimed but ${daysAgo(i.updated_at, now)} — verify or release` }],
        })),
      ],
    },
  ]);
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
const PLAN_GRID_COLUMNS = 3;

export function composePlan(m: ProjectMeasurement, ctx: PanelContext): Board {
  if (!m.backlog.ok) return failedBoard("the backlog inventory", m.backlog.error);
  if (m.backlog.data.length === 0) return HIDDEN;
  const readyIds = new Set(m.ready.ok ? m.ready.data.map((i) => i.id) : []);
  const epicProgress = new Map<string, BdEpicRow>(
    (m.epics.ok ? m.epics.data : []).map((row) => [row.epic.id, row]),
  );
  const waitsOn = new Map<string, number>(
    (m.blocked.ok ? m.blocked.data : []).map((b) => [b.id, b.blocked_by?.length ?? 0]),
  );
  const stateWord = (i: BdIssue) =>
    i.status === "deferred"
      ? "on hold"
      : i.status === "in_progress"
        ? "in progress"
        : i.status === "blocked"
          ? "blocked"
          : readyIds.has(i.id)
            ? "ready"
            : "waiting";
  const stateDot = (i: BdIssue): CanvasTone | undefined =>
    readyIds.has(i.id)
      ? "accent"
      : i.status === "in_progress"
        ? "ok"
        : i.status === "blocked"
          ? "error"
          : i.status === "deferred"
            ? "info"
            : undefined;
  // One leverage/dependency signal per card, never both.
  const signal = (i: BdIssue): string => {
    const unlocks = i.dependent_count ?? 0;
    if (unlocks > 0) return ` · unlocks ${unlocks}`;
    const waits = waitsOn.get(i.id) ?? 0;
    if (waits > 0) return ` · waits on ${waits}`;
    return "";
  };
  const card = (i: BdIssue, child = false) => {
    const dot = stateDot(i);
    return {
      title: `${child ? "└ " : ""}${i.title}`,
      pill: { label: i.id, tone: "neutral" as const },
      ...(dot ? { dot } : {}),
      selected: ctx.selectedId === i.id,
      action: { type: "select-bead", payload: { id: i.id } },
      fields: [{ value: `P${i.priority} · ${stateWord(i)}${signal(i)}` }],
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
  const push = (title: string | undefined, items: ReturnType<typeof card>[]) => {
    if (items.length === 0) return;
    sections.push({
      kind: "cards",
      boxed: true,
      grid: true,
      columns: PLAN_GRID_COLUMNS,
      ...(title ? { title } : {}),
      items,
    });
    shown += items.length;
  };
  for (const fam of epicFamilies) {
    if (room() <= 0) break;
    const p = epicProgress.get(fam.root.id);
    const meter = p
      ? ` — ${p.closed_children}/${p.total_children} done${p.eligible_for_close ? " · ready to close out" : ""}`
      : "";
    // An epic whose open children have all closed still needs a face: the
    // epic card itself stands in so the group never renders empty.
    const items = fam.children.length
      ? fam.children.slice(0, room()).map((c) => card(c))
      : [card(fam.root)];
    push(`▸ ${fam.root.title}${meter}`, items);
  }
  for (const fam of parentFamilies) {
    if (room() <= 0) break;
    push(undefined, [card(fam.root), ...fam.children.map((c) => card(c, true))].slice(0, room()));
  }
  if (room() > 0)
    push(
      "Standalone work",
      singles.slice(0, room()).map((c) => card(c)),
    );
  sections.push({
    kind: "rows",
    items: [
      {
        icon: "ℹ",
        chip: { label: "how to read this", tone: "neutral" },
        text: `Dot color is state: teal ready · green in progress · red blocked · blue on hold. ▸ panels are epics (their beads inside), └ marks a bead under the parent leading its box. P0 is most urgent, P4 least. Click a card to open it in the inspector.${shown < total ? ` Showing ${shown} of ${total}.` : ""}`,
      },
    ],
  });
  return board(sections);
}

// ── The inspector: the selected bead in full — meta, dependency links both
// ways, description and acceptance criteria as wrapped prose. `recommended`
// is the board's current pick, offered as the alternative when the inspected
// bead itself cannot be started.
export function composeInspect(
  issue: Measured<BdIssue> | undefined,
  blocked: BdIssue[],
  recommended?: BdIssue,
): Board {
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
  const waitsOn = linked(i.dependencies);
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
  if (i.status !== "closed" && i.status !== "in_progress") {
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
