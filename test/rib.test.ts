import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { columnRegions } from "@keelson/shared";
import rib from "../src/index";
import {
  ALL_KEYS,
  ATTENTION_KEY,
  BACKLOG_KEY,
  EPIC_MAP_KEY,
  INSPECT_KEY,
  PULSE_KEY,
  RECOMMEND_KEY,
  SHIPPED_KEY,
  TRACKERS_KEY,
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

  test("the surface lays out the trackers, the overview, Now, the epic map, then backlog and shipped", () => {
    const surface = rib.surfaces?.[0];
    expect(surface?.id).toBe("beads");
    expect(surface?.layout.header?.key).toBe(TRACKERS_KEY);
    const rowKeys = surface?.layout.rows.map((r) =>
      r.columns.map((c) => columnRegions(c).map((region) => region.key)),
    );
    // The map takes a full row and hides when no epic is open, so a project
    // without epics leaves no empty panel. The inspector has no region: it
    // opens in the canvas drawer.
    expect(rowKeys).toEqual([
      [[PULSE_KEY]],
      [[RECOMMEND_KEY], [WIP_KEY], [ATTENTION_KEY]],
      [[EPIC_MAP_KEY]],
      [[BACKLOG_KEY], [SHIPPED_KEY]],
    ]);
    expect(surface?.layout.rows.map((r) => r.zoneTitle)).toEqual([
      undefined,
      "Now",
      "Epics",
      "Backlog and shipped",
    ]);
    const titles = surface?.layout.rows.flatMap((r) =>
      r.columns.flatMap((c) => columnRegions(c).map((region) => region.title)),
    );
    expect(titles).toEqual([
      "Overview",
      "Next up",
      "In flight",
      "Your calls",
      "Wave map",
      "Backlog",
      "Shipped",
    ]);
    // The map, Your calls and Backlog hide when they have nothing to show.
    const regions = surface?.layout.rows.flatMap((r) => r.columns.flatMap(columnRegions)) ?? [];
    expect(regions.filter((r) => r.hideWhenEmpty).map((r) => r.key)).toEqual([
      ATTENTION_KEY,
      EPIC_MAP_KEY,
      BACKLOG_KEY,
    ]);
    // The map is the one html region; every other key is a structured view.
    expect(rib.views?.filter((v) => v.canvasKind === "html").map((v) => v.key)).toEqual([
      EPIC_MAP_KEY,
    ]);
    expect(rowKeys?.flat(2)).not.toContain(INSPECT_KEY);
    for (const row of surface?.layout.rows ?? []) {
      for (const col of row.columns) {
        for (const region of columnRegions(col)) expect(region.collapsed).toBeUndefined();
      }
    }
    // Every declared view key is registered as a panel.
    expect(rib.views?.map((v) => v.key).sort()).toEqual([...ALL_KEYS].sort());
  });

  test("a frame-relayed action may select a bead and nothing else", async () => {
    const ctx = { getExec: () => ({}) as never };
    const select = await rib.onAction?.(
      { type: "select-bead", payload: { id: "tl-x" }, origin: "canvas-html" },
      ctx,
    );
    expect(select?.ok).toBe(true);
    expect((select as { data?: unknown }).data).toEqual({
      effect: "open-canvas",
      key: INSPECT_KEY,
      title: "Bead",
      placement: "side",
    });
    const flag = await rib.onAction?.(
      { type: "select-bead", payload: { id: "--help" }, origin: "canvas-html" },
      ctx,
    );
    expect(flag?.ok).toBe(false);
    for (const type of ["claim-bead", "sync-merged-beads", "select-project", "open-run"]) {
      const res = await rib.onAction?.(
        { type, payload: { id: "tl-x" }, origin: "canvas-html" },
        ctx,
      );
      expect(res?.ok).toBe(false);
      expect((res as { error?: string }).error).toContain("from a frame");
    }
  });

  test("open-run hands the host the run to open beside the board", async () => {
    const ctx = { getExec: () => ({}) as never };
    const open = await rib.onAction?.({ type: "open-run", payload: { runId: "run-1" } }, ctx);
    expect(open).toEqual({
      ok: true,
      data: { effect: "open-run", runId: "run-1", workflow: "beads-work" },
    });
    const bad = await rib.onAction?.({ type: "open-run", payload: {} }, ctx);
    expect(bad?.ok).toBe(false);
  });

  test("the surface owns its scope instead of the host's all-projects picker", () => {
    expect(rib.surfaces?.[0]?.projectScoped).toBeUndefined();
  });

  test("select-project and select-bead succeed; unknown actions fail closed", async () => {
    const ctx = { getExec: () => ({}) as never };
    const good = await rib.onAction?.({ type: "select-project", payload: {} }, ctx);
    expect(good?.ok).toBe(true);
    const stranger = await rib.onAction?.(
      { type: "select-project", payload: { scopeId: "p1" } },
      ctx,
    );
    expect(stranger?.ok).toBe(false);
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
    expect(docs?.[0]?.content).toContain("retains claims with a recorded or unknown PR state");
    expect(docs?.[0]?.content).not.toContain("releases the claim on failure");
  });
});

