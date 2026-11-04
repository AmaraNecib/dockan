---
name: feature-implement
description: "Mandatory lifecycle orchestrator for code-changing issues. Delegates to implement, debate, guard and code-review; the parent session runs capture-wisdom. Read this first when the user says 'work on issue #N' or 'implement this feature'."
---

# Feature Implementation Orchestration

**Start here.** This is the mandatory entry point for all feature work.
Read `docs/engineering-workflow.md` first.

**A lane stops at step 10 (Guard Phase 2).** Steps 11-15 are parent-owned: push, PR,
CI/review round, architecture review, merge decision and wisdom. The lane hands off
its verified commit and evidence path; it never pushes, opens a PR or merges.
Workspace ownership, one-writer handoff, source freeze and reviewer sharing follow
`AGENTS.md`'s Lanes policy.

**A quiet child is not a stuck child.** A child that is thinking, waiting on a
long command, or finished touches no files, so file mtimes prove nothing about
it. Before you interrupt anything, read the child's last message and its
status: `completed` or `idle` means the turn ended, and a turn that ended
without a commit is a dead lane to relaunch (read its dirty diff first), not a
child to kill. Stopping a child on a hunch costs the hours it had already
spent. This cost six hours on one board: two lanes were killed for being
silent, and both had work in hand.

**Watch the pull requests; do not poll them.** `watch_pull_request` is the
trigger for everything a PR does: a new head, a CI run that finished, a
conflict, a review comment. It wakes the thread with the fact attached, so
the parent never has to sit in a `gh pr checks` loop and never has to guess
whether a run is still going.

**A lane never ends its turn with work in flight.** If it cannot finish the item
it is on, it commits a checkpoint — a WIP commit is fine when the message says so —
and then reports. A turn that ends with "step 2 of 3 is in flight" is a dead lane:
no wake comes, the work sits dirty in the worktree, and the next session starts by
rediscovering the state instead of continuing it. Two lanes on this board died
exactly that way, and the recovery is to read the dirty diff first, not to restart.

**Wisdom: read it, never write it.** Before step 1, grep `.agents/wisdom/` for your area
(`grep -rin "<symbol or failure mode>" .agents/wisdom/ | head -40`) and read the hits — not
all 62 files. Lessons live in per-area folders (`api/`, `data/`, `e2e/`, `money/`, `process/`,
`testing/`, `vault/`, `web/`, …); `.agents/wisdom/README.md` has the rule. Then apply
what bears on the task, and say in your **commit message body** which lessons you applied —
and which you deliberately did not. Wisdom is read-only for a lane; a candidate
lesson goes in that same body under a `Lesson:` line, which is the handoff that
travels with the branch. The parent decides whether the pattern
repeated enough to write an entry.

## Enforced order

Do not skip or reorder these steps.

### 1. Tier and base SHA

**Select review tier** from `docs/engineering-workflow.md` (Review tiers), which
defines the five High-assurance failure modes.

| Tier | When |
|------|------|
| **Lightweight** | Truly non-reviewable files only (.gitignore, LICENSE, .scratch/) |
| **Standard** | Everything else: code, tests, config, UI, API, skills, docs |
| **High-assurance** | The diff can violate one of the named failure modes in `docs/engineering-workflow.md` (Review tiers) |

Record the tier **and a one-line justification** in the design doc (step 2), so
the choice is reviewable next to the verdict. Pass the tier to `guard`.

**Resolve base commit once:**

1. Target branch is always `develop` (unless the PR specifies a different base).
2. Fetch: `git fetch origin develop`
3. Compute merge-base: `git merge-base origin/develop HEAD`
4. Record target branch name and SHA for all subsequent steps.

### 2. Design (.scratch/implementation/)

Before writing production code, create a design document:

```
.scratch/implementation/<issue-id>-design.md
```

Use this existing design note or PR handoff for the acceptance goal and a concise risk/review rationale; do not add a separate scope-note artifact. Include public interfaces, dependencies, planned tests and risks only when relevant. Compare prototypes early for uncertain visual behavior, not as a default for documents.

