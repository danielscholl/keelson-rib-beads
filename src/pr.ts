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

const prSchema = z.object({
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedAt: z.string().datetime({ offset: true }).nullable(),
  body: z.string(),
});

export type PrInfo = Pick<z.infer<typeof prSchema>, "url" | "state" | "mergedAt">;

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

function beadLineError(body: string, beadId: string): string | undefined {
  const lines = [
    ...body.matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?Bead\s*(?:\*\*)?\s*:\s*(?:\*\*)?(.+)$/gim),
  ];
  if (lines.length === 0) return undefined;
  const ids = lines.map((match) =>
    (match[1] ?? "")
      .trim()
      .replace(/^`|`$|\*\*$/g, "")
      .trim(),
  );
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
    const recorded = canonicalPrUrl(prUrl);
    if (!recorded.ok) return recorded;
    const res = await this.exec.runJSON<unknown>(
      "gh",
      ["pr", "view", recorded.data, "--json", "url,state,mergedAt,body"],
      { cwd: project.rootPath, timeoutMs: 30_000 },
    );
    if (!res.ok) return unmeasured(`gh pr view ${recorded.data}: ${res.error}`);
    const parsed = prSchema.safeParse(res.data);
    if (!parsed.success) return unmeasured(`Invalid gh PR response for ${recorded.data}`);
    const actual = canonicalPrUrl(parsed.data.url);
    if (!actual.ok || actual.data !== recorded.data) {
      return unmeasured(`gh PR identity does not match ${recorded.data}`);
    }
    if ((parsed.data.state === "MERGED") !== (parsed.data.mergedAt !== null)) {
      return unmeasured(`Inconsistent merge state for ${recorded.data}`);
    }
    const mismatch = beadLineError(parsed.data.body, beadId);
    if (mismatch) return unmeasured(mismatch);
    return {
      ok: true,
      data: { url: actual.data, state: parsed.data.state, mergedAt: parsed.data.mergedAt },
    };
  }
}
