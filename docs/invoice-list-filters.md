# Invoice list filters

The `/invoices` list filters business dates inclusively: a row dated on either entered endpoint remains in the result. The default order is newest business date first; oldest-first reverses the business-date order. Equal dates use numeric invoice sequence when both numbers have one; legacy/custom labels without a sequence fall back to recording time, then invoice ID. The order does not change ledger recording order or any accounting result.

Invoice number bounds accept a bare sequence (`111`) or a generated number (`INV-00111`, `SUP-00111`). Bounds compare the numeric sequence across both prefixes: `INV-111` through `SUP-113` includes matching sales and purchases numbered 111–113. Generated numbers use `INV` for sales and `SUP` for purchases; four digits are a minimum, not a maximum. Legacy nonnumeric/custom invoice labels have no numeric sequence and are excluded whenever a number bound is active. A malformed or unsafe number, or a lower bound greater than its upper bound, is rejected.

The item-name/barcode/number contents search, kind, and payment-status filters compose with both ranges. Filtering and counting happen before pagination. Clear filters restores all kinds, statuses, ranges and newest-first ordering.
