# Contributing to @keelson/rib-beads

The Beads rib is a [Keelson](https://github.com/danielscholl/keelson) rib: a
standalone package the harness discovers at runtime. The README's design notes
hold the invariants; this file holds the checks and conventions every pull
request follows. Where it is silent, the
[keelson CONTRIBUTING guide](https://github.com/danielscholl/keelson/blob/main/CONTRIBUTING.md)
is the parent.

## Development environment

You need [Bun](https://bun.sh/) and the [beads](https://github.com/steveyegge/beads)
`bd` CLI 1.2 or later on PATH. The board's PR data and the `beads-work`
workflow also need an authenticated `gh`.

```bash
git clone https://github.com/danielscholl/keelson-rib-beads.git
cd keelson-rib-beads
bun install
```

`@keelson/shared` resolves from the keelson release tarball pinned in
`package.json`, so install, typecheck and tests need no keelson checkout. To
move to a newer harness, change that URL and the peer range together.

To run the rib inside your Keelson home:

```bash
keelson rib add "$PWD"   # copies the working tree; repeat after each change
keelson restart
```

Or link it into a keelson checkout and run its dev server:

```bash
bun run link:keelson     # defaults to ../keelson; override with KEELSON_DIR
cd ../keelson && KEELSON_RIBS=beads bun dev
```

A restart interrupts any live workflow run, so check `keelson workflow status`
first. To try a change without touching your main server, run a second Keelson
on another port against a throwaway `bd` repo.

## Required checks

CI runs the same commands, and a PR needs all three green:

```bash
bun run check       # Biome lint + format
bun run typecheck   # tsc --noEmit
bun test
```

`bun run check:fix` applies the safe fixes. CI also runs a canary against
keelson `main`; it is informational and does not block a merge.

A change to a workflow under `workflows/` should also pass
`keelson workflow validate <name> --dir workflows --live`, which checks pinned
models and effort against each provider's live catalog. A change to the
`review-correctness` lens can be graded with the eval in `evals/review/` (see
the README).

## Sample data only

The repo is public. Fixtures, tests, screenshots, docs and issue text use
sample trackers and ids (`cos-hjf.1`, `acme/demo`). Bead titles, descriptions
and notes from a real tracker never enter the repo, including in logs or board
screenshots pasted into a PR or issue.

## Commits, PR titles and releases

PRs are squash-merged, and the PR title becomes the commit on `master`. It
must be a conventional commit (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`,
`chore:`, `test:`, `build:`, `ci:`); the PR Title check enforces it. Review
threads must be resolved before a merge.

[release-please](https://github.com/googleapis/release-please) reads those
commits and keeps a release PR open with the version bump and CHANGELOG.
Merging that PR tags the release, and `keelson rib update beads` installs it.
Use `feat` for a change an operator can see, `fix` for a bug they would hit,
and `!` after the type for a change that breaks a saved board choice, a tool's
input, or a workflow's inputs. `feat`, `fix`, `perf` and `docs` appear in the
CHANGELOG and cut a release; the other types are hidden and do not. To ship
hidden-type changes alone, squash-merge with a `Release-As: x.y.z` footer in
the commit body.

## Pull request hygiene

- One thing per PR. Split refactors out of feature work.
- The description says what changed and why now; add notes for review only
  where a reader would otherwise stop and ask.
- No abstractions ahead of a concrete second caller.
- Comments only for a non-obvious why, in one short line. What the PR changed
  belongs in the PR description, not the source.

## Security

Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes, not
as public issues.
