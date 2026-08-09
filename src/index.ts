// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Rib, RibAction, RibContext, SnapshotManager } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import { z } from "zod";
import { BdClient, discoverBeadsProjects } from "./bd";
import { composeBoard, composeNoTrackerBoard } from "./board";
import { BEADS_SURFACE_ID, BOARD_KEY } from "./keys";
import { measureProject } from "./measure";
import { makeBeadsTools } from "./tools";

// Captured in registerTools (the one hook that receives ctx at boot) and used
// by the composer + the tools' refresh nudge. Reset on every activation so a
// re-boot never runs against a disposed manager.
let snapshots: SnapshotManager | undefined;
let unregisterBoard: (() => void) | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let seedTimer: ReturnType<typeof setTimeout> | undefined;

const REFRESH_MS = 300_000;
// Boot-time compose can race project loading and see no beads projects; one
// early re-seed repaints the first frame without waiting a full cadence.
const SEED_RETRY_MS = 15_000;

// The surface is projectScoped: the host renders its shared project picker
// and posts `select-project` with the chosen project id. The board renders
// THAT project's backlog — never a concatenation of every beads project.
// Undefined = no explicit selection yet.
let scopeId: string | undefined;
// Captured alongside the snapshot manager so onAction can resolve names.
let getAllProjects: (() => readonly { id: string; name: string; rootPath: string }[]) | undefined;

const selectProjectPayload = z.object({ scopeId: z.string().min(1).optional() });

function refreshBoard(): void {
  // Fail-soft: a mutation's nudge must never take the tool result down with it.
  snapshots?.recompose(BOARD_KEY).catch(() => undefined);
}

const rib: Rib = {
  id: "beads",
  displayName: "Beads",

  // The board key binds to the canvas `view` renderer; the payload is a
  // CanvasBoardView the composer builds deterministically from bd output.
  views: [{ key: BOARD_KEY, canvasKind: "view", title: "Beads backlog" }],

  // The Beads nav tab: one focal board. The region binds no workflow, so the
  // rib drives its own refresh in-process (a cadence without a workflow
  // binding is inert — the host logs and skips it); mutations through the
  // beads_* tools nudge an immediate recompose on top of that.
  surfaces: [
    {
      id: BEADS_SURFACE_ID,
      title: "Beads",
      heading: "Beads backlog",
      subtitle: "Measured with bd — ready, in flight, blocked, and momentum. Never inferred.",
      // The host's first-class project picker drives the board's scope via
      // the select-project action handled below.
      projectScoped: true,
      layout: {
        header: {
          key: BOARD_KEY,
          title: "Backlog",
          glyph: { char: "◉", tone: "accent" },
          live: true,
        },
        rows: [],
      },
    },
  ],

  // An installed rib extends what the agent can look up about itself: the
  // conventions the tools encode, inline (no docs site yet).
  contributeDocs: () => [
    {
      title: "Beads",
      summary:
        "The Beads rib for Keelson: a beads (bd) backlog bridged as chat tools, a live backlog board, and workflows that drive work from the ready queue.",
      content: [
        "# Beads rib",
        "",
        "Bridges the beads issue tracker (the `bd` CLI) into keelson. Any registered",
        "keelson project whose repository carries a `.beads/` directory is discovered",
        "automatically; every tool takes an optional `project` name when several are",
        "registered.",
        "",
        "## The board",
        "",
        "The Beads surface is project-scoped: the host's project picker in the surface",
        "header chooses which backlog renders, and a project without a .beads tracker",
        "gets an honest empty state listing the projects that have one. The board is a",
        "decision surface first, inventory second: a current-state pulse (ready /",
        "in-progress / blocked / stale / closed-this-week), ONE recommended-next bead",
        "(leverage first, priority second) with its unlock chain named so the pick is",
        "explainable, an in-flight vs needs-attention pair (blocked ranked by how much",
        "waits on each, plus stale claims), then the Plan — the one canonical tree of",
        "everything not finished, epics carrying their n/m progress, children nested,",
        "ready rows dotted, every row expandable to description and acceptance",
        "criteria — and a finished-this-week momentum strip. Color means state, never",
        "priority. Every section is fail-closed: a failed bd query renders UNMEASURED,",
        "never empty-but-healthy. It refreshes on a 5-minute cadence; any beads_*",
        "mutation recomposes it immediately, and beads_board_refresh does so on demand.",
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
    const bd = new BdClient(ctx.getExec());
    const beadsProjects = () => discoverBeadsProjects(ctx.getProjects?.() ?? []);

    // Rebind on every activation: drop a stale composer registration first so
    // a re-boot against a fresh manager never throws on the duplicate key.
    unregisterBoard?.();
    unregisterBoard = undefined;
    snapshots = ctx.getSnapshotManager?.();
    getAllProjects = () => ctx.getProjects?.() ?? [];
    if (snapshots) {
      unregisterBoard = snapshots.register(
        BOARD_KEY,
        async () => {
          const withBeads = beadsProjects();
          // No explicit selection yet: the honest resting state is the map,
          // not a concatenation of every backlog.
          if (!scopeId) return composeNoTrackerBoard("the current scope", withBeads);
          const scoped = withBeads.find((p) => p.id === scopeId);
          if (!scoped) {
            const name =
              getAllProjects?.().find((p) => p.id === scopeId)?.name ?? "the selected project";
            return composeNoTrackerBoard(name, withBeads);
          }
          return composeBoard([await measureProject(bd, scoped)]);
        },
        { validate: expectView(BOARD_KEY, "board") },
      );
      // Seed the frame so the surface has data on first open, re-seed once
      // past the project-loading race, then hold the cadence. Fail-soft.
      snapshots.recompose(BOARD_KEY).catch(() => undefined);
      if (seedTimer) clearTimeout(seedTimer);
      seedTimer = setTimeout(refreshBoard, SEED_RETRY_MS);
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(refreshBoard, REFRESH_MS);
    }

    return makeBeadsTools({ bd, beadsProjects, refreshBoard });
  },

  // The host posts `select-project` when the surface's project chip changes
  // (and once on mount when an explicit selection exists). Scope, recompose,
  // and let the frame broadcast repaint the panel.
  onAction: (action: RibAction) => {
    if (action.type !== "select-project") {
      return { ok: false as const, error: `beads does not handle '${action.type}'` };
    }
    const parsed = selectProjectPayload.safeParse(action.payload ?? {});
    if (!parsed.success) {
      return { ok: false as const, error: "select-project payload must be { scopeId?: string }" };
    }
    scopeId = parsed.data.scopeId;
    refreshBoard();
    return { ok: true as const };
  },

  dispose(): void {
    if (seedTimer) clearTimeout(seedTimer);
    seedTimer = undefined;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    unregisterBoard?.();
    unregisterBoard = undefined;
    snapshots = undefined;
    // The SPA re-posts the explicit selection on mount, so a re-activation
    // starts clean rather than trusting stale scope.
    scopeId = undefined;
    getAllProjects = undefined;
  },
};

export default rib;
