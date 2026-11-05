# Agent notes

## Before starting work

Parents and workers complete this startup check before editing, delegating implementation, or running verification:

1. Read this checkout's `AGENTS.md`, `docs/engineering-workflow.md`, and the originating issue or approved task. Identify your role, absolute worktree, branch, base and permitted writes. Preserve unrelated changes.
2. Read `feature-implement` for a code-changing task, `guard` for verification, and the skills whose descriptions match the task. Load their `SKILL.md` files, not just their names. For design and code, include `codebase-design` and `domain-modeling`; for writing, include `unslop` and, when editing agent instructions, `writing-for-agents`.
3. Read `.agents/wisdom/README.md` and the lessons relevant to the affected area. Before planning or triage, also read `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md`.
4. Record the role, scope, applicable skills and lessons in the task's local design or handoff notes. Before writing or revising a worker brief, the parent reads `writing-for-agents` and applies it to the delegation instructions. The brief names the acceptance goal, required reading, file ownership, verification, authority limits and completion criteria. A worker loads its required sources in its own session; the parent's reading does not substitute for it. If a required source is unavailable, report the gap rather than claim it was read.

## Authority

- **A lane commits and reports; it does not land.** A lane (`fix-*`, `feat-*`,
  `test-*`, `chore-*`, `docs-*`, …) owns its assigned PR worktree exclusively under the one-writer rule and commits its diff. Its completion wakes the parent; there is no report tool to call. It **never** runs
  `git push`, **never** opens a PR (`gh pr create`) and **never** merges.
  `feature-implement` step 11 is parent-only.
- **The parent coordinates; workers implement and verify.** The parent scopes work, assigns isolated writers, dispatches reviewers, checks their evidence, and handles publication and merge decisions. Workers read the required sources, implement within their assigned scope, run the applicable verification, commit and report. Read-only reviewers return findings, not edits. Parent handling of small corrections does not make it the default test runner.
- **The parent delegates heavy execution by default.** Full test suites, E2E, builds and browser runs belong to a verification worker through the heavy-work queue. The parent uses `heavy_run` itself only when the owner explicitly requests it or delegation cannot perform a necessary check. Before an exception, record the exact check, why delegation cannot do it, and why it is needed now. Convenience, a quiet worker, or wanting a second copy of an unchanged run is not a reason. The exception does not waive queue limits or other approval requirements. Reads, diff inspection, selector dry-runs, lint and typecheck remain light parent work.
- **The parent session owns push, PR, review and merge.** The parent pushes the
  lane's branch, opens the PR, verifies the selected risk-sized local review and
  configured hosted findings, then handles merge decisions. It auto-merges a clean
  **cheap-to-reverse** PR itself (a visual one too, once its before/after packet is
  posted), and otherwise waits for the owner (see `Merging`).
- **`.agents/wisdom/` is parent-owned, and reading it is every lane's job.** A
  lane reads `.agents/wisdom/` before it starts, applies what bears on its task,
  and says which lessons it applied and which it deliberately did not **in its
  commit message body**, which is the durable handoff that travels with the
  branch. Wisdom is **read-only for a lane**: it never writes the file. A
  candidate lesson also goes in the commit message body, under a `Lesson:` line,
  for the parent to promote or drop.
- **A lesson lives in a category folder, and its filename never carries a date.**
  `.agents/wisdom/<category>/<lesson>.md`: the folder is the area (`api`, `data`, `e2e`,
  `money`, `process`, `testing`, `vault`, `web`, …), the filename says what the lesson
  teaches. When a lesson recurs, **append to the existing file** and add a `Seen in:`
  line — a second dated file for the same lesson is how a lane reads one of them,
  misses the other, and re-derives it a third time. `README.md` holds the full rule. One
  occurrence is a report line, not wisdom; the parent records it when the same
  failure shows up across reports. Measured reason (2026-10-19 snapshot — re-measure
  it, it grows): 47 non-merge commits on `develop` touch `.agents/wisdom/` (48 with
  merges), six of those files carry edits from more than one commit, and one carries
  three, so lane-written lessons collided and the owner resolved the same conflict by
  hand.

## Issue scope

