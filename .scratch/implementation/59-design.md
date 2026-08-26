# Issue 59 — returns & refunds

Tier: High-assurance (money + stock invariants). Base SHA: `9b6ee41`.

## Decisions (issue #58)

- Cash refund only; the return record carries `payoutMethod` (CASH default) so
  credit / debt-credit can be added later without a migration.
- Returned items go STRAIGHT into salable stock; the ledger movement is MARKED
  as returned (review-pending). The owner reviews later and the mark is
  consumed. Damaged → the owner removes/adjusts quantity via
  MANUAL_ADJUSTMENT with a reason instead of accepting.
- Returned units join normal FIFO cost layers — pure cost into the basis, no
  special valuation.
- No limits: any past SALE invoice, any item, any quantity up to
  originally-sold minus already-returned, forever.
- Return voucher: rendered ON DEMAND from the stored return record
  (query-driven, printable RTL like the receipts route), no PDFs stored.

## Storage

New tables (CREATE TABLE IF NOT EXISTS, additive — existing DBs upgrade):

- `returns`: id, return_number (UNIQUE, RTN-%04d), invoice_id FK, refund_amount
  (whole DZD), payout_method (CASH default), reason (nullable Arabic), status
  (PENDING_REVIEW | ACCEPTED | REJECTED_DAMAGED), occurred_at, created_at,
  updated_at.
- `return_lines`: id, return_id FK, invoice_line_id FK, item_id FK (nullable),
  description (snapshot), quantity (positive), refund_unit_price (whole DZD
  snapshot), refund_amount (= quantity × unit).
- `return_number_sequence`: singleton next_number mirroring the invoice
  sequence; `allocateReturnNumber()` reserves RTN-%04d atomically.
- `stock_movements` gains `return_mark TEXT` (nullable): PENDING | ACCEPTED |
  REJECTED. Null = not a return movement. The mark is review-state metadata on
  an append-only fact row: the flat facts (delta/cost/time/kind/ref) are never
  rewritten, only the review tag transitions (PENDING → ACCEPTED/REJECTED)
  inside the same transaction as `returns.status`.

Refund basis (pure, deterministic, whole DZD): per line,
`refundUnitPrice = Math.round(netTotal / quantity)` — the per-unit amount the
customer actually paid after the invoice-level discount allocation;
line refund = quantity × refundUnitPrice; total = Σ. A free (net 0) line
refunds 0. FULL-line returns refund the line's netTotal EXACTLY (round-half
would drift by a DZD the customer never paid).

## Settlement (owner-approved split, post-review addition)

The return record stores BOTH `cashPaidOut` and `debtOffset`, which always
sum to the return value (`refundAmount`). The owner picks the split on the
return screen — all-cash / all-debt / custom — and the api computes it from
the single `cashPaidOut` input:

- requestedCash defaults to the whole return value (all-cash); must be within
  0..refundTotal, else REFUND_SPLIT_INVALID.
- requestedDebt = refundTotal − requestedCash; the DEBT portion is capped at
  the invoice's remainingAmount (the debt can never go negative) and any
  excess flows back to cash, so cashPaidOut + debtOffset = refundAmount
  always.
- The debt portion is applied to the invoice in the SAME unit (conditional
  UPDATE remainingAmount, never below zero, RETURN_DEBT_OFFSET_REFUSED on a
  violated boundary). The cash side is a cash record: paidAmount is never
  rewritten.
- The screen shows collected-so-far (paidAmount) vs the return value and
  warns when the cash portion exceeds collected — a SOFT warning, no hard
  block (owner decision (a) from the debate).
- Deterministic tests: old debt 1000, return 500, split cash 200 / debt 300 →
  remaining debt 700 and cash out 200; all-cash on an unpaid invoice allowed;
  debt never negative (excess to cash); each return caps against the debt
  remaining AFTER previous offsets.

## Profit report and fully-returned lines (post-review addition)

A SALE line whose FULL sold quantity was returned is EXCLUDED from the profit
report — the goods are back in inventory (or scrapped via reject), so the
sale is un-booked. This is what unwinds a freebie's booked loss: free line
(price 0, cogs 200) → sale books −200 → the return puts the item back at cost
and the report shows no lingering loss (net effect zero over the two
movements; ledger stock returns to pre-sale, replay non-negative).
Partially-returned lines stay fully booked (documented limitation: the
partial refund is a cash record; whole-DZD exactness keeps the report
deterministic).

## Ledger semantics (ADR-0002/0005 invariant)

