// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { BdIssue, Measured } from "./bd";
import type { ProjectMeasurement } from "./measure";
import { byPriorityThenAge, STALE_DAYS } from "./measure";

// The ready queue is a glanceable strip, not the whole backlog; the caption
// says "showing N of M" whenever the cap bites, never implying completeness.
const READY_CAP = 12;
const BLOCKED_CAP = 10;
const CLOSED_CAP = 6;
const PLAN_CAP = 60;
// rows.detail is capped at 4,000 chars by the canvas schema.
const DETAIL_CAP = 3_900;

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

type BoardSection = CanvasBoardView["sections"][number];
type ColumnsSection = Extract<BoardSection, { kind: "columns" }>;
// A section that may nest inside a columns wrapper (everything but columns).
type LeafSection = ColumnsSection["columns"][number]["sections"][number];

// beads-ui's priority emoji — 🔥 Critical, ⚡️ High, 🔧 Medium, 🪶 Low,
// 💤 Backlog — reads faster than the bare P-number.
export function priorityEmoji(priority: number | undefined): string {
  switch (priority) {
    case 0:
      return "🔥";
    case 1:
      return "⚡️";
    case 2:
      return "🔧";
    case 3:
      return "🪶";
    default:
      return "💤";
  }
}

// P0 is a fire, P1 urgent, P2 normal, everything after that is backlog noise.
// Same mapping the touchline-queue lens established.
export function priorityTone(priority: number | undefined): CanvasTone {
  if (priority === 0) return "error";
  if (priority === 1) return "warn";
  if (priority === 2) return "info";
  return "neutral";
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

function sectionsForProject(m: ProjectMeasurement, titlePrefix: string): BoardSection[] {
  const sections: BoardSection[] = [];
  const t = (name: string) => (titlePrefix ? `${titlePrefix} — ${name}` : name);

  // KPI tiles in plain words. The blocked tile carries the measured union,
  // never the KPI line's dependency-only count, which can silently disagree.
  if (m.summary.ok) {
    const s = m.summary.data;
    const blockedUnion = m.blocked.ok ? m.blocked.data.length : s.blocked_issues;
    sections.push({
      kind: "stats",
      title: t("At a glance"),
      items: [
        { label: "Open", value: s.open_issues, sub: "not finished yet" },
        {
          label: "Ready to start",
          value: m.ready.ok ? m.ready.data.length : s.ready_issues,
          sub: "nothing blocks these",
          tone: "accent",
        },
        { label: "In progress", value: s.in_progress_issues, sub: "being worked now", tone: "ok" },
        {
          label: "Blocked",
          value: blockedUnion,
          sub: "waiting on other work",
          tone: blockedUnion > 0 ? "warn" : "neutral",
        },
        { label: "Finished", value: s.closed_issues, sub: "all time" },
      ],
    });
  } else {
    sections.push(failedSection(t("At a glance"), m.summary.error));
  }

  // Work already claimed is the most interesting state on the board.
  let wipSection: LeafSection | undefined;
  if (!m.inProgress.ok) {
    wipSection = failedSection(t("In progress"), m.inProgress.error);
  } else if (m.inProgress.data.length > 0) {
    wipSection = {
      kind: "cards",
      title: t("Working on now"),
      items: m.inProgress.data.map((i) => ({
        title: i.title,
        pill: { label: i.id, tone: "brand" },
        fields: [
          { label: "assignee", value: i.assignee ?? i.owner ?? "—" },
          {
            label: "priority",
            value: `${priorityEmoji(i.priority)} P${i.priority}`,
            tone: priorityTone(i.priority),
          },
        ],
      })),
    };
  }

  // The queue: what can start right now, highest priority first. `unlocks`
  // is dependent_count — the leverage signal; finishing a high-unlocks bead
  // frees the most downstream work, and that outranks raw priority.
  if (m.ready.ok) {
    const ready = m.ready.data;
    const shown = ready.slice(0, READY_CAP);
    sections.push({
      kind: "table",
      title: t("Up next — ready to start"),
      columns: [
        { key: "id", label: "ID" },
        { key: "priority", label: "Priority" },
        { key: "unlocks", label: "Frees up" },
        { key: "title", label: "What" },
      ],
      rows: shown.map((i) => {
        const unlocks = i.dependent_count ?? 0;
        return {
          id: i.id,
          priority: {
            badges: [
              {
                text: `${priorityEmoji(i.priority)} P${i.priority}`,
                tone: priorityTone(i.priority),
              },
            ],
          },
          unlocks:
            unlocks >= 2 ? { badges: [{ text: `frees ${unlocks}`, tone: "accent" }] } : unlocks,
          title: i.title,
        };
      }),
      caption: `${
        ready.length > shown.length
          ? `Showing ${shown.length} of ${ready.length} startable items. `
          : ""
      }Most urgent first (🔥 P0 → 💤 P4); work already started is not repeated here. "Frees up" counts blocked items that finishing this one would release — a high number is the best place to start.`,
    });
  } else {
    sections.push(failedSection(t("Up next — ready to start"), m.ready.error));
  }

  // Blocked union. A row with no blocked_by names was status-blocked by hand,
  // not by the dependency graph — say so instead of rendering an empty
  // "waiting on".
  let blockedSection: LeafSection | undefined;
  if (!m.blocked.ok) {
    blockedSection = failedSection(t("Blocked — waiting on other work"), m.blocked.error);
  } else if (m.blocked.data.length > 0) {
    const blocked = m.blocked.data;
    const shown = blocked.slice(0, BLOCKED_CAP);
    blockedSection = {
      kind: "rows",
      title:
        blocked.length > shown.length
          ? t(`Blocked — waiting on other work (showing ${shown.length} of ${blocked.length})`)
          : t("Blocked — waiting on other work"),
      items: shown.map((i) => ({
        chip: { label: i.id, tone: priorityTone(i.priority) },
        text: i.title,
        detail: issueDetail(i),
        trailing: i.blocked_by?.length
          ? `waiting on ${i.blocked_by.join(", ")}`
          : "paused by hand — no blocking dependency",
      })),
    };
  }

  // Working-now and blocked are both short lists; side by side they read as
  // the "in flight vs stuck" pair (beads-ui's adjacent lanes) instead of two
  // full-width strips.
  if (wipSection && blockedSection) {
    sections.push({
      kind: "columns",
      columns: [{ sections: [wipSection] }, { sections: [blockedSection] }],
    });
  } else if (wipSection) {
    sections.push(wipSection);
  } else if (blockedSection) {
    sections.push(blockedSection);
  }

  // The Plan: the whole non-closed backlog as the CLI's tree — epics with
  // their dotted-id children beneath them, status glyphs from bd's own
  // legend, and each row expandable to the bead's description and acceptance
  // criteria (the drill-in; `bd show <id>` / beads_show goes deeper).
  if (!m.backlog.ok) {
    sections.push(failedSection(t("Plan"), m.backlog.error));
  } else if (m.backlog.data.length > 0) {
    const ordered = planTree(m.backlog.data);
    const shown = ordered.slice(0, PLAN_CAP);
    const ids = new Set(m.backlog.data.map((i) => i.id));
    const plainStatus: Record<string, string> = {
      in_progress: "in progress",
      blocked: "blocked",
      deferred: "deferred — on hold for now",
    };
    sections.push({
      kind: "rows",
      title:
        ordered.length > shown.length
          ? t(`The plan — everything not finished (showing ${shown.length} of ${ordered.length})`)
          : t("The plan — everything not finished"),
      items: shown.map((i) => {
        const child = isChildOf(i, ids);
        const marker = i.issue_type && i.issue_type !== "task" ? `[${i.issue_type}] ` : "";
        const status = plainStatus[i.status];
        return {
          icon: statusGlyph(i.status),
          chip: { label: i.id, tone: priorityTone(i.priority) },
          text: `${child ? "└ " : ""}${marker}${i.title}`,
          trailing: `${priorityEmoji(i.priority)} P${i.priority}${status ? ` · ${status}` : ""}`,
          detail: issueDetail(i),
        };
      }),
    });
  }

  // Milestone meters — an epic is a bundle of related work; the bar is how
  // much of the bundle is finished. Tone ok when complete.
  if (!m.epics.ok) {
    sections.push(failedSection(t("Milestones"), m.epics.error));
  } else if (m.epics.data.length > 0) {
    sections.push({
      kind: "bars",
      title: t("Milestones — how each bundle of work is going"),
      items: m.epics.data.map((row) => ({
        label: row.epic.title,
        value: row.closed_children,
        total: Math.max(row.total_children, 1),
        tone:
          row.total_children > 0 && row.closed_children >= row.total_children
            ? ("ok" as const)
            : ("neutral" as const),
        trailing: `${row.closed_children}/${row.total_children} done${row.eligible_for_close ? " — ready to close out" : ""}`,
      })),
    });
  }

  // The momentum strip, not a graveyard: closes from the last few days only.
  if (!m.recentlyClosed.ok) {
    sections.push(failedSection(t("Finished recently"), m.recentlyClosed.error));
  } else if (m.recentlyClosed.data.length > 0) {
    sections.push({
      kind: "rows",
      title: t("Finished in the last 7 days"),
      items: m.recentlyClosed.data.slice(0, CLOSED_CAP).map((i) => ({
        chip: { label: i.id, tone: "neutral" },
        text: i.title,
        trailing: (i.closed_at ?? "").slice(0, 10),
      })),
    });
  }

  // Stale in-progress work is claimed-but-silent — bookkeeping to verify,
  // not proof of work. Omitted entirely when there is none.
  if (!m.stale.ok) {
    sections.push(failedSection(t("Started but gone quiet"), m.stale.error));
  } else if (m.stale.data.length > 0) {
    sections.push({
      kind: "rows",
      title: t(`Started but quiet for ${STALE_DAYS}+ days — worth checking on`),
      items: m.stale.data.map((i) => ({
        icon: "⚠",
        chip: { label: i.id, tone: "warn" },
        text: i.title,
        trailing: `last touched ${(i.updated_at ?? "").slice(0, 10)}`,
      })),
    });
  }

  return sections;
}

// One quiet row at the board's foot: what the symbols mean and where to dig
// deeper — the reader this board serves has never run bd.
function legendSection(): BoardSection {
  return {
    kind: "rows",
    items: [
      {
        icon: "ℹ",
        chip: { label: "how to read this", tone: "neutral" },
        text: "○ open · ◐ in progress · ● blocked · ❄ deferred — click any plan row to unfold its full description. Ask in chat about any id (e.g. “show me tl-4nx”) to go deeper.",
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

function firstRunJourney(): CanvasBoardView["sections"][number] {
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
  const readyTotal = measurements.reduce((n, m) => n + count(m.ready), 0);
  const wipTotal = measurements.reduce((n, m) => n + count(m.inProgress), 0);
  const blockedTotal = measurements.reduce((n, m) => n + count(m.blocked), 0);
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
      // The card's own clock tracks when the board last changed, not when it
      // was measured, so the header says this itself.
      chip: `measured ${asOf.slice(0, 16).replace("T", " ")}Z`,
      segments: [
        { label: "ready", n: readyTotal, tone: "accent" },
        { label: "in progress", n: wipTotal, tone: "ok" },
        { label: "blocked", n: blockedTotal, tone: "warn" },
      ],
    },
    sections,
  };
}
