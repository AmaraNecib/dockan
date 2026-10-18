# Ticket #30 — Sale checkout, negotiated pricing, and discounts

- **Issue:** #30, `Implement sale checkout, pricing, and discounts`
- **Base:** `origin/develop` / `af394f4`
- **Branch:** `feat/30-sale-checkout`
- **Persistence seam:** `StorePort` → Drizzle/SQLite only; no SQL outside the adapter.
- **UI seam:** a new `/sale` checkout page consumes the existing catalog search, scanner hook, picker, and unknown-scan dialog. The picker component remains owned by #38 and is not modified.
- **Money/time:** whole DZD integers, Algeria-local date/time strings.

## Public contract

1. `invoicesCreate` accepts both existing `PURCHASE` and `SALE` inputs. Sale lines default to the item's current `sellingPrice`; `unitPrice` remains the explicit actual price for compatibility. A line may instead use `priceOverride: { type: "AMOUNT" | "PERCENTAGE", value }` (percentage means a percentage of the default price). The API snapshots `defaultUnitPrice` and actual `unitPrice` on every invoice line.
2. Sale invoices accept `discount: { type: "AMOUNT" | "PERCENTAGE", value }`, with compatibility fields `discountType`/`discountValue`. Amounts and percentage points are whole numbers; percentage discounts are rounded to the nearest DZD, amount discounts are capped at the subtotal, and final totals never go below zero.
3. Invoice responses expose `subtotalAmount`, `discountType`, `discountValue`, `discountAmount`, and final `totalAmount`. Line responses retain gross `total`, expose `discountAllocated` and `netTotal`, and allocations sum exactly to the invoice discount. Existing rows/databases read as zero/no-discount defaults.

## Sale transaction

Before any write, resolve every item and reject `ITEM_NOT_FOUND`. In one transaction, allocate an invoice number, insert the invoice, and process lines in request order. Each sale line snapshots the default price and negotiated actual price, computes its gross total, and consumes FIFO layers from the item's existing ledger. `costAtSale` is the rounded weighted unit cost of the FIFO layers consumed by that line. This is the explicit #30 FIFO-cost extension; the live `items.costPrice` cache still follows ADR-0002's weighted-average replay and no lot is selected by the operator. Append one `SALE` movement per line (`delta = -quantity`, `unitCost = null`, `ref = invoice.id`), replay the complete ledger, and update cached stock/cost atomically. Any projected negative stock raises `STOCK_NEGATIVE`; rollback leaves invoice, lines, movements, cache, and activity untouched. Invoice discount allocation happens after gross line prices are resolved, so it never changes stock/COGS and is visible once at the invoice level. Initial payment is bounded by the final total and recorded in the invoice/payment history when positive.

## Calculation seam

`apps/api/src/lib/sale-calculations.ts` contains pure integer calculation: line price resolution, subtotal/discount/final total, and proportional largest-remainder allocation (stable input-order tie break). Tests use literal worked examples and assert nonnegative totals plus exact allocation reconciliation. `stock-ledger.ts` gains a pure FIFO consumed-cost helper tested with mixed layers.

## Quick-add and scan UX

`/sale` lets the operator add via exact scan (immediately adds the matched item), ranked manual picker, or the normal picker search. A confirmed unknown scan opens the existing explicit choice dialog. Create / create-with-stock use an inline quick-add form prefilled with the code; create-with-stock calls `itemsCreateWithStock`, which now also writes an opening ledger movement so the stock is saleable. The item is returned to the cart after creation. No unknown scan silently creates data. Known items can be quick-added with stock without an invoice through this same path.

The checkout form displays customer, quantities, default/actual prices, line gross/net values, subtotal, invoice discount, and final total. A sale error is translated and leaves the cart available for correction. Successful checkout clears the cart and invalidates item queries, showing the invoice number.

## Tests and validation

- Pure calculation + FIFO unit tests.
- Router wire tests for exact/default and negotiated prices, amount/percentage discounts, proportional reconciliation, oversell rollback, FIFO cost snapshots, payment/debt behavior, and initial-stock saleability.
- E2E checkout journey covers picker, exact scan, negotiated amount/percentage line pricing, amount/percentage invoice discounts, oversell, and stock reconciliation. Tests use unique names because Playwright's database is shared across specs.
- Required final gates: `bun run typecheck`; `bun run lint`; `bun run test`; `DOKAN_PORT=4318 DOKAN_WEB_PORT=5174 bun run test:e2e -- --workers=1`. Restore `.dokan-port`; no generated DB files are committed.

## Risks / explicit calls

- Existing `invoiceLine.unitPrice` is preserved as the historical actual price; `defaultUnitPrice` is additive. Gross line totals remain available for audit, while `discountAllocated`/`netTotal` support per-item reporting without showing the invoice discount more than once.
- Percentage values are numeric and bounded to 0–100; rounded DZD results and stable proportional remainders avoid floating totals.
- Purchase behavior remains intact and uses the same additive invoice fields with no discount by default.
