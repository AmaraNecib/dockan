# #146 guard record (PR #188 review-fix round)

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens.
  This file covers the PR #188 review-fix round.
- **Tier:** Standard (web UI).
- **Base SHA:** `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop` at the time
  the base was pinned, and still the merge-base with `HEAD`).
- **Code SHA (the tree these gates ran against):** `41c5fcdc39c56f3ca4c5a3369b2ee83cf3fbb06e`
- **Supersedes:** `6e0d153-gates.md`.

## Guard Phase 1 and Phase 2

| # | command | exit | result |
|---|---|---|---|
| 1 | `bun run typecheck` | 0 | `Tasks: 3 successful, 3 total` |
| 2 | `bun run lint` | 0 | `oxlint` with no findings |
| 3 | `bun run test` | 0 | `912 pass / 0 fail`, 69 files, 4716 assertions |
| 4 | `DOKAN_PORT=4617 DOKAN_WEB_PORT=5473 bun run test:e2e` | 0 | `55 passed` (8.5m) |
| 5 | `git status` | 0 | clean |

Notes:

- The change touches no Rust (`apps/desktop/src-tauri/`), so the cargo gates do
  not apply.
- The e2e run used an isolated port pair because sibling lanes were running
  Playwright suites concurrently. See
  `.agents/wisdom/2026-10-15-concurrent-lane-e2e-ports.md`. The vault spec
  hardcodes its own ports (4399/5174), so it cannot be isolated by env; one full
  run failed there and the next passed, recorded in the test-audit evidence.
- The pre-commit hook (oxlint, then `tsc --noEmit` in `apps/api`) ran on every
  commit and passed.

## Guard Phase 2 evidence checks

Each file in `.scratch/reviews/146/` carries `41c5fcd`, which is the code SHA.
`git diff --name-only 41c5fcd HEAD` after the evidence commit lists only the four
evidence files under `.scratch/reviews/146/`, which the guard treats as
non-reviewable, so the evidence is valid for the branch.

- `41c5fcd-debate.md` (critic + defender, four rounds)
- `41c5fcd-test-audit.md` (edge cases, coverage, test quality)
- `41c5fcd-code-review.md` (Standards axis + Spec axis, including the Greptile finding)
- `41c5fcd-gates.md` (this file)

## Guard Phase 3

| check | status |
|---|---|
| local checks green | yes (table above) |
| review evidence current for the tier | yes |
| Greptile CLI for the final HEAD with no actionable findings | **not run locally**: `greptile review --json --branch develop` exits 1 with "this review is too large to send" (see `.agents/wisdom/2026-08-24-greptile-cli-large-diff.md`), and the hosted path needs a push, which this lane is forbidden to do. Greptile's hosted review of PR #188 is what opened this round, at 4/5 with one finding; that finding is fixed here and the parent should re-run the hosted review on the new commit. |
| CI | the repo has no CI workflow, so the local Guard Phase 2 run is the gate |
| PR description | not applicable from this lane; the parent owns the PR |
| deferred items documented | yes, design doc section 8 plus the debate and test-audit evidence |
| wisdom captured | yes: `2026-10-15-shared-reset-drops-per-caller-state.md`, plus the earlier concurrent-ports and money-reader notes |

The Greptile gap is a lane constraint (no push allowed), not a clean result.
