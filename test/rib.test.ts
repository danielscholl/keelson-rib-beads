import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { columnRegions } from "@keelson/shared";
import rib from "../src/index";
import {
  ALL_KEYS,
  ATTENTION_KEY,
  INSPECT_KEY,
  MOMENTUM_KEY,
  PLAN_KEY,
  PORTFOLIO_KEY,
  PULSE_KEY,
  RECOMMEND_KEY,
  WIP_KEY,
} from "../src/keys";

describe("rib contract shape", () => {
  test("id and displayName satisfy the contract", () => {
    expect(rib.id).toBe("beads");
    expect(rib.displayName).toBe("Beads");
  });

  test("every published key lives under the rib namespace", () => {
    for (const view of rib.views ?? []) {
      expect(view.key.startsWith("rib:beads")).toBe(true);
    }
  });

  test("the surface lays out the operator's order", () => {
    const surface = rib.surfaces?.[0];
    expect(surface?.id).toBe("beads");
    expect(surface?.layout.header?.key).toBe(PULSE_KEY);
    // Since @keelson/shared 0.103.0 a column is one region or a stack of
    // them; `columnRegions` is the contract's own unwrap, so the test walks a
    // column exactly the way the host does, and the per-column arrays below
    // assert which columns stack as well as the order.
    const rowKeys = surface?.layout.rows.map((r) =>
      r.columns.map((c) => columnRegions(c).map((region) => region.key)),
    );
    // What's moving and what needs a human lead; the board's pick stacks
    // under what's-moving so both columns pack at their own height, and the
    // row break keeps the pick above the portfolio/momentum pair. The
    // inspector stays a full-width band ABOVE the Plan: stacks flow but
    // still can't stick, so side-by-side would strand it beside a much
    // taller inventory.
    expect(rowKeys).toEqual([
      [[WIP_KEY, RECOMMEND_KEY], [ATTENTION_KEY]],
      [[PORTFOLIO_KEY], [MOMENTUM_KEY]],
      [[INSPECT_KEY]],
      [[PLAN_KEY]],
    ]);
    // The pair renamed for what it shows: runs, and the human's queue.
    const titles = surface?.layout.rows[0]?.columns.flatMap((c) =>
      columnRegions(c).map((region) => region.title),
    );
    expect(titles).toEqual(["Agents at work", "Recommended next", "Needs a human"]);
    // Momentum earned a column — nothing starts collapsed anymore.
    for (const row of surface?.layout.rows ?? []) {
      for (const col of row.columns) {
        for (const region of columnRegions(col)) expect(region.collapsed).toBeUndefined();
      }
    }
    // Every declared view key is registered as a panel.
    expect(rib.views?.map((v) => v.key).sort()).toEqual([...ALL_KEYS].sort());
  });

  test("the surface opts into the host project picker", () => {
    expect(rib.surfaces?.[0]?.projectScoped).toBe(true);
  });

  test("select-project and select-bead succeed; unknown actions fail closed", async () => {
    const ctx = { getExec: () => ({}) as never };
    const good = await rib.onAction?.({ type: "select-project", payload: { scopeId: "p1" } }, ctx);
    expect(good?.ok).toBe(true);
    const pick = await rib.onAction?.({ type: "select-bead", payload: { id: "tl-x" } }, ctx);
    expect(pick?.ok).toBe(true);
    // Selection answers with an open-canvas directive so the inspector lands
    // in the drawer, in view regardless of where on the page the click was.
    expect((pick as { data?: { effect?: string; key?: string } })?.data?.effect).toBe(
      "open-canvas",
    );
    expect((pick as { data?: { key?: string } })?.data?.key).toBe(INSPECT_KEY);
    // claim-bead with no scoped beads project fails closed, never throws.
    const claim = await rib.onAction?.({ type: "claim-bead", payload: { id: "tl-x" } }, ctx);
    expect(claim?.ok).toBe(false);
    const bad = await rib.onAction?.({ type: "explode" }, ctx);
    expect(bad?.ok).toBe(false);
  });

  test("docs are contributed inline", () => {
    const docs = rib.contributeDocs?.({ getExec: () => ({}) as never });
    expect(docs?.[0]?.title).toBe("Beads");
    expect(docs?.[0]?.content).toContain("beads_ready");
  });
});

