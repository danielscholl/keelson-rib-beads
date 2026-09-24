// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ToolContext, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import type { BdClient, BeadsProject } from "./bd";
import type { SyncReport } from "./sync";

// The tool layer's seams, injected so the module stays pure and testable:
// index.ts passes the live client + project discovery; tests pass fakes.
export interface ToolDeps {
  bd: BdClient;
  beadsProjects: () => BeadsProject[];
  // Fail-soft nudge: a mutation recomposes the board so the surface tracks
  // the tracker without waiting for the next cadence tick.
  refreshBoard: () => void;
  syncMerged: (project: BeadsProject, confirm: boolean) => Promise<SyncReport>;
}

const projectArg = z
  .string()
  .optional()
  .describe(
    "Beads project name (as registered in keelson). Omit when exactly one project carries a .beads tracker.",
  );

function resolveProject(
  deps: ToolDeps,
  name: string | undefined,
): { ok: true; project: BeadsProject } | { ok: false; error: string } {
  const projects = deps.beadsProjects();
  if (projects.length === 0) {
    return { ok: false, error: "No registered keelson project carries a .beads tracker." };
  }
  if (name) {
    const hit = projects.find((p) => p.name === name);
    return hit
      ? { ok: true, project: hit }
      : {
          ok: false,
          error: `No beads project named '${name}'. Available: ${projects.map((p) => p.name).join(", ")}`,
        };
  }
  const first = projects[0];
  if (projects.length === 1 && first) return { ok: true, project: first };
  return {
    ok: false,
    error: `Several beads projects are registered — name one: ${projects.map((p) => p.name).join(", ")}`,
  };
}

