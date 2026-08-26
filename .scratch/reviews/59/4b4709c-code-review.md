# Code review — returns & refunds (standards + spec axes)

Base SHA: `9b6ee41`. Head SHA: `4b4709c`. Diff: `git diff 9b6ee41...4b4709c`.

Reviewers: reviewer subagents (standards axis, spec axis — mission 53796ce2)
plus the settlement-delta review (mission 2281d97f). Evidence re-keyed after
the settlement split, freebie unwind, and the delta review fixes.

## Standards

Fixed during review:
- New-source comments carrying issue numbers (return-calculations.ts,
  drizzle-store.ts) → semantic (cab527a).
- Arabic strings inside comments of NEW files (return-print.tsx,
  returns.spec.ts) → English (parent directive; existing legacy Arabic
  comments in touched files left untouched).
- Type assertions without SAFETY: justification (drizzle-store.test.ts)
  → added (617a7ab).

Confirmed compliant with the repo's documented standards:
- @dokan/contracts single source of truth (split fields, error keys, enum
  tuples imported by the drizzle schema).
- ADR-0003 StorePort seam: settlement + debt methods go through the port;
  raw SQL confined to the driver adapter (applyDebtOffsetToInvoice mirrors
  applyPaymentToInvoice).
- Money = whole DZD integers everywhere (split amounts, debt offsets,
  refunds), Algeria-local timestamps, Arabic UI with stable server keys
  translated by tError.
- Append-only ledger discipline preserved: the return inflow and reject
  outflow are appended rows; only `return_mark` and `returns.status/reason`
  transition; `paidAmount` is never rewritten (cash is a record, debt flows
  through the invoice remainingAmount — the debt is a live claim, not a sale
  fact).

Baseline smells (judgement calls, accepted):
- Duplicated ledger-append blocks between create/reject — matches the
  router's existing explicit style; a shared helper was judged higher risk.
- Speculative Generality (mild): payoutMethod future-proofing is a documented
  owner decision.

## Spec

All requirements present and correctly implemented for both the base spec and
the owner's post-implementation decisions:

Base:
- Returns table (invoice ref, line refs, quantities, Arabic reason, whole-DZD
  refund, payout method, review state), marked SALE-reversal movements,
  per-line sold−returned cap, RTN sequence, on-demand RTL voucher, reject →
  clamped MANUAL_ADJUSTMENT (all preserved).

Settlement split (decision 1+2):
- Return screen: all-cash / all-debt / custom split; collected-so-far vs
  refund-total; soft warning when the confirmed cash exceeds collected; no
  hard block. `cashPaidOut` + `debtOffset` sum to the return value; the debt
  portion reduces the invoice's remaining debt in the same unit; the cash
  side is a record. Deterministic parent scenario pinned by a wire test
  (1000 / 500 → cash 200 / debt 300 → debt 700).

Freebie unwind (decision 3):
- A free (0-price) line returned in full re-enters stock at cost and its
  booked −cogsExact leaves the report (no lingering loss, ledger net zero).
  REJECTED returns keep the sale booked (scrapped goods are a real cost) —
  review-refined behavior, tested both ways.

## Summary

Standards: 3 findings (all fixed) + 2 accepted judgement calls. Spec: 0
missing, 0 scope-creep, 0 wrong. Worst remaining per axis: none blocking.