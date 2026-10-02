# @keelson/rib-beads

A [keelson](https://github.com/danielscholl/keelson) rib for
[beads](https://github.com/steveyegge/beads) (`bd`) backlog intelligence:
the tracker bridged as native chat tools, a live backlog board on its own
surface, and workflows that drive work from the dependency-ready queue.

Any registered keelson project whose repository carries a `.beads/` directory
is discovered automatically — the rib owns the capability, the projects own
the data.

## What it contributes

**A surface.** The *Beads* nav tab opens on a tracker strip: one tile per
registered project that carries a `.beads` tracker, each with its in flight,
open and closed counts. A click switches the board, and the choice is
remembered across restarts. The strip is the rib's own, so picking a backlog
never moves Chat's active project, and projects without a tracker never
appear. The selected board is composed in-process from `bd` output on a
5-minute cadence:

- **Loading.** A first visit fills a meter in the Overview as each `bd` read
  lands (about 3 seconds for a 40-bead tracker on bd 1.3). A project seen
  before paints at once from its last sweep and refreshes in place, with the
  chip reading `refreshing · N of 12`.

Below the Overview come three zones in the order the operator acts.

- **Overview.** The flow strip (waiting → ready → in progress → in review →
  done 7d), one colour per lane, with its legend carrying the totals once. An
  empty lane is left out, and the measured time is the local clock. A shared
  cause reports here once: a `bd` older than 1.2, or a `gh` that fails every
  PR lookup.
  Panels that depend on it point at the header instead of alarming separately.
  Merged PRs whose beads are still open show here as one line with a
  confirmed **Reconcile merged PRs** action, and stale claims and epics ready
  for closeout as one housekeeping line.
- **Now.** *In flight* lists every claim with a three-stop stage meter
  (claimed, PR open, merged) captioned with the stop reached and the next
  one, how far along it is (claimed N ago, PR open with draft, CI and review
  state, merged and waiting on the close), what still holds it when a claim
  waits on an open bead, what closing it releases, and its newest comment or
  run remark. *Next up* is one pick,
  ranked by `dependent_count` before priority, with its unlock chain and
  runner-up; it never picks a person's call. With nothing ready it names
  the claim whose close makes the most beads ready, and which ones. *Your
  calls* lists the beads only a person can finish: type `decision`, or
  labelled `owner` or `human`, ranked by how much work waits on each, with
  what it unblocks. The panel hides when there are none.
- **Epics.** *Wave map* draws each open epic as columns: a child's column is
  one more than the deepest column among its open blockers, so the first
  column holds what no open bead blocks and position says what waits on what. Lines join a
  bead to its blockers; hovering a bead lights its chain. A bead that holds
  two or more others carries a `holds N` tag, and a person's call carries
  `your call`. Under an epic a child prints as
  `.5`; the epic prints its id once. Clicking a bead in the map opens the
  inspector.
- **Backlog and shipped.** *Backlog* is every open bead that is on no epic
  and not in flight, grouped by priority; it hides when there is none, and
  Shipped takes the full width. *Shipped* compares closes and creates this
  week against last, then lists every close in the fortnight by day, one row
  each with its PR and time. The close reason is in the inspector's history.
  A fortnight with no closes is one line.

Clicking any bead opens the inspector in a drawer docked to the right, so
the board stays in view and the next click swaps the bead in place (keelson
0.115.0 or later). It leads with the bead's title over one line of facts
(id, status, priority, owner, type), then dependency links by edge type (an
epic edge is membership, never "waits on"), description, acceptance criteria
one per row, and a history of created, claimed, plan, PR, comments and
closed. A blocked bead offers only the pick to start instead. A linked bead
opens in the same drawer, so a chain can be walked. A stop the tracker did
not record says so.

**One shape per bead.** A bead is a card when it has evidence to show (lane
dot, title, a meta line led by the id as `bd` prints it, one signal pill, and
the evidence line) and a row in dense lists (lane dot, title, id and signal on
the right). The dot is the lane: to do, in flight, done. Waiting, staleness,
merge drift and P0/P1 are signals, and most beads carry none.

The blocked set is the **union** of dependency-blocked (`bd blocked`) and
status-blocked (`bd list --status blocked`); either query alone undercounts.
An epic whose children have all closed raises a **closeout review**, never an
offer to close.

The wave map is the one `html` region: the host renders it in a sandboxed
frame, and the rib accepts only bead selection from it. Claiming and
reconciling stay on the structured panels. Picking another project shows
"Measuring <project>" on every panel until that project's first sweep
answers.

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
  dependencies is still open; with no id it skips decisions and beads
  labelled `owner` or `human`), investigates or plans, pauses for approval,
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
  Every review finding carries a `repro` (the command or input that shows
  the problem, which the triage judge traces before anything else), and the
  prompts use keelson's shared directives (`$DIRECTIVES.verify`, `review`,
  `confirm`), so this workflow needs keelson 0.113.0 or later.
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

Installing from the git URL pins the newest `vX.Y.Z` release tag. `keelson
update` (or `keelson rib update beads`) moves the pin to the newest release,
and `keelson rib update beads --to <version>` rolls back. Restart the server
afterwards so it loads the new version.

Releases come from release-please: squash-merged conventional PR titles on
`master` accumulate into a `chore(release): bump to X.Y.Z` PR, and merging
that PR tags the release and writes `CHANGELOG.md`. A change reaches installed
homes only once a release tag exists.

Requires the `bd` CLI 1.2 or later on PATH (`brew install beads` /
[steveyegge/beads](https://github.com/steveyegge/beads)). The board reads
`bd version` on every sweep; an older `bd` shows as one line in the header.
Homebrew also carries a separate, older `bd` formula; if both are installed,
`brew unlink bd && brew link beads` puts the current one on PATH.

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

### Evaluating the correctness reviewer

`evals/review/` grades the `review-correctness` lens of `beads-work` against
thirty-four seeded diffs over a small fixture service: twenty-five carry one
merge-blocking bug each, nine are clean. Ten of the bugs are built to be hard:
the broken line is outside the diff, or the defect only shows against a contract
stated in another file. A bug case passes when a CRITICAL or
HIGH finding points at the seeded lines; a clean case passes when no CRITICAL or
HIGH finding reaches the confidence the triage node keeps.

```bash
bun evals/review/setup.ts /tmp/review-eval            # fixture repo, workflow, case file
cd /tmp/review-eval/repo
export KEELSON_WORKFLOWS_DIR=$PWD/.keelson/workflows   # where setup.ts wrote the workflow
export KEELSON_SERVER_URL=http://127.0.0.1:9           # no server there: run in-process
keelson eval run ../beads-review-lens.eval.yaml --out ../results/before.json
```

The workflow `setup.ts` writes copies the lens node from
`workflows/beads-work.yml`, so the eval grades the prompt that ships. Rebuild
after editing the lens, or pass `--effort <level>` or `--model <class or id>`
to build a copy with a different pin, run again with `--out ../results/after.json`, and let
`keelson eval compare before.json after.json` decide. Each case is a real model
turn. The two exports are needed because neither an installed `keelson` nor a
running server looks in the fixture for its workflow.

## License

Apache-2.0
