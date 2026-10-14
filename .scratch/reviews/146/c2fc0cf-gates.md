# #146 guard record (PR #188 review-fix round 2)

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens.
- **Tier:** Standard (web UI).
- **Base SHA:** `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`, still
  the merge-base with `HEAD`).
- **Code SHA (the tree these gates ran against):** `c2fc0cf926bf57602715660ca9d264ba238b3e3c`
- **Supersedes:** `41c5fcd-gates.md`.

## Guard Phase 1 and Phase 2

| # | command | exit | result |
|---|---|---|---|
| 1 | `bun run typecheck` | 0 | `Tasks: 3 successful, 3 total` |
| 2 | `bun run lint` | 0 | `oxlint` with no findings |
| 3 | `bun run test` | 0 | `915 pass / 0 fail`, 69 files, 4734 assertions |
| 4 | `DOKAN_PORT=4621 DOKAN_WEB_PORT=5477 bun run test:e2e` | 0 | `55 passed` (5.0m) |
| 5 | `git status` | 0 | clean after restoring `.dokan-port` |

Notes:

- The change touches no Rust (`apps/desktop/src-tauri/`), so the cargo gates do
  not apply.
- The e2e run used an isolated port pair because a sibling lane
  (`feat-184-server-name-resolution`) was running its own Playwright suite at the
  same time; 4617/5473 were occupied by stale listeners, so 4621/5477 were used.
  See `.agents/wisdom/2026-10-15-concurrent-lane-e2e-ports.md`.
- The api writes the chosen port into the tracked `.dokan-port`; it was restored
  to `4317` before the evidence commit so the tree is clean.
- The pre-commit hook (oxlint, then `tsc --noEmit` in `apps/api`) ran on the
  commit and passed.

### Falsification runs (red before green)

| run | exit | result |
|---|---|---|
| pre-fix sources at `dfe1ed8`, new quantity tests kept | 1 | 2 fail — both received the payment message |
| discount block moved back after `resolveInitialPaid` | 1 | 1 fail — received `saleInvalidPaid`, not `saleInvalidDiscount` |

Both were reverted; the tests pass on the final tree.

## Guard Phase 2 evidence checks

Every file in `.scratch/reviews/146/` carries `c2fc0cf`, the code SHA.
`git diff --name-only c2fc0cf HEAD` after the evidence commit lists only the four
evidence files under `.scratch/reviews/146/`, which the guard treats as
non-reviewable, so the evidence is valid for the branch.

- `c2fc0cf-debate.md` (critic + defender; the discount finding)
- `c2fc0cf-test-audit.md` (edge cases, coverage, test quality)
- `c2fc0cf-code-review.md` (Standards axis + Spec axis, incl. the stale Greptile finding)
- `c2fc0cf-gates.md` (this file)

## Guard Phase 3

| check | status |
|---|---|
| local checks green | yes (table above) |
| review evidence current for the tier | yes |
| Greptile CLI for the final HEAD with no actionable findings | **not run locally**: `greptile review` exits 1 with "this review is too large to send" (see `.agents/wisdom/2026-08-24-greptile-cli-large-diff.md`), and the hosted path needs a push, which this lane is forbidden to do. The parent should re-run the hosted review on the new commit. |
| CI | the repo has no CI workflow, so the local Guard Phase 2 run is the gate |
| PR description | not applicable from this lane; the parent owns the PR |
| deferred items documented | yes: design doc section 8, the debate and test-audit evidence, and the handoff report |
| wisdom captured | existing entries apply (concurrent-lane ports, shared-reset drops state); no new durable lesson this round |

The Greptile gap is a lane constraint (no push allowed), not a clean result.
