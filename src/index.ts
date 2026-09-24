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
  RibRunEvent,
  RibViewDescriptor,
  SnapshotManager,
} from "@keelson/shared";
import { z } from "zod";
import { BdClient, type BeadsProject, discoverBeadsProjects } from "./bd";
import {
  composeAttention,
  composeBacklog,
  composeInspect,
  composeInspectNeedsBd,
  composeLadders,
  composeNoTrackerPulse,
  composePulse,
  composeRecommend,
  composeShipped,
  composeWip,
  EMPTY_PANEL,
  recommendNext,
} from "./board";
import {
  ALL_KEYS,
  ATTENTION_KEY,
  BACKLOG_KEY,
  BEADS_SURFACE_ID,
  INSPECT_KEY,
  LADDERS_KEY,
  PULSE_KEY,
  RECOMMEND_KEY,
  SHIPPED_KEY,
  WIP_KEY,
} from "./keys";
import {
  bdBelowFloor,
  fetchIssue,
  measureProject,
  type ProjectMeasurement,
  readComments,
} from "./measure";
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
const cleanupInFlight = new Map<string, Promise<void>>();

// The surface is projectScoped: the host posts `select-project` with the
// chosen project id; the panels render THAT backlog. `selectedBeadId` drives
// the inspector; both reset on scope change.
let scopeId: string | undefined;
let selectedBeadId: string | undefined;

const REFRESH_MS = 300_000;
// Boot-time compose can race project loading; one early re-seed repaints the
// first frames without waiting a full cadence.
const SEED_RETRY_MS = 15_000;
// One bd sweep feeds every panel: composers share this cache, and only
// refreshAll() (cadence, mutation, scope change) pays for a re-measure —
// invalidation is event-driven, so the TTL matches the cadence and exists
// only as a backstop. A short TTL made every selection pay a full serialized
// bd sweep before the inspector could answer.
const MEASURE_TTL_MS = REFRESH_MS;

let measureCache: { scopeId: string; at: number; promise: Promise<ProjectMeasurement> } | undefined;