function emitText(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// Wraps a handler so a tool failure is a result the agent can read and react
// to, never an exception that escapes into the harness's turn loop.
function guarded(
  fn: (input: unknown, ctx: ToolContext) => Promise<void>,
): (input: unknown, ctx: ToolContext) => Promise<void> {
  return async (input, ctx) => {
    try {
      await fn(input, ctx);
    } catch (err) {
      emitText(ctx, `beads tool failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };
}

export function makeBeadsTools(deps: ToolDeps): ToolDefinition[] {
  const read = async (
    ctx: ToolContext,
    projectName: string | undefined,
    args: string[],
  ): Promise<void> => {
    const resolved = resolveProject(deps, projectName);
    if (!resolved.ok) return emitText(ctx, resolved.error, true);
    const res = await deps.bd.readJSON<unknown>(resolved.project.rootPath, args);
    if (!res.ok) return emitText(ctx, `bd ${args.join(" ")} failed: ${res.error}`, true);
    emitText(ctx, JSON.stringify(res.data, null, 1));
  };

  const mutate = async (
    ctx: ToolContext,
    projectName: string | undefined,
    args: string[],
  ): Promise<void> => {
    const resolved = resolveProject(deps, projectName);
    if (!resolved.ok) return emitText(ctx, resolved.error, true);
    const res = await deps.bd.mutate(resolved.project.rootPath, args);
    if (!res.ok) return emitText(ctx, `bd ${args.join(" ")} failed: ${res.error}`, true);
    deps.refreshBoard();
    emitText(ctx, res.data.trim() || "ok");
  };

  return [
    {
      name: "beads_projects",
      description:
        "List the registered keelson projects that carry a beads (.beads) tracker — the projects every other beads_* tool can target.",
      inputSchema: z.object({}),
      execute: guarded(async (_input, ctx) => {
        const projects = deps.beadsProjects();
        emitText(ctx, JSON.stringify(projects, null, 1));
      }),
    },
    {
      name: "beads_status",
      description:
        "Backlog KPI summary from `bd status`: open / ready / blocked / in-progress / closed counts for one beads project.",
      inputSchema: z.object({ project: projectArg }),
      execute: guarded((input, ctx) => {
        const { project } = input as { project?: string };
        return read(ctx, project, ["status"]);
      }),
    },
    {
      name: "beads_ready",
      description:
        "The dependency-ready work queue (`bd ready`, epics excluded): what can start right now. Rows carry dependent_count — a high count is leverage, finishing that bead unblocks the most downstream work.",
      inputSchema: z.object({
        project: projectArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Cap the rows returned (default all)."),
      }),
      execute: guarded((input, ctx) => {
        const { project, limit } = input as { project?: string; limit?: number };
        return read(ctx, project, ["ready", "--exclude-type=epic", "--limit", String(limit ?? 0)]);
      }),
    },
    {
      name: "beads_blocked",
      description:
        "Dependency-blocked issues (`bd blocked`) with blocked_by naming what each waits on. NOTE: manually status-blocked issues are a separate population — query beads_list with status 'blocked' for those; the true blocked set is the union.",
      inputSchema: z.object({ project: projectArg }),
      execute: guarded((input, ctx) => {
        const { project } = input as { project?: string };
        return read(ctx, project, ["blocked"]);
      }),
    },
    {
      name: "beads_show",
      description:
        "Full detail for one bead (`bd show --include-dependents`): description, acceptance criteria, notes, dependencies and dependents. Returns a single-element array.",
      inputSchema: z.object({
        id: z.string().describe("The bead id, e.g. tl-2tc."),
        project: projectArg,
      }),
      execute: guarded((input, ctx) => {
        const { id, project } = input as { id: string; project?: string };
        return read(ctx, project, ["show", id, "--include-dependents"]);
      }),
    },
    {
      name: "beads_list",
      description:
        "Query beads with filters (`bd list`). Statuses: open, in_progress, blocked, deferred, closed. Types: bug, task, feature, epic, chore, decision.",
      inputSchema: z.object({
        project: projectArg,
        status: z.string().optional(),
        assignee: z.string().optional(),
        label: z.string().optional(),
        type: z.string().optional(),
        limit: z.number().int().min(0).max(1000).optional().describe("0 = unlimited (default)."),
      }),
      execute: guarded((input, ctx) => {
        const { project, status, assignee, label, type, limit } = input as {
          project?: string;
          status?: string;
          assignee?: string;
          label?: string;
          type?: string;
          limit?: number;
        };
        const args = ["list", "--limit", String(limit ?? 0)];
        if (status) args.push("--status", status);
        if (assignee) args.push("--assignee", assignee);
        if (label) args.push("--label", label);
        if (type) args.push("--type", type);
        return read(ctx, project, args);
      }),
    },
    {
      name: "beads_epics",
      description:
        "Epic completion (`bd epic status`): closed/total children per epic and whether an epic is eligible to close.",
      inputSchema: z.object({ project: projectArg }),
      execute: guarded((input, ctx) => {
        const { project } = input as { project?: string };
        return read(ctx, project, ["epic", "status"]);
      }),
    },
    {
      name: "beads_stale",
      description:
        "Issues untouched for N days (`bd stale`) — claimed-but-silent in_progress work is bookkeeping to verify, not proof of work.",
      inputSchema: z.object({
        project: projectArg,
        days: z.number().int().min(1).max(365).optional().describe("Default 7."),
        status: z.enum(["open", "in_progress", "blocked", "deferred"]).optional(),
      }),
      execute: guarded((input, ctx) => {
        const { project, days, status } = input as {
          project?: string;
          days?: number;
          status?: string;
        };
        const args = ["stale", "--days", String(days ?? 7)];
        if (status) args.push("-s", status);
        return read(ctx, project, args);
      }),
    },
    {
      name: "beads_create",
      description:
        "Create a bead (`bd create`). Convention: no one-liner beads — batch trivia; the sweet spot is 1–4 hours of work. Research work becomes its own bead that the implementation beads depend on.",
      inputSchema: z.object({
        project: projectArg,
        title: z.string(),
        description: z.string().optional(),
        type: z
          .enum(["bug", "task", "feature", "epic", "chore"])
          .optional()
          .describe("Default task."),
        priority: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe("0 fire … 4 backlog. Default 2."),
        assignee: z.string().optional(),
        labels: z.array(z.string()).optional(),
        deps: z
          .array(z.string())
          .optional()
          .describe("Dependencies as 'id' or 'type:id', e.g. ['tl-20', 'blocks:tl-15']."),
      }),
      state_changing: true,
      execute: guarded((input, ctx) => {
        const { project, title, description, type, priority, assignee, labels, deps } = input as {
          project?: string;
          title: string;
          description?: string;
          type?: string;
          priority?: number;
          assignee?: string;
          labels?: string[];
          deps?: string[];
        };
        const args = [
          "create",
          title,
          "--type",
          type ?? "task",
          "--priority",
          String(priority ?? 2),
        ];
        if (description) args.push("--description", description);
        if (assignee) args.push("--assignee", assignee);
        for (const label of labels ?? []) args.push("--label", label);
        if (deps?.length) args.push("--deps", deps.join(","));
        return mutate(ctx, project, args);
      }),
    },
    {
      name: "beads_update",
      description:
        "Update a bead (`bd update`): claim it (atomic assignee+in_progress), change status/priority/assignee, or append a note. Release a claim by setting status back to 'open'.",
      inputSchema: z.object({
        project: projectArg,
        id: z.string(),
        claim: z
          .boolean()
          .optional()
          .describe("Atomically claim: assignee = you, status = in_progress."),
        status: z.enum(["open", "in_progress", "blocked", "deferred"]).optional(),
        priority: z.number().int().min(0).max(4).optional(),
        assignee: z.string().optional(),
        appendNotes: z
          .string()
          .optional()
          .describe("Appended to the bead's notes with a separator."),
      }),
      state_changing: true,
      execute: guarded((input, ctx) => {
        const { project, id, claim, status, priority, assignee, appendNotes } = input as {
          project?: string;
          id: string;
          claim?: boolean;
          status?: string;
          priority?: number;
          assignee?: string;
          appendNotes?: string;
        };
        const args = ["update", id];
        if (claim) args.push("--claim");
        if (status) args.push("--status", status);
        if (priority !== undefined) args.push("--priority", String(priority));
        if (assignee) args.push("--assignee", assignee);
        if (appendNotes) args.push("--append-notes", appendNotes);
        if (args.length === 2) {
          emitText(
            ctx,
            "beads_update: nothing to change — pass claim, status, priority, assignee, or appendNotes.",
            true,
          );
          return Promise.resolve();
        }
        return mutate(ctx, project, args);
      }),
    },
    {
      name: "beads_close",
      description:
        "Close a bead with a reason (`bd close`). Convention: closing is a merge-time action — a bead whose change is still in review stays in_progress. A task closed with its reasoning is a decision record, so the reason matters.",
      inputSchema: z.object({
        project: projectArg,
        id: z.string(),
        reason: z.string().describe("Why this is done — becomes the decision record."),
      }),
      state_changing: true,
      requires_confirmation: true,
      execute: guarded((input, ctx) => {
        const { project, id, reason } = input as { project?: string; id: string; reason: string };
        return mutate(ctx, project, ["close", id, "--reason", reason]);
      }),
    },
    {
      name: "beads_sync_merged",
      description:
        "Preview merged PRs recorded on open or in-progress beads; with confirm: true, close them with their verified PR URL as the reason. Returns per-bead results.",
      inputSchema: z.object({
        project: projectArg,
        confirm: z
          .boolean()
          .optional()
          .describe("Only true permits closing beads; omitted is read-only."),
      }),
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const { project, confirm } = input as { project?: string; confirm?: boolean };
        const resolved = resolveProject(deps, project);
        if (!resolved.ok) return emitText(ctx, resolved.error, true);
        const report = await deps.syncMerged(resolved.project, confirm === true);
        emitText(
          ctx,
          JSON.stringify(report, null, 1),
          Boolean(report.error || report.results.some((entry) => entry.status === "error")),
        );
      }),
    },
    {
      name: "beads_dep",
      description:
        "Link two beads (`bd dep add`): the first argument depends on (waits for) the second. Parent-child epic links are structure, not sequence — use dependencies only for real ordering.",
      inputSchema: z.object({
        project: projectArg,
        id: z.string().describe("The bead that waits."),
        dependsOn: z.string().describe("The bead it waits for."),
      }),
      state_changing: true,
      execute: guarded((input, ctx) => {
        const { project, id, dependsOn } = input as {
          project?: string;
          id: string;
          dependsOn: string;
        };
        return mutate(ctx, project, ["dep", "add", id, dependsOn]);
      }),
    },
    {
      name: "beads_board_refresh",
      description:
        "Recompose the Beads backlog board snapshot now instead of waiting for its refresh cadence. Read-only: re-measures with bd and republishes.",
      inputSchema: z.object({}),
      execute: guarded(async (_input, ctx) => {
        deps.refreshBoard();
        emitText(ctx, "Board recompose requested.");
      }),
    },
  ];
}
