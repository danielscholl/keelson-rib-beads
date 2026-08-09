// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { BdClient, BdEpicRow, BdIssue, BdSummary, BeadsProject, Measured } from "./bd";
import { unmeasured } from "./bd";

export const STALE_DAYS = 7;
export const RECENT_CLOSE_DAYS = 7;

export interface ProjectMeasurement {
  project: BeadsProject;
  asOf: string;
  summary: Measured<BdSummary>;
  inProgress: Measured<BdIssue[]>;
  // Dependency-ready, epics excluded, in-progress subtracted, priority order.
  ready: Measured<BdIssue[]>;
  // The union of dependency-blocked (`bd blocked`, own status still open) and
  // status-blocked (`bd list --status blocked`). Either alone undercounts —
  // a board built from one query silently omits the other population.
  blocked: Measured<BdIssue[]>;
  epics: Measured<BdEpicRow[]>;
  recentlyClosed: Measured<BdIssue[]>;
  stale: Measured<BdIssue[]>;
  // The whole non-closed backlog (`bd list` default scope: open, in-progress,
  // blocked, deferred) — the board's Plan tree, mirroring the CLI's tree view.
  backlog: Measured<BdIssue[]>;
}

function asArray(value: unknown): BdIssue[] {
  return Array.isArray(value) ? (value as BdIssue[]) : [];
}

// priority asc (missing → 2, beads-ui's default), then created_at asc so age
// surfaces, then id for stability.
export function byPriorityThenAge(a: BdIssue, b: BdIssue): number {
  const pa = a.priority ?? 2;
  const pb = b.priority ?? 2;
  if (pa !== pb) return pa - pb;
  const ca = a.created_at ?? "";
  const cb = b.created_at ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export function unionBlocked(dep: BdIssue[], status: BdIssue[]): BdIssue[] {
  const seen = new Map<string, BdIssue>();
  for (const issue of [...dep, ...status]) {
    if (!seen.has(issue.id)) seen.set(issue.id, issue);
  }
  return [...seen.values()].sort(byPriorityThenAge);
}

export function subtractInProgress(ready: BdIssue[], inProgress: BdIssue[]): BdIssue[] {
  // `bd ready` still returns items already claimed; the queue is what is
  // startable NOW, so work in flight is subtracted (beads-ui does the same).
  const wip = new Set(inProgress.map((i) => i.id));
  return ready.filter((i) => !wip.has(i.id)).sort(byPriorityThenAge);
}

export function recentCloses(closed: BdIssue[], now: Date, days = RECENT_CLOSE_DAYS): BdIssue[] {
  const floor = new Date(now.getTime() - days * 86_400_000).toISOString();
  return closed
    .filter((i) => (i.closed_at ?? "") >= floor)
    .sort((a, b) => ((a.closed_at ?? "") > (b.closed_at ?? "") ? -1 : 1));
}

export async function measureProject(
  bd: BdClient,
  project: BeadsProject,
  now: () => Date = () => new Date(),
): Promise<ProjectMeasurement> {
  const cwd = project.rootPath;

  const statusRes = await bd.readJSON<{ summary?: BdSummary }>(cwd, ["status"]);
  const summary: Measured<BdSummary> = statusRes.ok
    ? statusRes.data.summary
      ? { ok: true, data: statusRes.data.summary }
      : unmeasured("bd status carried no summary")
    : statusRes;

  const wipRes = await bd.readJSON<unknown>(cwd, [
    "list",
    "--status",
    "in_progress",
    "--limit",
    "0",
  ]);
  const inProgress: Measured<BdIssue[]> = wipRes.ok
    ? { ok: true, data: asArray(wipRes.data) }
    : wipRes;

  const readyRes = await bd.readJSON<unknown>(cwd, [
    "ready",
    "--exclude-type=epic",
    "--limit",
    "0",
  ]);
  const ready: Measured<BdIssue[]> =
    readyRes.ok && inProgress.ok
      ? { ok: true, data: subtractInProgress(asArray(readyRes.data), inProgress.data) }
      : readyRes.ok
        ? unmeasured("in-progress unmeasured, so the ready subtraction cannot run")
        : readyRes;

  const depBlockedRes = await bd.readJSON<unknown>(cwd, ["blocked"]);
  const statusBlockedRes = await bd.readJSON<unknown>(cwd, [
    "list",
    "--status",
    "blocked",
    "--limit",
    "0",
  ]);
  const blocked: Measured<BdIssue[]> =
    depBlockedRes.ok && statusBlockedRes.ok
      ? {
          ok: true,
          data: unionBlocked(asArray(depBlockedRes.data), asArray(statusBlockedRes.data)),
        }
      : unmeasured(
          [
            depBlockedRes.ok ? null : `bd blocked: ${depBlockedRes.error}`,
            statusBlockedRes.ok ? null : `bd list --status blocked: ${statusBlockedRes.error}`,
          ]
            .filter(Boolean)
            .join("; "),
        );

  const epicsRes = await bd.readJSON<unknown>(cwd, ["epic", "status"]);
  const epics: Measured<BdEpicRow[]> = epicsRes.ok
    ? {
        ok: true,
        data: (Array.isArray(epicsRes.data) ? (epicsRes.data as BdEpicRow[]) : []).filter(
          (row) => row?.epic && row.epic.status !== "tombstone",
        ),
      }
    : epicsRes;

  const closedRes = await bd.readJSON<unknown>(cwd, ["list", "--status", "closed", "--limit", "0"]);
  const recentlyClosed: Measured<BdIssue[]> = closedRes.ok
    ? { ok: true, data: recentCloses(asArray(closedRes.data), now()) }
    : closedRes;

  const staleRes = await bd.readJSON<unknown>(cwd, [
    "stale",
    "--days",
    String(STALE_DAYS),
    "-s",
    "in_progress",
  ]);
  const stale: Measured<BdIssue[]> = staleRes.ok
    ? { ok: true, data: asArray(staleRes.data) }
    : staleRes;

  const backlogRes = await bd.readJSON<unknown>(cwd, ["list", "--limit", "0"]);
  const backlog: Measured<BdIssue[]> = backlogRes.ok
    ? { ok: true, data: asArray(backlogRes.data) }
    : backlogRes;

  return {
    project,
    asOf: now().toISOString(),
    summary,
    inProgress,
    ready,
    blocked,
    epics,
    recentlyClosed,
    stale,
    backlog,
  };
}