### 3. Implement (TDD + Playwright)

Load `implement` skill. It handles TDD at pre-agreed seams. Write tests for changed behavior and use Playwright for changed user-facing flows. Run the applicable checks from `guard` Phase 1; that skill owns the canonical command list and the Phase 2 full-suite/build requirements. Preserve Rust checks when Rust Core changes.

### 4. Guard pre-review (Phase 1)

Run `guard` Phase 1. Its check list is canonical; do not copy or narrow it here. Do not begin review until Phase 1 passes.

### 5. Quality check

Load relevant skills from the workflow's quality check table:

| If the change touches... | Load these skills |
|---|---|
| New module, interface, or architecture | `codebase-design` while writing; `improve-codebase-architecture` is the parent's step 13, after the 5/5 |
| Complex logic, state, or edge cases | `diagnosing-bugs` |
| Domain entities, terms, or data models | `domain-modeling` |
| Any production code | `code-review` |
| UI components, pages, or visual design | `frontend-design`, `web-design-guidelines` |
| Existing UI that needs polish | `redesign-existing-projects` |
| Adding/managing shadcn/ui components | `shadcn` |
| Component API design, prop proliferation | `vercel-composition-patterns` |
| React rendering performance | `vercel-react-best-practices` |
| Tauri desktop features (IPC, window, system tray) | `tauri-v2` |
| Hono API routes, middleware, validation | `hono` |
| Playwright E2E test design | `playwright-best-practices` |
| Accessibility, RTL, keyboard navigation | `accessibility` |
| React Query / TanStack Query data fetching, cache keys, invalidation | `tanstack-query` |
| TanStack Router routes, search params, loaders | `tanstack-router`, `tanstack-router-best-practices` |

### 6. Local review — every reviewable change

Select depth by reachable risk under `docs/engineering-workflow.md`. Compact Standard requires one genuine local `code-review` execution covering Standards, Spec and affected-test adequacy; record `debate` and `test-audit` skips with reasons in the renderer payload. Ordinary Standard uses all three lenses; High-assurance uses all three and a final-head debate after fixes. Use separate reviewer executions and preserve model-family independence. The handoff may supply the short author account; a fresh author-model session is not a gate. The parent verifies exact base/head, reviewer session, actual model, provenance and report. A worker's unsupported claim is not evidence, while a valid execution on the exact tree is reusable and should not be duplicated automatically. Never report a skipped lens as run.

### 7–9. Review payload and resolution

Use `.agents/skills/reviewloop/SKILL.md` for the payload format, renderer and current-head process. Every reviewable change gets local review. During the [paired trial](../../../docs/review-comparison.md), local and hosted verdicts each need 5/5 on the exact current head, with no unresolved actionable finding. Verify every finding. Fix valid blockers or hold dependent work; disputes need code evidence and reviewer resolution. A score never overrides an unresolved finding. Any code change requires applicable current-head reviews again.

### 10. Guard pre-push (Phase 2)

Commit the complete reviewable scope before running `guard` Phase 2 for the local checks below. If verification requires a fix, commit it and refresh the affected checks and stale reviews before handoff. Record post-commit results in `.scratch/reviews/<issue-id>/<head-sha>-verification.md`, not an evidence-only commit. The red-on-parent replay runs only in the PR `checks` job and must pass before merge. Parents and workers, including nested subagents, must not run or delegate it locally. A review, push or report does not require local replay output; ordinary TDD still applies.

Use `guard` Phase 2's canonical check list, including the full suite and production web build through the heavy-work queue. Do not replace either with focused checks. Follow its execution reliability rules: pinned absolute cwd/tree, unique durable streamed logs, real progress/output inspection and truthful result states. Apply `guard`'s **Browser verification: selector first** procedure when browser verification is relevant. Inspect `bun scripts/e2e-changed.ts --dry-run` before taking a heavy slot; preserve its full/affected/skip decision and evidence. The selector procedure governs final selected-scope verification; focused TDD does not replace it.
- Review evidence files exist and are not stale
- Working tree is clean

