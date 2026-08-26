# Wisdom: returns — money and review-flow traps

## Review-consume flows must never deadlock on a STOCK_NEGATIVE reversal (🟠 Major)

A rejected (damaged) return removes the returned quantity as a MANUAL_ADJUSTMENT
outflow. Because returned goods are salable IMMEDIATELY, by review time some of
them may already have been resold — a full-quantity reversal then pushes the
projection negative, `projectLedger` throws, the transaction rolls back, and
the return stays PENDING_REVIEW forever with no escape (the "review deadlock").
Fix pattern: clamp the removal to the stock actually on hand
(`removal = min(returnedQty, projected.stockOnHand)`) and record the clamp;
resold units remain legitimate sales. Replay stays valid by construction and
the review can always finish. General rule: any "consume" action that reverses
a prior inflow must tolerate intervening consumption, or it becomes a trap the
user cannot escape.

**Always**: design the reject/undo path for the state where the thing being
undone is partially or fully gone; clamp to reality, never fail the whole
operation.

## Full-line refunds must be exact; per-unit rounding only for partials (🟠 Major)

`Math.round(netTotal / lineQuantity)` refunded 3 units of net-101 as 3 × 34 =
102 — a DZD the customer never paid. When `returnedQty === soldQty` refund the
line's netTotal EXACTLY (the unit snapshot stays the rounded effective price
for display). The same whole-DZD rounding philosophy that keeps unit prices
snapshotted does NOT justify drifting the total refund on the primary money
path — exactness there matters more than display consistency. Partial returns
still price at the rounded effective unit.

## Refunds and collected money are a separate axis from quantity caps (🟡 Minor)

The owner decision "any past invoice, any quantity, forever" scopes QUANTITY.
Whether a cash refund may exceed what the invoice actually collected
(`paidAmount`) is a separate policy question — and a hard guard is dangerous
in this app because counter sales are routinely recorded with `paidAmount=0`
(optional field), so "refund ≤ paid" would block the primary flow. When a
money cap would break the app's real recording patterns, surface the question
to the owner instead of silently coding either side.

## A pending review must stay reachable forever — never row-cap that list (🟡 Minor)

`listReturns` originally had an unconditional `.limit(200)`; a PENDING return
older than the newest 200 rows would be invisible on the review page, its mark
never consumed, and the client's remaining-cap mirror would diverge from the
server. Review queues are low-volume by nature; ordering newest-first with NO
row cap keeps every pending item actionable. If a cap is ever needed, cap the
reviewed section, never the pending one.

## Durable data carries Arabic directly; UI copy goes through i18n (💡 Design)

ADRs and activity summaries already write Arabic data ("تصحيح فاتورة",
"تسوية مخزون"). Similarly, ledger movement reasons ("مرجوع", "مرجوع تالف …")
are stored DATA — keep them in the DB in Arabic and do NOT route them through
the UI translation layer. Reviewers may flag hardcoded strings; the principled
line is stored-fact vs rendered-copy.