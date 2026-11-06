---
name: feature-implement
description: "Mandatory lifecycle orchestrator for code-changing issues. Coordinates implementation, risk-sized review and guard; the parent owns publication, merge and wisdom. Read this first when the user says 'work on issue #N' or 'implement this feature'."
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

Select the review tier from `docs/engineering-workflow.md` (Review tiers), which names elevated reachable failure modes.

| Tier | When |
|------|------|
| **Lightweight** | Truly non-reviewable files only (.gitignore, LICENSE, .scratch/) |
| **Standard** | Everything else: code, tests, config, UI, API, skills, docs |
| **High-assurance** | A concrete reachable failure mode in `docs/engineering-workflow.md` (Review tiers) needs three initial lens sessions |

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

For an issue that changes UI, load `impeccable` and critique the incumbent surface before the first UI edit. Treat Dokan app surfaces as Operate mode. A narrow refinement preserves the incumbent visual identity, behavior, and content; ask the owner before a broader redesign or unrelated copy or claim changes.

Use the critique to define one bounded improvement pass, then inspect the result once in a batch and confirm at most once after fixes. Before editing UI, read `impeccable/reference/craft-floor.md`. Keep keyboard, RTL, relevant states, and any required before/after element evidence and video/GIF in scope. Impeccable guides design work; it does not replace behavior tests, accessibility checks, code review, or the existing merge gate.

Follow the skill's setup and supply-chain guards: if its launcher is unavailable or would download code, use its documented direct-context fallback without installing or fetching anything. Do not create PRODUCT.md or DESIGN.md, or run init/doctor, as a prerequisite for a narrow refinement.

Load `implement` skill. It handles TDD at pre-agreed seams. Write tests for changed behavior and use Playwright when changed UI behavior needs browser proof. Run applicable focused checks from `guard`; the guard defines when CI-final checks can replace routine full local runs. Preserve Rust checks when Rust Core changes.

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
| UI components, pages, or visual design | `impeccable` |
| Adding/managing shadcn/ui components | `shadcn` |
| Component API design, prop proliferation | `vercel-composition-patterns` |
| React rendering performance | `vercel-react-best-practices` |
| Tauri desktop features (IPC, window, system tray) | `tauri-v2` |
| Hono API routes, middleware, validation | `hono` |
| Playwright E2E test design | `playwright-best-practices` |
| Accessibility, RTL, keyboard navigation | `accessibility` |
| React Query / TanStack Query data fetching, cache keys, invalidation | `tanstack-query` |
| TanStack Router routes, search params, loaders | `tanstack-router`, `tanstack-router-best-practices` |

Commit the complete reviewable scope before step 6. Pin that committed HEAD for every local reviewer and the renderer; they do not review uncommitted changes. After any review fix, commit it before refreshing affected checks and current-head reviews. Keep source frozen while reviewers read.

### 6. Risk-sized local review

Apply the review tiers in `docs/engineering-workflow.md`. Routine reversible localized changes get one fresh `code-review` context covering Standards, Spec and affected-test adequacy. High-assurance requires three distinct initial lens sessions for a named reachable failure mode. Do not fan out specialists without a concrete unanswered question. The handoff may supply the author account; a fresh author-review session is not required. Verify exact-tree executions and never claim a skipped lens ran.

### 7–9. Findings and bounded fixes

Use `.agents/skills/reviewloop/SKILL.md` for renderer mechanics. Every reviewable change requires current-head local reviewloop 5/5 and zero unresolved actionable findings. Verify each finding against source. After a bounded fix, commit it and run affected checks; one fresh reviewer checks the combined delta and direct callers, carrying unchanged prior conclusions forward explicitly. Rerun another lens only for a new concrete risk it covers. A score never excuses an actionable finding. CI acceptance remains pending until publication and is mandatory before merge.

### 10. Guard pre-push (Phase 2)

Use the committed, locally reviewed HEAD from steps 6–9 when running `guard` Phase 2 for the local checks below. If verification requires a fix, commit it and refresh the affected checks and stale reviews before handoff. Record post-commit results in `.scratch/reviews/<issue-id>/<head-sha>-verification.md`, not an evidence-only commit. The red-on-parent replay runs only in the PR `checks` job and must pass before merge. Parents and workers, including nested subagents, must not run or delegate it locally. A review, push or report does not require local replay output; ordinary TDD still applies.

Use `guard` Phase 2's risk-sized local checks. The parent explicitly passes the verification mode after checking current activation requirements in `docs/engineering-workflow.md`; inherit that mode without rediscovering activation. Routine full-suite, full-browser, production-build and audit checks are CI-final; run them locally only for a concrete uncertainty or CI coverage gap. A real enforcement regression blocks and goes to the owner; it does not silently restore full local execution. Follow guard's execution reliability rules: pinned absolute cwd/tree, unique durable logs, real output inspection and truthful result states. For relevant browser verification, inspect `bun scripts/e2e-changed.ts --dry-run` before a heavy run and retain its scope decision. The red-on-parent replay runs only in the PR `checks` job and must pass before merge. Parents and workers, including nested subagents, must not run or delegate it locally. Ordinary failing-first TDD still applies.
- Review evidence files exist and are not stale
- Working tree is clean

Focused local checks satisfy the local gate when they cover changed behavior and direct callers. Record a concrete uncertainty or CI coverage gap before adding a full local run. Record any failed check and resolve it before claiming its gate passed; an unrelated failure is not a pass.

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

### 12. CI and hosted review — parent-owned

The parent publishes the branch and verifies `.github/workflows/ci.yml`'s required checks on the current head. `CI acceptance` must pass before merge. This policy PR may be published with that check pending after focused local proof and review; it is not merge-ready. The parent also owns the [paired hosted-review gate](../../../docs/review-comparison.md). Until the owner explicitly ends the trial, both current-head verdicts must be 5/5 with no unresolved actionable findings. Request Greptile once per pushed head; a missing verdict blocks merge, including when credit is unavailable. This does not restart or duplicate local lens executions. Reuse valid exact-tree executions and resolve every actionable finding against source.

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

The parent reports: PR link, local and CI check status, the configured review verdicts, finding dispositions and reviewer-accepted nonblocking follow-ups.

## Merge rules

**Parent-only — a lane never merges at all.** The class decides who merges: a
cheap-to-reverse diff with no decision in it merges itself once the gate is
clean, and an expensive-to-reverse or decision diff waits for the owner's word.
A current-head local 5/5 with no unresolved actionable findings and green, enforced CI acceptance are mandatory for merge. An unresolved actionable finding blocks merge at any score. The [paired hosted-review gate](../../../docs/review-comparison.md) remains active until the owner explicitly ends it; a missing hosted verdict blocks merge.

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
| Local review payload missing or stale | Steps 7–9 before Guard Phase 2 |
| Guard Phase 2 not run | Step 10 — guard pre-push |
| Lane done, not pushed | Parent only — Step 11 (push + PR) |
| Review round not clean | Parent only — Step 12 (CI + review round) |
| reviewloop 5/5, architecture not reviewed | Parent only — Step 13 (architecture review) |
| All done | Parent only — Steps 14-15 (guard pre-report, then report to the owner) |
