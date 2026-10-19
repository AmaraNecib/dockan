---
name: feature-implement
description: "Mandatory lifecycle orchestrator for code-changing issues. Delegates to implement, debate, guard and code-review; the parent session runs capture-wisdom. Read this first when the user says 'work on issue #N' or 'implement this feature'."
---

# Feature Implementation Orchestration

**Start here.** This is the mandatory entry point for all feature work.
Read `docs/engineering-workflow.md` first.

**A lane stops at step 9 (Guard Phase 2).** Steps 10-13 are parent-owned: push,
PR, CI/Greptile, the merge decision and wisdom. The lane's last act is its
**commit**; its completion wakes the parent. It never pushes, never opens a PR
and never merges.

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
| New module, interface, or architecture | `codebase-design` |
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

Run this lens, `test-audit` and `code-review` on `opencode-go/deepseek-v4.1-flash`, the same
model that wrote the diff (owner decision, 2026-10-19: one model for every sub-agent, so the
reviewer-is-never-the-author separation is not available). The reviewer is never the author, so
a lens report states plainly that its round had no model separation. A lane that reports "I ran
the debate" has not run
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
  --body "See .scratch/reviews/<issue-id>/ for review evidence"
```

After opening the PR, the parent publishes a concise review-evidence summary as a
PR comment.

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

### 12. Guard pre-report (Phase 3) — parent-owned

The parent runs `guard` Phase 3. Verifies:
- Checks — local gates green, plus CI when the branch has it
- PR description — accurate and complete
- Any deferred items — documented with follow-up issues

There is **no lane wisdom step.** A lane states in its commit message body which lessons it
applied and carries any candidate lesson there; the parent writes
a `.agents/wisdom/` entry (via `capture-wisdom`) only when the same failure has
occurred more than once.

### 13. Report to the owner — parent-owned

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
| All done | Parent only — Steps 12-13 (guard pre-report, then report to the owner) |
