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
  composeClosed,
  composeInspect,
  composeNoTrackerPulse,
  composePlan,
  composePulse,
  composeRecommend,
  composeWip,
  EMPTY_PANEL,
  recommendNext,
} from "./board";
import {
  ALL_KEYS,
  ATTENTION_KEY,
  BEADS_SURFACE_ID,
  CLOSED_KEY,
  INSPECT_KEY,
  PLAN_KEY,
  PULSE_KEY,
  RECOMMEND_KEY,
  WIP_KEY,
} from "./keys";
import { fetchIssue, measureProject, type ProjectMeasurement } from "./measure";
import { makeBeadsTools } from "./tools";

// ── Module state, reset on every activation.
let snapshots: SnapshotManager | undefined;
let unregisters: (() => void)[] = [];
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let seedTimer: ReturnType<typeof setTimeout> | undefined;
let bdClient: BdClient | undefined;
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
  if (!bdClient) return Promise.reject(new Error("bd client not bound"));
  const promise = measureProject(bdClient, project);
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

  // Stable spatial roles: pulse header → recommendation full-width → the
  // in-flight/attention pair → the selected-bead inspector as a full-width
  // band → the Plan grid → momentum, collapsed by default. Surface columns
  // split evenly and cannot stick, so the inspector never sits beside the
  // (much taller) Plan — selection opens it in the drawer instead. The rib
  // drives refresh in-process (a cadence without a workflow binding is
  // inert), so regions declare none.
  surfaces: [
    {
      id: BEADS_SURFACE_ID,
      title: "Beads",
      heading: "Beads backlog",
      subtitle: "Measured with bd — decide first, then browse the inventory.",
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
              {
                key: RECOMMEND_KEY,
                title: "Recommended next",
                glyph: { char: "→", tone: "accent" },
                live: true,
              },
            ],
          },
          {
            columns: [
              { key: WIP_KEY, title: "In progress", glyph: { char: "◐", tone: "ok" }, live: true },
              {
                key: ATTENTION_KEY,
                title: "Needs attention",
                glyph: { char: "●", tone: "error" },
                live: true,
              },
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
          {
            columns: [
              {
                key: CLOSED_KEY,
                title: "Finished in the last 7 days",
                glyph: { char: "✓", tone: "ok" },
                live: true,
                collapsible: true,
                collapsed: true,
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
        "as stable panels: a current-state pulse; ONE recommended-next bead (leverage",
        "first, priority second) with its unlock chain named and Inspect / Start",
        "actions; an in-progress vs needs-attention pair (blocked ranked by how much",
        "waits on each, stale claims alongside); a Selected-bead inspector band that",
        "renders any clicked card's description, acceptance criteria, and dependency",
        "links (a click also opens it in the canvas drawer, so the detail is in view",
        "no matter where on the page the click landed); the Plan — the canonical",
        "grouped grid of everything not finished, epics carrying n/m progress",
        "meters; and a collapsed finished-this-week",
        "strip. Color means state, never priority. Every panel is fail-closed: a",
        "failed bd query renders UNMEASURED, never empty-but-healthy. Panels refresh",
        "on a 5-minute cadence; any beads_* mutation recomposes them immediately, and",
        "beads_board_refresh does so on demand.",
        "",
        "## Tools",
        "",
        "Read: beads_projects, beads_status, beads_ready, beads_blocked, beads_show,",
        "beads_list, beads_epics, beads_stale.",
        "Write: beads_create, beads_update (claim/status/priority/notes),",
        "beads_close (confirmation-gated), beads_dep.",
        "",
        "## Conventions the tools encode",
        "",
        "- Ready order is priority, but leverage outranks it: a bead with a high",
        "  dependent_count unblocks the most downstream work — start there.",
        "- Epics are structure, never work items (`--exclude-type=epic`).",
        "- Closing is a merge-time action with a written reason; automated runs release",
        "  a claim back to open instead of closing.",
        "- No one-liner beads: batch trivia, split research into its own bead.",
        "",
        "## Workflows",
        "",
        "- `beads-next` — recommends what to start first (leverage-ranked), read-only.",
        "- `beads-groom` — backlog health report: stale claims, blocked chains,",
        "  priority drift; proposes bd commands, never runs them.",
      ].join("\n"),
    },
  ],

  registerTools: (ctx: RibContext) => {
    bdClient = new BdClient(ctx.getExec());
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
      register(CLOSED_KEY, makePanelComposer(composeClosed));
      register(INSPECT_KEY, async () => {
        const project = scopedProject();
        if (!project) return composeInspect(undefined, []);
        if (!selectedBeadId || !bdClient) return composeInspect(undefined, []);
        const m = await getMeasurement(project);
        const issue = await fetchIssue(bdClient, project.rootPath, selectedBeadId);
        // The board's current pick rides along: when the inspected bead is
        // blocked, "Start X instead" must name the same bead the
        // recommendation panel does.
        const rec = m.ready.ok ? recommendNext(m.ready.data).pick : undefined;
        return composeInspect(issue, m.blocked.ok ? m.blocked.data : [], rec);
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
        recomposeKeys([PLAN_KEY, RECOMMEND_KEY, WIP_KEY, ATTENTION_KEY]);
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
    getAllProjects = undefined;
    listBeadsProjects = undefined;
  },
};

// The chat tools share the same client, discovery, and refresh nudge the
// panels use.
function makeBeadsToolsBound() {
  if (!bdClient || !listBeadsProjects) return [];
  return makeBeadsTools({
    bd: bdClient,
    beadsProjects: listBeadsProjects,
    refreshBoard: refreshAll,
  });
}

export default rib;
