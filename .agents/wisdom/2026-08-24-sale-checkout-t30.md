# Wisdom: sale checkout ticket #30

## Keep live stock valuation separate from sale FIFO snapshots

Ticket #30 explicitly asks sale lines to consume FIFO layers and preserve a cost snapshot. ADR-0002 still governs the live `items.costPrice` cache: replay all inflows with weighted-average math and leave the average unchanged on outflows. Document this split before review. Otherwise a standards check will read the two requirements as contradictory.

## Zero is a real persisted value

A fully discounted line has `netTotal = 0`, and an item may have a zero default price. Never use truthiness when mapping these fields from SQLite. Use nullish fallback and backfill legacy rows when an additive column is first introduced.

## Initial stock must enter the ledger

`itemsCreateWithStock` used to update only the cached stock fields. A later sale replayed an empty history and rejected valid stock. Any quick-add path that creates stock must append an opening movement in the same transaction.
