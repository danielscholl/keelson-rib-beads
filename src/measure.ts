// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  BdClient,
  BdComment,
  BdEpicRow,
  BdIssue,
  BdSummary,
  BdVersion,
  BeadRunInfo,
  BeadsProject,
  Measured,
} from "./bd";
import { bdFloorLabel, parseBdVersion, unmeasured } from "./bd";
import type { GhClient, PrInfo } from "./pr";

export const STALE_DAYS = 7;
export const RECENT_CLOSE_DAYS = 7;
// The momentum chart's span. Wider than the close window on purpose: a 7-day
// bar chart can't show whether this week is faster or slower than last week.
export const FLOW_WINDOW_DAYS = 14;

// One member of an epic as its parent-child edge reports it: enough to draw
// the ladder, closed children included.
export interface EpicMember {
  id: string;
  title: string;
  status: string;
  priority?: number;
}

export interface ProjectMeasurement {
  project: BeadsProject;
  asOf: string;
  // `undefined` data: bd answered but its version string was unreadable, so
  // nothing is gated on it.
  bd: Measured<BdVersion | undefined>;
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
  // The same closed list over the chart window (FLOW_WINDOW_DAYS) — one bd
  // call feeds both filters, so the two are ok/unmeasured together.
  closedFortnight: Measured<BdIssue[]>;
  stale: Measured<BdIssue[]>;
  // The whole non-closed backlog (`bd list` default scope: open, in-progress,
  // blocked, deferred) — the board's Plan tree, mirroring the CLI's tree view.
  backlog: Measured<BdIssue[]>;
  // Epic membership by parent-child dependency links (epic id → child ids):
  // dotted ids alone miss it, and `bd list` carries no dependency payload —
  // only `bd show <epic> --include-dependents` names an epic's children.
  epicChildren: Measured<Record<string, EpicMember[]>>;
  // The newest comment on each claimed bead that has any — the In flight
  // row's evidence line.
  latestComment: Measured<Record<string, Measured<BdComment | undefined>>>;
  // Run notes for all eligible open and in-progress beads. Individual failures
  // degrade their bead, while an unmeasured backlog degrades the whole scan.
  runInfo: Measured<Record<string, Measured<BeadRunInfo | undefined>>>;
  prInfo: Measured<Record<string, Measured<PrInfo | undefined>>>;
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

// The bead-work completion convention, one line appended to a bead's notes:
//
//   bead-work run: PR <url|#number|unknown|none> — <outcome> — <free text>
//
// `--append-notes` appends, so the LAST matching line is the current claim.
// An unparseable note yields undefined — "no run reported" — which under-
// claims rather than invents: the failure mode of a typo'd note is a bead
// reading "in progress" instead of "in review", never the reverse.
export function parseRunNote(notes: string | undefined): BeadRunInfo | undefined {
  if (!notes) return undefined;
  let found: BeadRunInfo | undefined;
  for (const raw of notes.split("\n")) {
    const match = /^bead-work run:\s*PR\s+(\S+)\s*(.*)$/.exec(raw.trim());
    if (!match) continue;
    const pr = match[1] ?? "";
    const number = /^#(\d+)$/.exec(pr)?.[1];
    const state = number ? "number-only" : pr === "unknown" || pr === "none" ? pr : undefined;
    if (!/^https?:\/\/[^/\s]+\/[^\s]+$/.test(pr) && !state) continue;
    // The tail is em-dash-separated: first cell is the outcome, the rest is
    // prose (re-joined, so a dash inside the prose survives).
    const cells = (match[2] ?? "")
      .split("—")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const outcome = cells[0];
    const note = cells.slice(1).join(" — ");
    found = {
      ...(!state ? { prUrl: pr } : { prState: state }),
      ...(number ? { prNumber: number } : {}),
      ...(outcome ? { outcome } : {}),
      ...(note ? { note } : {}),
    };
  }
  return found;
}

// One bead in full, for the inspector: `bd show` returns a single-element
// array, and --include-dependents is what carries the linked issues.
export async function fetchIssue(
  bd: BdClient,
  cwd: string,
  id: string,
): Promise<Measured<BdIssue>> {
  const res = await bd.readJSON<unknown>(cwd, ["show", id, "--include-dependents"]);
  if (!res.ok) return res;
  const issue = Array.isArray(res.data) ? (res.data[0] as BdIssue | undefined) : undefined;
  return issue?.id === id
    ? { ok: true, data: issue }
    : unmeasured(`bd show ${id} returned no matching issue`);
}

export async function readComments(
  bd: BdClient,
  cwd: string,
  id: string,
): Promise<Measured<BdComment[]>> {
  const res = await bd.readJSON<unknown>(cwd, ["comments", id]);
  if (!res.ok) return res;
  return {
    ok: true,
    data: (Array.isArray(res.data) ? (res.data as BdComment[]) : [])
      .filter((c) => typeof c?.text === "string")
      .sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1)),
  };
}

// The bd on PATH, when it can say. A version below the floor gates every
// query that needs a newer flag, so one header line reports the cause
// instead of each panel alarming on its own.
export async function readBdVersion(
  bd: BdClient,
  cwd: string,
): Promise<Measured<BdVersion | undefined>> {
  const res = await bd.readJSON<unknown>(cwd, ["version"]);
  return res.ok ? { ok: true, data: parseBdVersion(res.data) } : res;
}

export function bdBelowFloor(m: Pick<ProjectMeasurement, "bd">): string | undefined {
  return m.bd.ok && m.bd.data && !m.bd.data.supported
    ? `bd ${m.bd.data.version} is older than ${bdFloorLabel()}`
    : undefined;
}

