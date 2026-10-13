# Guard — issue #176, Greptile round-2 fix (High-assurance)

Reviewed SHA: `8e567c4` (base `1840a3a`; round-2 fix `f7e7661..8e567c4`).
Previous review evidence archived under `.scratch/reviews/176/superseded/`.

## Phase 1 — pre-commit

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 workspaces pass |
| lint | `bun run lint` | 0 errors (oxlint) |
| tests | `bun run test` | api 787 pass / 0 fail; web 816 pass / 0 fail |

The Husky pre-commit hook (`oxlint`) ran on every commit.

## Phase 2 — pre-push

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 pass |
| lint | `bun run lint` | 0 errors |
| tests | `bun run test` | api 787 pass; web 816 pass; 0 fail |
| e2e (UI changed) | `bunx playwright test` | 53 passed (3.6m), incl. `supplier-adjustment.spec.ts` |
| working tree | `git status --short` | clean after the evidence commit |
| evidence | `.scratch/reviews/176/8e567c4-{debate,test-audit,code-review}.md` | present and current |

Note: this repo has no `test:e2e` root script, so Playwright is invoked as
`bunx playwright test`. No CI workflow on this branch; the local Guard Phase 2
run is the gate (the parent owns push/PR/Greptile).

## Review evidence

- Reviewed implementation SHA: `8e567c4` (round-2 fix `f7e7661..8e567c4`).
- Debate (High-assurance): substantive review at `895d1c9`; final critic pass at
  `8e567c4` found **no blocker**.
- Test audit: both findings have regression tests that fail pre-fix; the
  contract test's reject-half is non-discriminating because zod v4 `.int()`
  already bounds to safe integers (documented, not a defect).
- Code review (Standards + Spec): both findings fixed; no documented-standard
  violation, no spec gap.

## Deferred (non-blocking)

- Label/treat the `/debts` supplier group-total when it is a net credit.
- Consolidate the grouped-amount parser across the single-entry amount inputs.