describe("no tracker registered", () => {
  test("the strip says how to get one and the map frame stays markup", async () => {
    const composers = new Map<string, () => Promise<unknown>>();
    const ctx = {
      getExec: () => ({ runJSON: async () => ({ ok: true, data: [] }) }),
      getProjects: () => [],
      getSnapshotManager: () => ({
        register: (key: string, compose: () => Promise<unknown>) => {
          composers.set(key, compose);
          return () => {};
        },
        recompose: async () => undefined,
      }),
    };
    try {
      rib.registerTools?.(ctx as never);
      expect(await composers.get(EPIC_MAP_KEY)?.()).toBe("");
      expect(JSON.stringify(await composers.get(TRACKERS_KEY)?.())).toContain(
        "no beads tracker registered",
      );
      expect(await composers.get(WIP_KEY)?.()).toEqual({ view: "board", sections: [] });
    } finally {
      rib.dispose?.();
    }
  });
});

describe("tracker choice", () => {
  test("the picked tracker is remembered across a re-activation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "beads-rib-data-"));
    const roots = ["alpha", "bravo"].map((name) => {
      const rootPath = mkdtempSync(join(tmpdir(), `beads-rib-${name}-`));
      mkdirSync(join(rootPath, ".beads"));
      return { id: name, name, rootPath };
    });
    const composers = new Map<string, () => Promise<unknown>>();
    const ctx = {
      getExec: () => ({ runJSON: async () => ({ ok: true, data: [] }) }),
      getProjects: () => roots,
      getDataDir: () => dataDir,
      getSnapshotManager: () => ({
        register: (key: string, compose: () => Promise<unknown>) => {
          composers.set(key, compose);
          return () => {};
        },
        recompose: async () => undefined,
      }),
    };
    const selected = async () => {
      const strip = (await composers.get(TRACKERS_KEY)?.()) as {
        sections: { items: { title: string; selected?: boolean }[] }[];
      };
      return strip.sections[0]?.items.find((t) => t.selected)?.title;
    };
    try {
      rib.registerTools?.(ctx as never);
      expect(await selected()).toBe("alpha");
      await rib.onAction?.({ type: "select-project", payload: { scopeId: "bravo" } }, ctx as never);
      expect(await selected()).toBe("bravo");
      rib.dispose?.();
      rib.registerTools?.(ctx as never);
      expect(await selected()).toBe("bravo");
    } finally {
      rib.dispose?.();
      rmSync(dataDir, { recursive: true, force: true });
      for (const root of roots) rmSync(root.rootPath, { recursive: true, force: true });
    }
  });
});