export function eligibleBeads(rows: readonly BdIssue[]): BdIssue[] {
  return rows.filter((issue) => issue.status === "open" || issue.status === "in_progress");
}

export async function readBacklog(bd: BdClient, cwd: string): Promise<Measured<BdIssue[]>> {
  const res = await bd.readJSON<unknown>(cwd, ["list", "--limit", "0"]);
  return res.ok ? { ok: true, data: asArray(res.data) } : res;
}

export async function readRunInfo(
  bd: BdClient,
  cwd: string,
  id: string,
): Promise<Measured<BeadRunInfo | undefined>> {
  const issue = await fetchIssue(bd, cwd, id);
  return issue.ok ? { ok: true, data: parseRunNote(issue.data.notes) } : issue;
}

export async function collectRecordedPRs(
  bd: BdClient,
  gh: GhClient,
  project: BeadsProject,
  backlog: Measured<BdIssue[]>,
): Promise<Pick<ProjectMeasurement, "runInfo" | "prInfo">> {
  if (!backlog.ok) {
    return {
      runInfo: unmeasured(`backlog unmeasured: ${backlog.error}`),
      prInfo: unmeasured(`backlog unmeasured: ${backlog.error}`),
    };
  }
  const runs: Record<string, Measured<BeadRunInfo | undefined>> = {};
  const prs: Record<string, Measured<PrInfo | undefined>> = {};
  const links: { id: string; prUrl: string }[] = [];
  for (const bead of eligibleBeads(backlog.data)) {
    const run = await readRunInfo(bd, project.rootPath, bead.id);
    runs[bead.id] = run;
    if (!run.ok) {
      prs[bead.id] = run;
    } else if (!run.data?.prUrl) {
      prs[bead.id] = { ok: true, data: undefined };
    } else {
      links.push({ id: bead.id, prUrl: run.data.prUrl });
    }
  }
  Object.assign(prs, await gh.readPRs(project, links));
  return { runInfo: { ok: true, data: runs }, prInfo: { ok: true, data: prs } };
}

export async function measureProject(
  bd: BdClient,
  project: BeadsProject,
  now: () => Date = () => new Date(),
  gh?: GhClient,
): Promise<ProjectMeasurement> {
  const cwd = project.rootPath;

  const bdVersion = await readBdVersion(bd, cwd);
  const tooOld = bdBelowFloor({ bd: bdVersion });

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
  const closedFortnight: Measured<BdIssue[]> = closedRes.ok
    ? { ok: true, data: recentCloses(asArray(closedRes.data), now(), FLOW_WINDOW_DAYS) }
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

  const backlog = await readBacklog(bd, cwd);
  const { runInfo, prInfo } = tooOld
    ? { runInfo: unmeasured<never>(tooOld), prInfo: unmeasured<never>(tooOld) }
    : gh
      ? await collectRecordedPRs(bd, gh, project, backlog)
      : {
          runInfo:
            unmeasured<Record<string, Measured<BeadRunInfo | undefined>>>(
              "GitHub reader not bound",
            ),
          prInfo:
            unmeasured<Record<string, Measured<PrInfo | undefined>>>("GitHub reader not bound"),
        };

  // One bd show per epic in the open backlog (epics are few); a failed lookup
  // marks the whole map unmeasured rather than presenting partial membership
  // as complete.
  let epicChildren: Measured<Record<string, EpicMember[]>>;
  if (tooOld) {
    epicChildren = unmeasured(tooOld);
  } else if (!backlog.ok) {
    epicChildren = unmeasured("backlog unmeasured, so epic membership cannot be read");
  } else {
    const map: Record<string, EpicMember[]> = {};
    let failure: string | undefined;
    for (const epic of backlog.data.filter((i) => i.issue_type === "epic")) {
      const res = await bd.readJSON<unknown>(cwd, ["show", epic.id, "--include-dependents"]);
      if (!res.ok) {
        failure = `bd show ${epic.id}: ${res.error}`;
        break;
      }
      const issue = Array.isArray(res.data) ? (res.data[0] as BdIssue | undefined) : undefined;
      map[epic.id] = (issue?.dependents ?? [])
        .filter((d) => (d.dependency_type ?? d.type) === "parent-child")
        .flatMap((d): EpicMember[] => {
          const id = d.id ?? d.issue_id;
          return id
            ? [
                {
                  id,
                  title: d.title ?? id,
                  status: d.status ?? "open",
                  ...(d.priority !== undefined ? { priority: d.priority } : {}),
                },
              ]
            : [];
        });
    }
    epicChildren = failure ? unmeasured(failure) : { ok: true, data: map };
  }

  // Comments are read only where a row will show one: claimed beads that
  // carry any. A failure degrades that bead's evidence line alone.
  let latestComment: Measured<Record<string, Measured<BdComment | undefined>>>;
  if (!inProgress.ok) {
    latestComment = unmeasured(`in-progress unmeasured: ${inProgress.error}`);
  } else {
    const map: Record<string, Measured<BdComment | undefined>> = {};
    for (const bead of inProgress.data) {
      if (!bead.comment_count) continue;
      const res = await readComments(bd, cwd, bead.id);
      map[bead.id] = res.ok ? { ok: true, data: res.data.at(-1) } : res;
    }
    latestComment = { ok: true, data: map };
  }

  return {
    project,
    asOf: now().toISOString(),
    bd: bdVersion,
    summary,
    inProgress,
    ready,
    blocked,
    epics,
    recentlyClosed,
    closedFortnight,
    stale,
    backlog,
    epicChildren,
    latestComment,
    runInfo,
    prInfo,
  };
}