- Return creation, per line: append a SALE movement with `delta = +quantity`,
  `kind = "SALE"` (a sale reversal), `unitCost = item.costPrice` at return
  time (the returned units re-enter at the going weighted average — "pure cost
  into the basis"; this also leaves the ADR-0002 average invariant), `ref =
  return.id`, `occurredAt = localDateTime()`, `return_mark = 'PENDING'`. An
  inflow can never invalidate replay, so no clamp is needed. The pending
  return's stock is salable immediately.
- Review accept: `returns.status → ACCEPTED` and movement marks
  `PENDING → ACCEPTED` (the mark is consumed). No stock change.
- Review reject (damaged): `returns.status → REJECTED_DAMAGED`, movement marks
  `PENDING → REJECTED`, and — in the same unit — one MANUAL_ADJUSTMENT outflow
  per line (`delta = -quantity`, Arabic reason "مرجوع تالف <RTN>", ref =
  return id) that re-balances stock. Replay stays valid because the return
  inflow precedes the rejection outflow (both in the same unit, different
  timestamps).
- Cap: per invoice line, remaining returnable = line.quantity − Σ(already
  returned on that line). This is the decision's "sold − already returned"
  cap; on one-line-per-item invoices it is exactly the per-item cap, and it is
  the sharper bound when an invoice carries duplicate item lines.
- Append-only money: returns never rewrite `invoices.paid_amount` /
  `remaining_amount`, debt summaries, or the profit report — the sale stays a
  settled fact; the refund is a cash record on the return (documented
  decision, mirrors the append-only philosophy).

## RPC (flat, guarded, @dokan/contracts)

- `returnsGet({ returnId })` → ReturnDetail
- `returnsCreate({ invoiceId, lines: [{ invoiceLineId, quantity }], reason?,
  payoutMethod? })` → ReturnDetail (validations: invoice exists + SALE, line
  belongs to the invoice + has itemId, quantity ≥ 1, cap; refund math; atomic
  unit: return + lines + movements + stock/cost caches + activity)
- `returnsList({ invoiceId? })` → { items: ReturnDetail[] } (detail carries
  invoiceNumber/invoiceDate/counterpartyName for display and the voucher)
- `returnsAccept({ returnId })`, `returnsReject({ returnId, reason? })` →
  ReturnDetail (status transition is a conditional UPDATE guarded by
  withTransactionImmediate, so concurrent reviews can never double-consume)

New activity types: RETURN_RECORDED, RETURN_REVIEWED.

## Web

- Vue pattern mirror of #53: `lib/return-voucher.ts` (pure `buildReturnVoucher`,
  no money math), `components/return-voucher-view.tsx` (deterministic RTL),
  page `pages/return-print.tsx` at `/invoices/$invoiceId/returns/$returnId/print`
  with the same one-shot auto-print gate as ReceiptPrintPage.
- Invoice detail page gains a returns panel: history of this invoice's returns
  (status chips, print links) + a new-return form with per-line quantity
  drafts capped at the remaining-returnable (draft-string pattern from #43).
- New `/returns` review page: all returns, pending first, Accept / Reject
  (with optional reason) buttons; rejects carry the standardized Arabic
  reason.
- i18n: Arabic strings + server error keys (RETURN_NOT_FOUND,
  RETURN_NOT_SALE, LINE_NOT_ON_INVOICE, RETURN_EXCEEDS_RETURNABLE,
  RETURN_NOT_PENDING, RETURN_LINE_NOT_RETURNABLE).

## Tests

- Unit (`apps/api/src/lib/return-calculations.test.ts`): refund math with and
  without discount, round-half behaviour, zero-net lines, caps, remaining.
- Store (`apps/api/src/store/drizzle-store.test.ts`): returns persistence,
  return-number allocation, list-by-invoice, detail shape, transition +
  mark-consume, mark columns preserved by replay (append-only).
- Router (`apps/api/src/rpc/router.test.ts`): create validations (invoice
  missing/not-sale, line off-invoice, >cap refusal, quantity bounds), refund
  math through the wire, stock back + marked + ref, list/get, accept consumes
  mark and leaves stock, reject removes stock as MANUAL_ADJUSTMENT + status,
  double-review refused, payoutMethod default.
- Web (`apps/web/src/pages/invoice.test.tsx`, `return-voucher.test.ts`,
  `returns.test.tsx`): form caps and payload, review flow, voucher content
  (store name / return number / invoice number / lines / refund total).
- E2E (`tests/e2e/returns.spec.ts`): sale → return → stock back + marked +
  voucher route renders content.

## Risks

- Refund basis is a policy choice (effective-per-unit after discount); full-line
  returns refund netTotal EXACTLY (the round-half-up unit could otherwise
  refund a DZD the customer never paid — fixed in review, cab527a); partials
  keep the rounded unit.
- Reject auto-removes the returned quantity CLAMPED to stock actually on hand
  (returned goods are salable immediately; some may be resold by review time —
  a full reversal would deadlock the review on STOCK_NEGATIVE, fixed cab527a).
  A reject can never block; whatever was resold stays a legitimate sale.
- `return_mark` is mutable workflow state on an otherwise append-only row —
  only the review tag ever changes, never ledger facts.
- OPEN DECISION (parent): a cash refund may pay out more than the invoice
  actually collected (paidAmount). Quantity caps are per owner decision; the
  money cap was deliberately NOT coded (counter sales routinely record
  paidAmount=0) — surfaced in the crew report decisionRequest.