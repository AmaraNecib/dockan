# Debate — Sale checkout (issue #30, PR #42)

- **Issue:** #30, *Implement sale checkout, pricing, and discounts*
- **PR:** #42 (`feat/30-sale-checkout`)
- **Base:** `origin/develop` af394f4
- **Head reviewed:** cd02ed9cc31e8b6be816a0d6eab2100aecb5aa31 (after review fixes; initial review at 33e36a1)
- **Tier:** High-assurance (invoice/stock money math, FIFO cost, oversell rollback)

Two adversarial reviewers (CRITIC / DEFENDER) read the full base→head diff, the
issue, the design doc, ADR-0001..0004, and wisdom, then this lane synthesized,
fixed, or deferred every finding.

## Findings classified

| # | Severity | Finding | Verdict | Resolution |
|---|----------|---------|---------|------------|
| 1 | 8 | Legacy stock (pre-PR `itemsCreateWithStock`) has no ledger movement → sales of migrated stock would throw STOCK_NEGATIVE | **False alarm** | `StorePort.setup()` (ticket 27) backfills exactly one synthetic `MANUAL_ADJUSTMENT · opening` movement for EVERY item with an empty ledger on every boot (`drizzle-store.ts`, INSERT…WHERE NOT EXISTS). Critic read only the diff; verified in code. |
| 2 | 7 | Oversell "atomic rollback" is read-then-write; only safe inside one process | **Dismissed (documented)** | Dokan is a single-shop single-machine desktop app (ADR-0001); `withTransaction` serializes every store call in-process via its unit queue, and `allocateInvoiceNumber` stays DB-atomic. Cross-process hardening (`BEGIN IMMEDIATE`) is out of PR scope → follow-up. |
| 3 | 6 | `costAtSale` rounds the consumed FIFO cost, so line COGS drifts from exact layer totals by up to ½ DZD/unit | **Dismissed (designed)** | Design doc mandates "rounded weighted unit cost of the FIFO layers consumed"; matches the whole-DZD rounding `averageCostAfter` already applies. Tradeoff recorded in ADR-0005. Exact per-line COGS needs an additive column → follow-up. |
| 4 | 5 | `invoiceDate` can be backdated while SALE movements always use `localDateTime()` → `stockAsOf`/day history diverge | **Deferred (documented)** | UI never sends `invoiceDate`; sales are same-day. Design defaults both to now. Ledger-day-vs-invoice-day semantics → follow-up issue. |
| 5 | 4 | Cart quantity inputs cannot be cleared (empty parses to 0, guard rejects) | **Deferred** | Minor UX; E2E uses fill() which works; fix needs string-state rework. Follow-up. |
| 6 | 4 | "−0 دج" discount line shown when no discount entered | **Fixed** | sale.tsx renders `0` when `discountAmount === 0`. |
| 7 | 3 | `priceOverride` + `unitPrice` precedence is silent; PURCHASE silently drops overrides | **Fixed** | contracts now reject unitPrice+override on one line and any override on PURCHASE lines (mirrors discount pairing checks); router tests added. |
| 8 | 3 | Read-time subtotal heuristic is fragile if future discount variants bypass the cap | **Dismissed (documented)** | Today-safe (inserts always store real subtotals; legacy rows only), tested for zero-total and 100%-discount rows; normalized in one shared helper. |
| 9 | 2 | Dead `Number.isInteger` checks duplicated after `.int()` across 4 schemas | **Fixed** | Removed; percentage >100 bounds kept. |
| 10 | 2 | ADR-0002's "future sales snapshot that average as their cost" contradicts the FIFO implementation | **Fixed** | New `docs/adr/0005-fifo-cost-at-sale.md` documents the split; ADR-0002 amended with a pointer. |
| 11 | 2 | Doc comment for `averageCostAfter` dangles above `fifoCostForOutflow` | **Fixed** | Relocated to its function. |
| 12 | 1 | `discountValueSchema` comment claims fractional percentages the schema rejects | **Fixed** | Comment corrected to "whole percentage points". |
| 13 | 1 | `SALE_NOT_IMPLEMENTED` i18n key left dead after the stub was removed | **Fixed** | Removed from `i18n.ts`. |

## Defender's case (accepted)

- FIFO snapshots + weighted-average live cache is not an ADR-0002 contradiction:
  ADR-0002's own prose ("past sales keep theirs") mandates per-sale snapshots;
  FIFO makes them deterministic while outflows leave the live average untouched
  (proven by a new test asserting `costAtSale` 200 on the second sale while
  `items.costPrice` stays 150). Confidence 9.
- Largest-remainder allocation reconciles exactly (Σ discounts = discountAmount,
  Σ netTotal = totalAmount) and never produces negative totals (cap at subtotal).
- Serialized unit transactions + atomic UPDATE..RETURNING invoice numbering.
- Additive columns with nullish fallbacks honor "zero is a real value".

## Follow-ups (documented, not created as GitHub issues by this lane)

1. `BEGIN IMMEDIATE` (or conditional stock UPDATE) for cross-process sale safety.
2. Exact per-line COGS total column if profit reconciliation needs it.
3. `invoiceDate`-driven movement timestamps / reject backdated sales.
4. Allow clearing the cart quantity field (string-draft state).