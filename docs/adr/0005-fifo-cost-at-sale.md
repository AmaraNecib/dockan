# FIFO cost at sale is separate from the weighted-average live cache

Ticket #30 records every sale line's cost as the rounded weighted unit cost of
the FIFO layers that line actually consumes (`costAtSale`, see
`fifoCostForOutflow` in `apps/api/src/lib/stock-ledger.ts`), so historical sale
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
applied by `averageCostAfter`; exact per-line COGS would need an additive
column and is deferred as a follow-up.