Do not trade this for a focused test run and a typecheck: that is how a red CI
run becomes the first place the lane learns a script or the production bundle
broke. A red check that cannot come from this change is still a red push — record
it, and take it to the owner instead of calling the branch green.

**Evidence staleness check:**
- Extract SHA from evidence filenames in `.scratch/reviews/<issue-id>/`
- Compare to `git rev-parse HEAD`
- If different, inspect `git diff --name-only <evidence-sha> HEAD`:
  - If any reviewable file changed → evidence is **STALE**, must regenerate
  - If only non-reviewable files (.gitignore, LICENSE, .scratch/) → valid

### 11. Report to the parent — the parent owns push and PR

**A lane stops after step 10 verifies its committed HEAD.** It reports that SHA and the local verification evidence path to the parent. It does not push, does
not open a PR and does not merge — running any command below is a breach of its
authority boundary, not help. The parent session pushes the lane's branch, opens
the PR and drives the review rounds.

Branch naming: `feat/<issue-id>-<short-description>`, `fix/<issue-id>-<description>`,
`refactor/<issue-id>-<description>`, or `agent/<description>`.

**Parent-only — a lane must not run these:**

```bash
git push origin <branch-name>
gh pr create --base develop \
  --title "<description> (closes #<issue-id>)" \
  --body "<what changed, how it was verified, and the SHA>"
```

After opening the PR, the parent publishes selected local review executions, exact SHA, verdict, finding dispositions and counts in the evidence summary.
The reports themselves stay local — `.scratch/reviews/` is gitignored, and a
committed report makes the reviewer judge our notes instead of our code, burns
credits, and makes the previous report stale.

### 12. CI + review round — parent-owned

`.github/workflows/ci.yml` runs three jobs on every PR to
`develop`: `checks` (typecheck, lint, test, audit, and the red-on-parent gate),
`e2e` (Playwright) and `rust` (cargo test + clippy). The red-on-parent gate is
CI-only and must pass before merge. A PR this thread opened is **watched**, and the watch is
what reports the run — do not sit in a `gh pr checks` loop for it. Poll only a PR
nobody here watches, and never poll a lane.
A lane cannot trigger CI or the review round at all, because it cannot push
(step 11). This wait belongs to the parent, never the lane.

The parent verifies the current-head local review and, during the paired trial, the hosted Greptile verdict using the canonical `reviewloop` and merge-gate rules. Reuse a genuine valid worker execution on the exact tree; do not rerun it just because the worker produced it. Verify each finding against the cited code and resolve it without relabeling valid findings as refinements. Both required current-head verdicts must be 5/5 with no unresolved actionable findings. A new head needs applicable review at that exact head.

### 13. Architecture review — parent-owned, only after a 5/5

Load `improve-codebase-architecture`. Run it **after reviewloop returns 5/5**, never before: the
order is lenses → push and PR → reviewloop to 5/5 → this review → fold → merge. Running it earlier
spends the budget on code whose acceptability is still in question, and a review of code that may
still be wrong is the expensive way to learn nothing.

**Budget: two passes, and the second one only if the code changed.** One pass on the
head reviewloop scored, then one more on the head that carries the fold — a fold that
touched no code needs no second pass, because the first pass still describes the
tree. That is the same rule `docs/engineering-workflow.md` states as its re-run
budget, and the two must not disagree.

**The vocabulary is cheaper and starts earlier.** While the code is being designed and written,
`codebase-design` supplies the words (module, interface, depth, seam, adapter, leverage, locality)
and `domain-modeling` keeps `CONTEXT.md` current. Those two are habits, not gates: no report, no
candidate list, no token spend beyond the conversation.

**Trigger.** If the diff adds a module, moves a seam, adds an adapter or widens an existing
interface, run the full pass and write the report to the OS temp dir — never into the repo. If it
does none of those, record the one-line form instead: `architecture: no seam moved`.