describe("beads-work claim node", () => {
  test("fails the run when the claim did not land instead of trusting bd's exit code", async () => {
    const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
    const workflow = Bun.YAML.parse(yaml) as {
      nodes: { id: string; bash?: string }[];
    };
    const claim = workflow.nodes.find((n) => n.id === "claim");
    expect(claim?.bash).toBeDefined();
    const script = claim?.bash ?? "";
    // The verification must read the bead back and gate on in_progress
    // before `.bead-id` is written, so a lost write never reaches writeback.
    const verifyAt = script.indexOf('!= "in_progress"');
    const recordAt = script.indexOf('> "$KEELSON_ARTIFACTS_DIR/.bead-id"');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(verifyAt);
    expect(script).toContain("exit 1");
  });
});

describe("beads-work approval trail", () => {
  test("records the approver's reply on the bead without gating implementation", async () => {
    const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
    const workflow = Bun.YAML.parse(yaml) as {
      nodes: { id: string; depends_on?: string[]; bash?: string }[];
    };
    const record = workflow.nodes.find((n) => n.id === "record-approval");
    expect(record?.depends_on).toEqual(["approve-plan"]);
    expect(record?.bash).toContain("KEELSON_NODE_approve_plan_OUTPUT");
    expect(record?.bash).toContain('bd note "$BEAD" "bead-work plan: approved');
    const implement = workflow.nodes.find((n) => n.id === "implement");
    expect(implement?.depends_on).not.toContain("record-approval");
  });
});

