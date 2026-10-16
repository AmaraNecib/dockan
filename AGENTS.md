# Agent notes

## Authority

- **A lane commits and reports; it does not land.** A lane (`fix-*`, `feat-*`,
  `test-*`, `chore-*`, `docs-*`, …) works in its own worktree, commits its diff
  and calls `crew_report`. It **never** runs `git push`, **never** opens a PR
  (`gh pr create`) and **never** merges. `feature-implement` step 10 is
  parent-only.
- **The parent session owns push, PR, review and merge.** The parent pushes the
  lane's branch, opens the PR, requests Greptile review, drives the rounds and
  merges — only when the owner says so (see `Merging`).
- **`.agents/wisdom/` is parent-owned, and reading it is every lane's job.** A
  lane reads `.agents/wisdom/` before it starts, applies what bears on its task
  and says in its `crew_report` which lessons it applied, and which it
  deliberately did not. Wisdom is **read-only for a lane**: it never writes the
  file. A candidate lesson goes in the `lesson` field of `crew_report` (a harness
  without that field carries it in the report summary).
- **The parent writes the entry, and only for a repeated pattern.** One
  occurrence is a report line, not wisdom; the parent records it when the same
  failure shows up across reports. Measured reason: 45 non-merge commits on
  `develop` touch `.agents/wisdom/` (46 with merges), six of those files carry
  edits from more than one commit, and one carries three, so lane-written lessons
  collided and the owner resolved the same conflict by hand.

## e2e ports and lanes

`DOKAN_PORT`/`DOKAN_WEB_PORT` isolate the shared api/web pair, and the vault
spec honours `DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT` (defaults 4399/5174) for
its dedicated pair. Set both pairs per lane and vault-touching e2e runs coexist:
they no longer have to be serialized across lanes (#202).

## Lanes

Every PR starts a FRESH worktree, a FRESH agent and a FRESH session — never
reuse a lane's session for the next PR (a reused session also misses the
workspace label at startup, which is what makes `crew_report` work).

Name the herdr workspace label so it matches `/^(issue|rev|pr|feat|fix|chore|docs|test|build|ci|perf|style)-/`
AND name the manifest `<worktree>/.scratch/sessions/crew/<label>.manifest.json`
expected by `crew-watch`. `herdr workspace rename <id> <label>` takes the label
positionally (no `--label` flag).

**Three lanes at a time, and an idle lane is a wasted one.** Close a lane's
workspace the moment the parent has pushed its branch: a lane waiting on review
(or on a rebase) is doing nothing while it holds RAM and CPU. Close first, then
start the next lane in the freed slot. Prefer lanes that touch disjoint files;
when two lanes share a store/router, nominate which one lands first and rebase
the other onto it. Poll CI and Greptile in-session, never the lane.

**A lane ALWAYS gets its own workspace** — never a pane split inside the parent's
workspace (owner complaint, 2026-10-13: *"why u open the crew here in this panel;
I can't see anything"*). Create lanes with `herdr worktree create` (new branch)
or `herdr worktree open --path <worktree> --label <label>` (re-entering an
existing worktree). Pass `--cwd` and VERIFY the pane's cwd before
`herdr agent start`: a bare `herdr pane run "cd ..."` silently leaves the agent in
the MAIN repo (owner complaint, same day).

Why the lane limit is hard: five lanes went up at once on 2026-10-13, so finished
lanes sat idle while new ones spawned, and sibling lanes fought over the shared
dev ports 4317/5173 — each failing its own e2e run against the other's server.

## Vendored skills

`.agents/skills/<x>` is the single source of truth; `.claude/skills/<x>` is
generated from it with `bun run skills:sync` and checked with
`bun run skills:check` (wired into pre-commit and CI). Never edit
`.claude/skills` by hand. The vendored TanStack skills carry local fixes, so an
upstream sync must not clobber them: their pinned upstream commits, divergence
count and re-apply checklist are in `docs/skills-vendoring.md`.

## Merging

**Merge only when the owner says to merge.** The agent never merges on its own
initiative, whatever the review says — 5/5 with no findings and every check green
is the *bar to ask*, not permission. A **CI change** (anything under `.github/`)
additionally goes to the owner for the diff. Merge order matters when two PRs
share a store/router: land the one that owns the write path first and rebase the
other onto the new develop.

## Waiting on CI / Greptile

Do not hand the wait back to the user. After pushing and requesting
`@greptile-apps review`, poll in-session with `sleep`: start at ~5 minutes,
then 2-3 minutes, then 1-2 minutes, checking `gh pr checks <n>` and the
Greptile comment each time, until the verdict appears. Same for CI.

A crew lane reports on its own (`crew_report` wakes the session) — stop and
let it report. Never poll a lane.

## Search scope

Scope every filesystem search (`find`, `grep`, `rg`, glob) to this repository
root or a specific subdirectory — e.g. `find . -name "*.ts"` from the repo
root. Never search from `/` (the filesystem root): scans of the whole disk are
slow and waste the session.
