# Guard — issue #176 supplier adjustments (High-assurance)

Reviewed implementation SHA: `ef0e885` (base `1840a3a`).
Evidence committed at HEAD `0aecc33` (only `.scratch/` changed since `ef0e885`,
the non-reviewable exemption).

## Phase 1 — pre-commit

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 workspaces pass |
| lint | `bun run lint` | 0 errors (oxlint) |
| tests | `bun run test` (turbo) | api 783 pass / 0 fail; web 790 pass / 0 fail |

The Husky pre-commit hook (`oxlint`) ran on every commit.

## Phase 2 — pre-push

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 pass |
| lint | `bun run lint` | 0 errors |
| tests | `bun run test` | api 783 pass; web 790 pass; 0 fail |
| e2e (UI changed) | `bunx playwright test` | 53 passed (3.0m), incl. `supplier-adjustment.spec.ts` and the existing `supplier-account.spec.ts` |
| working tree | `git status --short` | clean after the evidence/wisdom commit |
| evidence | `.scratch/reviews/176/ef0e885-{debate,test-audit,code-review}.md` | present; current (only `.scratch/` changed since `ef0e885`) |

Note: this repo has no `test:e2e` root script, so Playwright is invoked as
`bunx playwright test`. There is no CI workflow on this branch; the local Guard
Phase 2 run is the gate (the parent owns push/PR/Greptile).

## Review evidence

- Reviewed implementation SHA: `ef0e885`
- Debate (High-assurance): final critic pass found **no blocker**; the two
  earlier rounds' findings are recorded in the same file.
- Test audit: every acceptance criterion maps to a test; the BLOCKING v2 → v3
  migration test is green and proves column add, row preservation, version
  stamp, old-build refusal, and idempotent re-open.
- Code review (Standards + Spec): no documented-standard violation, no spec gap.

## Deferred (non-blocking)

- Server-side duplicate-name refusal in the bulk endpoint (client-side today
  because ADR-0007 permits duplicate names). Follow-up issue proposed.
- A store-seam assertion that an `invoice_id`-bearing ADJUSTMENT is `THEY_OWE`.
- Split `SupplierOpeningBalancePage` into table/dialog subcomponents.
