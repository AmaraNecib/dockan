# Weighted average cost for stock valuation

Stock is valued at the weighted average of unit costs across purchases: buy 100 units at 200 DA, later 200 units at 220 DA, and the app recomputes the per-unit mean automatically; profit = selling price − average cost. The mean is recomputed over the quantity **on hand at purchase time**. sold units are already realized and never re-valued: 30 left at 200 + 100 bought at 120 → (30×200 + 100×120) ÷ 130 = 138 DA. Future sales snapshot that average as their cost; past sales keep theirs. We chose this over per-batch/lot tracking (selling "from the first buy" vs "from the second buy" at different prices) because batch selection costs roughly 3-4 extra days of UI and bookkeeping a small shop does not need. Batch tracking remains a possible post-MVP upgrade, but retrofitting it will require migrating historical sales.

> Amended by ADR-0005: since ticket #30, SALE lines snapshot the FIFO
> cost of the layers they consume, not this moving average; the sentence
> above ("future sales snapshot that average as their cost") now applies
> only to the live cache valuation, which still follows this weighted average.
