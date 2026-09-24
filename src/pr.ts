// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibExec } from "@keelson/shared";
import { z } from "zod";
import type { BeadsProject, Measured } from "./bd";
import { unmeasured } from "./bd";
import { BEAD_ID_PATTERN } from "./bead-id";

const checkSchema = z.object({
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
});

const prSchema = z.object({
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().datetime({ offset: true }).nullable(),
  body: z.string(),
  isDraft: z.boolean().optional(),
  reviewDecision: z.string().nullish(),
  statusCheckRollup: z.array(checkSchema).nullish(),
});

type PrResponse = z.infer<typeof prSchema>;
export type PrChecks = "passing" | "failing" | "pending";
export type PrInfo = Pick<z.infer<typeof prSchema>, "url" | "state" | "mergedAt"> & {
  draft?: boolean;
  review?: "approved" | "changes requested" | "review required";
  checks?: PrChecks;
};

// A check run reports status + conclusion; a legacy commit status reports state.
export function rollupChecks(
  rollup: readonly z.infer<typeof checkSchema>[] | null | undefined,
): PrChecks | undefined {
  if (!rollup?.length) return undefined;
  let pending = false;
  for (const c of rollup) {
    const outcome = (c.conclusion ?? c.state ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(outcome))
      return "failing";
    const done = c.status ? c.status.toUpperCase() === "COMPLETED" : outcome !== "PENDING";
    if (!done || outcome === "" || outcome === "PENDING") pending = true;
  }
  return pending ? "pending" : "passing";
}

function reviewOf(decision: string | null | undefined): PrInfo["review"] {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes requested";
  if (decision === "REVIEW_REQUIRED") return "review required";
  return undefined;
}

export function canonicalPrUrl(value: string): Measured<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return unmeasured(`Invalid PR URL: ${value}`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/[a-z\d_.-]+\/[a-z\d_.-]+\/pull\/[1-9]\d*\/?$/i.test(url.pathname)
  ) {
    return unmeasured(`Invalid GitHub PR URL: ${value}`);
  }
  return { ok: true, data: `${url.origin}${url.pathname.replace(/\/$/, "")}` };
}

// The workflow writes `Bead: <id> — <title>`; only the leading id identifies the bead.
const LEADING_BEAD_ID = new RegExp(
  `^(?:\\*\\*)?\`?(${BEAD_ID_PATTERN})\`?(?:\\*\\*)?(?=$|[\\s,:;(])`,
);

function beadLineError(body: string, beadId: string): string | undefined {
  const lines = [
    ...body.matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?Bead\s*(?:\*\*)?\s*:\s*(?:\*\*)?(.*)$/gim),
  ];
  if (lines.length === 0) return undefined;
  const ids = lines.map((match) => {
    const value = (match[1] ?? "").trim();
    return LEADING_BEAD_ID.exec(value)?.[1] ?? value;
  });
  if (ids.length !== 1 || ids[0] !== beadId) {
    return `PR Bead line does not identify ${beadId} exactly: ${ids.join(", ")}`;
  }
  return undefined;
}

export function isMergedPR(pr: PrInfo): pr is PrInfo & { state: "MERGED"; mergedAt: string } {
  return pr.state === "MERGED" && pr.mergedAt !== null;
}

export class GhClient {
  constructor(private readonly exec: RibExec) {}

  async readPR(project: BeadsProject, prUrl: string, beadId: string): Promise<Measured<PrInfo>> {
    return this.readWithCache(project, prUrl, beadId, new Map());
  }

  async readPRs(
    project: BeadsProject,
    links: readonly { id: string; prUrl: string }[],
  ): Promise<Record<string, Measured<PrInfo>>> {
    const cache = new Map<string, Promise<Measured<PrResponse>>>();
    const results: Record<string, Measured<PrInfo>> = {};
    for (const { id, prUrl } of links) {
      results[id] = await this.readWithCache(project, prUrl, id, cache);
    }
    return results;
  }

  private async readWithCache(
    project: BeadsProject,
    prUrl: string,
    beadId: string,
    cache: Map<string, Promise<Measured<PrResponse>>>,
  ): Promise<Measured<PrInfo>> {
    const recorded = canonicalPrUrl(prUrl);
    if (!recorded.ok) return recorded;
    let pending = cache.get(recorded.data);
    if (!pending) {
      pending = this.fetchPR(project, recorded.data);
      cache.set(recorded.data, pending);
    }
    const response = await pending;
    if (!response.ok) return response;
    const mismatch = beadLineError(response.data.body, beadId);
    if (mismatch) return unmeasured(mismatch);
    const checks = rollupChecks(response.data.statusCheckRollup);
    const review = reviewOf(response.data.reviewDecision);
    return {
      ok: true,
      data: {
        url: recorded.data,
        state: response.data.state,
        mergedAt: response.data.mergedAt,
        ...(response.data.isDraft ? { draft: true } : {}),
        ...(review ? { review } : {}),
        ...(checks ? { checks } : {}),
      },
    };
  }

  private async fetchPR(project: BeadsProject, url: string): Promise<Measured<PrResponse>> {
    const res = await this.exec.runJSON<unknown>(
      "gh",
      [
        "pr",
        "view",
        url,
        "--json",
        "url,state,mergedAt,body,isDraft,reviewDecision,statusCheckRollup",
      ],
      { cwd: project.rootPath, timeoutMs: 30_000 },
    );
    if (!res.ok) return unmeasured(`gh pr view ${url}: ${res.error}`);
    const parsed = prSchema.safeParse(res.data);
    if (!parsed.success) return unmeasured(`Invalid gh PR response for ${url}`);
    const actual = canonicalPrUrl(parsed.data.url);
    if (!actual.ok || actual.data !== url) {
      return unmeasured(`gh PR identity does not match ${url}`);
    }
    if ((parsed.data.state === "MERGED") !== (parsed.data.mergedAt !== null)) {
      return unmeasured(`Inconsistent merge state for ${url}`);
    }
    return { ok: true, data: parsed.data };
  }
}
