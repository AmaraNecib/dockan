# Weighted average cost for stock valuation

Stock is valued at the weighted average of unit costs across purchases: buy 100 units at 200 DA, later 200 units at 220 DA, and the app recomputes the per-unit mean automatically; profit = selling price − average cost. The mean is recomputed over the quantity **on hand at purchase time**. sold units are already realized and never re-valued: 30 left at 200 + 100 bought at 120 → (30×200 + 100×120) ÷ 130 = 138 DA. Future sales snapshot that average as their cost; past sales keep theirs. We chose this over per-batch/lot tracking (selling "from the first buy" vs "from the second buy" at different prices) because batch selection costs roughly 3-4 extra days of UI and bookkeeping a small shop does not need. Batch tracking remains a possible post-MVP upgrade, but retrofitting it will require migrating historical sales.

> Amended by ADR-0005: since ticket #30, SALE lines snapshot the FIFO
> cost of the layers they consume, not this moving average; the sentence
> above ("future sales snapshot that average as their cost") now applies
> only to the live cache valuation, which still follows this weighted average.

> Amended (issue 144): an owner-edited cost price is a ledger fact, not a
> direct `items.costPrice` write. A cost change through `itemsUpdate` appends a
> **cost-correction movement** in the same transaction: a `MANUAL_ADJUSTMENT`
> with `delta = 0`, `unit_cost = <new cost>`, and the stable
> `reason = "COST_CORRECTION"` token. This defines the zero-quantity case the
> formula `(oldQty*oldCost + qty*cost)/(oldQty+qty)` leaves undefined: a
> zero-quantity correction **sets** the running weighted average to its unit
> cost without changing quantity. Replay then stays safe — a later inflow
> weights the corrected average by the on-hand quantity (weight zero when the
> correction landed on an empty item, so it cannot corrupt that inflow), and a
> later outflow only reduces quantity. The correction revalues the live
> average; FIFO layers are untouched (delta 0 adds no layer), consistent with
> ADR-0005's separation of `costAtSale` from `items.costPrice`. A zero-delta
> movement whose `reason` is not `COST_CORRECTION` (the legacy `opening`
> backfill writes these for zero-stock items) stays a replay no-op. The
> activity log carries a distinct `ITEM_COST_CORRECTED` entry; the api emits a
> locale-neutral token and the web owns the copy.
