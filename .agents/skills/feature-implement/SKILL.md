---
name: feature-implement
description: "Mandatory lifecycle orchestrator for code-changing issues. Delegates to implement, debate, guard and code-review; the parent session runs capture-wisdom. Read this first when the user says 'work on issue #N' or 'implement this feature'."
---

# Feature Implementation Orchestration

**Start here.** This is the mandatory entry point for all feature work.
Read `docs/engineering-workflow.md` first.

**A lane stops at step 9 (Guard Phase 2).** Steps 10-14 are parent-owned: push, PR,
CI/Greptile, the architecture review, the merge decision and wisdom. The lane's
last act is its **commit**; its completion wakes the parent. It never pushes,
never opens a PR and never merges.

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

The design must specify:
- The chosen review tier and a one-line justification (step 1)
- Public API / component interfaces
- Dependencies
- Planned tests (unit + Playwright E2E)
- Implementation risks

### 3. Implement (TDD + Playwright)

Load `implement` skill. It handles TDD at pre-agreed seams.

**Every feature MUST include:**

- **Unit tests** for business logic (via `bun run test`; `bun test` in apps/api)
- **Playwright E2E tests** for the user-facing flow, added to `tests/e2e/`
- Run `bun run typecheck && bun run test` during implementation

If the feature touches the Rust Core (`apps/desktop/src-tauri/src/`), also run:
```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings
```

### 4. Guard pre-review (Phase 1)

Run `guard` Phase 1 (pre-commit) to confirm everything compiles:
- `bun run typecheck`
- `bun run lint`
- `bun run test`

If the feature touches Rust Core, also run:
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings`

Do NOT proceed to reviews until this passes.

### 5. Quality check

Load relevant skills from the workflow's quality check table:

| If the change touches... | Load these skills |
|---|---|
| New module, interface, or architecture | `codebase-design` while writing; `improve-codebase-architecture` is the parent's step 12, after the 5/5 |
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

### 6. Debate — every reviewed change (Standard and High-assurance)

Load `debate` with resolved base SHA. Saves evidence to
`.scratch/reviews/<issue-id>/<head-sha>-debate.md`.

Run this lens, `test-audit` and `code-review` on `zen-proxy/minimax-m3.1-flash-free` —
never on the model that wrote the diff (`opencode-go/deepseek-v4.1-flash`). When MiniMax is down,
`zen-proxy/beam-free` is the free reviewer. The
reviewer is never the author. A lane that reports "I ran the debate" has not run
it; the parent re-runs the lens and records the disclosure.

### 7. Test audit — Standard and High-assurance

Load `test-audit` with resolved base SHA. Saves evidence to
`.scratch/reviews/<issue-id>/<head-sha>-test-audit.md`.

**Checks performed:**
- Edge case coverage (empty states, error states, boundary values)
- Test quality (meaningful assertions, not just "doesn't crash")
- E2E coverage (critical user path is tested via Playwright)
- No shallow/missing tests

### 8. Pre-push self-review (code-review)

Run `code-review` skill against `git diff <base-sha>...HEAD`. Save output to
`.scratch/reviews/<issue-id>/<head-sha>-code-review.md`.

### 9. Guard pre-push (Phase 2)

Run `guard` Phase 2. Verifies:
- All checks pass (typecheck, lint, tests, e2e when UI changed)
- `bun scripts/red-on-parent.ts` — every test file the change **adds** is red on
  the parent, or carries a `red-on-parent-waive` line. New files only.
- Review evidence files exist and are not stale
- Working tree is clean

**Evidence staleness check:**
- Extract SHA from evidence filenames in `.scratch/reviews/<issue-id>/`
- Compare to `git rev-parse HEAD`
- If different, inspect `git diff --name-only <evidence-sha> HEAD`:
  - If any reviewable file changed → evidence is **STALE**, must regenerate
  - If only non-reviewable files (.gitignore, LICENSE, .scratch/) → valid

### 10. Report to the parent — the parent owns push and PR

**A lane stops at step 9.** Its last act is its **commit**. It does not push, does
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

After opening the PR, the parent publishes a concise review-evidence summary as a
PR comment: the three lens names, the SHA they read, the verdict and the counts.
The reports themselves stay local — `.scratch/reviews/` is gitignored, and a
committed report makes the reviewer judge our notes instead of our code, burns
credits, and makes the previous report stale.

### 11. CI + Greptile — parent-owned

`.github/workflows/ci.yml` runs three jobs on every PR to
`develop`: `checks` (typecheck, lint, test, audit), `e2e` (Playwright) and `rust`
(cargo test + clippy). Poll them in-session with `sleep`, never by polling a lane.
A lane cannot trigger CI or a Greptile review at all, because it cannot push
(step 10). This wait belongs to the parent, never the lane.

Then the parent triggers Greptile:
- CLI path (preferred): the parent runs the `cli-review` skill (`greptile review --json`) against the pinned base
- PR path: the parent comments `@greptile-apps review` in the PR

**Verify every finding against the code before fixing it.** Greptile edits its
comment in place and can re-list findings a later commit already fixed. On #188 a
third of the reported findings was already implemented; on #190 and #184 two were.
Read the cited lines, and when a finding is stale, close it on the PR with the
line evidence instead of re-implementing the fix.

Repeat until Greptile passes with no actionable findings.

### 12. Architecture review — parent-owned, only after a 5/5

Load `improve-codebase-architecture`. Run it **after Greptile returns 5/5**, never before: the
order is lenses → push and PR → Greptile to 5/5 → this review → fold → merge. Running it earlier
spends the budget on code whose acceptability is still in question, and a review of code that may
still be wrong is the expensive way to learn nothing.

**The vocabulary is cheaper and starts earlier.** While the code is being designed and written,
`codebase-design` supplies the words (module, interface, depth, seam, adapter, leverage, locality)
and `domain-modeling` keeps `CONTEXT.md` current. Those two are habits, not gates: no report, no
candidate list, no token spend beyond the conversation.

**Trigger.** If the diff adds a module, moves a seam, adds an adapter or widens an existing
interface, run the full pass and write the report to the OS temp dir — never into the repo. If it
does none of those, record the one-line form instead: `architecture: no seam moved`.

**What it finds is a loop, not a one-shot.** A finding has exactly three ways out:

```
Greptile 5/5?  ── no ──→ fix ──→ ask once more at the new head
      ↓ yes
