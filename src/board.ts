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
import { STALE_DAYS } from "./measure";

// The ready queue is a glanceable strip, not the whole backlog; the caption
// says "showing N of M" whenever the cap bites, never implying completeness.
const READY_CAP = 12;
const BLOCKED_CAP = 10;
const CLOSED_CAP = 6;

type BoardSection = CanvasBoardView["sections"][number];

// P0 is a fire, P1 urgent, P2 normal, everything after that is backlog noise.
// Same mapping the touchline-queue lens established.
export function priorityTone(priority: number | undefined): CanvasTone {
  if (priority === 0) return "error";
  if (priority === 1) return "warn";
  if (priority === 2) return "info";
  return "neutral";
}

function failedSection(title: string, error: string): BoardSection {
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
  return [m.summary, m.inProgress, m.ready, m.blocked, m.epics, m.recentlyClosed, m.stale].some(
    (s) => !s.ok,
  );
}

function count(measured: Measured<BdIssue[]>): number {
  return measured.ok ? measured.data.length : 0;
}

function sectionsForProject(m: ProjectMeasurement, titlePrefix: string): BoardSection[] {
  const sections: BoardSection[] = [];
  const t = (name: string) => (titlePrefix ? `${titlePrefix} — ${name}` : name);

  // KPI tiles. The blocked tile carries the measured union, never the KPI
  // line's dependency-only count, which can silently disagree with it.
  if (m.summary.ok) {
    const s = m.summary.data;
    const blockedUnion = m.blocked.ok ? m.blocked.data.length : s.blocked_issues;
    sections.push({
      kind: "stats",
      title: t("Pulse"),
      items: [
        { label: "Open", value: s.open_issues },
        {
          label: "Ready",
          value: m.ready.ok ? m.ready.data.length : s.ready_issues,
          tone: "accent",
        },
        { label: "In progress", value: s.in_progress_issues, tone: "ok" },
        { label: "Blocked", value: blockedUnion, tone: blockedUnion > 0 ? "warn" : "neutral" },
        { label: "Closed", value: s.closed_issues, sub: "all time" },
      ],
    });
  } else {
    sections.push(failedSection(t("Pulse"), m.summary.error));
  }

  // Work already claimed is the most interesting state on the board.
  if (!m.inProgress.ok) {
    sections.push(failedSection(t("In progress"), m.inProgress.error));
  } else if (m.inProgress.data.length > 0) {
    sections.push({
      kind: "cards",
      title: t("In progress"),
      items: m.inProgress.data.map((i) => ({
        title: i.title,
        pill: { label: i.id, tone: "brand" },
        fields: [
          { label: "assignee", value: i.assignee ?? i.owner ?? "—" },
          { label: "priority", value: `P${i.priority}`, tone: priorityTone(i.priority) },
        ],
      })),
    });
  }

  // The queue: what can start right now, highest priority first. `unlocks`
  // is dependent_count — the leverage signal; finishing a high-unlocks bead
  // frees the most downstream work, and that outranks raw priority.
  if (m.ready.ok) {
    const ready = m.ready.data;
    const shown = ready.slice(0, READY_CAP);
    sections.push({
      kind: "table",
      title: t("Ready"),
      columns: [
        { key: "id", label: "ID" },
        { key: "priority", label: "Priority" },
        { key: "unlocks", label: "Unlocks" },
        { key: "title", label: "Title" },
      ],
      rows: shown.map((i) => {
        const unlocks = i.dependent_count ?? 0;
        return {
          id: i.id,
          priority: { badges: [{ text: `P${i.priority}`, tone: priorityTone(i.priority) }] },
          unlocks:
            unlocks >= 2 ? { badges: [{ text: `unlocks ${unlocks}`, tone: "accent" }] } : unlocks,
          title: i.title,
        };
      }),
      caption:
        ready.length > shown.length
          ? `Showing ${shown.length} of ${ready.length} ready issues, priority order.`
          : "Priority order; work in flight already subtracted.",
    });
  } else {
    sections.push(failedSection(t("Ready"), m.ready.error));
  }

  // Blocked union. A row with no blocked_by names was status-blocked by hand,
  // not by the dependency graph — say so instead of rendering an empty
  // "waits on".
  if (!m.blocked.ok) {
    sections.push(failedSection(t("Blocked"), m.blocked.error));
  } else if (m.blocked.data.length > 0) {
    const blocked = m.blocked.data;
    const shown = blocked.slice(0, BLOCKED_CAP);
    sections.push({
      kind: "rows",
      title:
        blocked.length > shown.length
          ? t(`Blocked — showing ${shown.length} of ${blocked.length}`)
          : t("Blocked"),
      items: shown.map((i) => ({
        chip: { label: i.id, tone: priorityTone(i.priority) },
        text: i.title,
        trailing: i.blocked_by?.length
          ? `waits on ${i.blocked_by.join(", ")}`
          : "status-blocked (manual)",
      })),
    });
  }

  // Epic completion, one meter per epic. Tone ok when complete.
  if (!m.epics.ok) {
    sections.push(failedSection(t("Epics"), m.epics.error));
  } else if (m.epics.data.length > 0) {
    sections.push({
      kind: "bars",
      title: t("Epics"),
      items: m.epics.data.map((row) => ({
        label: row.epic.title,
        value: row.closed_children,
        total: Math.max(row.total_children, 1),
        tone:
          row.total_children > 0 && row.closed_children >= row.total_children
            ? ("ok" as const)
            : ("neutral" as const),
        trailing: `${row.closed_children}/${row.total_children}${row.eligible_for_close ? " — eligible to close" : ""}`,
      })),
    });
  }

  // The momentum strip, not a graveyard: closes from the last few days only.
  if (!m.recentlyClosed.ok) {
    sections.push(failedSection(t("Recently closed"), m.recentlyClosed.error));
  } else if (m.recentlyClosed.data.length > 0) {
    sections.push({
      kind: "rows",
      title: t("Recently closed"),
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
    sections.push(failedSection(t("Stale"), m.stale.error));
  } else if (m.stale.data.length > 0) {
    sections.push({
      kind: "rows",
      title: t(`Stale — in progress, untouched ${STALE_DAYS}+ days`),
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
