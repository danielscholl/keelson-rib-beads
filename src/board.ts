// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The board is a decision surface first and an inventory second. Order of
// attention: what should I start (one recommendation, explained) → what is in
// flight or stuck → the canonical Plan tree → momentum. The top sections are
// curated attention queues; the Plan is the one complete listing, so the same
// bead never earns two full-width strips.
//
// Visual grammar (operator feedback, 2026-08-09): color means STATE (accent
// ready, ok in-progress, error blocked, info deferred), priority is a quiet
// `P0`–`P4` text, ids are neutral chips, and the title is the scan target.

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { BdEpicRow, BdIssue, Measured } from "./bd";
import type { ProjectMeasurement } from "./measure";
import { byPriorityThenAge, STALE_DAYS } from "./measure";

const BLOCKED_CAP = 8;
const CLOSED_CAP = 6;
const PLAN_CAP = 80;
// rows.detail is capped at 4,000 chars by the canvas schema.
const DETAIL_CAP = 3_900;

type BoardSection = CanvasBoardView["sections"][number];
type ColumnsSection = Extract<BoardSection, { kind: "columns" }>;
// A section that may nest inside a columns wrapper (everything but columns).
type LeafSection = ColumnsSection["columns"][number]["sections"][number];

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

// The drill-in a row expands to: the bead's description and acceptance
// criteria, verbatim from bd, trimmed to the canvas cap.
export function issueDetail(issue: BdIssue): string | undefined {
  const parts: string[] = [];
  if (issue.description?.trim()) parts.push(issue.description.trim());
  if (issue.acceptance_criteria?.trim())
    parts.push(`— acceptance —\n${issue.acceptance_criteria.trim()}`);
  if (issue.comment_count) parts.push(`(${issue.comment_count} comment(s) — bd show ${issue.id})`);
  if (parts.length === 0) return undefined;
  const text = parts.join("\n\n");
  return text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP - 1)}…` : text;
}

// The Plan tree, mirroring `bd list`: children carry dotted ids (tl-65z.6
// belongs under tl-65z), so parentage is derived from the id itself.
export function planTree(backlog: BdIssue[]): BdIssue[] {
  const byId = new Map(backlog.map((i) => [i.id, i]));
  const children = new Map<string, BdIssue[]>();
  const roots: BdIssue[] = [];
  for (const issue of backlog) {
    const dot = issue.id.lastIndexOf(".");
    const parentId = dot > 0 ? issue.id.slice(0, dot) : undefined;
    if (parentId && byId.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(issue);
      children.set(parentId, siblings);
    } else {
      roots.push(issue);
    }
  }
  roots.sort(byPriorityThenAge);
  const ordered: BdIssue[] = [];
  for (const root of roots) {
    ordered.push(root);
    for (const child of (children.get(root.id) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      ordered.push(child);
    }
  }
  return ordered;
}

function isChildOf(issue: BdIssue, byId: Set<string>): boolean {
  const dot = issue.id.lastIndexOf(".");
  return dot > 0 && byId.has(issue.id.slice(0, dot));
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

function failedSection(title: string, error: string): LeafSection {
  return {
    kind: "rows",
    title,
    items: [
      {
        icon: "⚠",
        chip: { label: "UNMEASURED", tone: "error" },
        text: "The measurement failed — this is not an empty-and-healthy section.",
        trailing: error.slice(0, 120),
      },
    ],
  };
}

function anyUnmeasured(m: ProjectMeasurement): boolean {
  return [
    m.summary,
    m.inProgress,
    m.ready,
    m.blocked,
    m.epics,
    m.recentlyClosed,
    m.stale,
    m.backlog,
  ].some((s) => !s.ok);
}

function count(measured: Measured<BdIssue[]>): number {
  return measured.ok ? measured.data.length : 0;
}

function daysAgo(iso: string | undefined, now: Date): string {
  if (!iso) return "age unknown";
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
  if (days === 0) return "touched today";
  return `quiet ${days}d`;
}

function sectionsForProject(m: ProjectMeasurement, titlePrefix: string): BoardSection[] {
  const sections: BoardSection[] = [];
  const t = (name: string) => (titlePrefix ? `${titlePrefix} — ${name}` : name);
  const now = new Date(m.asOf);
  const blocked = m.blocked.ok ? m.blocked.data : [];
  const readyIds = new Set(m.ready.ok ? m.ready.data.map((i) => i.id) : []);

  // ── Current-state pulse. All five describe NOW (closed-this-week is the
  // momentum rate, not all-time volume — that context lives in the header).
  if (m.summary.ok) {
    const s = m.summary.data;
    const blockedUnion = m.blocked.ok ? blocked.length : s.blocked_issues;
    const staleCount = m.stale.ok ? m.stale.data.length : 0;
    sections.push({
      kind: "stats",
      title: t("At a glance"),
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
    });
  } else {
    sections.push(failedSection(t("At a glance"), m.summary.error));
  }

  // ── Recommended next: one confident pick, explained.
  if (!m.ready.ok) {
    sections.push(failedSection(t("Recommended next"), m.ready.error));
  } else {
    const { pick, runnerUp } = recommendNext(m.ready.data);
    if (!pick) {
      sections.push({
        kind: "rows",
        title: t("Recommended next"),
        items: [
          {
            glyph: "warn",
            text: "Nothing is ready to start — everything open is blocked or deferred.",
            trailing: "see Needs attention",
          },
        ],
      });
    } else {
      const chain = unlockChain(pick.id, blocked);
      const unlocks = pick.dependent_count ?? 0;
      const fields: { label?: string; value?: string | number }[] = [
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
        const hop2 = chain.second.length
          ? ` → then ${chain.second.map((b) => b.id).join(", ")}`
          : "";
        fields.push({ label: "unlocks", value: `${hop1}${hop2}` });
      }
      fields.push({
        label: "status",
        value: `ready · ${pick.assignee ?? "unclaimed"} · P${pick.priority}`,
      });
      sections.push({
        kind: "cards",
        title: t("Recommended next"),
        items: [
          {
            title: pick.title,
            pill: { label: pick.id, tone: "neutral" },
            dot: "accent",
            stacked: true,
            fields,
            footnote: runnerUp
              ? `runner-up: ${runnerUp.id} — ${runnerUp.title}`
              : "the ready queue holds nothing else",
          },
        ],
      });
    }
  }

  // ── In flight vs needs attention, side by side.
  let wipSection: LeafSection;
  if (!m.inProgress.ok) {
    wipSection = failedSection(t("In progress"), m.inProgress.error);
  } else if (m.inProgress.data.length === 0) {
    wipSection = {
      kind: "rows",
      title: t("In progress"),
      items: [{ glyph: "ok", text: "No work currently claimed — start the recommended bead." }],
    };
  } else {
    wipSection = {
      kind: "cards",
      title: t("In progress"),
      items: m.inProgress.data.map((i) => ({
        title: i.title,
        pill: { label: i.id, tone: "neutral" },
        dot: "ok",
        fields: [
          { label: "owner", value: i.assignee ?? i.owner ?? "unassigned" },
          { label: "age", value: daysAgo(i.updated_at, now) },
          { label: "priority", value: `P${i.priority}` },
        ],
      })),
    };
  }

  // Blocked, ranked by consequence: what the most other work waits on comes
  // first, because releasing IT is the highest-value action. Stale claims
  // ride in the same queue — claimed-but-silent is also "needs attention".
  let attentionSection: LeafSection;
  if (!m.blocked.ok) {
    attentionSection = failedSection(t("Needs attention"), m.blocked.error);
  } else {
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
    const shown = ranked.slice(0, BLOCKED_CAP);
    const staleItems = m.stale.ok ? m.stale.data : [];
    attentionSection = {
      kind: "rows",
      title:
        blocked.length > shown.length
          ? t(`Needs attention (top ${shown.length} of ${blocked.length} blocked)`)
          : t("Needs attention"),
      items: [
        ...shown.map((i) => ({
          glyph: "error" as const,
          chip: { label: i.id, tone: "neutral" as const },
          text: i.title,
          trailing: i.blocked_by?.length
            ? `waiting on ${i.blocked_by.join(", ")}`
            : "paused by hand — no blocking dependency",
          detail: issueDetail(i),
        })),
        ...staleItems.map((i) => ({
          glyph: "warn" as const,
          chip: { label: i.id, tone: "neutral" as const },
          text: i.title,
          trailing: `claimed but ${daysAgo(i.updated_at, now)} — verify or release`,
          detail: issueDetail(i),
        })),
      ],
    };
  }
  const attentionEmpty = attentionSection.kind === "rows" && attentionSection.items.length === 0;
  if (attentionEmpty) {
    attentionSection = {
      kind: "rows",
      title: t("Needs attention"),
      items: [{ glyph: "ok", text: "Nothing is blocked or stale." }],
    };
  }
  sections.push({
    kind: "columns",
    columns: [{ sections: [wipSection] }, { sections: [attentionSection] }],
  });

  // ── The Plan: the one canonical inventory. Epics carry their progress in
  // the row itself; children sit beneath them; the accent dot marks the rows
  // that are startable right now. Everything above links back here by id.
  if (!m.backlog.ok) {
    sections.push(failedSection(t("Plan"), m.backlog.error));
  } else if (m.backlog.data.length > 0) {
    const epicProgress = new Map<string, BdEpicRow>(
      (m.epics.ok ? m.epics.data : []).map((row) => [row.epic.id, row]),
    );
    const ordered = planTree(m.backlog.data);
    const shown = ordered.slice(0, PLAN_CAP);
    const ids = new Set(m.backlog.data.map((i) => i.id));
    sections.push({
      kind: "rows",
      title:
        ordered.length > shown.length
          ? t(`Plan — the full inventory (showing ${shown.length} of ${ordered.length})`)
          : t("Plan — the full inventory"),
      items: shown.map((i) => {
        const child = isChildOf(i, ids);
        const isEpic = i.issue_type === "epic";
        const progress = isEpic ? epicProgress.get(i.id) : undefined;
        const stateWord =
          i.status === "deferred"
            ? " · on hold"
            : i.status === "in_progress"
              ? " · in progress"
              : i.status === "blocked"
                ? " · blocked"
                : "";
        return {
          icon: isEpic ? "▸" : statusGlyph(i.status),
          // The accent dot is the readiness signal — the one state the
          // status glyph cannot express.
          ...(readyIds.has(i.id) ? { glyph: "accent" as const } : {}),
          chip: { label: i.id, tone: "neutral" as const },
          text: `${child ? "└ " : ""}${isEpic ? "[epic] " : ""}${i.title}`,
          trailing: progress
            ? `${progress.closed_children}/${progress.total_children} done`
            : `P${i.priority}${stateWord}${readyIds.has(i.id) ? " · ready" : ""}`,
          detail: issueDetail(i),
        };
      }),
    });
  }

  // ── The momentum strip, not a graveyard: closes from the last week only.
  if (!m.recentlyClosed.ok) {
    sections.push(failedSection(t("Finished recently"), m.recentlyClosed.error));
  } else if (m.recentlyClosed.data.length > 0) {
    sections.push({
      kind: "rows",
      title: t("Finished in the last 7 days"),
      items: m.recentlyClosed.data.slice(0, CLOSED_CAP).map((i) => ({
        icon: "✓",
        chip: { label: i.id, tone: "neutral" },
        text: i.title,
        trailing: (i.closed_at ?? "").slice(0, 10),
      })),
    });
  }

  return sections;
}

// One quiet row at the board's foot: what the marks mean and where to dig
// deeper — the reader this board serves has never run bd.
function legendSection(): BoardSection {
  return {
    kind: "rows",
    items: [
      {
        icon: "ℹ",
        chip: { label: "how to read this", tone: "neutral" },
        text: "○ open · ◐ in progress · ● blocked · ❄ deferred · ▸ epic — a colored dot marks state (teal = ready to start, red = blocked, amber = gone quiet). P0 is most urgent, P4 least. Click a Plan row to unfold its description; ask in chat about any id (e.g. “show me tl-4nx”) to go deeper.",
      },
    ],
  };
}

// The scope names a project that carries no beads tracker (the default
// project, say). Deliberately quiet: an empty board here is the truth, and
// the row list is the map to somewhere the board has something to say.
export function composeNoTrackerBoard(
  projectName: string,
  beadsProjects: readonly { name: string }[],
): CanvasBoardView {
  return {
    view: "board",
    title: "Beads backlog",
    header: {
      status: { label: `no beads tracker in ${projectName}`, tone: "neutral" },
      chip: "select a beads project in the picker above",
    },
    sections:
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
        : [firstRunJourney()],
  };
}

function firstRunJourney(): BoardSection {
  return {
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
  };
}

export function composeBoard(measurements: ProjectMeasurement[]): CanvasBoardView {
  if (measurements.length === 0) {
    return {
      view: "board",
      title: "Beads backlog",
      header: { status: { label: "no beads projects", tone: "neutral" } },
      sections: [firstRunJourney()],
    };
  }

  const failed = measurements.some(anyUnmeasured);
  const openTotal = measurements.reduce(
    (n, m) => n + (m.summary.ok ? m.summary.data.open_issues : 0),
    0,
  );
  const asOf = measurements[0]?.asOf ?? new Date().toISOString();

  const multi = measurements.length > 1;
  const sections = measurements.flatMap((m) => sectionsForProject(m, multi ? m.project.name : ""));
  sections.push(legendSection());
  // The board names its own scope: the header must answer "which backlog am I
  // looking at" without the reader hunting for the surface's picker chip.
  const scopeName = multi
    ? `${measurements.length} projects`
    : (measurements[0]?.project.name ?? "unknown");

  return {
    view: "board",
    title: `Beads backlog — ${scopeName}`,
    header: {
      status: failed
        ? { label: `${scopeName} — measurement failed`, tone: "error" }
        : { label: scopeName, tone: "ok" },
      // Open count is context, not a comparison tile; the clock says when the
      // numbers were measured (the card's own clock tracks when the board
      // last changed, which is a different thing).
      chip: `${openTotal} open · measured ${asOf.slice(0, 16).replace("T", " ")}Z`,
    },
    sections,
  };
}
