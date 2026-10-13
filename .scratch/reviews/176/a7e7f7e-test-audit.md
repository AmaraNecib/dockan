# Test audit — issue #176, Greptile round-1 fix

Reviewed SHA: `a7e7f7e`. Edge-case hunter, coverage analyst, and quality
reviewer, in two rounds.

## Finding → regression test

| # | Greptile finding | Regression test | Fails pre-fix? |
|---|---|---|---|
| 1 | A `1,000` amount / incomplete inline supplier was silently dropped | `supplier-opening-draft.test.ts` (`parseBulkAmount`, `openingRowStatus`, `newOpeningRowStatus`); page tests "keeps a grouped 1,000 amount…", "blocks the save…invalid", "blocks an incomplete inline supplier" | yes |
| 2 | The linked invoice auto-switched when the selected one settled | `supplier-adjust-panel.test.tsx` "never auto-switches the linked invoice…" | yes |
| 3 | `dashboardSummary.weOwe` hid supplier account balances | `dashboard-summary.test.ts` "includes a supplier account balance…" + "matches the /debts supplier total across id-backed, typed-only and credit accounts" | yes |
| 4 | A >200-row batch failed only after filling the table | `supplier-opening-draft.test.ts` "allows exactly the cap and blocks only a larger batch"; page test "blocks a batch over the 200-row contract limit" | yes (blocked half) |
| 5 | Both forms invalidated the dead `["debtsData"]` key | panel/page "invalidates the real debts and dashboard keys after saving"; `query-keys.test.ts` pins the prefix shape | yes |
| 6 | Opposite adjustments looked identical on /debts | `supplier-entry-display.test.ts`; `debts.test.tsx` "distinguishes opposite adjustments…" | yes |

## Round-2 additions (from the round-1 audit)

- Exactly-200 accept boundary (199/200 false, 201 true) via the production
  `isOpeningBatchOverLimit`.
- Dashboard agreement test with an id-backed supplier that has an open invoice
  **and** ledger entries (the double-count guard), a credit-only supplier, and a
  typed-only purchase — asserts `weOwe` equals the `/debts` displayed total.
- Corrected the duplicate-name test to a real `normalizeTextKey` variant
  (whitespace collapse) instead of a tautological repeat.
- `query-keys.test.ts` pins the prefix-vs-generated-key contract.

## Quality grades

- `supplier-opening-draft.test.ts` — A (pure, boundary-complete)
- `supplier-entry-display.test.ts` — A
- `query-keys.test.ts` — B+ (hand-rolled prefix matcher; component tests assert
  the literal keys)
- `supplier-opening-balance.test.tsx` — B+ (strong regressions; the 200-row test
  is slow)
- `supplier-adjust-panel.test.tsx` — A− (rerenders the same root for the
  lifecycle race)
- `dashboard-summary.test.ts` — A− (cross-seam agreement)
- `debts.test.tsx` — A (self-contained router mock now)

## Remaining (non-blocking)

- The dashboard agreement test hand-mirrors the `/debts` group-total formula;
  extract a shared reducer eventually.
- "200 allowed" is unit-level only, not page-level.
- The ~200-row page test takes ~17s; the pure boundary test covers the logic.
- The sibling dead flat keys in panels outside this diff (pre-existing).

**Verdict: A−. No red gaps.**
