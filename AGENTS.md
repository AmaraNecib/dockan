# Agent notes

## Authority

- **A lane commits and reports; it does not land.** A lane (`fix-*`, `feat-*`,
  `test-*`, `chore-*`, `docs-*`, …) works in its own worktree and commits its diff. Its
  completion wakes the parent; there is no report tool to call. It **never** runs
  `git push`, **never** opens a PR (`gh pr create`) and **never** merges.
  `feature-implement` step 10 is parent-only.
- **The parent session owns push, PR, review and merge.** The parent pushes the
  lane's branch, opens the PR, requests Greptile review, drives the rounds, and
  merges — auto-merging a clean **cheap-to-reverse** PR itself (a visual one too, once its
  before/after packet is posted), and otherwise only when the owner says so (see `Merging`).
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

**Mechanism: a child agent with its own worktree, by default.** `delegate_task` with
`isolation: "worktree"` checks out the work from the parent's local commit, runs project setup,
and wakes the parent when it finishes. Prefer it to a top-level thread: no workspace to create,
none to close afterwards, and the completion arrives by itself instead of being polled.

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

Either way, one writer per worktree, and a lane never pushes or merges.

Every PR starts a FRESH worktree, a FRESH agent and a FRESH session — never
reuse a lane's session for the next PR.

**Run as many lanes as the box can carry, and an idle lane is a wasted one.** No
fixed count: measure it. A lane waiting on review, on CI or on a rebase is doing
nothing while it holds RAM and CPU, so close it the moment the parent has pushed
its branch and start the next one in the freed slot. Prefer lanes that touch
disjoint files; when two lanes share a store/router, nominate which one lands
first and rebase the other onto it. Poll CI and Greptile in-session, never the
lane.

**A lane ALWAYS gets its own workspace** — never a pane split inside the parent's
workspace (owner complaint, 2026-10-13: *"why u open the crew here in this panel;
I can't see anything"*). `delegate_task` with `isolation: "worktree"` gives it
one: it checks the work out from the parent's local commit, runs project setup,
and wakes the parent when it finishes. The `herdr worktree create` /
`herdr agent start` pair this paragraph used to prescribe went with the crew
apparatus. Two things the mechanism does not do for you: a fresh worktree has no
`node_modules`, so the lane's first command is `bun install --frozen-lockfile`,
and it starts from the parent's **commit**, so commit before delegating or the
lane cannot see the work. `t3_thread_launch` is the fallback and only for
resuming work that exists uncommitted — see Lanes above.

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

## Pick the skill before you write code

The workflow in `docs/engineering-workflow.md` and the skills in `.agents/skills/` are the
same process in two shapes: the doc is the map, the skills are the per-phase instructions a
session loads when it reaches that phase. **Read the doc, then load the skill for the phase
you are in — do not improvise a process.**

| Phase | Skill |
|---|---|
| Any code-changing issue, start to finish | `feature-implement` (the lifecycle orchestrator — read it first) |
| Design conversation before code | `grill-with-docs` |
| Review round, in order | `debate` → `test-audit` → `code-review` |
| Before the push | `guard` |
| Greptile, either path | `cli-review` |
| After a repeated failure | `capture-wisdom` (parent only) |
| Every piece of writing, always | `unslop` |

Two rules that hold across all of them: a lane **reads** wisdom and never writes it, and a
lane **commits and reports** — it never pushes, opens a PR or merges. The parent owns those,
plus CI, Greptile and the merge decision.

## Review lenses

**Every reviewed change runs all three lenses — `debate`, `test-audit`,
`code-review` — not just High-assurance** (owner decision, 2026-10-18). The tier
still decides how much scrutiny a failure mode deserves; it no longer decides
whether the debate happens. Run them in that order, each as its own sub-agent,
before the lane reports.

- **The lenses run on a different model than the author.** Author lanes run
  `zen-proxy/deepseek-v4.1-flash-free`; the three lenses run
  `zen-proxy/glm-5.3-flash-free` (both via `zen-proxy`; the `opencode*` routes
  have an expired key). A model reviewing its own diff shares the blind spots the
  lens exists to catch, so the reviewer is never the author.
- **A lane cannot self-certify a lens.** A lane that reports "I ran the debate"
  has not run it. The parent re-runs the lens where the tool exists and records
  the disclosure.
- **Evidence lands in `.scratch/reviews/<issue-id>/<head-sha>-<lens>.md`**, which
  `guard` checks before a push.
- **The lenses return findings; they do not author.** Neither reviewer writes to
  the worktree or takes the e2e slot (one full `test:e2e` run at a time). The
  authoring session applies the fixes and re-runs the lens where the tier
  requires a fresh look, so no lens ever signs off on its own edit.

## Merging

**The class decides who merges.** A lane never merges. The parent session merges a
**cheap-to-reverse, no-decision** diff itself once the gate is clean (owner decision,
2026-10-17, class A); an **expensive-to-reverse** or **decision** diff goes to the owner. The
gate is written down in [`docs/verification-and-merge-gate.md`](docs/verification-and-merge-gate.md):
the four reasons, the evidence form (visual vs measured), the owner triggers, and the queue path.

A **visual** diff is anything a browser can render — `apps/web/**`, i18n/copy, CSS/tokens,
image assets. It is **not a veto**: it auto-merges too when it is cheap to reverse, but the parent
must post the before/after table plus the video at the head **first**, so the owner can judge it
after the fact. A diff that is **visual, changes e2e behaviour, or changes wording** owes a fixed
shape in its PR evidence comment: before/after images, **a GIF that plays inline**, and the
video link (the mp4) — GitHub strips `<video>`, so the GIF is what plays. The full form is in the
gate doc §1. Everything is auto-merge eligible when all four reasons hold, every check is green
or legitimately skipped, and GitHub reports `MERGEABLE` — unless it is expensive to reverse
(migrations/schema, `packages/contracts/**`, release/deploy, outside state), encodes a decision,
or the owner asked to see it. Those go to the owner.
A **CI change** (anything under `.github/`) always goes to the owner for the diff, whatever
the class. Merge order matters when two PRs share a store/router: land the one that owns the
write path first and rebase the other onto the new develop.

**Provenance.** Every agent commit ends with `Model:` / `Thinking:` / `Harness:` / `Agent:`
trailers, and the parent repeats them in the PR body and the evidence comment. That is how a
defect is traced to the model and the thinking effort that produced it; the full form is in the
gate doc §5. A human commit carries none of them.

## Waiting on CI / Greptile

Do not hand the wait back to the user. After pushing and requesting
`@greptile-apps review`, poll in-session with `sleep`: start at ~5 minutes,
then 2-3 minutes, then 1-2 minutes, checking `gh pr checks <n>` and the
Greptile comment each time, until the verdict appears. Same for CI.

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
- `find . -not -path "*node_modules*" -name "*.ts"`;
- or name the subtree you mean: `find apps/api/src -name "*.ts"`.
