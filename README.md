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

- KPI pulse — startable / in-progress / waiting on deps / closed this week.
  Every tile counts a population the rib measured; a failed query renders `?`
  in an alarm tone rather than borrowing bd's own summary number, which counts
  a different population under the same word.
- The ready queue, priority order, epics excluded, work-in-flight subtracted,
  ranked by `dependent_count` — finishing a high-leverage bead frees the most
  downstream work, and that outranks raw priority
- In-progress cards (work already claimed is the most interesting state)
- Merged PRs awaiting bead closure in Needs attention, linked to the recorded
  PR with a confirmed **Reconcile merged PRs** action for the selected project
- The blocked set as the **union** of dependency-blocked (`bd blocked`) and
  status-blocked (`bd list --status blocked`) — either query alone
  undercounts, and a manually blocked row says "paused by hand" instead of an
  empty waits-on
- Epic completion meters, and an epic whose children have all closed raises a
  **closeout review** — never an offer to close
- A recent-closes momentum strip, and stale claims surfaced in Needs attention
  when nonzero (with an `UNMEASURED` alarm when the query fails, so an absent
  section can never mean "probably fine")

**Two channels, deliberately separate.** Lifecycle (open / in progress /
deferred) is one value carried by the dot and a word; dependency blocking is a
*condition* that overlays any lifecycle and lives only in the trailing
**decision rail** alongside the other exceptional signals — `waiting on N`,
`N downstream`, `bug`, `closeout review`. A bead can be in progress *and*
waiting, which is why the same bead no longer renders green in one panel and
red in another. The rail is empty on most beads, and that is the point: a
signal present on 7% of the backlog must not cost every row a reserved column.

**Two leverage metrics, never one contested word.** `N downstream` is the
declared `dependent_count` and does the ranking; `releases N now` is measured
off the blocked edges and explains the immediate consequence. They can
disagree honestly — `3 downstream · releases 0 now` says the leverage is real
but deferred.

Every section is **fail-closed**: a failed `bd` query renders UNMEASURED,
never an empty-but-healthy board.

**Tools.** Tools that target a backlog take an optional project name; omit it
only when exactly one registered project has a `.beads` tracker.

| Tool | Use |
| --- | --- |
| `beads_projects`, `beads_status`, `beads_ready`, `beads_blocked`, `beads_show`, `beads_list`, `beads_epics`, `beads_stale` | Read the registered backlogs and their tracker state. |
| `beads_create`, `beads_update`, `beads_dep` | Policy-gated tracker writes. |
| `beads_close` | Manually close one bead with a reason (confirmation-required). |
| `beads_sync_merged` | State-changing tool: without `confirm: true`, read-only preview listing each proposed bead ID, canonical PR URL and merge timestamp, plus skipped/error reasons. With `confirm: true`, recheck and close eligible beads; return closed/skipped/error results. |
| `beads_board_refresh` | Re-measure the board on demand, without writes. |

The board reads linked PRs on its five-minute cadence without writing to
`bd`. It requires an authenticated `gh` CLI for PR-linked data; failed lookups
appear as `UNMEASURED`, not as "nothing merged." The confirmed board action
uses the selected project; the chat tool uses the project rule above. Both
read the latest recorded `bead-work run: PR ...` note, re-read the current
tracker and GitHub state, and close only eligible open or
in-progress beads with reason `Merged via <canonical PR URL>` (for example,
`Merged via https://github.com/acme/demo/pull/42`). A skipped or failed bead
stays open, and successful closure releases dependents according to `bd`.
There is no automatic merge webhook. Mutations recompose the board.

**Workflows.** Two read-only ones that propose while the operator disposes,
and one that does the work:

- `beads-next` — what to start first, leverage-ranked, with runner-ups.
- `beads-groom` — backlog health: stale claims (verify-or-release), blocked
  chains grouped by blocker, priority drift, epics eligible to close; every
  finding carries the exact `bd` command that would fix it.
- `beads-work` — takes one bead from the ready queue to a reviewed draft PR:
  claims it (or the bead id you pass, refused while any of its `blocks`
  dependencies is still open), investigates or plans, pauses for approval,
  implements in an isolated worktree, runs the project's own checks
  (discovered from its manifests), opens a draft PR, runs a three-lens review
  loop with an independent triage judge, waits on CI, and writes the outcome
  back to the bead as a `bead-work run:` note the board reads. The approver's
  reply at the plan gate lands on the bead too, as a `bead-work plan:` note,
  so the decision record shows what was approved and with what changes.
  Two deterministic guards run around the agent nodes: attribution trailers
  (`Co-authored-by`, "Generated with") are stripped from the run's commits
  before each push, and every dependency manifest or lockfile change is
  audited against the plan and marked UNPLANNED in the PR body and report
  when the plan never named it. The writeback only touches a bead that still
  carries the run's claim; one a human closed or deferred mid-run is left
  as found. It never closes a bead; a failed run releases the claim to `open`
  with no assignee, even if a PR was recorded. If a run is cancelled or fails
  before writeback, the rib releases a still-in-progress bead to `open` with
  no assignee only when the successful claim recorded its assignee, that
  assignee still holds the bead, `create-pr` never started, and no PR is
  recorded. Older runs without a recorded assignee are left untouched. A
  recorded PR keeps the claim; if PR creation started but no identifier was
  recorded, the claim stays in place with a note that the PR state is
  unknown. After merge, run reconciliation or manually use `beads_close`.
  Judgment nodes pin `gpt-6-astra`,
  edit nodes `gpt-5.6-sol`, review lenses `gpt-5.6-terra` on the Copilot
  provider; elsewhere they resolve through the `deep` tier. Needs `gh`, `jq`,
  and a GitHub remote. Pass `review_bot=false` to skip requesting the Copilot
  reviewer.

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
- **The rib never auto-closes beads.** The operator confirms reconciliation
  after merge (or manually uses `beads_close`), preserving the PR URL as the
  written decision reason. Children closing does not establish that an epic
  meets its own acceptance criteria; epic closeout remains a separate review.

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
