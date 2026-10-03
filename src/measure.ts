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
// the epic map, closed children included.
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
  // Epic membership by parent-child links (epic id → children): dotted ids
  // alone miss it. Read off list rows on bd 1.3+, else one `bd show <epic>
  // --include-dependents` per epic.
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
  return parseRunNotes(notes).at(-1);
}

// Every run note on a bead, oldest first. The writeback ends its note with
// "(run <id>)"; the rib's cleanup note opens its prose with "run <id>;".
const RUN_MARKER = /\s*\(run ([A-Za-z0-9-]*\d[A-Za-z0-9-]*)\)\s*$/;
const CLEANUP_MARKER = /^run ([A-Za-z0-9-]*\d[A-Za-z0-9-]*);/;
export function parseRunNotes(notes: string | undefined): BeadRunInfo[] {
  if (!notes) return [];
  const found: BeadRunInfo[] = [];
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
    const prose = cells.slice(1).join(" — ");
    const runId = (RUN_MARKER.exec(prose) ?? CLEANUP_MARKER.exec(prose))?.[1];
    const note = prose.replace(RUN_MARKER, "").replace(/\s*\(run unknown\)\s*$/, "");
    found.push({
      ...(!state ? { prUrl: pr } : { prState: state }),
      ...(number ? { prNumber: number } : {}),
      ...(outcome ? { outcome } : {}),
      ...(note ? { note } : {}),
      ...(runId ? { runId } : {}),
    });
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
  opts: { rowsCarryNotes?: boolean; onBead?: (done: number, total: number) => void } = {},
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
  const eligible = eligibleBeads(backlog.data);
  for (const [at, bead] of eligible.entries()) {
    const run: Measured<BeadRunInfo | undefined> = opts.rowsCarryNotes
      ? { ok: true, data: parseRunNote(bead.notes) }
      : await readRunInfo(bd, project.rootPath, bead.id);
    if (!opts.rowsCarryNotes) opts.onBead?.(at + 1, eligible.length);
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

// The parent edge as a list row reports it: the `parent` field, or the
// parent-child dependency record when only that is present.
export function parentOf(i: BdIssue): string | undefined {
  if (i.parent) return i.parent;
  const edge = (i.dependencies ?? []).find((d) => (d.dependency_type ?? d.type) === "parent-child");
  return edge?.depends_on_id;
}

// Epic membership read off full list rows: every open and closed bead whose
// parent is an open epic in the backlog.
export function epicMembersFromRows(
  backlog: readonly BdIssue[],
  closed: readonly BdIssue[],
): Record<string, EpicMember[]> {
  const map: Record<string, EpicMember[]> = {};
  for (const epic of backlog) if (epic.issue_type === "epic") map[epic.id] = [];
  const seen = new Set<string>();
  for (const i of [...backlog, ...closed]) {
    const parent = parentOf(i);
    const members = parent ? map[parent] : undefined;
    if (!members || seen.has(i.id)) continue;
    seen.add(i.id);
    members.push({
      id: i.id,
      title: i.title,
      status: i.status,
      ...(i.priority !== undefined ? { priority: i.priority } : {}),
    });
  }
  return map;
}

// Sweep progress for the loading header: which read is running and how many
// of the sweep's fixed steps have finished.
export interface SweepProgress {
  done: number;
  total: number;
  label: string;
}

export const SWEEP_STEPS = 12;

export async function measureProject(
  bd: BdClient,
  project: BeadsProject,
  now: () => Date = () => new Date(),
  gh?: GhClient,
  onProgress?: (p: SweepProgress) => void,
): Promise<ProjectMeasurement> {
  const cwd = project.rootPath;
  let done = 0;
  const step = (label: string) => onProgress?.({ done: done++, total: SWEEP_STEPS, label });

  step("bd version");
  const bdVersion = await readBdVersion(bd, cwd);
  const tooOld = bdBelowFloor({ bd: bdVersion });
  const fullRows = bdVersion.ok && bdVersion.data?.fullRows === true;

  step("summary");
  const statusRes = await bd.readJSON<{ summary?: BdSummary }>(cwd, ["status"]);
  const summary: Measured<BdSummary> = statusRes.ok
    ? statusRes.data.summary
      ? { ok: true, data: statusRes.data.summary }
      : unmeasured("bd status carried no summary")
    : statusRes;

  step("in-flight work");
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

  step("ready queue");
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

  step("blocked work");
  const depBlockedRes = await bd.readJSON<unknown>(cwd, ["blocked"]);
  step("paused work");
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

  step("epics");
  const epicsRes = await bd.readJSON<unknown>(cwd, ["epic", "status"]);
  const epics: Measured<BdEpicRow[]> = epicsRes.ok
    ? {
        ok: true,
        data: (Array.isArray(epicsRes.data) ? (epicsRes.data as BdEpicRow[]) : []).filter(
          (row) => row?.epic && row.epic.status !== "tombstone",
        ),
      }
    : epicsRes;

  step("recent closes");
  const closedRes = await bd.readJSON<unknown>(cwd, ["list", "--status", "closed", "--limit", "0"]);
  const recentlyClosed: Measured<BdIssue[]> = closedRes.ok
    ? { ok: true, data: recentCloses(asArray(closedRes.data), now()) }
    : closedRes;
  const closedFortnight: Measured<BdIssue[]> = closedRes.ok
    ? { ok: true, data: recentCloses(asArray(closedRes.data), now(), FLOW_WINDOW_DAYS) }
    : closedRes;

  step("stale claims");
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

  step("backlog");
  const backlog = await readBacklog(bd, cwd);
  step("run notes and PRs");
  const { runInfo, prInfo } = tooOld
    ? { runInfo: unmeasured<never>(tooOld), prInfo: unmeasured<never>(tooOld) }
    : gh
      ? await collectRecordedPRs(bd, gh, project, backlog, {
          rowsCarryNotes: fullRows,
          onBead: (n, of) =>
            onProgress?.({ done: done - 1, total: SWEEP_STEPS, label: `run notes ${n} of ${of}` }),
        })
      : {
          runInfo:
            unmeasured<Record<string, Measured<BeadRunInfo | undefined>>>(
              "GitHub reader not bound",
            ),
          prInfo:
            unmeasured<Record<string, Measured<PrInfo | undefined>>>("GitHub reader not bound"),
        };

  // Full rows name each bead's parent, so membership needs no extra read.
  // Otherwise one bd show per epic in the open backlog (epics are few); a
  // failed lookup marks the whole map unmeasured rather than presenting
  // partial membership as complete.
  step("epic membership");
  let epicChildren: Measured<Record<string, EpicMember[]>>;
  if (tooOld) {
    epicChildren = unmeasured(tooOld);
  } else if (!backlog.ok) {
    epicChildren = unmeasured("backlog unmeasured, so epic membership cannot be read");
  } else if (fullRows && closedRes.ok) {
    epicChildren = { ok: true, data: epicMembersFromRows(backlog.data, asArray(closedRes.data)) };
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
