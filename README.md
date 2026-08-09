# @keelson/rib-beads

A [keelson](https://github.com/danielscholl/keelson) rib for
[beads](https://github.com/steveyegge/beads) (`bd`) backlog intelligence:
the tracker bridged as native chat tools, a live backlog board on its own
surface, and workflows that drive work from the dependency-ready queue.

Any registered keelson project whose repository carries a `.beads/` directory
is discovered automatically — the rib owns the capability, the projects own
the data.

## What it contributes

**A surface.** The *Beads* nav tab is project-scoped: the host's project
picker in the surface header chooses which backlog renders, and a project
without a `.beads` tracker gets an honest empty state that lists the projects
that have one. The scoped board is composed in-process from `bd` output on a
5-minute cadence:

- KPI pulse — open / ready / in-progress / blocked / closed
- The ready queue, priority order, work-in-flight subtracted, with
  `unlocks N` leverage badges (`dependent_count` — finishing a high-unlocks
  bead frees the most downstream work, and that outranks raw priority)
- In-progress cards (work already claimed is the most interesting state)
- The blocked set as the **union** of dependency-blocked (`bd blocked`) and
  status-blocked (`bd list --status blocked`) — either query alone
  undercounts, and a manually blocked row says "status-blocked (manual)"
  instead of an empty waits-on
- Epic completion meters with eligible-to-close flags
- A recent-closes momentum strip and a stale-claims alarm

Every section is **fail-closed**: a failed `bd` query renders UNMEASURED,
never an empty-but-healthy board.

**Tools.** Read: `beads_projects`, `beads_status`, `beads_ready`,
`beads_blocked`, `beads_show`, `beads_list`, `beads_epics`, `beads_stale`.
Write (policy-gated): `beads_create`, `beads_update` (claim / status /
priority / notes), `beads_close` (confirmation-required — closing is a
merge-time action), `beads_dep`. Any mutation recomposes the board
immediately; `beads_board_refresh` does so on demand.

**Workflows.** Both read-only — they propose, the operator disposes:

- `beads-next` — what to start first, leverage-ranked, with runner-ups.
- `beads-groom` — backlog health: stale claims (verify-or-release), blocked
  chains grouped by blocker, priority drift, epics eligible to close; every
  finding carries the exact `bd` command that would fix it.

## Install

```bash
keelson rib add /path/to/keelson-rib-beads   # or a git URL / npm name
```

keelson discovers installed `@keelson/rib-*` packages at boot. Scope
activation to just this rib with `KEELSON_RIBS=beads` while testing.

Requires the `bd` CLI on PATH (`brew install beads` /
[steveyegge/beads](https://github.com/steveyegge/beads)).

## Design notes

- **One serialized bd runner.** Concurrent `bd` processes crash Dolt's
  embedded mode, so every call — reads and writes, across all projects —
  funnels through a single promise chain.
- **Reads run `--sandbox`** so an interactive query never blocks on a Dolt
  auto-push; writes run plain `bd`, leaving sync behavior to the project's
  own `.beads/config.yaml`.
- **The numbers are never the agent's to invent.** The board is composed
  deterministically in TypeScript; the workflows measure in bash and spend
  exactly one agent turn on composition.
- **The rib never auto-closes beads.** Closing is a merge-time human action
  with a written reason — a task closed with its reasoning is a decision
  record.

Patterned on [keelson-rib-workiq](https://github.com/danielscholl/keelson-rib-workiq)
(the teaching rib), with board conventions distilled from
[mantoni/beads-ui](https://github.com/mantoni/beads-ui) and the
touchline-queue chamber lens.

## Local development

```bash
bun install
bun test
bun run typecheck
bun run check
bun dev/link.ts        # symlink into a local keelson checkout (KEELSON_DIR)
```

## License

Apache-2.0