describe("recompose ordering", () => {
  test("a recompose asked for mid-compose still paints the newer state", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "beads-rib-"));
    mkdirSync(join(rootPath, ".beads"));
    const composers = new Map<string, () => Promise<unknown>>();
    const frames = new Map<string, unknown>();
    const inflight = new Map<string, Promise<undefined>>();
    const ctx = {
      getExec: () => ({
        runJSON: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return { ok: true, data: [] };
        },
      }),
      getProjects: () => [{ id: "p1", name: "demo", rootPath }],
      getSnapshotManager: () => ({
        register: (key: string, compose: () => Promise<unknown>) => {
          composers.set(key, compose);
          return () => {};
        },
        // Like the host: a recompose during a compose shares the in-flight one.
        recompose: (key: string) => {
          const running = inflight.get(key);
          if (running) return running;
          const run = (async () => {
            const frame = await composers.get(key)?.();
            await new Promise((resolve) => setTimeout(resolve, 5));
            frames.set(key, frame);
            inflight.delete(key);
            return undefined;
          })();
          inflight.set(key, run);
          return run;
        },
      }),
    };
    try {
      rib.registerTools?.(ctx as never);
      for (let i = 0; i < 200; i++) {
        if (JSON.stringify(frames.get(PULSE_KEY) ?? "").includes("measured ")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(JSON.stringify(frames.get(PULSE_KEY))).toContain("measured ");
      expect(JSON.stringify(frames.get(PULSE_KEY))).not.toContain("first sweep");
    } finally {
      rib.dispose?.();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

describe("project switch", () => {
  test("a newly picked project's panels say measuring until its first sweep settles", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "beads-rib-"));
    mkdirSync(join(rootPath, ".beads"));
    const composers = new Map<string, () => Promise<unknown>>();
    const frames = new Map<string, unknown>();
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = {
      getExec: () => ({
        runJSON: async () => {
          await hold;
          return { ok: true, data: [] };
        },
        runText: async () => ({ ok: true, data: "" }),
      }),
      getProjects: () => [{ id: "p1", name: "demo", rootPath }],
      getSnapshotManager: () => ({
        register: (key: string, compose: () => Promise<unknown>) => {
          composers.set(key, compose);
          return () => {};
        },
        recompose: async (key: string) => {
          frames.set(key, await composers.get(key)?.());
          return undefined;
        },
      }),
    };
    try {
      rib.registerTools?.(ctx as never);
      await rib.onAction?.({ type: "select-project", payload: { scopeId: "p1" } }, ctx as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The sweep is still held: every panel names the project being measured
      // and the map stays hidden, rather than keep the previous scope's frames.
      expect(JSON.stringify(frames.get(PULSE_KEY))).toContain("Measuring demo");
      expect(JSON.stringify(frames.get(WIP_KEY))).toContain("Measuring demo");
      expect(frames.get(EPIC_MAP_KEY)).toBe("");
      release();
      for (let i = 0; i < 100; i++) {
        if (!JSON.stringify(frames.get(PULSE_KEY)).includes("Measuring")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(JSON.stringify(frames.get(PULSE_KEY))).toContain("Done 7d");
      expect(JSON.stringify(frames.get(WIP_KEY))).not.toContain("Measuring");
    } finally {
      release();
      rib.dispose?.();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

describe("project sweep failures and re-selection", () => {
  function harness(runJSON: (cwd: string) => Promise<unknown>) {
    const roots = ["alpha", "bravo"].map((name) => {
      const rootPath = mkdtempSync(join(tmpdir(), `beads-rib-${name}-`));
      mkdirSync(join(rootPath, ".beads"));
      return { id: name, name, rootPath };
    });
    const composers = new Map<string, () => Promise<unknown>>();
    const frames = new Map<string, unknown>();
    const ctx = {
      getExec: () => ({
        runJSON: (_command: string, _args: string[], opts?: { cwd?: string }) =>
          runJSON(opts?.cwd ?? ""),
        runText: async () => ({ ok: true, data: "" }),
      }),
      getProjects: () => roots,
      getSnapshotManager: () => ({
        register: (key: string, compose: () => Promise<unknown>) => {
          composers.set(key, compose);
          return () => {};
        },
        // Like the host: a composer that throws leaves the last frame standing.
        recompose: async (key: string) => {
          try {
            frames.set(key, await composers.get(key)?.());
          } catch {}
          return undefined;
        },
      }),
    };
    const settle = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const text = (key: string) => JSON.stringify(frames.get(key));
    const cleanup = () => {
      rib.dispose?.();
      for (const root of roots) rmSync(root.rootPath, { recursive: true, force: true });
    };
    return { ctx, text, settle, cleanup };
  }

  test("a first sweep that throws alarms instead of staying on the placeholder", async () => {
    const f = harness(async () => {
      throw new Error("exec exploded");
    });
    try {
      rib.registerTools?.(f.ctx as never);
      await rib.onAction?.(
        { type: "select-project", payload: { scopeId: "alpha" } },
        f.ctx as never,
      );
      await f.settle(() => !f.text(WIP_KEY).includes("Measuring"));
      expect(f.text(WIP_KEY)).not.toContain("Measuring");
      expect(f.text(WIP_KEY)).toContain("UNMEASURED");
      expect(String(JSON.parse(f.text(EPIC_MAP_KEY)))).toContain("UNMEASURED");
    } finally {
      f.cleanup();
    }
  });

  test("going back to a project never leaves another project's placeholder up", async () => {
    let releaseBravo: () => void = () => {};
    const holdBravo = new Promise<void>((resolve) => {
      releaseBravo = resolve;
    });
    const f = harness(async (cwd) => {
      if (cwd.includes("bravo")) await holdBravo;
      return { ok: true, data: [] };
    });
    const select = (scopeId: string) =>
      rib.onAction?.({ type: "select-project", payload: { scopeId } }, f.ctx as never);
    try {
      rib.registerTools?.(f.ctx as never);
      await select("alpha");
      await f.settle(() => f.text(PULSE_KEY).includes("in flight"));
      await select("bravo");
      await f.settle(() => f.text(PULSE_KEY).includes("Measuring bravo"));
      expect(f.text(PULSE_KEY)).toContain("Measuring bravo");
      await select("alpha");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(f.text(PULSE_KEY)).not.toContain("bravo");
      releaseBravo();
      await f.settle(() => f.text(PULSE_KEY).includes("in flight"));
      expect(f.text(PULSE_KEY)).toContain('"label":"alpha"');
    } finally {
      releaseBravo();
      f.cleanup();
    }
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
    expect(script).toContain("assignee:.assignee");
    expect(script).toContain('if [ -z "$CLAIMED_ASSIGNEE" ]');
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

describe("beads-work must-fix gating", () => {
  test("the review loop runs after a skipped fix pair, never after a failed fixer or re-review", async () => {
    const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
    const workflow = Bun.YAML.parse(yaml) as {
      nodes: { id: string; depends_on?: string[]; when?: string; trigger_rule?: string }[];
    };
    const byId = (id: string) => workflow.nodes.find((n) => n.id === id);
    const gate = "$must-fix-count.output != '0'";
    expect(byId("must-fix-count")?.depends_on).toEqual(["triage"]);
    expect(byId("apply-fixes")?.depends_on).toContain("must-fix-count");
    expect(byId("apply-fixes")?.when).toBe(gate);
    expect(byId("re-review")?.when).toBe(gate);
    const loop = byId("review-loop");
    expect(loop?.depends_on).toEqual(["triage", "apply-fixes", "re-review"]);
    expect(loop?.trigger_rule).toBe("none_failed_min_one_success");
  });
});

describe("beads-work review findings carry a repro", () => {
  type ListContract = { items?: { required?: string[] } };
  type Contract = { properties?: Record<string, ListContract> };
  type Node = {
    id: string;
    prompt?: string;
    output_format?: Contract;
    output_schema?: Contract;
  };

  async function loadNodes(): Promise<Map<string, Node>> {
    const yaml = await Bun.file(new URL("../workflows/beads-work.yml", import.meta.url)).text();
    const workflow = Bun.YAML.parse(yaml) as { nodes: Node[] };
    return new Map(workflow.nodes.map((n) => [n.id, n]));
  }

  function itemRequired(contract: Contract | undefined, list: string): string[] {
    const required = contract?.properties?.[list]?.items?.required;
    if (!required) throw new Error(`${list} items declare no required list`);
    return required;
  }

  test("each review lens requires repro beside fix in both contracts", async () => {
    const nodes = await loadNodes();
    for (const [id, remedy] of [
      ["review-correctness", "fix"],
      ["review-conventions", "fix"],
      ["review-coverage", "test"],
    ] as const) {
      const node = nodes.get(id);
      const format = itemRequired(node?.output_format, "findings");
      const schema = itemRequired(node?.output_schema, "findings");
      expect(format).toEqual(schema);
      expect(format.indexOf("repro")).toBe(format.indexOf(remedy) + 1);
      expect(node?.prompt).toContain("`repro`");
      expect(node?.prompt).toContain("$DIRECTIVES.review");
    }
  });

  test("the judges carry repro into what the fixers receive", async () => {
    const nodes = await loadNodes();
    const mustFix = itemRequired(nodes.get("triage")?.output_format, "must_fix");
    expect(mustFix.indexOf("repro")).toBe(mustFix.indexOf("fix") + 1);
    const actionable = itemRequired(nodes.get("triage-ci")?.output_format, "actionable");
    expect(actionable.indexOf("repro")).toBe(actionable.indexOf("fix") + 1);
    for (const id of ["triage", "triage-ci", "apply-fixes", "fix-ci", "re-review", "report"]) {
      expect(nodes.get(id)?.prompt).toContain("repro");
    }
  });
});
