# Issue 174 — Debate evidence (High-assurance)

Base: `8bf2a81` (origin/develop merge-base). Reviewed HEAD: `2c8f885`.

The debate ran against the first commit `984df76`; the one blocker it found was
fixed in `1655152`; the test-audit additions (`48f8683`) and the code-review
refactor (`2c8f885`) that followed do not touch the debate's conclusions or the
money path, so this file is anchored to the final HEAD `2c8f885`.

Two `reviewer` sub-agents ran in opposite directions on
`git diff 8bf2a81...HEAD`: a harsh Critic (find every flaw) and a charitable
Defender (argue for the design). Both were read-only.

## Critic findings

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | **8 (blocker)** | `refreshTabQueries()` in `party-detail.tsx` invalidated `["partyInvoices"]` / `["partyPayments"]` / `["supplierEntries"]`. oRPC's key is `[pathArray, {input,type}]`, so a string-first filter never matches — all three invalidations were silent no-ops and the tabs would stay stale after a payment. | **Fixed** in `1655152`: added `PARTY_INVOICES_QUERY_KEY` / `PARTY_PAYMENTS_QUERY_KEY` / `SUPPLIER_ENTRIES_QUERY_KEY` (`[[...]]`) to `apps/web/src/lib/query-keys.ts` and used them. Pinned by `query-keys.test.ts` (prefix matches the generated key, string-first does not) and a settle-refetch assertion in `party-detail.test.tsx`. |
| 2 | 4 | `mapRecentInvoices(rows) ?? []` can blank a page while the SQL `total` stays full (a single malformed legacy row). | **Dismissed.** This is exactly the degradation the tab already had: pre-#174 it rendered `partyDetail.invoices`, which is also `mapRecentInvoices(...) ?? []`, and `partyDetail.stats` derive from the same all-or-nothing map. The paged read does not introduce new data loss; the pager copy over an empty degraded page is cosmetic. |
| 3 | 3 | The `pagination === undefined` full-read branches in the three new store reads are unreachable from the router. | **Dismissed.** They match the established store-seam convention (`listInvoices`, `listReturns`, `listSupplierReturns` all keep an optional-pagination full read) and are exercised directly by the store tests (`partyInvoices(..., {})`, `supplierEntries(id)`). |
| 4 | 2 | `partyPaymentsInputSchema` accepts `role:"supplier"`, a scope no test pins. | **Dismissed.** It mirrors the pre-existing `partyDetail.payments` (which returned purchase payments for suppliers too); it is a coherent read, just unused by the current UI. Restricting the enum would make the two party reads asymmetric for no benefit. |
| 5 | 2 | An unknown party could show the invoices skeleton forever because a disabled query reports `isPending`. | **Dismissed (false alarm).** The whole tab block only renders in the `detail.data !== undefined` branch, after the page has handled loading / error / missing. The skeleton cannot show for an unknown party. |

No blocker on the money path was found. Both reviewers independently confirmed:
`partyDetail` still returns the full invoice/payment set and the full supplier
account, no paginated read reaches `distributePayment`, the settle/pay writes,
or the `deleteParty` FK guard, the `unpaidOnly` predicate matches
`unpaidInvoices` (remaining > 0), and the payment `COUNT(*)` shares the joined
scope with its select.

## Defender highlights

- Shared query builders (`partyInvoiceWhere` / `partyInvoiceSelect` /
  `partyPaymentSelect` / `supplierEntrySelect`) back both the full and paged
  reads, so rows and `total` cannot drift.
- The change is purely additive at the port and router; the money paths are
  untouched by construction and by test (`customersGet().invoices` is still 13
  while `partyInvoices` pages sum to 13).
- The `rowid DESC` tie-break is justified (second-precision timestamps) and
  cannot perturb money math because `distributePayment` re-sorts.
- Keeping `listSupplierEntries` unpaginated is required for balance
  derivation.
- The Defender also flagged the same key-shape blocker, and noted the shipped
  mocks keyed the tab queries single-nested, which is why the unit suite did not
  catch it; the fix widens the mocks to the production shape.

## Deferred / out of scope

The same string-first no-op literals pre-exist in `customer-settle-panel.tsx`
and `supplier-pay-panel.tsx` (`["invoicesList"]` / `["activitiesList"]`).
Fixing those means editing shared supplier/customer panel components, which
this lane must avoid to keep `feat-181-adjustment-idempotency` rebasing cleanly.
Recorded as a follow-up for the parent (see report `deferredWork`).
