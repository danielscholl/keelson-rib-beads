# Copilot code review: @keelson/rib-beads

A [Keelson](https://github.com/danielscholl/keelson) rib, Bun + TypeScript,
that bridges a beads (`bd`) tracker into chat tools, a backlog board, and the
`beads-work` workflow that takes a bead to a draft PR. It writes to trackers
and drives code changes, so the review weight sits on those write paths. The
README has the board's behavior and the design notes.

## How to review

Be terse and cite `file:line`. A few high-signal findings beat breadth. This is
single-operator local software: skip speculative scale, multi-tenant and
micro-optimization concerns. No poems, jokes or emoji.

## Comments

Do not ask for docstrings or comment coverage. Flag a comment only when it
narrates the PR or restates the code; a missing comment is not a finding.

## Invariants to flag when a change breaks them

- **One serialized bd runner.** Every `bd` call, read or write, across all
  projects, goes through the single chain in `src/bd.ts`. Flag a `bd` process
  started any other way; concurrent `bd` crashes Dolt's embedded mode.
- **Reads run `--sandbox`; writes do not.** Flag a read without it or a write
  with it.
- **The rib never auto-closes a bead.** Closing happens through `beads_close`
  or a confirmed reconciliation (`beads_sync_merged` with `confirm: true`,
  or the board's confirmed action), and the reason carries the verified PR
  URL. Flag any other path to `bd close`, or a reconciliation that closes
  without re-reading the tracker and GitHub state.
- **Run cleanup only touches what the run holds.** `onRunEvent` releases a
  claim only when the run's recorded assignee still holds it, `create-pr`
  never started, and no PR is recorded. Flag a loosened condition.
- **Frame actions select, nothing else.** The wave map is a sandboxed frame;
  an action with `origin: "canvas-html"` may only be `select-bead` with a bead
  id. Flag a new action type accepted from a frame.
- **Fail closed.** A failed `bd` or `gh` read renders UNMEASURED, never an
  empty or zero board. Flag a default of 0, `[]` or "ok" standing in for a
  failed or missing read.
- **Composers are pure.** Board composers in `src/board.ts` and `src/map.ts`
  map a measurement to a board. Flag exec or disk access added to a composer.
- **Untrusted text.** Titles, descriptions, notes, labels and PR fields are
  untrusted. Flag one spliced into a shell string, passed to `bd` or `gh`
  without going through an argument array, or used as a path. In workflow
  YAML, upstream output reaches `bash` nodes through `KEELSON_NODE_*`
  variables; flag `$<node>.output` spliced into a `bash` body.
- **Workflow guards stay in place.** `beads-work` strips attribution trailers
  before each push, audits dependency changes against the plan, and writes
  back only to a bead that still carries the run's claim. Flag a change that
  removes or bypasses one.
- **A judge never grades its own model.** In `beads-work`, a review, triage
  or verification node runs on a different model from the node whose output
  it judges. Flag a model pin that makes them the same.
- **Sample data only.** The repo is public. Flag fixtures, tests, docs or
  screenshots that carry real tracker content instead of sample ids
  (`cos-hjf.1`, `acme/demo`).
- **Attach only through the `Rib` contract** from `@keelson/shared`. Flag
  reaching into harness internals.

## What not to flag

- Missing docstrings or comments.
- `evals/review/base/`: a fixture service seeded with deliberate bugs for the
  reviewer eval.
- Tests in `test/` using `bun:test` and fake exec runners.
- The absence of an abstraction; this repo waits for a second caller.
