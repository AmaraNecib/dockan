# Code review — issue #176, Greptile round-2 fix

Reviewed SHA: `8e567c4`. Standards + Spec axes.

## Standards

No documented-standard violation. Judgement-call smells:

- The explicit `.min(-MAX_SAFE_INTEGER).max(MAX_SAFE_INTEGER)` on `weOwe` is
  redundant with zod v4's safe-integer `.int()`, but documents the money range
  beside a field that just changed sign.
- Only the bulk screen accepts grouped amounts; the other amount inputs use the
  stricter `parseWholeAmount`. Safe (fails closed); a shared tolerant parser
  would consolidate. Proposed follow-up.
- `/debts` still renders the supplier group total as a raw negative under the
  "we owe suppliers" heading; the dashboard now labels the credit. Presentational
  disagreement, pre-existing. Proposed follow-up.

## Spec — the two PR #178 round-2 findings

1. **Dashboard `weOwe` signed, request never fails.** Fixed: the contract field
   is explicitly signed and documented (negative = the shop is ahead), the
   dashboard renders a `dashboardSupplierCredit` subline, the customer side is
   unchanged, and a router test proves a credit-only shop resolves and matches
   `/debts`. ✔
2. **`parseBulkAmount` never inflates 100×.** Fixed: valid thousands grouping
   is accepted; a decimal or malformed separator is rejected with a row error
   and a blocked save; separators are never deleted into a different number. ✔

No unintended behavior change, no scope creep. The `8e567c4` bound commit is
defense-in-depth only.

## Deferred (non-blocking)

- Label/treat the `/debts` supplier group-total credit.
- Consolidate the grouped-amount parser across the amount inputs.
