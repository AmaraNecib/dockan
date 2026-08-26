# FIFO cost at sale is separate from the weighted-average live cache

Ticket #30 records every sale line's cost as the rounded weighted unit cost of
the FIFO layers that line actually consumes (`costAtSale`, see
`fifoOutflowCost` in `apps/api/src/lib/stock-ledger.ts`), so historical sale
profit reflects the first-in-first-out flow of stock. ADR-0002 still governs the
live `items.costPrice` cache: every inflow blends into the moving weighted
average, outflows only reduce quantity, and the average is replayed from the
full ledger after any write. This amends the ADR-0002 sentence "future sales
snapshot that average as their cost" — sale lines snapshot FIFO cost, not the
live average — because issue #30 explicitly requires FIFO for costing and the
two numbers legitimately diverge (e.g. layers 5×100 + 5×200: a 6-unit sale
records costAtSale 117 while `items.costPrice` stays 150). No lot is ever
selected by the operator; the ledger remains the single source of truth for
both valuations.

Tradeoff accepted: `costAtSale` is the FIFO-weighted unit cost rounded to
whole DZD, so a line's implied COGS (quantity × costAtSale) can drift from the
exact layer total by up to half a DZD per unit (e.g. layers 2×10 + 1×15, 3-unit
sale: rounded 12 vs exact 11.67). This matches the whole-DZD rounding already
applied by `averageCostAfter`; exact per-line COGS needs an additive column.

> Resolved (issue 43): the additive column landed as `invoice_lines.cogs_exact`
> — the exact, unrounded total of the layers a line consumed (SALE lines store
> the FIFO layer sum from `fifoOutflowCost`; PURCHASE lines store
> quantity × unit cost). The profit report now sums `cogsExact` instead of
> `quantity × costAtSale`, so historical per-line profit is exact from the
> moment the column exists. Backfill for older rows is `cogs_exact =
> quantity × cost_at_sale`: exact for PURCHASE rows (cost was the unit cost),
> and equal to the old report formula for SALE rows written before the exact
> snapshot — those keep their previous accuracy, only new sales are exact.
>
> Issue 43 also widened sale movement timestamps: a SALE invoice that
> explicitly carries an `invoiceDate` dates its stock movements at that
> business date, bounded to never precede the item's newest inflow — a dated
> row can never sort ahead of stock it consumes, so FIFO replay stays valid
> (see `saleMovementTime` in apps/api/src/lib/stock-ledger.ts). Undated
> invoices keep wall-clock movement timestamps.