const selectProjectPayload = z.object({ scopeId: z.string().min(1).optional() });
const beadPayload = z.object({ id: z.string().min(1) });
const runDetailPayload = z.object({
  data: z.object({
    run: z.object({
      runId: z.string(),
      workflowName: z.string(),
      status: z.string(),
      completedAt: z.string().nullable(),
      projectId: z.string().nullable(),
      workingDir: z.string().nullable(),
      nodes: z.array(
        z.object({
          nodeId: z.string(),
          status: z.string(),
          outputText: z.string().nullable(),
          startedAt: z.string().nullable(),
        }),
      ),
    }),
  }),
});
const claimOutput = z.object({
  status: z.string(),
  id: z.string().optional(),
  assignee: z.string().optional(),
});
const cleanupIssue = z.object({
  id: z.string(),
  status: z.string(),
  assignee: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

function prFromOutput(output: string, nodeId: string): string | undefined {
  const url = /https?:\/\/[^\s"'<>]+\/pull\/\d+/.exec(output)?.[0];
  if (url) return url;
  const number =
    /\b(?:PR|pull request)\s*(?:number|#|:|=)\s*#?(\d+)\b/i.exec(output)?.[1] ??
    /\bpr[_-]?number\s*["']?\s*[:=]\s*["']?(\d+)\b/i.exec(output)?.[1] ??
    (nodeId === "create-pr" ? /"number"\s*:\s*"?(\d+)"?/.exec(output)?.[1] : undefined);
  return number ? `#${number}` : undefined;
}

async function cleanupEndedRun(event: RibRunEvent, ctx: RibContext): Promise<void> {
  const exec = ctx.getExec();
  const result = await exec.runJSON<unknown>(
    "keelson",
    ["workflow", "status", event.runId, "--json"],
    { timeoutMs: 30_000 },
  );
  if (!result.ok) throw new Error(`beads-work ${event.runId}: run detail failed: ${result.error}`);
  const parsed = runDetailPayload.safeParse(result.data);
  if (!parsed.success) throw new Error(`beads-work ${event.runId}: invalid workflow run detail`);
  const run = parsed.data.data.run;
  if (
    run.runId !== event.runId ||
    run.workflowName !== event.workflowName ||
    run.status !== event.status ||
    (event.completedAt && run.completedAt !== event.completedAt)
  ) {
    return;
  }
  const writeback = run.nodes.find((node) => node.nodeId === "beads-writeback");
  if (
    event.status === "failed" &&
    (writeback?.startedAt || writeback?.status === "succeeded" || writeback?.status === "failed")
  ) {
    return;
  }

  const claim = run.nodes.find((node) => node.nodeId === "claim");
  if (!claim) throw new Error(`beads-work ${event.runId}: claim node missing from run detail`);
  if (claim.status !== "succeeded") return;
  if (!claim.outputText) return;
  const output = claimOutput.safeParse(JSON.parse(claim.outputText));
  if (!output.success) throw new Error(`beads-work ${event.runId}: invalid claim output`);
  if (output.data.status === "empty") return;
  if (output.data.status !== "claimed" || !output.data.id) {
    throw new Error(`beads-work ${event.runId}: claimed bead ID not recorded`);
  }
  const explicitId = event.inputs.bead?.trim();
  const beadId = output.data.id;
  if (explicitId && explicitId !== beadId) return;
  // Older runs did not persist the claim's assignee; they cannot safely release it.
  if (!output.data.assignee) return;

  const cwd =
    (run.projectId &&
      ctx.getProjects?.().find((project) => project.id === run.projectId)?.rootPath) ||
    run.workingDir;
  if (!cwd) throw new Error(`beads-work ${event.runId}: run project directory not recorded`);
  const bd = bdClient;
  if (!bd) throw new Error(`beads-work ${event.runId}: bd client not registered`);
  const shown = await bd.readJSON<unknown>(cwd, ["show", beadId]);
  if (!shown.ok) throw new Error(`beads-work ${event.runId}: bd show ${beadId}: ${shown.error}`);
  const issue = cleanupIssue.safeParse(Array.isArray(shown.data) ? shown.data[0] : shown.data);
  if (!issue.success || issue.data.id !== beadId) {
    throw new Error(`beads-work ${event.runId}: invalid bd show result for ${beadId}`);
  }
  if (issue.data.status !== "in_progress" || issue.data.assignee !== output.data.assignee) return;

  const createPrIndex = run.nodes.findIndex((node) => node.nodeId === "create-pr");
  if (createPrIndex < 0) throw new Error(`beads-work ${event.runId}: create-pr node missing`);
  const pr = run.nodes
    .slice(createPrIndex)
    .flatMap((node) => (node.outputText ? [prFromOutput(node.outputText, node.nodeId)] : []))
    .find((value) => value !== undefined);
  const createPr = run.nodes[createPrIndex];
  const prUnknown =
    !pr &&
    (Boolean(createPr?.startedAt) ||
      createPr?.status === "succeeded" ||
      createPr?.status === "failed");
  const disposition = prUnknown
    ? "PR state unknown; claim retained"
    : pr
      ? "claim retained"
      : "claim released";
  const marker = `run ${event.runId}; ${event.status}; ended ${event.completedAt ?? "unknown"}`;
  const note = `bead-work run: PR ${pr ?? (prUnknown ? "unknown" : "none")} — ${event.status} — ${marker}; ${disposition}`;
  if (issue.data.notes?.split("\n").some((line) => line.includes(marker))) return;
  const args = ["update", beadId];
  if (!pr && !prUnknown) args.push("--status", "open", "--assignee", "");
  args.push("--append-notes", note);
  const updated = await bd.mutate(cwd, args);
  if (!updated.ok)
    throw new Error(`beads-work ${event.runId}: bd update ${beadId}: ${updated.error}`);
  refreshAll();
}
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

  // Three zones in the order a status conversation runs: what is moving,
  // what is left, what landed. A column entry may be a stack, so Next up and
  // the epic ladders share one column and a project without epics leaves no
  // empty column behind. The inspector has no region; selection opens it in
  // the canvas drawer. The rib drives refresh in-process, so regions declare
  // no cadence.
  surfaces: [
    {
      id: BEADS_SURFACE_ID,
      title: "Beads",
      heading: "Beads backlog",
      subtitle: "Measured with bd: what's in flight, what's left, and what shipped.",
      projectScoped: true,
      layout: {
        header: {
          key: PULSE_KEY,
          title: "Overview",
          glyph: { char: "◉", tone: "accent" },
          live: true,
        },
        rows: [
          {
            zoneTitle: "Doing",
            columns: [
              {
                key: WIP_KEY,
                title: "In flight",
                glyph: { char: "◐", tone: "info" },
                live: true,
              },
              {
                key: ATTENTION_KEY,
                title: "Needs you",
                glyph: { char: "●", tone: "warn" },
                live: true,
              },
            ],
          },
          {
            zoneTitle: "To do",
            columns: [
              [
                {
                  key: RECOMMEND_KEY,
                  title: "Next up",
                  glyph: { char: "→", tone: "accent" },
                  live: true,
                },
                {
                  key: LADDERS_KEY,
                  title: "Epics",
                  glyph: { char: "▰", tone: "accent" },
                  live: true,
                  hideWhenEmpty: true,
                },
              ],
              {
                key: BACKLOG_KEY,
                title: "Backlog",
                glyph: { char: "○", tone: "accent" },
                live: true,
                collapsible: true,
              },
            ],
          },
          {
            zoneTitle: "Done",
            columns: [
              {
                key: SHIPPED_KEY,
                title: "Shipped",
                glyph: { char: "✓", tone: "ok" },
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
        "in three zones. The Overview header says the week in one sentence (shipped,",
        "in flight, left to do) above the flow strip (waiting → ready → in progress →",
        "in review → done 7d), and reports a shared cause once: a bd older than 1.2 or",
        "a gh that fails every PR lookup. Doing holds In flight (every claim with its",
        "stage — claimed, PR open with draft, CI and review state, merged — and the",
        "newest comment or run remark) beside Needs you (merged PRs to reconcile,",
        "reviews to merge, dams grouped by what they hold, hand-paused work, stale",
        "claims, epic closeouts). To do holds Next up (one leverage-ranked pick with",
        "its unlock chain, runner-up, and Inspect / Start actions), Epics (one ladder",
        "per open epic: a stage meter, then the children in dependency order, done",
        "first), and the Backlog (everything else open, grouped by priority). Done",
        "holds Shipped: closes this week against last, created this week against",
        "last, and every close in the fortnight by day with its PR and the first",
        "sentence of its close reason. Clicking any bead opens the inspector in the",
        "canvas drawer: facts, dependency links by edge type, description,",
        "acceptance criteria, and a history timeline (created, claimed, plan, PR,",
        "comments, closed). Every panel is fail-closed: a failed bd query renders",
        "UNMEASURED, never empty-but-healthy.",
        "Panels measure linked PRs read-only on a 5-minute cadence using an",
        "authenticated gh CLI. There is no automatic merge webhook. The confirmed",
        "Reconcile merged PRs action rechecks and closes eligible beads in the",
        "selected project with reason Merged via <canonical PR URL>; refresh alone",
        "never closes anything. Mutations recompose immediately;",
        "beads_board_refresh does so on demand.",
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
        "  beads_close with a reason; automated runs never close beads. Cleanup",
        "  releases only a claim still held by the run when create-pr never",
        "  started and no PR is recorded. Epic acceptance criteria still need review.",
        "- No one-liner beads: batch trivia, split research into its own bead.",
        "",
        "## Workflows",
        "",
        "- `beads-next` — recommends what to start first (leverage-ranked), read-only.",
        "- `beads-groom` — backlog health report: stale claims, blocked chains,",
        "  priority drift; proposes bd commands, never runs them.",
        "- `beads-work` — claims a bead (or takes an id), plans, gates on approval,",
        "  implements in a worktree, opens a draft PR, reviews, waits on CI, and",
        "  records the outcome on the bead. Never closes; on cancellation or failure",
        "  before writeback, retains claims with a recorded or unknown PR state, and",
        "  releases to open with no assignee only when create-pr never started and",
        "  no PR exists.",
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
        LADDERS_KEY,
        makePanelComposer((m) => composeLadders(m, { selectedId: selectedBeadId })),
      );
      register(
        BACKLOG_KEY,
        makePanelComposer((m) => composeBacklog(m, { selectedId: selectedBeadId })),
      );
      register(
        SHIPPED_KEY,
        makePanelComposer((m) => composeShipped(m, { selectedId: selectedBeadId })),
      );
      register(INSPECT_KEY, async () => {
        const project = scopedProject();
        if (!project || !bdClient) return composeInspect(undefined, []);
        if (!selectedBeadId) return composeInspect(undefined, []);
        const m = await getMeasurement(project);
        if (bdBelowFloor(m)) return composeInspectNeedsBd(m);
        const id = selectedBeadId;
        const issue = await fetchIssue(bdClient, project.rootPath, id);
        const comments =
          issue.ok && issue.data.comment_count
            ? await readComments(bdClient, project.rootPath, id)
            : undefined;
        // The board's current pick rides along: when the inspected bead is
        // blocked, "Start X instead" must name the same bead Next up does.
        const rec = m.ready.ok ? recommendNext(m.ready.data).pick : undefined;
        const epicRow = m.epics.ok ? m.epics.data.find((r) => r.epic.id === id) : undefined;
        return composeInspect(issue, m.blocked.ok ? m.blocked.data : [], rec, {
          epicRow,
          prInfo: m.prInfo,
          projectId: project.id,
          ...(comments ? { comments } : {}),
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

  onRunEvent: async (event: RibRunEvent, ctx: RibContext) => {
    if (event.workflowName !== "beads-work" || !["cancelled", "failed"].includes(event.status)) {
      return;
    }
    const key = `${event.runId}:${event.status}:${event.completedAt ?? ""}`;
    const pending = cleanupInFlight.get(key);
    if (pending) return pending;
    const task = cleanupEndedRun(event, ctx);
    cleanupInFlight.set(key, task);
    try {
      await task;
    } finally {
      if (cleanupInFlight.get(key) === task) cleanupInFlight.delete(key);
    }
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
        recomposeKeys(ALL_KEYS.filter((key) => key !== INSPECT_KEY));
        // The inspector lives only in the canvas drawer, so a click anywhere
        // on the page shows its detail in view.
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
    cleanupInFlight.clear();
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