Resolve architecture findings under the same current-head 5/5 and blocker rules in `docs/engineering-workflow.md`. A substantial independent finding may move to a separate issue only when this PR does not depend on it.

**The vocabulary is always on, like TDD.** `codebase-design` supplies the words for the design
conversation and `domain-modeling` keeps `CONTEXT.md` current while the code is written — not at the
gate. The deep pass is only the audit that the habit happened.

**Token budget — spend it on the finding, not the prose.**

- Scope the walk to the modules the diff touches and their direct callers. A repo-wide sweep is
  refused, not shortened.
- At most five candidates; each is one sentence plus a deletion-test verdict.
- The HTML report goes to the OS temp dir and its path goes in the PR comment. Never paste it back
  into the conversation.
- Fold the findings once. The lenses check the fold, and a second pass is spent only when the fold changed code — the same budget `docs/engineering-workflow.md` states.
- No seam moved means no report: `architecture: no seam moved` is the whole output.

**A measured run (PR #291).** Five candidates: two re-derivations the code-review lens had already
written down, three new ones and not one of them a defect. The one thing it predicted was a
*cause* - the reason → meaning policy re-derived in three consumers, which is what produced a lens
finding the lens had found as a symptom. Read a candidate that way: a cause of an existing finding
is worth folding, a candidate that only consolidates is an issue and never a fix on a bug-fix PR.

### 14. Guard pre-report (Phase 3) — parent-owned

The parent runs `guard` Phase 3. Verifies:
- Checks — local gates green, plus CI when the branch has it
- PR description — accurate and complete
- Only reviewer-accepted nonblocking follow-ups, with issue links; no valid blocker is deferred

There is **no lane wisdom step.** A lane states in its commit message body which lessons it
applied and carries any candidate lesson there; the parent writes
a `.agents/wisdom/` entry (via `capture-wisdom`) only when the same failure has
occurred more than once.

### 15. Report to the owner — parent-owned

The parent reports: PR link, local and CI check status, both trial verdicts, finding dispositions and reviewer-accepted nonblocking follow-ups.

## Merge rules

**Parent-only — a lane never merges at all.** The class decides who merges: a
cheap-to-reverse diff with no decision in it merges itself once the gate is
clean, and an expensive-to-reverse or decision diff waits for the owner's word.
A current-head 5/5 with no unresolved actionable findings, plus every CI check green, is the **bar to merge at all**. Auto-merging below it is not allowed, and a REFUSED verdict never merges. While the A/B runs, a Greptile
verdict that disagrees is investigated before the merge.

The gate is [`docs/verification-and-merge-gate.md`](../../../docs/verification-and-merge-gate.md):
the four reasons, the evidence form (visual vs measured), the AUTO/OWNER/REFUSED
decision, and the queue path when it cannot merge now. `crew-mergeable.ts --selftest`
proves the scripted half.

Apply the four-part merge gate in `docs/verification-and-merge-gate.md`. A clean review is not a substitute for its CI, mergeability, evidence or owner-trigger checks.

**Parent-only command:**
```bash
gh pr merge <num> --squash --subject "<title> (closes #<issue>)"
```

A **CI change** (anything under `.github/`) goes to the owner for the diff before
it merges, whatever the review says.

## Where to start

| State | Start at |
|-------|----------|
| Nothing exists | Read workflow + wisdom |
| No design doc | Step 2 — design |
| Code not written | Step 3 — implement |
| Guard Phase 1 not run | Step 4 — guard pre-review |
| No quality check | Step 5 — quality check |
| Local review missing | Risk-sized local review under the workflow policy |
| Review payload missing or stale | Parent only — Step 12 (current-head review) |
| Guard Phase 2 not run | Step 10 — guard pre-push |
| Lane done, not pushed | Parent only — Step 11 (push + PR) |
| Review round not clean | Parent only — Step 12 (CI + review round) |
| reviewloop 5/5, architecture not reviewed | Parent only — Step 13 (architecture review) |
| All done | Parent only — Steps 14-15 (guard pre-report, then report to the owner) |