describe("registered merge reconciliation entry points", () => {
  const prUrl = "https://github.com/acme/demo/pull/";
  const mergedAt = "2026-09-22T01:02:03Z";

  function setup() {
    const rootPath = mkdtempSync(join(tmpdir(), "beads-rib-"));
    mkdirSync(join(rootPath, ".beads"));
    const project = { id: "p1", name: "demo", rootPath };
    const rows = [
      { id: "tl-1", title: "First", priority: 2, status: "in_progress" },
      { id: "tl-2", title: "Second", priority: 2, status: "open" },
    ];
    const writes: string[][] = [];
    const events: { content: string; isError?: boolean }[] = [];
    let recomposes = 0;
    let failClose = false;
    let holdGh: Promise<void> | undefined;
    const exec = {
      runJSON: async (command: string, args: string[]) => {
        if (command === "gh") {
          await holdGh;
          const url = args[2] ?? "";
          const merged = url.endsWith("/1");
          return {
            ok: true,
            data: {
              url,
              state: merged ? "MERGED" : "OPEN",
              mergedAt: merged ? mergedAt : null,
              body: "",
            },
          };
        }
        if (args[1] === "list")
          return { ok: true, data: rows.filter((row) => row.status !== "closed") };
        if (args[1] === "show") {
          const row = rows.find((item) => item.id === args[2]);
          return {
            ok: true,
            data: row
              ? [
                  {
                    ...row,
                    notes: `bead-work run: PR ${prUrl}${row.id.endsWith("1") ? "1" : "2"} — success`,
                  },
                ]
              : [],
          };
        }
        if (args[1] === "status") return { ok: true, data: { summary: {} } };
        return { ok: true, data: [] };
      },
      runText: async (_command: string, args: string[]) => {
        writes.push(args);
        if (failClose) return { ok: false, error: "bd could not close" };
        const row = rows.find((item) => item.id === args[1]);
        if (row) row.status = "closed";
        return { ok: true, data: "ok" };
      },
    };
    const ctx = {
      getExec: () => exec,
      getProjects: () => [project],
      getSnapshotManager: () => ({
        register: () => () => {},
        recompose: async () => {
          recomposes++;
        },
      }),
    };
    const tools = rib.registerTools?.(ctx as never) ?? [];
    const tool = tools.find((item) => item.name === "beads_sync_merged");
    return {
      ctx,
      project,
      writes,
      events,
      tool,
      toolCtx: { emit: (event: { content: string; isError?: boolean }) => events.push(event) },
      recomposes: () => recomposes,
      hold(promise: Promise<void>) {
        holdGh = promise;
      },
      failWrites() {
        failClose = true;
      },
      cleanup() {
        rib.dispose?.();
        rmSync(rootPath, { recursive: true, force: true });
      },
    };
  }

  test("chat tool previews by default, then confirms; unmerged PR is skipped", async () => {
    const f = setup();
    try {
      expect(f.tool?.state_changing).toBe(true);
      expect(f.tool?.requires_confirmation).toBe(true);
      const before = f.recomposes();
      await f.tool?.execute({}, f.toolCtx as never);
      expect(f.writes).toEqual([]);
      expect(f.recomposes()).toBe(before);
      const preview = JSON.parse(f.events.at(-1)?.content ?? "{}");
      expect(preview.results).toEqual([
        { id: "tl-1", status: "would_close", prUrl: `${prUrl}1`, mergedAt },
        { id: "tl-2", status: "skipped", reason: "PR is OPEN, not merged" },
      ]);
      await f.tool?.execute({ confirm: true }, f.toolCtx as never);
      expect(f.writes).toEqual([["close", "tl-1", "--reason", `Merged via ${prUrl}1`]]);
      expect(JSON.parse(f.events.at(-1)?.content ?? "{}").results).toEqual([
        { id: "tl-1", status: "closed", prUrl: `${prUrl}1`, mergedAt },
        { id: "tl-2", status: "skipped", reason: "PR is OPEN, not merged" },
      ]);
      expect(f.recomposes()).toBeGreaterThan(before);
    } finally {
      f.cleanup();
    }
  });

  test("board action rejects missing or stale scope and refreshes after a close", async () => {
    const f = setup();
    try {
      expect((await rib.onAction?.({ type: "sync-merged-beads" }, f.ctx as never))?.ok).toBe(false);
      expect(
        (
          await rib.onAction?.(
            { type: "sync-merged-beads", payload: { projectId: "other" } },
            f.ctx as never,
          )
        )?.ok,
      ).toBe(false);
      await rib.onAction?.({ type: "select-project", payload: { scopeId: "p1" } }, f.ctx as never);
      const before = f.recomposes();
      expect(
        (
          await rib.onAction?.(
            { type: "sync-merged-beads", payload: { projectId: "p1" } },
            f.ctx as never,
          )
        )?.ok,
      ).toBe(true);
      expect(f.writes).toHaveLength(1);
      expect(f.recomposes()).toBeGreaterThan(before);
    } finally {
      f.cleanup();
    }
  });

  test("confirmed partial failures surface as errors and still refresh", async () => {
    const f = setup();
    try {
      await rib.onAction?.({ type: "select-project", payload: { scopeId: "p1" } }, f.ctx as never);
      f.failWrites();
      const before = f.recomposes();
      const action = await rib.onAction?.(
        { type: "sync-merged-beads", payload: { projectId: "p1" } },
        f.ctx as never,
      );
      expect(action?.ok).toBe(false);
      expect(JSON.stringify(action)).toContain("bd could not close");
      expect(f.recomposes()).toBeGreaterThan(before);
      await f.tool?.execute({ confirm: true, project: "demo" }, f.toolCtx as never);
      expect(f.events.at(-1)?.isError).toBe(true);
      expect(f.events.at(-1)?.content).toContain("bd could not close");
    } finally {
      f.cleanup();
    }
  });

  test("overlapping reconciliations for one project cannot double-close", async () => {
    const f = setup();
    let release: () => void = () => {};
    try {
      f.hold(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const first = f.tool?.execute({ confirm: true }, f.toolCtx as never);
      await Promise.resolve();
      await f.tool?.execute({ confirm: true }, f.toolCtx as never);
      expect(f.events.at(-1)?.isError).toBe(true);
      expect(f.events.at(-1)?.content).toContain("already running");
      release();
      await first;
      expect(f.writes).toHaveLength(1);
    } finally {
      release();
      f.cleanup();
    }
  });
});

describe("beads-work CI fixer gating", () => {
  test("fix-ci runs only for a red or conflicting CI and the final scrub tolerates the skip", async () => {
    const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
    const workflow = Bun.YAML.parse(yaml) as {
      nodes: { id: string; depends_on?: string[]; when?: string; trigger_rule?: string }[];
    };
    const fixCi = workflow.nodes.find((n) => n.id === "fix-ci");
    expect(fixCi?.when).toContain("ci_status == 'fail'");
    expect(fixCi?.when).toContain("ci_status == 'conflict'");
    const scrub = workflow.nodes.find((n) => n.id === "scrub-trailers-final");
    expect(scrub?.depends_on).toEqual(["triage-ci", "fix-ci"]);
    expect(scrub?.trigger_rule).toBe("none_failed_min_one_success");
    const finalize = workflow.nodes.find((n) => n.id === "finalize-pr");
    expect(finalize?.depends_on).toEqual(["scrub-trailers-final"]);
  });
});
