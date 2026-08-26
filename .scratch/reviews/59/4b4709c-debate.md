# Debate — returns & refunds (high-assurance, incl. settlement split)

Tier: High-assurance (money + stock + debt invariants). Base SHA: `9b6ee41`.
Head SHA: `4b4709c`. Evidence reviewed: design doc `.scratch/implementation/
59-design.md` and diff `git diff 9b6ee41...4b4709c`.

Two review rounds: the base-feature debate (mission 53796ce2, findings applied
in `cab527a`) and a focused settlement-delta review (mission 2281d97f,
findings applied in `4b4709c`).

## Base debate (9b6ee41...cab527a) — dispositions carried forward

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | 8 | Cash refund not bounded by collected money | **Resolved by parent decision:** settlement split with a SOFT warning when cash exceeds collected — no hard block (owner-approved option (a)); cash side stays a cash record. |
| 2 | 6 | Round-half per-unit can over-refund a full return | Fixed (cab527a): full-line returns refund netTotal exactly. |
| 3 | 5 | listReturns row cap could strand a PENDING return | Fixed (cab527a): cap removed. |
| 4 | 5 | Reject-after-resale reversal can STOCK_NEGATIVE | Fixed (cab527a): reject clamps to stock on hand. |
| 5–6 | 4 | Itemless-row escape hatch / mutable return_mark | Dismissed: unreachable, documented exception. |
| 7 | 3 | Rejection note not persisted on the record | Fixed (cab527a): setReturnReason. |
| 8–10 | ≤2 | Error opacity / lines cap / Arabic ledger reasons | Fixed (8,9) cab527a; dismissed by design (10). |

## Settlement delta (cab527a...4b4709c) — findings and dispositions

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| S1 | 6 | Profit-report exclusion leaks on REJECTED fully-returned lines: scrapped goods are a real cost, the report hides the loss | **Fixed (4b4709c):** the exclusion's SUM counts only returns with status != REJECTED_DAMAGED; a rejected freebie keeps its −cogsExact (wire test: report back to the after-sale state, not pre-sale baseline). |
| S2 | 6 | Soft warning computed on REQUESTED cash, but the debt cap can swing excess into cash (all-debt beyond the debt → api settles cash, UI showed 0 → no warning) | **Fixed (4b4709c):** the panel mirrors the api's debt cap (min(requestedDebt, remainingAmount)) and warns/shows the SETTLED cash; web test: all-debt-excess warns with the settled 200. |
| S3 | ≤3 | Backfill runs un-gated on every boot (full-table UPDATE, no marker) | **Dismissed:** the row invariant (cash=0 AND debt=0 AND refund>0) cannot match a genuine post-split row; un-gated self-healing UPDATEs are the documented #43 pattern; idempotency tested. |
| S4 | ≤3 | Partially-returned lines stay fully booked in the report (profit overstated until full) | **Documented limitation** in design doc; whole-DZD determinism over per-unit reversal. |
| S5 | ≤3 | A later return rewrites the earlier sale period's reported profit (cross-period) | **Documented:** the report is query-time derived; the exclusion reflects the current returns state. Accepted for the shop's monthly-window usage. |

## Settlement-delta defender highlights (accepted)

- Single-cash-input design guarantees cashPaidOut + debtOffset = refundAmount
  in every branch (requestedDebt = refund − cash; debt = min(requested,
  remaining); cash = refund − debt; excess flows to cash).
- `dinarsSchema.min(0)` makes a negative cash input impossible (no debt
  inflation through a negative cash).
- Debt application mirrors the proven `applyPaymentToInvoice` write-first
  guard, inside BEGIN IMMEDIATE; store test pins boundary refusal and exact
  settlement.
- Legacy backfill reclassifies pre-split rows as all-cash (their recorded
  behavior) and is idempotent; fresh DBs carry the columns in DDL.

## Verdict

No blockers remain. The money/debt invariants (split sum, debt floor, atomic
debt unit, report exclusion, soft warning) are tested deterministically.