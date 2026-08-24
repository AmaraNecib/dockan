# Ticket 29. Purchase intake & deferred invoice linking — design

- **issue:** #29 (`Implement purchase intake and deferred invoice linking`, parent #19)
- **branch:** `feat/29-purchase-intake` (STACKED on `feat/28-catalog-search` — needs barcode column + catalogSearch)
- **review tier:** High-assurance — purchase costs feed ADR-0002 weighted average and future COGS.

## Scope decisions up front

- **SALE stays a stub**: `invoicesCreate` implements `kind: "PURCHASE"` only; SALE returns the
  stable key `SALE_NOT_IMPLEMENTED` (ticket #30 owns it). No silent half-sale flow.
- **Append-only everywhere**: corrections never rewrite rows — they append compensating
  movements. Linking never rewrites `ref` on old rows — it appends link records.
- **Quick-add reuses ticket 28 seams**: unknown scan on the purchase page → plain
  `itemsCreate` (no stock; the purchase line itself is the stock event) → back to the line.

## Public interfaces

### contracts (`packages/contracts/src/core.ts`)

- `stockAddManualInputSchema` gains `kind: z.enum(["PURCHASE", "MANUAL_ADJUSTMENT"]).default("MANUAL_ADJUSTMENT")`.
  `kind: "PURCHASE"` requires positive delta (stock-in only).
- `purchaseAllocationSchema = { itemId, quantity }`
- `purchasesLinkStockInputSchema = { invoiceId, allocations: purchaseAllocationSchema[] (min 1) }`
- `purchasesProposalOutputSchema = { invoiceId, items: [{ itemId, itemName, lineQuantity, uninvoicedQty, proposedLinkQty, remainderQty }] }`
- `purchasesCorrectLineInputSchema = { lineId, quantity: int ≥ 1, unitCost: dinars }`

### app-contract additions

`purchasesProposal: oc.input(z.object({ invoiceId })).output(purchasesProposalOutputSchema)`
`purchasesLinkStock: oc.input(...).output(z.object({ linked: int≥0, remainderMoved: int≥0 }))`
`purchasesCorrectLine: oc.input(...).output(invoiceDetailSchema)`

### DB (additive DDL only)

```sql
CREATE TABLE IF NOT EXISTS stock_links (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  movement_id TEXT NOT NULL REFERENCES stock_movements(id),
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

### StorePort additions

- `insertStockLink(link): Promise<StockLink>` (`{ id, invoiceId, movementId, quantity, createdAt }`)
- `listStockLinksByItem(itemId): Promise<StockLink[]>` (JOIN through stock_movements)
- `getInvoiceLine(lineId): Promise<InvoiceLine | undefined>` (correction entry point)

## Router behavior

### invoicesCreate (PURCHASE)

1. Resolve every line's item (`ITEM_NOT_FOUND`). Aggregate totals: `Σ qty × line.unitPrice`.
2. `initialPaid > total` → `PAID_EXCEEDS_TOTAL`. Auto-suggest invoice number `INV-%04d`
   from `lastInvoiceNumber()` (+1, zero-padded; parse failure restarts at 0001).
3. One transaction: header → lines (`costAtSale = unitPrice`; for a purchase the line price
   IS the cost basis) → per line one `PURCHASE` movement (`delta=+qty`, `unitCost`, `ref=invoiceId`)
   → per item recompute `projectLedger` + `weightedAverageCost` replay → `setItemStockAndCost`
   → activity `PURCHASE_CREATED`.
4. Return full `InvoiceDetail`.

### stockAddManual kind=PURCHASE

Same path as today but stores `kind:"PURCHASE"`; rejects non-positive delta with
`PURCHASE_REQUIRES_INFLOW`.

### Deferred linking (purchasesProposal + purchasesLinkStock)

Uninvoiced availability per item = Σ of that item's `PURCHASE` movements with `ref=null`,
minus Σ quantities already consumed by `stock_links` rows on those movements — walked
oldest-first (FIFO by the ledger ordering).

- **Proposal** (read-only): per invoice line item → `proposedLinkQty = min(uninvoicedAvailable, lineQuantity)`,
  `remainderQty = lineQuantity − proposedLinkQty`.
- **Link** (transactional): consumes availability into `stock_links` rows until the
  allocation is satisfied; if an allocation exceeds what remains linkable AND the invoice
  line covers more than was ever recorded, the difference becomes a NEW `PURCHASE` movement
  (`ref=invoiceId`, unit cost = that line's unit price) — "create a linked movement for any
  remaining quantity". Allocation larger than line quantity → `LINK_EXCEEDS_LINE`.
- Re-linking the same invoice is allowed up to the line quantity (idempotent totals).

### purchasesCorrectLine

Find the line (`LINE_NOT_FOUND`), its invoice must be PURCHASE. In one transaction:

1. Append `MANUAL_ADJUSTMENT delta=−originalLine.quantity` (reversal),
2. Append `PURCHASE delta=+corrected.quantity, unitCost=corrected.unitCost, ref=invoiceId`,
   both `reason="تصحيح فاتورة <number>"`,
3. Validate the projected history (negative stock → `STOCK_NEGATIVE`, nothing written),
4. Recompute cached stock + weighted average by full replay,
5. Activity `STOCK_ADJUSTED`.

Historical sale rows are untouched — settled sales keep their original cost basis;
only the live cache follows the corrected replay (ADR-0002 rule).

## Web (/purchase)

Single Arabic RTL page, nav link «المشتريات»:

- Line builder: ItemPickerDialog (ticket 28) + inline quick-add mini-form
  (barcode/name/category/prices → `itemsCreate`) that lands straight in the lines table.
- Supplier free-text name + notes + optional paid-at-intake amount.
- Save → success card showing the invoice number, then a proposal panel:
  items with `proposedLinkQty > 0` get a one-click «ربط المخزون السابق» button → `purchasesLinkStock`.
- No e2e-flaky date inputs: invoiceDate defaults server-side to today.

## Tests

Router (`router.test.ts`, wire seam):

- unauthed `invoicesCreate` → UNAUTHORIZED; SALE kind → SALE_NOT_IMPLEMENTED
- multi-line purchase: movements appended per line, cached stock + weighted avg correct
  (blend case: 5@200 + 10@300 → 266… exact ints chosen), paid/partial/remaining math
- quick stock without invoice: `stockAddManual kind=PURCHASE` lands as PURCHASE movement
- proposal + link: partial link consumes FIFO availability; remainder creates a linked
  movement; second link caps at line quantity; over-allocation → LINK_EXCEEDS_LINE
- correction: reverses + re-adds, history grows (append-only), weighted avg follows the
  corrected cost, oversell during correction → STOCK_NEGATIVE and ledger untouched

Store: stock_links round-trip + per-item filtering.

E2E (`tests/e2e/ticket29.spec.ts`): category + two uniquely-named items → /purchase →
build lines via picker → save → stock reflected in items list; unique item names per the
shared-wiped-database wisdom rule.

## Risks

- Link consumption ordering relies on the same occurredAt/rowid ordering as the ledger —
  shared helper keeps one spelling of "oldest first".
- `costAtSale` doubles as purchase cost basis for PURCHASE lines; ticket #30 must not
  assume it always means "sale-time cost".
- Correcting QUANTITY can trigger STOCK_NEGATIVE if the inflated units were already sold —
  surfaced as a user-facing error, not silent acceptance.
