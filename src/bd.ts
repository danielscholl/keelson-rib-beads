// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, RibExec } from "@keelson/shared";
import { z } from "zod";

// A measurement either happened or it didn't. Rendering must be able to tell
// "the query failed" from "there is nothing there" at a glance, so a failed
// bd call never collapses into an empty-but-healthy value.
export type Measured<T> = { ok: true; data: T } | { ok: false; error: string };

export function unmeasured<T>(error: string): Measured<T> {
  return { ok: false, error };
}

// The subset of a bd issue row this rib reads. bd carries more; unknown
// fields pass through untyped rather than being modeled speculatively.
export interface BdIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type?: string;
  assignee?: string;
  owner?: string;
  created_at?: string;
  created_by?: string;
  updated_at?: string;
  // Written by bd from 1.2 on; older claims have none, and updated_at is no
  // substitute because it moves on any edit.
  started_at?: string;
  closed_at?: string;
  close_reason?: string;
  labels?: string[];
  dependency_count?: number;
  dependent_count?: number;
  blocked_by?: string[];
  // Epic membership as `bd list` reports it — the parent's id on the child row.
  parent?: string;
  description?: string;
  acceptance_criteria?: string;
  notes?: string;
  comment_count?: number;
  // `bd show --include-dependents` carries linked issues; `bd list` carries
  // edge records or null. Both shapes are tolerated at the read site.
  dependencies?: readonly BdLinked[] | null;
  dependents?: readonly BdLinked[] | null;
}

export interface BdComment {
  author?: string;
  text: string;
  created_at?: string;
}

export interface BdLinked {
  id?: string;
  issue_id?: string;
  depends_on_id?: string;
  title?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  type?: string;
  // "blocks" or "parent-child" — the latter is epic membership.
  dependency_type?: string;
}

// The oldest bd that answers every query the rib sends: `bd show
// --include-dependents` arrived in 1.2.0.
export const BD_VERSION_FLOOR = [1, 2, 0] as const;

// From 1.3.0 a `bd list` row carries notes and the parent edge (omitted when
// empty), so a sweep reads run notes and epic membership off the list instead
// of one `bd show` per bead. Older bd keeps the per-bead reads.
export const BD_FULL_ROWS = [1, 3, 0] as const;

export type BdVersion = { version: string; supported: boolean; fullRows?: boolean };

function atLeast(have: readonly number[], floor: readonly number[]): boolean {
  for (let k = 0; k < floor.length; k++) {
    const a = have[k] ?? 0;
    const b = floor[k] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function parseBdVersion(raw: unknown): BdVersion | undefined {
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version !== "string") return undefined;
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!parts) return undefined;
  const have = parts.slice(1, 4).map(Number);
  return {
    version: version.trim(),
    supported: atLeast(have, BD_VERSION_FLOOR),
    fullRows: atLeast(have, BD_FULL_ROWS),
  };
}

export const bdFloorLabel = (): string => `${BD_VERSION_FLOOR[0]}.${BD_VERSION_FLOOR[1]}+`;

// What a bead-work run reported about a bead, read from the notes convention
// (`bead-work run: PR <url|#number|unknown|none> — <outcome> — <free text>`). The join to live
// runs is the note line, not a run id: bead-work writes it at completion, so
// this names the PR and how the run ended — nothing more is claimed.
export interface BeadRunInfo {
  prUrl?: string;
  prState?: "number-only" | "unknown" | "none";
  prNumber?: string;
  outcome?: string;
  note?: string;
  // The run that wrote the note, when the note names it.
  runId?: string;
}

// `bd epic status --json` nests the epic under an `epic` key with the child
// counters as siblings (beads-ui ships the same flattening).
export interface BdEpicRow {
  epic: BdIssue;
  total_children: number;
  closed_children: number;
  eligible_for_close: boolean;
}

