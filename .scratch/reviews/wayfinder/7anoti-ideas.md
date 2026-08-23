# 7anoti → Dokan: feature mining (wayfinder research #20)

Source: D:\7anoti (Expo shop app). Frame: does it fit Dokan (local-first Tauri+Bun+React, Arabic-only UI, integer DZD, weighted-average cost ADR-0002, single admin, cash/debt payments)?

## Keepers (adopt / adapt)

1. **Barcode on items + scan-to-find** (`app/(tabs)/pos.tsx`, `products.tsx`, `src/database/repositories/productRepository.ts`, `src/store/productStore.ts`) — `Product.barcode`, `getByBarcode`, search filters name/name_ar/barcode. ADOPT: this IS ticket #23's data shape; POS shows only stock>0 and blocks add when the cart would exceed stock. Also has ratio filter (products.tsx:772 `barcode?.includes()`).
2. **Per-line price edit, unit OR row-total mode** (`pos.tsx` `handleEditPrice`/`handlePriceSave`, `cartStore.updatePrice`) — editing "total" divides by qty to set unit price. ADOPT: feeds discount ticket #24; both modes are what the owner described.
3. **Cart-level discount** (`cartStore` `discount`, `getTotal = max(0, subtotal - discount)`) — ADOPT seed for #24 invoice-level discount.
4. **Every sale line records buy_price, original_price, sold_price, profit** (`types/SaleItem`) — ADOPT: historical-cost-per-line; answers the fog item (old-sale profit stays true without re-valuing).
5. **StockChange ledger** (`types: StockChange` with previous/new quantity + reason enum `sale|purchase|adjustment|return|damage|restock`) — ADOPT: this is exactly the append-only item-history shape in #22; already has `batch_id` slot.
6. **Returns**: `sale_returns` (qty, refund, reason) + `updateTotalsAfterReturn` (final_amount − refund, profit − returnedProfit) + per-item return cap `getTotalReturnedQuantity` + `ReturnItemModal`. ADOPT: a proven answer to the fog "returns and stock history" — return writes a StockChange reason=return.
7. **Expense model** (`types: Expense` amount/category/description/date + `DEFAULT_EXPENSE_CATEGORIES` rent/maintenance/electricity/water/food/transport + expenses screen with icons + edit/delete) — ADAPT: keep model; for Dokan the categories are rent / salary / owner-draw / other (owner's words), food/transport fold into owner-draw.
8. **Period stats with returns accounted** (`salesStore.getStatsByDateRange` → total, profit, count, costTotal; `saleRepository.updateTotalsAfterReturn`) — ADOPT: seed math for #25 yearly report (before/after expenses = stats profit − expenses).
9. **Product photo offline (base64)** (`Product.image_base64`, grid shows image) — ADOPT (nice-to-have): car-accessory items are visual; sqlite base64 is offline-safe.
10. **Low-stock badge on the product tile** (pos grid: orange when remaining ≤ 5) — ADOPT: cheap addition to the existing low-stock list.
11. **Debt extras: personal_owed / personal_owe types + due_date + status paid/unpaid/partial** (`types/Debt`) — ADAPT: Dokan already groups parties by namespace; add owner-draw style "personal" debts + due dates if the owner wants them.
12. **ActivityLog with old/new data diff + action enum incl. stock_adjustment** (`types/ActivityLog`) — ADAPT: Dokan's activity log ticket #12 can reuse the shape; drop ip/device (single PC).
13. **Algerian date utils** (`utils/date.ts`: start-of-today/week/month/year) — ADAPT: directly serves #25 date ranges under UTC+1.

## Skip / not in scope

14. **FIFO ProductBatch** (`types: ProductBatch`, `StockChange.batch_id`) — SKIP: ADR-0002 locks weighted average; the `batch_id` slot stays a harmless nullable column if a later change needs it.
15. **Dual name name/name_ar** (`types: Category.name_ar`) — SKIP: Dokan is Arabic-only, no FR slot.
16. **Multiuser roles + permissions** (`UserPermissions`: canProcessReturns / canEditProducts / canViewAllDebts / canDeleteSales) — SKIP (single admin), but note which actions are sensitive for the single-actor audit log: returns and deletes.
17. **Turso sync machinery** (`syncService`, `tursoHttpClient`, `dualWrite`, sync_status on every row, retry/conflict) — SKIP: local-first, out of scope; the dual-write pattern is a no-go for bun:sqlite transactions.
18. **`displayMode` "ألف/مليون" compact currency** (`utils/format.ts` — colloquial 1 ألف = 10 DA, 1 مليون = 10,000 DA) — SKIP: confusing mapping; Dokan shows plain whole دج per spec. Could revisit as a display pref later.
19. **Card payment method** (`PaymentMethod 'card'`) — SKIP: spec is cash / credit / split.
20. **(minor) Toast + ConfirmDialog + haptics** (`components/`) — ADAPT the toast/confirm patterns for React; haptics are n/a on the desktop shell.

Top 5 keepers: barcode field + scan search; unit-or-total price edit; cart discount; SaleItem historical cost line; StockChange append-only ledger (= item history).