**Never pick up an issue numbered below 273.** That backlog is closed business: the
numbers are read-only history, not a queue. Work issues **#273 and above**, or a lower
one only when this session agreed to it in writing.

## e2e ports and lanes

`DOKAN_PORT`/`DOKAN_WEB_PORT` isolate the shared api/web pair, and the vault
spec honours `DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT` (defaults 4399/5174) for
its dedicated pair. Set both pairs per lane and vault-touching e2e runs coexist:
they no longer have to be serialized across lanes (#202).

## Lanes

**Heavy work goes through the queue.** A full test suite, `test:e2e`, a build or a browser agent takes a slot: `bun tools/heavy-slot/heavy-slot.ts run "<label>" "<command>"`. Light work — one test file, lint, typecheck — runs directly and does not take a slot.

**One writer owns the PR worktree at a time.** If the parent has an isolated worktree for this PR, it may assign that tree to one implementation worker with `delegate_task` and `isolation: "shared"`; the parent gives up edits while the worker owns it. Reviewers may share the same tree read-only at the pinned head. Freeze source during final verification and review. Before replacing a writer, cancel it and confirm it stopped. If no isolated PR worktree exists, create one through the supported T3 worktree mechanism; never use the shared project root for concurrent writes. Create another worktree only for a genuinely independent concurrent writing scope or PR. A verification runner creates no checkouts.

**Never pi's native `subagent` tool for a lane.** It runs the child inside the pi process, and T3
Code's lineage panel lists only app-owned child threads — so the owner sees no lane, concludes
nothing is happening, and cannot steer or stop work that does exist. Inside a T3 thread every lane
is `delegate_task`, with its model from `orchestrator_capabilities`, `mode: "async"` for anything
that runs minutes, and one stable `clientRequestId` per lane. The native tool is the fallback only
when `delegate_task` is missing from the toolset, and that reply says the children will not show up
in lineage. Lineage is the default view for every
child, so `delegate_task` is the mechanism for all of them — a one-line probe included. A T3 child is
its own `pi.exe` process with its own context: **6 ordinary lanes at once is the default** (the owner may raise it for
a session), while **heavy work — a full suite, `test:e2e`, a build, a browser agent — is 2 or 3 at
once across every thread**, through the slot queue. The tighter limit on lanes is the files they
edit, not their count.

A top-level thread (`t3_thread_launch`) is for the one case a fresh worktree cannot serve:
**resuming work that only exists uncommitted** in an existing worktree. That is the fallback for a
dead lane, not the default. The cheaper path through the same situation is to commit the partial
work to its branch first, after which an ordinary child can continue on that branch.

**A fresh worktree has no `node_modules`.** Worktree setup does not install. A lane must run
`bun install --frozen-lockfile` (about a minute with the warm cache) before it can run a test,
typecheck, or build, or it will fail for a reason that has nothing to do with its change. Reusing
an existing install with a directory junction is faster, but it shares one dependency tree with
the worktree it points at, so deleting `node_modules/` through the junction would delete that
worktree's packages too.

**A worktree also costs a trust decision.** Pi asks before loading a folder's skills and settings
whenever `.agents/skills` sits in it or above it, and this repository has exactly that — so every
worktree needs one. The lane roots are saved in `~/.pi/agent/trust.json`
(`D:\worktrees\mani-project`, `D:\projects\mani-worktrees`), and the closest ancestor entry covers
every worktree under it. When T3 runs Pi in RPC mode it cannot show that prompt itself, which is
why an untrusted lane surfaces as an approval card in T3 instead of a question in the terminal.

**Read-only reviewers share the checkout being reviewed.** Use `delegate_task` with `isolation: "shared"`, the absolute PR worktree path and a pinned head SHA. They read files and return findings; they do not install dependencies, build, run tests that write artifacts, or edit the checkout. Finish or cancel stale reviews before the writer changes their reviewed files.

**Retire finished helpers after handoff.** The parent transfers needed commits and evidence to the main PR checkout, checks for live processes and dependency links, then removes the helper worktree. Keep shared dependency or build targets until their consumers have moved. A review or CI wait does not need a helper checkout.

Either way, one writer per worktree, and a lane never pushes or merges.

Every PR gets a fresh isolated PR worktree and session; do not reuse another PR's worktree or lane session.

**Run as many lanes as the box can carry, and an idle lane is a wasted one.** No
fixed count: measure it. A lane waiting on review, on CI or on a rebase is doing
nothing while it holds RAM and CPU, so close it the moment the parent has pushed
its branch and start the next one in the freed slot. Prefer lanes that touch
disjoint files; when two lanes share a store/router, nominate which one lands
first and rebase the other onto it. Poll CI and the review round in-session, never
the lane.

When a separate isolated worktree is needed, use `delegate_task` with `isolation: "worktree"`; it starts from the parent's commit and has no `node_modules`, so install with `bun install --frozen-lockfile` only after checking free space. Use `t3_thread_launch` only to resume uncommitted work in an existing worktree.

Two costs, and only one of them still binds. An idle lane holds RAM and CPU for
nothing, which is why a finished lane is closed the moment its branch is pushed.
The other was the shared dev ports 4317/5173: five lanes went up at once on
2026-10-13 and each failed its own e2e run against a sibling's server. Per-lane
`DOKAN_PORT` and `DOKAN_VAULT_PORT` fixed that (#202), so the count now follows
measured capacity instead of the ports.

## Vendored skills

`.agents/skills/<x>` is the single source of truth; `.claude/skills/<x>` is
generated from it with `bun run skills:sync` and checked with
`bun run skills:check` (wired into pre-commit and CI). Never edit
`.claude/skills` by hand. The vendored TanStack skills carry local fixes, so an
upstream sync must not clobber them: their pinned upstream commits, divergence
count and re-apply checklist are in `docs/skills-vendoring.md`.

## Red-on-parent runs in CI only

The PR `checks` job runs `scripts/red-on-parent.ts` for pull requests and must pass before merge. The automated parent-checkout replay is CI-only. Parents, workers (including nested subagents) and reviewers must not run or delegate it locally, or require local replay output to accept a review, push, report or merge. Use the PR `checks` result for this gate; keep ordinary TDD and focused regression tests. Hooks and local pre-push workflows also exclude this replay. For browser verification, use the selector-first procedure in `.agents/skills/guard/SKILL.md`; inspect `bun scripts/e2e-changed.ts --dry-run` before any heavy browser run.

## Pick the skill before you write code

The workflow in `docs/engineering-workflow.md` and the skills in `.agents/skills/` are the
same process in two shapes: the doc is the map, the skills are the per-phase instructions a
session loads when it reaches that phase. **Read the doc, then load the skill for the phase
you are in — do not improvise a process.**

| Phase | Skill |
|---|---|
| Any code-changing issue, start to finish | `feature-implement` (the lifecycle orchestrator — read it first) |
| Design conversation before code | `grill-with-docs` |
| Local review | Risk-sized review under `docs/engineering-workflow.md`; when multiple lenses apply: `debate` → `test-audit` → `code-review` |
| After reviewloop's 5/5, before the merge | `improve-codebase-architecture` (parent only; the deep pass when a module, seam, adapter or interface changed) |
| Before the push | `guard` |
| Review | Risk-sized local review under `docs/engineering-workflow.md`; `reviewloop` owns evidence mechanics |
| After a repeated failure | `capture-wisdom` (parent only) |
| Every piece of writing, always | `unslop` |

Three rules that hold across all of them: a lane **reads** wisdom and never writes it, a lane
**commits and reports** — it never pushes, opens a PR or merges — and `codebase-design` plus
`domain-modeling` are **always on**, the way TDD is. They supply the words while the code is
designed and written; the deep architecture pass after reviewloop's 5/5 is only the audit that the
habit happened. The parent owns push, CI, the review round and the merge decision.

## Review lenses

The risk matrix, bounded-fix rule and mandatory local 5/5 with zero actionable findings live in [`docs/engineering-workflow.md`](docs/engineering-workflow.md). Routine changes get one focused code-review session; only a named reachable high-risk failure gets the three initial lenses. `reviewloop` owns the payload and report mechanics.

Use enabled review routes only. OpenCode is opt-in, not a quota fallback. Prefer an enabled non-author model family; the owner's standing exception allows separate same-family sessions when no independent family is available. Record actual model IDs and the existing `independence: { approvedBy, reason }` payload. The exception waives no review or finding gate. The parent verifies the exact base/head, reviewer session, model and report. Reuse valid exact-tree work. Reports stay untracked in `.scratch/reviews/`; reviewers return findings and never edit the worktree. A bounded fix gets one fresh review of the combined delta and affected callers, with unchanged conclusions carried forward; see `reviewloop`.

## Merging

**Every PR this thread opens is linked and watched in the same turn** (`link_pull_request` then
`watch_pull_request`). A watch is the only way a red check or a verdict reaches the session that can
act on it, so it is the default rather than a favour the owner has to ask for: one watch per open PR,
never dropped because a wait is long, and dropped **after** confirming a terminal state — `MERGED` or
`CLOSED` — so the thread returns to their inbox. A reopened PR is watched again; a terminal one is
never watched again.

**The class decides who merges.** A lane never merges. The parent session merges a
**cheap-to-reverse, no-decision** diff itself once the gate is clean (owner decision,
2026-10-17, class A); an **expensive-to-reverse** or **decision** diff goes to the owner. The
gate is written down in [`docs/verification-and-merge-gate.md`](docs/verification-and-merge-gate.md):
the four reasons, evidence form, required CI acceptance, owner triggers and queue path.

A **visual** diff is anything a browser can render — `apps/web/**`, i18n/copy, CSS/tokens,
image assets. It is **not a veto**: it auto-merges too when it is cheap to reverse, but the parent
must post the before/after table plus the video at the head **first**, so the owner can judge it
after the fact. A diff that is **visual, changes e2e behaviour, or changes wording** owes a fixed
shape in its PR evidence comment: before/after images, **a GIF that plays inline**, and the
video link (the mp4) — GitHub strips `<video>`, so the GIF is what plays. The full form is in the
gate doc §1. Everything is auto-merge eligible when all four reasons hold, required CI acceptance is green, every other check is green or legitimately skipped, and GitHub reports `MERGEABLE` — unless it is expensive to reverse
(migrations/schema, `packages/contracts/**`, release/deploy, outside state), encodes a decision,
or the owner asked to see it. Those go to the owner.
A **CI change** (anything under `.github/`) always goes to the owner for the diff, whatever
the class. Merge order matters when two PRs share a store/router: land the one that owns the
write path first and rebase the other onto the new develop.

**Provenance.** Every agent commit ends with `Model:` / `Thinking:` / `Harness:` / `Agent:`
trailers, and the parent repeats them in the PR body and the evidence comment. That is how a
defect is traced to the model and the thinking effort that produced it; the full form is in the
gate doc §5. A human commit carries none of them.

## Waiting on CI / review round

Do not hand the wait back to the user. A PR this thread opened is watched, and the
watch is what reports it: a red check, a new head, a verdict. Never sit in a
`gh pr checks` loop for a watched PR — that is the same as not watching it, only
busier. Poll only a PR nobody here watches, and then with `sleep`: start at
~5 minutes, then 2-3 minutes, then 1-2 minutes, checking `gh pr checks <n>` and the
review comment each time, until the requested verdict appears. Apply configured hosted-review
policy under [the active paired trial](docs/review-comparison.md). Until the owner explicitly ends it, both current-head verdicts must be 5/5 with no unresolved actionable findings. Request Greptile once per pushed head; missing credit or a missing verdict blocks merge, not local work. Same for CI.

A lane reports by finishing: its completion wakes the session. Stop and let it
finish rather than polling it.

## Search scope

Scope every search (`find`, `grep`, `rg`, glob) to this repository root or a
specific subdirectory. Never search from `/` (the filesystem root): scans of
the whole disk are slow and waste the session, and the guard refuses one before
it runs. A caller that genuinely needs one escalates to the parent session;
the guard never asks the owner.

A walk that starts at the repository root also reads `node_modules` unless you
exclude it, and that is the heaviest tree here. Reading it is a resource
decision, so pick one of these instead:

- `rg "symbol"` — ripgrep skips what `.gitignore` excludes, so start here;
- `grep -rn --exclude-dir=node_modules "symbol" .`;
- or name the subtree you mean: `find apps/api/src -name "*.ts"`. A subtree is the only
  `find` the guard runs: it refuses a bare `find .` even with `-prune`, so the pruned
  root form is not a safe recommendation.
