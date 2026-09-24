import { describe, expect, test } from "bun:test";
import type { RibExec } from "@keelson/shared";
import type { BeadsProject } from "../src/bd";
import { canonicalPrUrl, GhClient, isMergedPR, rollupChecks } from "../src/pr";

const project: BeadsProject = { id: "p", name: "Project", rootPath: "/repo" };
const url = "https://github.com/acme/demo/pull/42";

function reader(response: unknown, calls: unknown[][]) {
  const exec = {
    runJSON: async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, data: response };
    },
  } as unknown as RibExec;
  return new GhClient(exec);
}

describe("GitHub PR evidence", () => {
  test("a MERGED PR with a timestamp and exact dotted Bead line is authoritative", async () => {
    const calls: unknown[][] = [];
    const result = await reader(
      { url, state: "MERGED", mergedAt: "2026-09-22T01:02:03Z", body: "- **Bead:** `cos-hjf.1`" },
      calls,
    ).readPR(project, `${url}/`, "cos-hjf.1");
    expect(result).toEqual({
      ok: true,
      data: { url, state: "MERGED", mergedAt: "2026-09-22T01:02:03Z" },
    });
    if (result.ok) expect(isMergedPR(result.data)).toBe(true);
    expect(calls).toEqual([
      [
        "gh",
        [
          "pr",
          "view",
          url,
          "--json",
          "url,state,mergedAt,body,isDraft,reviewDecision,statusCheckRollup",
        ],
        { cwd: "/repo", timeoutMs: 30_000 },
      ],
    ]);
  });

  test("an open PR carries its draft, review and CI state when gh reports them", async () => {
    const result = await reader(
      {
        url,
        state: "OPEN",
        mergedAt: null,
        body: "Bead: cos-hjf.1",
        isDraft: true,
        reviewDecision: "CHANGES_REQUESTED",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      [],
    ).readPR(project, url, "cos-hjf.1");
    expect(result).toEqual({
      ok: true,
      data: {
        url,
        state: "OPEN",
        mergedAt: null,
        draft: true,
        review: "changes requested",
        checks: "passing",
      },
    });
  });

  test("CI rolls up to the worst check: failing beats pending beats passing", () => {
    expect(rollupChecks(undefined)).toBeUndefined();
    expect(rollupChecks([])).toBeUndefined();
    expect(rollupChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("passing");
    expect(
      rollupChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: "" },
      ]),
    ).toBe("pending");
    expect(
      rollupChecks([
        { status: "IN_PROGRESS", conclusion: "" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failing");
    expect(rollupChecks([{ state: "SUCCESS" }])).toBe("passing");
    expect(rollupChecks([{ state: "PENDING" }])).toBe("pending");
  });

  test.each(["OPEN", "CLOSED"] as const)("a %s PR without a merge is not merged", async (state) => {
    const result = await reader({ url, state, mergedAt: null, body: "" }, []).readPR(
      project,
      url,
      "cos-hjf.1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(isMergedPR(result.data)).toBe(false);
  });

  test.each([
    "**Bead:** `cos-hjf.1` — Reconcile merged PR closures",
    "- **Bead**: cos-hjf.1 — Reconcile merged PR closures",
    "Bead: cos-hjf.1 (Reconcile merged PR closures)",
  ])("accepts the workflow's id-and-title Bead line: %s", async (body) => {
    const result = await reader(
      { url, state: "MERGED", mergedAt: "2026-09-22T01:02:03Z", body },
      [],
    ).readPR(project, url, "cos-hjf.1");
    expect(result.ok).toBe(true);
  });

  test("legacy PRs without a Bead line remain linked", async () => {
    const result = await reader(
      { url, state: "MERGED", mergedAt: "2026-09-22T01:02:03Z", body: "A change" },
      [],
    ).readPR(project, url, "cos-hjf.1");
    expect(result.ok).toBe(true);
  });

  test("deduplicates a shared URL but checks each bead's association independently", async () => {
    const calls: unknown[][] = [];
    const results = await reader(
      { url, state: "MERGED", mergedAt: "2026-09-22T01:02:03Z", body: "Bead: cos-hjf.1" },
      calls,
    ).readPRs(project, [
      { id: "cos-hjf.1", prUrl: url },
      { id: "cos-hjf.2", prUrl: `${url}/` },
    ]);
    expect(results["cos-hjf.1"]?.ok).toBe(true);
    expect(results["cos-hjf.2"]?.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test.each([
    { url, state: "MERGED", mergedAt: null, body: "" },
    { url, state: "CLOSED", mergedAt: "2026-09-22T01:02:03Z", body: "" },
    { url, state: "MERGED", mergedAt: "invalid", body: "" },
    { url, state: "UNKNOWN", mergedAt: null, body: "" },
    {
      url: "https://github.com/acme/demo/pull/41",
      state: "MERGED",
      mergedAt: "2026-09-22T01:02:03Z",
      body: "",
    },
    { url, state: "MERGED", mergedAt: "2026-09-22T01:02:03Z", body: "**Bead:** `cos-hjf.10`" },
    { url, state: "MERGED", mergedAt: "2026-09-22T01:02:03Z", body: "**Bead:** " },
    {
      url,
      state: "MERGED",
      mergedAt: "2026-09-22T01:02:03Z",
      body: "**Bead:** `cos-hjf.10` — Reconcile merged PR closures",
    },
    {
      url,
      state: "MERGED",
      mergedAt: "2026-09-22T01:02:03Z",
      body: "Bead: cos-hjf.1 — first\nBead: cos-hjf.2 — second",
    },
    {
      url,
      state: "MERGED",
      mergedAt: "2026-09-22T01:02:03Z",
      body: "Bead: cos-hjf.1\nBead: cos-hjf.2",
    },
  ])("rejects inconsistent responses and mismatched associations", async (response) => {
    const result = await reader(response, []).readPR(project, url, "cos-hjf.1");
    expect(result.ok).toBe(false);
  });

  test.each([
    "http://github.com/acme/demo/pull/42",
    "https://github.com/acme/demo/issues/42",
    "https://github.com/acme/demo/pull/42?foo=bar",
    "https://github.com.evil.test/acme/demo/pull/42",
    "none",
  ])("rejects malformed or untrusted URLs before running gh: %s", async (bad) => {
    const calls: unknown[][] = [];
    expect(canonicalPrUrl(bad).ok).toBe(false);
    expect((await reader({}, calls).readPR(project, bad, "cos-hjf.1")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("surfaces gh auth, rate-limit and timeout failures", async () => {
    for (const reason of ["not authenticated", "rate limit", "timeout"]) {
      const exec = {
        runJSON: async () => ({ ok: false, error: reason }),
      } as unknown as RibExec;
      expect(await new GhClient(exec).readPR(project, url, "cos-hjf.1")).toEqual({
        ok: false,
        error: `gh pr view ${url}: ${reason}`,
      });
    }
  });
});
