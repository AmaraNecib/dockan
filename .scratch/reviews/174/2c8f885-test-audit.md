# Issue 174 — Test-audit evidence

Base: `8bf2a81`. HEAD audited: `2c8f885` (the audit ran against `1655152`;
its findings were applied as `48f8683` and the code-review refactor `2c8f885`.
No production money behavior changed; this file is anchored to the final HEAD).

Three read-only `reviewer` sub-agents ran in parallel: Edge Case Hunter,
Coverage Analyst, Quality Reviewer.

## Findings and dispositions

| Agent | Finding | Disposition |
|---|---|---|
| Coverage | **AC3 ("settle/pay money math unchanged — router tests") was under-tested.** The 174 router block only asserted `partyDetail` length; no router test drove a distribution over more than one page. | **Fixed.** Added `settles a supplier across more than one page without truncating the distribution`: 12 PURCHASE invoices, `suppliersPay` with `target: OLDEST` and the full balance, asserting balance 0 and every one of the 12 invoices reached (`remainingAmount === 0`). Added the web counterpart: a 12-invoice settle distributes to all 12 `payInputs` while only 10 rows are visible. |
| Coverage | No jsdom test for the customer **payments** pager (separate render branch / `paymentPager`). | **Fixed.** `partyPayments` mock now slices by limit/offset; new test pages 12 payments (10 + 2) and asserts `party-payments-pager`. |
| Edge | Role mismatch never asserted — a swapped `partyInvoiceKind` would pass. | **Fixed.** Router + store tests assert `partyInvoices({role:"supplier"})` of a customer id, `supplierEntries(<customerId>)` and `partyPayments` of a mismatched id all return `{items:[],total:0}`. |
| Edge | Unknown party id untested (design promises an empty page). | **Fixed.** Router test asserts empty pages for a random UUID on all three reads. |
| Edge | Empty party / supplier with zero entries untested. | **Fixed.** Store test asserts empty pages for a customer with no invoices/payments and a supplier with no entries. |
| Edge | Negative / fractional pagination input only partly pinned. | **Fixed.** Router test asserts `offset: -1` and `limit: 1.5` are rejected at the contract. |
| Edge | **RED:** a shrinking list can leave the offset past the end, rendering an empty tab with data present. | **Dismissed — already covered by the shared component.** The Pager's own clamp effect (`clampOffset`) runs before its hidden-at-one-page return and is pinned by `apps/web/src/components/ui/pager.test.tsx` "snaps an out-of-range offset back to the last real page". The page renders the Pager whenever `total > 0`, so the clamp fires after a payment shrinks the list; a filter change additionally calls `invoicePager.reset()`. Adding a page-level duplicate of that clamp would test the shared component twice. |
| Quality | E2E seeding (`call` helper + bootstrap) was copy-pasted across the two new specs. | **Fixed.** Extracted `callRpc` (typed `TabSeedRequest` union) and `firstCategoryId`; both specs now share them. |
| Quality | Redundant assertion immediately after `waitFor`. | **Left as-is** — harmless, and the explicit expectation documents the intended count. |
| Quality | Global `ui.pageSize` preference persists across the shared e2e DB. | **Left as-is** — the established pattern: every spec's `signIn` preamble resets it to 500, and only `pagination.spec.ts` pins it to 10. |
| Quality | `parties.test.tsx` mock ignores limit/offset. | **Left as-is** — that file covers the issue-120 flows; the pagination window is pinned in `party-detail.test.tsx`, whose mock slices. |
| Quality | Grade A−. No vacuous pre-settle assertions; async hygiene uses `waitFor` under `act()`. | — |

## Verification after the fixes

- `apps/api`: `bun test src/store/pagination-store.test.ts src/rpc/router.test.ts` — 12 + 208 pass / 0 fail.
- `apps/web`: `bun test src/lib/query-keys.test.ts src/pages/party-detail.test.tsx src/pages/parties.test.tsx` — 35 pass / 0 fail.
- `tests/e2e/pagination.spec.ts` — 3 passed.

No test-only change altered production behavior.