export interface BdSummary {
  total_issues: number;
  open_issues: number;
  ready_issues: number;
  blocked_issues: number;
  in_progress_issues: number;
  closed_issues: number;
  deferred_issues?: number;
  epics_eligible_for_closure?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const initEnv = { BD_DISABLE_METRICS: "1", OTEL_SDK_DISABLED: "true" };
const prefixSchema = z.object({ key: z.literal("issue_prefix"), value: z.string().trim().min(1) });
const count = z.number().int().nonnegative();
const statusSchema = z
  .object({
    summary: z
      .object({
        total_issues: count,
        open_issues: count,
        ready_issues: count,
        blocked_issues: count,
        in_progress_issues: count,
        closed_issues: count,
        deferred_issues: count.optional(),
        epics_eligible_for_closure: count.optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface BdInitResult {
  result: "initialized" | "existing";
  project: { id: string; name: string };
  path: string;
  prefix: string;
  status: { summary: BdSummary };
}

// A keelson project whose repository carries a beads tracker.
export interface BeadsProject {
  id: string;
  name: string;
  rootPath: string;
}

export function discoverBeadsProjects(projects: readonly Project[]): BeadsProject[] {
  return projects
    .filter((p) => existsSync(join(p.rootPath, ".beads")))
    .map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath }));
}

export function resolveRegisteredProject(
  projects: readonly Project[] | undefined,
  selector: string,
): Measured<BeadsProject> {
  if (!selector.trim()) return unmeasured("A registered project name or ID is required.");
  if (!projects?.length) return unmeasured("No registered keelson projects are available.");
  const byId = projects.find((project) => project.id === selector);
  const matches = byId ? [byId] : projects.filter((project) => project.name === selector);
  if (matches.length === 0) {
    return unmeasured(
      `No registered keelson project matches '${selector}'. Use a name or ID, not a path.`,
    );
  }
  if (matches.length > 1) {
    return unmeasured(
      `Several registered projects are named '${selector}'. Use an exact project ID.`,
    );
  }
  const project = matches[0]!;
  return { ok: true, data: { id: project.id, name: project.name, rootPath: project.rootPath } };
}

// One serialized bd runner. Concurrent bd processes crash Dolt's embedded
// mode (a beads-ui production learning), so every call — reads and writes,
// across all projects — funnels through a single promise chain.
export class BdClient {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly exec: RibExec) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => fn();
    const next = this.tail.then(run, run);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  init(project: BeadsProject, prefix?: string): Promise<Measured<BdInitResult>> {
    return this.enqueue(async () => {
      const cwd = realpathSync(project.rootPath);
      const path = join(cwd, ".beads");
      const opts = { cwd, timeoutMs: DEFAULT_TIMEOUT_MS, env: initEnv };
      const metadata = async (result: BdInitResult["result"]): Promise<Measured<BdInitResult>> => {
        if (!existsSync(path) || !statSync(path).isDirectory()) {
          return unmeasured("bd init did not produce a .beads directory.");
        }
        const config = await this.exec.runJSON<unknown>(
          "bd",
          ["--sandbox", "config", "get", "issue_prefix", "--json"],
          opts,
        );
        if (!config.ok) return unmeasured(`prefix read failed: ${config.error}`);
        const actualPrefix = prefixSchema.safeParse(config.data);
        if (!actualPrefix.success) return unmeasured("bd config returned no valid issue_prefix.");
        const status = await this.exec.runJSON<unknown>(
          "bd",
          ["--sandbox", "status", "--json"],
          opts,
        );
        if (!status.ok) return unmeasured(`status read failed: ${status.error}`);
        const measuredStatus = statusSchema.safeParse(status.data);
        if (!measuredStatus.success) return unmeasured("bd status returned no valid summary.");
        return {
          ok: true,
          data: {
            result,
            project: { id: project.id, name: project.name },
            path,
            prefix: actualPrefix.data.value,
            status: measuredStatus.data,
          },
        };
      };

      if (existsSync(path)) return metadata("existing");
      if (prefix !== undefined && !prefix.trim()) return unmeasured("Prefix must be nonempty.");
      const top = await this.exec.runText("git", ["rev-parse", "--show-toplevel"], opts);
      if (!top.ok) return unmeasured(`Git precondition failed: ${top.error}`);
      if (realpathSync(top.data.trim()) !== cwd) {
        return unmeasured("The registered project root must be the Git repository's top level.");
      }
      const tree = await this.exec.runText("git", ["status", "--porcelain"], opts);
      if (!tree.ok) return unmeasured(`Git status failed: ${tree.error}`);
      if (tree.data.length) {
        return unmeasured("Initialization requires a clean Git working tree and index.");
      }
      // A successful empty read with exit 1 means this repository has no commit yet.
      const head = await this.exec.runText("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
        ...opts,
        acceptNonZeroExit: true,
      });
      if (!head.ok || (head.exitCode !== undefined && head.exitCode !== 0 && head.exitCode !== 1)) {
        return unmeasured(`Git HEAD read failed: ${head.ok ? head.data : head.error}`);
      }
      const ignorePath = join(cwd, ".gitignore");
      let ignore: Buffer | undefined;
      try {
        ignore = readFileSync(ignorePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const args = ["init", "--quiet", "--skip-agents", "--skip-hooks", "--non-interactive"];
      if (prefix !== undefined) args.push("--prefix", prefix);
      let failure: string;
      try {
        const initialized = await this.exec.runText("bd", args, opts);
        const measured = initialized.ok
          ? await metadata("initialized")
          : unmeasured<BdInitResult>(`bd init failed: ${initialized.error}`);
        if (measured.ok) return measured;
        failure = measured.error;
      } catch (error) {
        failure = `bd init failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      const after = await this.exec.runText("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
        ...opts,
        acceptNonZeroExit: true,
      });
      if (
        !after.ok ||
        (after.exitCode !== undefined && after.exitCode !== 0 && after.exitCode !== 1)
      ) {
        failure += ` Git commit state could not be read: ${after.ok ? after.data : after.error}`;
      } else if (after.data.trim() && after.data.trim() !== head.data.trim()) {
        failure += ` bd init made commit ${after.data.trim()}; history was not rewritten.`;
      } else {
        rmSync(path, { recursive: true, force: true });
        if (ignore === undefined) rmSync(ignorePath, { force: true });
        else writeFileSync(ignorePath, ignore);
      }
      return unmeasured(failure);
    });
  }

  // Read-only query. `--sandbox` disables Dolt auto-push so an interactive
  // read never blocks on a network sync. bd prints `[]` (exit 0) for an
  // empty result set, so ok:false here always means the query itself failed.
  readJSON<T>(cwd: string, args: string[]): Promise<Measured<T>> {
    return this.enqueue(async () => {
      const res = await this.exec.runJSON<T>("bd", ["--sandbox", ...args, "--json"], {
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!res.ok) return unmeasured<T>(res.error);
      return { ok: true as const, data: res.data };
    });
  }

  // Mutation. No `--sandbox`: whether a write syncs is the project's
  // .beads/config.yaml decision, not this rib's.
  mutate(cwd: string, args: string[]): Promise<Measured<string>> {
    return this.enqueue(async () => {
      const res = await this.exec.runText("bd", args, {
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!res.ok) return unmeasured<string>(res.error);
      return { ok: true as const, data: res.data };
    });
  }
}
