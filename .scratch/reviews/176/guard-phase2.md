# Guard — issue #176, Greptile round-1 fix (High-assurance)

Reviewed SHA: `a7e7f7e` (base `1840a3a`). Previous review evidence archived under
`.scratch/reviews/176/superseded/` (`ef0e885`).

## Phase 1 — pre-commit

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 workspaces pass |
| lint | `bun run lint` | 0 errors (oxlint) |
| tests | `bun run test` | api 785 pass / 0 fail; web 814 pass / 0 fail |

The Husky pre-commit hook (`oxlint`) ran on every commit.

## Phase 2 — pre-push

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 pass |
| lint | `bun run lint` | 0 errors |
| tests | `bun run test` | api 785 pass; web 814 pass; 0 fail |
| e2e (UI changed) | `bunx playwright test` | 53 passed (3.1m), incl. `supplier-adjustment.spec.ts` |
| working tree | `git status --short` | clean after the evidence/wisdom commit |
| evidence | `.scratch/reviews/176/a7e7f7e-{debate,test-audit,code-review}.md` | present and current |

Note: this repo has no `test:e2e` root script, so Playwright is invoked as
`bunx playwright test`. No CI workflow on this branch; the local Guard Phase 2
run is the gate (the parent owns push/PR/Greptile).

## Review evidence

- Reviewed implementation SHA: `a7e7f7e` (Greptile fix `3a0074e..a7e7f7e`).
- Debate (High-assurance): round-1 critic found a RED cross-file mock blocker;
  fixed in `a7e7f7e`; final critic pass found **no blocker**.
- Test audit: every one of the six Greptile findings has a regression test that
  fails pre-fix; the round-2 additions (exactly-200 boundary, dashboard
  agreement/double-count guard, real folding variant) are non-vacuous.
- Code review (Standards + Spec): all six findings fixed; no
  documented-standard violation, no spec gap.

## Deferred (non-blocking)

- Adopt `apps/web/src/lib/query-keys.ts` / a shared invalidation helper in the
  sibling panels outside this diff (pre-existing dead flat keys).
- Consolidate the supplier sign rule into `@dokan/contracts`.
- Align null-direction ADJUSTMENT display with the store-seam refusal.
