// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  Rib,
  RibAction,
  RibContext,
  RibViewDescriptor,
  SnapshotManager,
} from "@keelson/shared";
import { z } from "zod";
import { BdClient, type BeadsProject, discoverBeadsProjects } from "./bd";
import {
  composeAttention,
  composeInspect,
  composeMomentum,
  composeNoTrackerPulse,
  composePlan,
  composePortfolio,
  composePulse,
  composeRecommend,
  composeWip,
  EMPTY_PANEL,
  fallbackSelectedId,
  recommendNext,
} from "./board";
import {
  ALL_KEYS,
  ATTENTION_KEY,
  BEADS_SURFACE_ID,
  INSPECT_KEY,
  MOMENTUM_KEY,
  PLAN_KEY,
  PORTFOLIO_KEY,
  PULSE_KEY,
  RECOMMEND_KEY,
  WIP_KEY,
} from "./keys";
import { fetchIssue, measureProject, type ProjectMeasurement } from "./measure";
import { GhClient } from "./pr";
import { type SyncReport, syncMergedPRs } from "./sync";
import { makeBeadsTools } from "./tools";

// ── Module state, reset on every activation.
let snapshots: SnapshotManager | undefined;
let unregisters: (() => void)[] = [];
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let seedTimer: ReturnType<typeof setTimeout> | undefined;
let bdClient: BdClient | undefined;
let ghClient: GhClient | undefined;
const syncingProjects = new Set<string>();
let getAllProjects: (() => readonly { id: string; name: string; rootPath: string }[]) | undefined;
let listBeadsProjects: (() => BeadsProject[]) | undefined;

// The surface is projectScoped: the host posts `select-project` with the
// chosen project id; the panels render THAT backlog. `selectedBeadId` drives
// the inspector; both reset on scope change.
let scopeId: string | undefined;
let selectedBeadId: string | undefined;

const REFRESH_MS = 300_000;
// Boot-time compose can race project loading; one early re-seed repaints the
// first frames without waiting a full cadence.
const SEED_RETRY_MS = 15_000;
// One bd sweep feeds all seven panels: composers share this cache, and only
// refreshAll() (cadence, mutation, scope change) pays for a re-measure —
// invalidation is event-driven, so the TTL matches the cadence and exists
// only as a backstop. A short TTL made every selection pay a full serialized
// bd sweep before the inspector could answer.
const MEASURE_TTL_MS = REFRESH_MS;

let measureCache: { scopeId: string; at: number; promise: Promise<ProjectMeasurement> } | undefined;

const selectProjectPayload = z.object({ scopeId: z.string().min(1).optional() });
const beadPayload = z.object({ id: z.string().min(1) });
const syncPayload = z.object({ projectId: z.string().min(1) });

function scopedProject(): BeadsProject | undefined {
  if (!scopeId) return undefined;
  return listBeadsProjects?.().find((p) => p.id === scopeId);
}

function getMeasurement(project: BeadsProject): Promise<ProjectMeasurement> {
  const now = Date.now();
  if (
    measureCache &&
    measureCache.scopeId === project.id &&
    now - measureCache.at < MEASURE_TTL_MS
  ) {
    return measureCache.promise;
  }
  if (!bdClient || !ghClient) return Promise.reject(new Error("beads clients not bound"));
  const promise = measureProject(bdClient, project, undefined, ghClient);
  measureCache = { scopeId: project.id, at: now, promise };
  // A failed sweep must not poison the cache window.
  promise.catch(() => {
    if (measureCache?.promise === promise) measureCache = undefined;
  });
  return promise;
}

function recomposeKeys(keys: readonly string[]): void {
  for (const key of keys) snapshots?.recompose(key).catch(() => undefined);
}

function refreshAll(): void {
  measureCache = undefined;
  recomposeKeys(ALL_KEYS);
}

