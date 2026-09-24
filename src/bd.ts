// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project, RibExec } from "@keelson/shared";

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

export type BdVersion = { version: string; supported: boolean };

export function parseBdVersion(raw: unknown): BdVersion | undefined {
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version !== "string") return undefined;
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!parts) return undefined;
  const have = parts.slice(1, 4).map(Number);
  let supported = true;
  for (let k = 0; k < BD_VERSION_FLOOR.length; k++) {
    const a = have[k] ?? 0;
    const b = BD_VERSION_FLOOR[k] ?? 0;
    if (a !== b) {
      supported = a > b;
      break;
    }
  }
  return { version: version.trim(), supported };
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
