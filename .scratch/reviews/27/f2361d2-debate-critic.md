# Review evidence — critic
Base: 3bbad9c  Head: f2361d2

## Review

### Money math / FIFO

- **MAJOR — avg-cost drift between `items.costPrice` and FIFO layers** (`apps/api/src/rpc/router.ts`, `stockAddManual` handler, ~line 118–130). Inflows blend `averageCostAfter(item.costPrice, ...)` but outflows leave `costPrice` untouched, while FIFO consumes specific layers. Concrete failure: buy 10@100, buy 10@200, sell 10 → ledger holds one layer of 10@200 (value 2000), but `items.costPrice` stays 150. The next inflow blends from 150, compounding divergence. Future COGS read from FIFO layers will disagree with every profit preview built on `cost_price`. This is arguably the approved ADR-0002 dual-write design, but the two costing methods are now permanently inconsistent and nothing documents/reconciles them.
- **MINOR — sign/kind coherence unenforced** (`apps/api/src/lib/stock-ledger.ts:70-92`, `packages/contracts/src/core.ts` `stockMovementSchema`). `projectLedger` branches on delta sign, never `kind`. A `kind:"SALE"` row with positive delta (the schema permits any nonzero int) silently creates a cost layer at `fallbackUnitCost ?? 0` — a zero-cost layer that would emit COGS=0/profit=100% later. Unreachable through today's `stockAddManual` (always writes `MANUAL_ADJUSTMENT`), but neither zod nor the lib rejects the combination, and the store's `insertStockMovement` is a public port method.
- **MINOR — silent zero-cost layers** (`stock-ledger.ts:76`). `movement.unitCost ?? opts.fallbackUnitCost ?? 0` means an inflow with no cost through a caller that forgets `opts` produces a 0-cost layer instead of failing loudly — directly contrary to this module's stated "corrupt history fails loudly" intent.

### Validation gaps (oRPC)

- **MINOR — no upper bounds** (`core.ts`, `stockAddManualInputSchema`). `delta: z.number().int()` has no `.max(MAX_SAFE_INTEGER)` / magnitude cap; `unitCost: dinarsSchema` likewise unbounded. Values above 2^53 lose integer precision in JS before hitting SQLite's 64-bit INTEGER column — corrupt signed quantities in the exact money-adjacent path this ticket feeds. `delta=0` is correctly rejected by the refine; NaN/fractional/negative unitCost fail zod server-side (UI sends raw `Number(unitCost)`, which can be NaN — rejected, but the ORPC validation error message is verbose JSON, not a stable i18n key).
- **NIT — `unitCost` accepted on outflows** (`router.ts` `stockAddManual`). API stores a user-supplied unitCost on negative deltas where it's semantically meaningless (UI suppresses it, but the contract doesn't). Raw-fact table now contains misleading facts.
- **NIT — `occurredAt` accepts arbitrary future dates**; a future-dated inflow inflates current stock immediately and skews any future `stockAsOf` reporting.

### Backfill / transactions

- **MINOR — backfill check-then-insert race** (`apps/api/src/store/drizzle-store.ts`, setup(), ~line 227–249). The zero-count guard is a separate read followed by a non-transactional insert. Two concurrent `setup()` invocations (or setup racing anything inserting movements) double-inserts the opening row. Single-process boot makes the window small, but the fix is trivial: wrap per-item in the existing transaction machinery or `INSERT ... WHERE NOT EXISTS`. Also note it inserts **delta=0 opening rows** for zero-stock pre-ledger items — clutter rows that appear in the history view as real movements.
- **MINOR — ledger invariant split**: `itemsCreate` seeds no opening movement, so post-setup items start with empty history while pre-setup items get synthetic "opening" rows (even at 0 stock). Two classes of items with different history semantics; AC "existing data compatible" is met, but this asymmetry will surprise the invoice ticket that appends SALE movements onto an empty ledger.
- **NIT — `itemsHistory` reads outside a tx** (`router.ts`): `getItemsByIds` and `listStockMovements` are two unsynchronized reads, so `fallbackUnitCost` (item.costPrice) can be newer than the movement snapshot. Single-admin app makes this near-impossible; noting for completeness. (`stockAddManual` correctly validates inside `withTransaction` — good.)
- **Note — newCost base**: `averageCostAfter` blends on `item.stockOnHand` (fast-path column) rather than ledger-derived `stockAfter`. Today they're written atomically together so they agree; the first writer that updates `items.stock_on_hand` without a ledger movement (invoices) breaks the equality silently.

### Date handling

- **Correct**: `stockAsOf`'s `occurredAt.slice(0,10) <= dateIso` is sound — all timestamps are zero-padded Algeria-local strings by schema regex, so lexicographic compare is exact and inclusive-day semantics match the test expectations. **NIT**: the public function doesn't validate `dateIso` shape; a non-padded caller input ("2025-3-5") would silently mis-compare. Internal-only today.

### Ordering

- Correct: `listStockMovements` orders by `(occurred_at, rowid)` and `ordered()` falls back to array index when seq is absent, which places the validation `candidate` after same-timestamp existing rows — matching the rowid it will get on insert. Verified consistent between projection-validation and persistence. Same-timestamp, negative-larger-than-one-layer, duplicate-cost merge, and immutability cases all have unit tests (`stock-ledger.test.ts`) that assert real values, not just "doesn't throw".

### UI

- **NIT — stale-history cache**: `StockForm.onSuccess` invalidates `itemsList`/`itemsLowStock` but not `itemsHistory`. Safe today only because the QueryClient uses defaults (staleTime 0, refetch on mount) and the history page remounts via navigation; add `staleTime` globally later and this becomes a real stale-display bug.
- Wrong-item-selected risk checked: `chosenItem = itemId || items.data?.items[0]?.id` matches the select's displayed-first-option behavior; no bug found.

### E2E

- **MINOR — false confidence in `tests/e2e/ticket27.spec.ts`**: header claims verification of "the opening movement marker", but no opening row is ever asserted (a fresh item legitimately has none — the comment even admits it). Step 3 asserts row `toContainText("6")` — a substring match that would also pass on "16"/"60" in any cell. Step 5 asserts only the error text appears, never that stock remained unchanged after the rejection. Coverage of the actual acceptance path (add-stock → history → derived stock-after) is real, though.
- **UNVERIFIED — e2e DB isolation**: step 4's `toHaveCount(1)` assumes no other spec polluted the item; whether playwright workers share one server/DB (parallel interference) depends on `playwright.config.ts`, which I did not inspect before the tool-budget cutoff.

## Acceptance report