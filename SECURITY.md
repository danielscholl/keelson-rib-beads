# Security Policy

## Supported versions

The Beads rib is pre-1.0. Security fixes land on the latest `0.x` release only.

| Version              | Supported          |
|----------------------|--------------------|
| Latest `0.x` release | :white_check_mark: |
| Any older release    | :x:                |

## Reporting a vulnerability

**Please do not file public GitHub issues for security reports.** Report
privately through either channel:

- GitHub private vulnerability report:
  <https://github.com/danielscholl/keelson-rib-beads/security/advisories/new>
- Email **degnome@gmail.com** with the subject line `[rib-beads security]`

Include what you observed and its impact, the rib version, `keelson version`,
`bd version`, `gh --version`, your OS, and the smallest reproduction you have.
Leave out real tracker content; describe beads by shape ("an epic with three
children").

New reports are acknowledged within **3 business days**, with a fix or
mitigation plan within **14 days** of acknowledgement, sooner when there is a
public proof of concept.

## Threat model

The rib runs inside the Keelson server with the operator's privileges. It runs
`bd` and `gh` as the operator, writes to the operator's beads trackers, and
ships `beads-work`, a workflow that edits code in a worktree, pushes a branch
and opens a pull request. The model assumes the operator trusts their own
machine, the harness and the ribs they install. Hostile input may arrive from
tracker content (titles, descriptions, notes, comments, labels), from GitHub PR
data, from the repository a workflow runs against, and from board actions,
including those relayed from the sandboxed wave map frame.

### In scope

- Tracker or PR text that reaches a shell, a `bd` or `gh` argument list, or a
  filesystem path without being checked.
- A board action from the wave map frame that does anything other than select
  a bead.
- A bead closed without the operator's confirmation, or a reconciliation that
  closes a bead whose PR did not merge.
- A `beads-work` writeback or cleanup that changes a bead the run no longer
  holds, or a run that pushes outside its own branch.
- A credential (the `gh` token or anything in the operator's environment)
  written to a bead, a board frame, a snapshot, a PR body or a log.

### Out of scope

- The Keelson harness itself; report those at
  <https://github.com/danielscholl/keelson>.
- Behavior under a hostile rib, or with an attacker who already has local code
  execution, the operator's `gh` session, or write access to the tracker.
- What an agent does inside a `beads-work` run when the operator approved a
  plan that asked for it. The plan gate is the control.
- `bd`, Dolt, `gh` or model provider defects; report those upstream.

## Disclosure

Once a fix is released, a GitHub security advisory is published crediting the
reporter (unless they prefer otherwise), with a CVE where warranted.
