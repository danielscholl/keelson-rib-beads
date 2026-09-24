// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { BdClient, BeadsProject } from "./bd";
import {
  collectRecordedPRs,
  eligibleBeads,
  fetchIssue,
  parseRunNote,
  readBacklog,
} from "./measure";
import { canonicalPrUrl, type GhClient, isMergedPR } from "./pr";

export type SyncResult =
  | { id: string; status: "would_close" | "closed"; prUrl: string; mergedAt: string }
  | { id: string; status: "skipped" | "error"; reason: string };

export interface SyncReport {
  results: SyncResult[];
  error?: string;
}

export async function syncMergedPRs(
  bd: BdClient,
  gh: GhClient,
  project: BeadsProject,
  options: { confirm: boolean },
): Promise<SyncReport> {
  const cwd = project.rootPath;
  const backlog = await readBacklog(bd, cwd);
  if (!backlog.ok) return { results: [], error: `bd list: ${backlog.error}` };
  const { runInfo, prInfo } = await collectRecordedPRs(bd, gh, project, backlog);
  if (!runInfo.ok || !prInfo.ok) {
    return { results: [], error: !runInfo.ok ? runInfo.error : !prInfo.ok ? prInfo.error : "" };
  }

  const results: SyncResult[] = [];
  for (const bead of eligibleBeads(backlog.data)) {
    const run = runInfo.data[bead.id];
    const pr = prInfo.data[bead.id];
    if (!run || !pr || !run.ok || !pr.ok) {
      results.push({
        id: bead.id,
        status: "error",
        reason: !run
          ? "Run note missing"
          : !run.ok
            ? run.error
            : !pr
              ? "PR lookup missing"
              : !pr.ok
                ? pr.error
                : "PR lookup inconsistent",
      });
      continue;
    }
    if (!run.data || !pr.data) {
      results.push({ id: bead.id, status: "skipped", reason: "No recorded PR" });
      continue;
    }
    if (!isMergedPR(pr.data)) {
      results.push({
        id: bead.id,
        status: "skipped",
        reason: `PR is ${pr.data.state}, not merged`,
      });
      continue;
    }
    const { url, mergedAt } = pr.data;
    // A preview should describe what the confirmed path would do now, not
    // what a stale backlog row suggested before the per-bead read.
    const current = await fetchIssue(bd, cwd, bead.id);
    if (!current.ok) {
      results.push({ id: bead.id, status: "error", reason: current.error });
      continue;
    }
    if (current.data.status !== "open" && current.data.status !== "in_progress") {
      results.push({
        id: bead.id,
        status: "skipped",
        reason: `Status changed to ${current.data.status}`,
      });
      continue;
    }
    const currentUrl = parseRunNote(current.data.notes)?.prUrl;
    const currentLink = currentUrl ? canonicalPrUrl(currentUrl) : undefined;
    if (!currentLink?.ok || currentLink.data !== url) {
      results.push({ id: bead.id, status: "skipped", reason: "Recorded PR changed" });
      continue;
    }
    if (!options.confirm) {
      results.push({ id: bead.id, status: "would_close", prUrl: url, mergedAt });
      continue;
    }
    const close = await bd.mutate(cwd, ["close", bead.id, "--reason", `Merged via ${url}`]);
    if (!close.ok) {
      results.push({ id: bead.id, status: "error", reason: `bd close: ${close.error}` });
      continue;
    }
    const after = await fetchIssue(bd, cwd, bead.id);
    if (!after.ok || after.data.status !== "closed") {
      results.push({
        id: bead.id,
        status: "error",
        reason: after.ok ? `bd close did not close bead (${after.data.status})` : after.error,
      });
      continue;
    }
    results.push({ id: bead.id, status: "closed", prUrl: url, mergedAt });
  }
  return { results };
}