architecture review (this diff only)
      ↓
finding about this diff?
      ├─ nothing ────→ merge
      ├─ fixable here ──→ fix → push → Greptile 5/5 → review again (two rounds max)
      └─ too big for this PR ──→ its own issue + its own PR/lane → merge this one on its 5/5
```

**Small fix here, big fix elsewhere.** A finding the diff can absorb is fixed on this branch; the
head moves, so Greptile is asked once more. A finding that needs its own PR — a seam move, a
deepening across several modules — does not hold this PR hostage: it gets an issue and a lane, and
this PR merges on the 5/5 it already has. What it does not do is vanish: read the evidence comment
before merging and confirm the follow-up issue number is in it.

**Stop rule: two rounds, then the owner.** A second review that still finds something is a
disagreement about the design, not a detail — the owner decides. Round three spends Greptile credit
and never converges.

**Scope is always the diff under review.** A finding about older code becomes an issue, never a loop
iteration, or the loop never terminates. A review that finds nothing about this diff costs nothing.
The report ends by asking the owner which candidate to explore, so carry its path and the candidate
list into the PR evidence comment.

**The vocabulary is always on, like TDD.** `codebase-design` supplies the words for the design
conversation and `domain-modeling` keeps `CONTEXT.md` current while the code is written — not at the
gate. The deep pass is only the audit that the habit happened.

**Token budget — spend it on the finding, not the prose.**

- Scope the walk to the modules the diff touches and their direct callers. A repo-wide sweep is
  refused, not shortened.
- At most five candidates; each is one sentence plus a deletion-test verdict.
- The HTML report goes to the OS temp dir and its path goes in the PR comment. Never paste it back
  into the conversation.
- Fold the findings once. Do not re-run the review after the fold — the lenses check the fold.
- No seam moved means no report: `architecture: no seam moved` is the whole output.

**A measured run (PR #291).** Five candidates: two re-derivations the code-review lens had already
written down, three new ones and not one of them a defect. The one thing it predicted was a
*cause* - the reason → meaning policy re-derived in three consumers, which is what produced a lens
finding the lens had found as a symptom. Read a candidate that way: a cause of an existing finding
is worth folding, a candidate that only consolidates is an issue and never a fix on a bug-fix PR.

### 13. Guard pre-report (Phase 3) — parent-owned

The parent runs `guard` Phase 3. Verifies:
- Checks — local gates green, plus CI when the branch has it
- PR description — accurate and complete
- Any deferred items — documented with follow-up issues

There is **no lane wisdom step.** A lane states in its commit message body which lessons it
applied and carries any candidate lesson there; the parent writes
a `.agents/wisdom/` entry (via `capture-wisdom`) only when the same failure has
occurred more than once.

### 14. Report to the owner — parent-owned

The parent reports: PR link, check status (local + CI), Greptile verdict, any deferred items.

## Merge rules

**Parent-only — a lane never merges at all.** The class decides who merges: a
cheap-to-reverse diff with no decision in it merges itself once the gate is
clean, and an expensive-to-reverse or decision diff waits for the owner's word.
A 5/5 Greptile verdict with no findings, anchored to the current head SHA, and
every CI check green is the **bar to merge at all** — auto-merging below it is
not allowed, and a REFUSED verdict never merges.

The gate is [`docs/verification-and-merge-gate.md`](../../../docs/verification-and-merge-gate.md):
the four reasons, the evidence form (visual vs measured), the AUTO/OWNER/REFUSED
decision, and the queue path when it cannot merge now. `crew-mergeable.ts --selftest`
proves the scripted half.

Ask, and wait. Do not treat a clean review as consent, and do not merge "since it
is green anyway".

**Parent-only command:**
```bash
gh pr merge <num> --squash --subject "<title> (closes #<issue>)"
```

A **CI change** (anything under `.github/`) goes to the owner for the diff before
it merges, whatever Greptile says.

## Where to start

| State | Start at |
|-------|----------|
| Nothing exists | Read workflow + wisdom |
| No design doc | Step 2 — design |
| Code not written | Step 3 — implement |
| Guard Phase 1 not run | Step 4 — guard pre-review |
| No quality check | Step 5 — quality check |
| No debate | Step 6 — debate |
| No test audit | Step 7 — test audit |
| No code-review | Step 8 — code-review |
| Guard Phase 2 not run | Step 9 — guard pre-push |
| Lane done, not pushed | Parent only — Step 10 (push + PR) |
| Greptile not clean | Parent only — Step 11 (CI + Greptile) |
| Greptile 5/5, architecture not reviewed | Parent only — Step 12 (architecture review) |
| All done | Parent only — Steps 13-14 (guard pre-report, then report to the owner) |
