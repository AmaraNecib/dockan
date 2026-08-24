# Ticket 27. Stock ledger, FIFO, item history — design

- **issue:** #27 (`Implement stock ledger, FIFO, and item history`, parent #19)
- **branch:** `feat/27-stock-ledger`
- **base SHA:** `3bbad9c` (origin/develop tip; branch is exactly develop + shadcn/skills/ADR commits)
- **review tier:** High-assurance — movement costs and FIFO consumption feed future COGS/profit
  (DZD money math); debate + test-audit required.
- **ADR:** 0004 irrelevant here except permissions naming (`stock:*` domain reserved).

## Public interfaces

### DB (additive DDL only)

```sql
CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL,            -- 'PURCHASE' | 'SALE' | 'MANUAL_ADJUSTMENT'
  delta INTEGER NOT NULL,        -- signed: +in / -out
  unit_cost INTEGER,             -- dinars; required for PURCHASE/MANUAL+, null for SALE
  reason TEXT,
  ref TEXT,                      -- invoice id when kind=SALE/PURCHASE-from-invoice
  occurred_at TEXT NOT NULL,     -- Algeria-local ISO instant chosen by caller
  created_at TEXT NOT NULL
);
-- ordering: ORDER BY occurred_at ASC, rowid ASC   (rowid breaks timestamp ties deterministically)
```

### StorePort additions

- `insertStockMovement(m): Promise<StockMovement>`
- `listStockMovements(itemId: string): Promise<StockMovement[]>` (ordered, includes rowid as `seq`)
- `countStockMovements(itemId): Promise<number>` (backfill guard)

### Domain module `apps/api/src/lib/stock-ledger.ts` (pure, no IO)

- `projectLedger(movements): { stockOnHand, layers: FifoLayer[] }`
  - positive delta → push layer `{qty, unitCost}` (unit_cost ?? item fallback passed in)
  - negative delta → consume oldest-first (FIFO)
  - throws on negative stock result (corrupt history = loud, not silent)
- `stockAsOf(movements, dateIso): number` — replay filtered to `occurred_at <= dateIso`
- `remainingAtRow(movements)` — for history UI: derived stock after each movement
- All pure functions over arrays; trivially unit-testable seam.

### Backfill rule

In `setup()`: for each item with **zero** movements, insert one `MANUAL_ADJUSTMENT`
(delta = stock_on_hand, unit_cost = cost_price, reason `"opening"`,
occurred_at = item.created_at). Idempotent: only fires when count == 0, so real
movements are never duplicated. Existing item rows stay untouched otherwise.

### Contracts (`packages/contracts/src/core.ts`)

- `StockMovement` zod schema (+ `kind` enum), `stockAddManual` input
  `{ itemId, delta (>0 for this ticket's add-stock; negative allowed with reason), unitCost?, reason?, occurredAt? }`
- `itemHistory` output `{ movements: [{..., stockAfter}], stockOnHand }`

### Router procedures (guarded seam)

- `stockAddManual(input)` — validates item exists, positive-cost rules, wraps
  `withTransaction`: insert movement + `setItemStockAndCost(newStock, newAvgCost)`
  (weighted average preserved per ADR-0002 for PURCHASE-like inflows).
- `itemsLowStock`, `itemsList` unchanged (read `items.stock_on_hand` — fast path;
  ledger is the audit trail, not the hot read).

## Dependencies

- No new packages. Uses existing drizzle/bun:sqlite, zod contracts, oRPC guard seam.
- Desktop/Tauri untouched.

## Tests

Unit (`apps/api/src/lib/stock-ledger.test.ts` + `drizzle-store.test.ts`):
- projectLedger: purchase→sale FIFO order, mixed costs, tie-break same timestamps,
  stock-as-of mid-history, negative-history rejection, opening backfill idempotency
  (run setup twice), weighted-average cost after mixed purchases.
- Store: insert/list ordering (occurred_at, rowid), transaction atomicity
  (movement + stock update commit/rollback together).

Playwright (`tests/e2e/ticket27.spec.ts`):
- add stock manually → appears in items list with raised stock;
- open item history → shows movements with derived stock-after;
- stock-as-of date control returns earlier value.

## Implementation risks

- **Backfill vs. real history:** synthetic opening movements must be visually marked
  (`reason: "opening"`) so the owner doesn't mistake them for real purchases.
- **Timezone:** occurredAt is caller-supplied Algeria-local input; we store ISO strings,
  no tz math in the API (matches existing invoice_date handling).
- **Concurrency:** single bun:sqlite connection + withTransaction keeps movement+stock
  atomic; same caveat as ADR-0003 postgres note.
- **Negative stock:** UI blocks it; API rejects with `STOCK_NEGATIVE` error key (i18n).

## Known limitations (accepted for ticket 27 — revisit when invoices land)

- **Dual-source-of-truth risk:** `items.stock_on_hand`/`cost_price` is a fast-path cache
  kept in sync only by writers that dual-write. Today those are `stockAddManual` and the
  backfill. The invoice flow currently calls bare `setItemStockAndCost`; when invoice work
  starts it MUST also append movements, or derived ledger stock silently diverges from the
  cached column. Follow-up: consistency check comparing `projectLedger` to the column,
  and route invoice stock changes through the ledger.
- **Costing duality:** ADR-0002 weighted average (`cost_price`) and FIFO layers are two
  different lenses on cost; they legitimately disagree after partial consumption. Profit
  previews read `cost_price`; future COGS from the ledger reads FIFO layers. Reconcile or
  pick one when invoices consume layers.
- **`ref` column unwired:** reserved for invoice linkage; always null until then.
- **`stockAsOf` not exposed:** implemented + unit-tested at the seam; RPC/UI exposure
  (stock-as-of date control) deferred to a later ticket.
- **Single-process assumption:** backfill idempotency relies on the single serialized
  connection; two OS processes on one DB file could race the count-then-insert guard.
