# Test audit — issue #181 review-fix round 1 (final)

Base: `fc95113` · Final head: `9bdb8c8` · Tier: **High-assurance**
Method: `test-audit` — edge-case hunter, coverage analyst, quality reviewer, plus a
post-rebase test-integrity check.

## Corrected claims and their pinning tests

| Corrected claim | Pinning test | Status |
|---|---|---|
| `ref` is in neither the key nor the signature arm | `supplier-ledger.test.ts` "ignores ref, which is in neither form" (golden strings, keyed + unkeyed); `supplier-account-store.test.ts` "refuses an identical adjustment that only changes ref" (REF-A → REF-B ⇒ `DUPLICATE`, 1 entry, landed row keeps REF-A) | COVERED |
| A server-stamped request matches any stored time (explicit row included) | `supplier-account-store.test.ts` "treats a server-stamped request as time-insensitive against a stored explicit row" (explicit at 2026, stamped at 2099 ⇒ `DUPLICATE`); `supplier-ledger.test.ts` time-insensitivity unit | COVERED |
| A fresh key with an unchanged signature is refused; a changed signature is allowed | `supplier-account-store.test.ts` "refuses a fresh key while the signature is unchanged, and allows one with a changed signature" (k1→k2 same shape refused; k2 + amount 401 accepted ⇒ 2 rows); router "does not let the key weaken the signature guard" | COVERED |
| A changed direction is a distinct entry | `supplier-account-store.test.ts` "accepts a changed direction as a distinct adjustment" | COVERED |
| Migration backfill/self-heal/index/refusal intact | `supplier-adjustment-migration.test.ts` v2→v4, v3→v4, half-migrated self-heal | COVERED |

## Findings (from the round-1 audit) and decisions

- **Tautological `ref` unit test** → fixed: it now asserts against the golden key strings
  for both the keyed and unkeyed forms, and the store test proves the landed row's `ref`.
- **Stamped test name imprecise** ("omits the date" while passing `serverStamped: true`) →
  renamed to "treats a server-stamped request as time-insensitive against a stored
  explicit row"; at the store seam `occurredAt` is required and `serverStamped` is the
  faithful representation of an omitted-date request.
- **Store seam did not assert the winner** → now asserts the surviving row's `ref`.
- **`direction` dimension untested at the guard seam** → new store test.
- **Residuals (deferred, documented):** the guarded-path index-violation catch and true
  concurrency remain untested (need a race/fault-injection seam); the raw seam stores an
  empty-string note verbatim while the router normalizes `""` to null (no production caller
  writes ADJUSTMENT through the raw seam); the corrected claims are pinned at the
  store/unit seam, not through every RPC path.

## Post-rebase test integrity

- All four changed test files pass at `9bdb8c8` (**285 pass, 0 fail, 1126 assertions**).
- The only conflict, `router.test.ts`, kept both #174's `party-detail tab pagination`
  describe and #181's describes; there is exactly one module-level `setupSupplier`; the
  branch-vs-`fc95113` diff is purely additive in the test files. No test lost.

## Gates

- `bun run test` 0 (848 web + api); `bun run test:e2e` 0 (55 passed); `bun run lint` 0;
  `bun run typecheck` 0.