async function reconcile(project: BeadsProject, confirm: boolean): Promise<SyncReport> {
  if (!bdClient || !ghClient) throw new Error("beads clients not bound");
  if (syncingProjects.has(project.id))
    throw new Error(`reconciliation already running for ${project.name}`);
  syncingProjects.add(project.id);
  try {
    return await syncMergedPRs(bdClient, ghClient, project, { confirm });
  } finally {
    syncingProjects.delete(project.id);
    if (confirm) refreshAll();
  }
}

function syncErrors(report: SyncReport): string | undefined {
  const failures = report.results.filter((result) => result.status === "error");
  return (
    report.error ??
    (failures.length ? `${failures.length} bead(s) could not be reconciled` : undefined)
  );
}

// Composer factory: every panel resolves the scope the same way — no scope or
// a scope without a tracker renders the resting state on the pulse panel and
// hides the rest (the zero-section signal).
function makePanelComposer(
  compose: (m: ProjectMeasurement) => unknown,
  restingOnPulse = false,
): () => Promise<unknown> {
  return async () => {
    const project = scopedProject();
    if (!project) {
      if (!restingOnPulse) return EMPTY_PANEL;
      const name = scopeId
        ? (getAllProjects?.().find((p) => p.id === scopeId)?.name ?? "the selected project")
        : "the current scope";
      return composeNoTrackerPulse(name, listBeadsProjects?.() ?? []);
    }
    return compose(await getMeasurement(project));
  };
}

