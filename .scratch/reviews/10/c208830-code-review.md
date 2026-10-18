# Code Review — Ticket #10 @ c208830 (Greptile round-3 refresh)

- Tier: Standard · Base: c1bec84 · Head: c208830
- Prior evidence: `0b7d644-code-review.md` (2-axis battery) — still valid for
  the source it reviewed. This file refreshes the evidence for the reviewable
  delta `0b7d644..c208830` (fix commit `c208830`, plus test files).
- Changed since 0b7d644: `apps/api/src/rpc/router.ts` (settingsUpdate
  transaction), `apps/api/src/rpc/router.test.ts` (atomicity test + hoisted
  beforeAll deps), `apps/web/src/components/invoice-header.tsx` (three
  states), `apps/web/src/components/invoice-header.test.tsx` (new).

## Greptile round-3 findings — verification verdict (independent reviewer)

**Finding 1 — settingsUpdate writes + audit not atomic → FIXED.**
`settingsUpdate` now wraps `tx.updateSettings(...)` and
`tx.insertActivity(...)` in one `store.withTransaction`; a thrown audit
insert aborts the unit and the explicit ROLLBACK reverts the settings write
(drizzle-store.ts BEGIN/try-COMMIT/catch-ROLLBACK). The failing-store test
wraps the tx-scoped `insertActivity` only (`{...realTx, insertActivity:
throw}`) — under the pre-fix two-call wiring the direct
`deps.store.insertActivity` call would hit the real method, the call would
succeed, and `rejects.toThrow()` would fail — so the test discriminates the
fix **and** was mutation-verified by the author (temporarily reverted the
fix; test failed; restored). Assertions cover rejection, identity rollback
(`settingsGet` equality), and zero phantom audit rows.

**Finding 2 — InvoiceHeader silently blank while loading/on error → FIXED.**
Three explicit states, no `return null` path: pending → `Skeleton`
(`invoice-header-loading` testid); error → `role="alert"` with
`t("activityError")` + retry wired to `settings.refetch()`
(`invoice-header-retry`); success → identity. Verified by a mode-driven
happy-dom test (loading / error→retry→recovered / loaded) with no wall-clock
timing.

## Standards

No new violations in the delta. `withTransaction` usage matches the existing
inventory flows (stockAddManual, invoicesCreate); the Proxy-free test wrapper
uses only typed spread assignment (anti-slop `no-reflect-get` clean);
test-selector/testid conventions and i18n-key reuse (`activityError`,
`itemsSearchRetry`) follow the page standards; no lockfile or unrelated
changes. The hoisted beforeAll deps (`config`/`logger`/`auth`/`cookie`) stay
module-scoped, matching the file's existing module-level fixtures.

## Spec

Original issue requirements unchanged and still met (0b7d644 pass). The
round-3 delta strengthens two implicit requirements: audit integrity on
failure and never-hidden invoice identity — both are now documented
behavior with deterministic tests.

**One-line summary:** Standards — 0 findings. Spec — 0 missing; both
Greptile findings FIXED with discriminating tests. READY.