const rib: Rib = {
  id: "beads",
  displayName: "Beads",

  views: ALL_KEYS.map(
    (key): RibViewDescriptor => ({
      key,
      canvasKind: "view",
      title: `Beads — ${key.split(":").pop()}`,
    }),
  ),

  // Stable spatial roles in the OPERATOR's order — what's moving and what
  // needs me first, then the board's own pick, then how far along each
  // initiative is and what happened lately, then the inspector band and the
  // Plan grid. Column STACKS (keelson 0.103.0, the peer floor) let each
  // column's height flow independently of its row siblings: the pick tucks
  // under Agents at work instead of forcing its own full-width row barrier,
  // and the one-region Portfolio/Momentum stacks stop stretching to each
  // other's height. The row break between the two zones keeps the pick
  // above the portfolio pair in both columns. Columns still cannot stick,
  // so the inspector never sits beside the (much taller) Plan — selection
  // opens it in the drawer instead. The rib drives refresh in-process (a
  // cadence without a workflow binding is inert), so regions declare none.
  surfaces: [
    {
      id: BEADS_SURFACE_ID,
      title: "Beads",
      heading: "Beads backlog",
      subtitle: "Measured with bd — what's moving, what needs you, then the inventory.",
      projectScoped: true,
      layout: {
        header: {
          key: PULSE_KEY,
          title: "Pulse",
          glyph: { char: "◉", tone: "accent" },
          live: true,
        },
        rows: [
          {
            columns: [
              [
                {
                  key: WIP_KEY,
                  title: "Agents at work",
                  glyph: { char: "◐", tone: "ok" },
                  live: true,
                },
                {
                  key: RECOMMEND_KEY,
                  title: "Recommended next",
                  glyph: { char: "→", tone: "accent" },
                  live: true,
                },
              ],
              [
                {
                  key: ATTENTION_KEY,
                  title: "Needs a human",
                  glyph: { char: "●", tone: "error" },
                  live: true,
                },
              ],
            ],
          },
          {
            columns: [
              [
                {
                  key: PORTFOLIO_KEY,
                  title: "Portfolio",
                  glyph: { char: "▰", tone: "brand" },
                  live: true,
                },
              ],
              [
                {
                  key: MOMENTUM_KEY,
                  title: "Momentum",
                  glyph: { char: "✓", tone: "ok" },
                  live: true,
                },
              ],
            ],
          },
          {
            columns: [
              {
                key: INSPECT_KEY,
                title: "Selected bead",
                glyph: { char: "☰", tone: "neutral" },
                live: true,
                collapsible: true,
              },
            ],
          },
          {
            columns: [
              {
                key: PLAN_KEY,
                title: "Plan",
                glyph: { char: "▤", tone: "brand" },
                live: true,
                collapsible: true,
              },
            ],
          },
        ],
      },
    },
  ],

  contributeDocs: () => [
    {
      title: "Beads",
      summary:
        "The Beads rib for Keelson: a beads (bd) backlog bridged as chat tools, an overview-plus-inspector backlog surface, and workflows that drive work from the ready queue.",
      content: [
        "# Beads rib",
        "",
        "Bridges the beads issue tracker (the `bd` CLI) into keelson. Any registered",
        "keelson project whose repository carries a `.beads/` directory is discovered",
        "automatically; every tool takes an optional `project` name when several are",
        "registered.",
        "",
        "## The surface",
        "",
        "Project-scoped (the host's project picker chooses the backlog) and arranged",
        "in the operator's order: the Pulse — a proportional flow strip (waiting →",
        "ready → in progress → in review → done 7d, ordinal ramp tones, the review",
        "stage derived from bead-work run notes; an unmeasured stage renders as a",
        "hatched segment, never a zero); an Agents-at-work vs Needs-a-human pair",
        "(runs and their PRs on the cards; verified merges pending close, reviews",
        "to merge, dams — blockers grouped",
        "by what they hold — hand-paused work, stale claims, and epic closeouts in",
        "the queue); ONE recommended-next bead (leverage first, priority second) with",
        "its unlock chain named and Inspect / Start actions; a Portfolio of per-epic",
        "stage-composition meters (done → in review → in progress → ready → waiting,",
        "the strip's vocabulary at epic scale) beside Momentum — a closed-vs-created",
        "per-day chart over the fortnight, then the event feed (closes, touches, new",
        "beads); a Selected-bead inspector band that renders any clicked card's or",
        "row's description, acceptance criteria, and dependency links (a click also",
        "opens it in the canvas drawer, so the detail is in view no matter where on",
        "the page the click landed); and the Plan — the canonical grouped grid of",
        "everything not finished. Color means state, never priority. Every panel is",
        "fail-closed: a failed bd query renders UNMEASURED, never empty-but-healthy.",
        "Panels measure linked PRs read-only on a 5-minute cadence using an",
        "authenticated gh CLI. Failed lookups show UNMEASURED, not a clean slate.",
        "There is no automatic merge webhook. The confirmed Reconcile merged PRs",
        "action rechecks and closes eligible beads in the selected project with",
        "reason Merged via <canonical PR URL>; refresh alone never closes anything.",
        "Mutations recompose immediately; beads_board_refresh does so on demand.",
        "",
        "## Tools",
        "",
        "Read: beads_projects, beads_status, beads_ready, beads_blocked, beads_show,",
        "beads_list, beads_epics, beads_stale.",
        "Write: beads_create, beads_update (claim/status/priority/notes),",
        "beads_close (manual, confirmation-gated), beads_dep.",
        "beads_sync_merged is state-changing: omit confirm for a read-only preview",
        "of bead ID, PR URL and merge timestamp; confirm: true closes verified",
        "merged PR beads and reports closed, skipped and error results. Its optional",
        "project name defaults only when exactly one beads project is registered.",
        "",
        "## Conventions the tools encode",
        "",
        "- Ready order is priority, but leverage outranks it: a bead with a high",
        "  dependent_count unblocks the most downstream work — start there.",
        "- Epics are structure, never work items (`--exclude-type=epic`).",
        "- Closing follows verified merge and explicit confirmation, or manual",
        "  beads_close with a reason. Epic acceptance criteria still need review.",
        "- No one-liner beads: batch trivia, split research into its own bead.",
        "",
        "## Workflows",
        "",
        "- `beads-next` — recommends what to start first (leverage-ranked), read-only.",
        "- `beads-groom` — backlog health report: stale claims, blocked chains,",
        "  priority drift; proposes bd commands, never runs them.",
        "- `beads-work` — claims a bead (or takes an id), plans, gates on approval,",
        "  implements in a worktree, opens a draft PR, reviews, waits on CI, and",
        "  records the outcome on the bead. Never closes; releases the claim on failure.",
        "  After the PR merges, use reconciliation or manual beads_close.",
      ].join("\n"),
    },
  ],

  registerTools: (ctx: RibContext) => {
    const exec = ctx.getExec();
    bdClient = new BdClient(exec);
    ghClient = new GhClient(exec);
    listBeadsProjects = () => discoverBeadsProjects(ctx.getProjects?.() ?? []);
    getAllProjects = () => ctx.getProjects?.() ?? [];

    for (const un of unregisters) un();
    unregisters = [];
    snapshots = ctx.getSnapshotManager?.();
    if (snapshots) {
      const sm = snapshots;
      const register = (key: string, compose: () => Promise<unknown>) =>
        unregisters.push(sm.register(key, compose));
      register(PULSE_KEY, makePanelComposer(composePulse, true));
      register(
        RECOMMEND_KEY,
        makePanelComposer((m) => composeRecommend(m, { selectedId: selectedBeadId })),
      );
      register(
        WIP_KEY,
        makePanelComposer((m) => composeWip(m, { selectedId: selectedBeadId })),
      );
      register(
        ATTENTION_KEY,
        makePanelComposer((m) => composeAttention(m, { selectedId: selectedBeadId })),
      );
      register(
        PLAN_KEY,
        makePanelComposer((m) => composePlan(m, { selectedId: selectedBeadId })),
      );
      register(
        PORTFOLIO_KEY,
        makePanelComposer((m) => composePortfolio(m, { selectedId: selectedBeadId })),
      );
      register(
        MOMENTUM_KEY,
        makePanelComposer((m) => composeMomentum(m, { selectedId: selectedBeadId })),
      );
      register(INSPECT_KEY, async () => {
        const project = scopedProject();
        if (!project || !bdClient) return composeInspect(undefined, []);
        const m = await getMeasurement(project);
        // With nothing chosen, rest on the board's own recommendation rather
        // than an empty panel. `selectedBeadId` stays untouched — it means
        // "the operator picked this", which is what the selection rings on the
        // other panels report, and `select-project` clearing it drops straight
        // through to the new project's pick with no extra bookkeeping.
        const preselected = !selectedBeadId;
        const id = selectedBeadId ?? fallbackSelectedId(m);
        if (!id) return composeInspect(undefined, []);
        const issue = await fetchIssue(bdClient, project.rootPath, id);
        // The board's current pick rides along: when the inspected bead is
        // blocked, "Start X instead" must name the same bead the
        // recommendation panel does.
        const rec = m.ready.ok ? recommendNext(m.ready.data).pick : undefined;
        // An epic's completion row, when the measurement has one: the
        // inspector turns it into a closeout review instead of a claim button.
        const epicRow = m.epics.ok ? m.epics.data.find((r) => r.epic.id === id) : undefined;
        return composeInspect(issue, m.blocked.ok ? m.blocked.data : [], rec, {
          epicRow,
          preselected,
          prInfo: m.prInfo,
          projectId: project.id,
        });
      });

      recomposeKeys(ALL_KEYS);
      if (seedTimer) clearTimeout(seedTimer);
      seedTimer = setTimeout(refreshAll, SEED_RETRY_MS);
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(refreshAll, REFRESH_MS);
    }

    return makeBeadsToolsBound();
  },

  // Board actions: the host's project chip posts `select-project`; the panels
  // post `select-bead` (inspector) and `claim-bead` (bd update --claim).
  onAction: async (action: RibAction) => {
    switch (action.type) {
      case "select-project": {
        const parsed = selectProjectPayload.safeParse(action.payload ?? {});
        if (!parsed.success) {
          return {
            ok: false as const,
            error: "select-project payload must be { scopeId?: string }",
          };
        }
        scopeId = parsed.data.scopeId;
        selectedBeadId = undefined;
        refreshAll();
        return { ok: true as const };
      }
      case "select-bead": {
        const parsed = beadPayload.safeParse(action.payload ?? {});
        if (!parsed.success) {
          return { ok: false as const, error: "select-bead payload must be { id: string }" };
        }
        selectedBeadId = parsed.data.id;
        // Compose the inspector BEFORE answering: the open-canvas directive
        // below opens that snapshot in the drawer, and it must show the bead
        // just clicked, not the previous frame. Selection is cheap — the
        // measurement cache holds, only bd show runs.
        await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
        recomposeKeys([
          PLAN_KEY,
          RECOMMEND_KEY,
          WIP_KEY,
          ATTENTION_KEY,
          PORTFOLIO_KEY,
          MOMENTUM_KEY,
        ]);
        // Open the inspector in the canvas drawer: a click deep in the Plan
        // would otherwise update a panel far off-screen — visible feedback
        // must not depend on scroll position. The Selected-bead panel keeps
        // the same frame for when the drawer closes.
        return {
          ok: true as const,
          data: {
            effect: "open-canvas" as const,
            key: INSPECT_KEY,
            title: `Bead ${parsed.data.id}`,
          },
        };
      }
      case "claim-bead": {
        const parsed = beadPayload.safeParse(action.payload ?? {});
        if (!parsed.success) {
          return { ok: false as const, error: "claim-bead payload must be { id: string }" };
        }
        const project = scopedProject();
        if (!project || !bdClient) {
          return { ok: false as const, error: "no beads project is in scope" };
        }
        const res = await bdClient.mutate(project.rootPath, ["update", parsed.data.id, "--claim"]);
        if (!res.ok) return { ok: false as const, error: `bd update --claim failed: ${res.error}` };
        selectedBeadId = parsed.data.id;
        refreshAll();
        return { ok: true as const, data: { claimed: parsed.data.id } };
      }
      case "sync-merged-beads": {
        const parsed = syncPayload.safeParse(action.payload ?? {});
        if (!parsed.success) {
          return {
            ok: false as const,
            error: "sync-merged-beads payload must be { projectId: string }",
          };
        }
        const project = scopedProject();
        if (!project || project.id !== parsed.data.projectId) {
          return {
            ok: false as const,
            error: "selected beads project no longer matches this action",
          };
        }
        try {
          const report = await reconcile(project, true);
          const error = syncErrors(report);
          return error
            ? { ok: false as const, error, data: report }
            : { ok: true as const, data: report };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
      }
      default:
        return { ok: false as const, error: `beads does not handle '${action.type}'` };
    }
  },

  dispose(): void {
    if (seedTimer) clearTimeout(seedTimer);
    seedTimer = undefined;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    for (const un of unregisters) un();
    unregisters = [];
    snapshots = undefined;
    // The SPA re-posts the explicit selection on mount, so a re-activation
    // starts clean rather than trusting stale scope.
    scopeId = undefined;
    selectedBeadId = undefined;
    measureCache = undefined;
    bdClient = undefined;
    ghClient = undefined;
    syncingProjects.clear();
    getAllProjects = undefined;
    listBeadsProjects = undefined;
  },
};

// The chat tools share the same client, discovery, and refresh nudge the
// panels use.
function makeBeadsToolsBound() {
  if (!bdClient || !ghClient || !listBeadsProjects) return [];
  return makeBeadsTools({
    bd: bdClient,
    beadsProjects: listBeadsProjects,
    refreshBoard: refreshAll,
    syncMerged: reconcile,
  });
}

export default rib;
