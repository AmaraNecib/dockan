# Debate — returns & refunds (high-assurance, incl. settlement split)

Tier: High-assurance (money + stock + debt invariants). Base SHA: `9b6ee41`.
Head SHA: `fd09134`. Evidence reviewed: design doc `.scratch/implementation/
59-design.md` and diff `git diff 9b6ee41...fd09134`.

Review rounds: base-feature debate (mission 53796ce2), settlement-delta review
(mission 2281d97f), and an adversarial pass over the PR-review fixes
(documenting the two PR findings below with their dispositions; the FINDING
lines were externally validated findings rather than reviewer proposals).

## Base debate — dispositions carried forward

See the previous evidence file revisions: full-return exactness, no list row
cap, clamped reject removal, persisted review annotation, split-sum and
debt-floor invariants, soft collected-cash warning on the settled cash. All
fixed; none reopened by the PR review.

## PR review findings (external, both validated)

| # | Finding | Disposition |
|---|---------|-------------|
| P1 | A request splitting one full-line return across duplicate invoiceLineId entries priced each entry as a PARTIAL return → per-entry rounding could over-refund (a 101-DZD line over 3 units, requested as [2,1], settled 34+34 = 102). | **Fixed (fd09134):** `computeReturnRefund` consolidates quantities by invoiceLineId BEFORE pricing, one line + movement per consolidated line. Wire regression: net-101 line requested [2,1] refunds exactly 101 with a single return line (qty 3) and a single marked movement. |
| P2 | When returned units were RESOLD before the reject, the report exclusion/un-exclusion treated the reject as restoring the ENTIRE original sale → the resold units' revenue+COGS booked in BOTH the original sale and the resale (double-booking). | **Fixed (fd09134):** per-unit closed booking — `bookSaleLineForReturns`: bookedQty = sold − held(pending/accepted) − (rejectedQty − rejectedScrapQty, the CLAMPED on-hand portion at review). Scrapped-now units stay in the original line (preserves the approved full-scrap freebie-reject loss); resold units are booked only by the resale invoice, never twice. The reject now aggregates ONE scrapping movement per item so the scrap attribution is exact. Wire regression: return 3 / resell 2 / reject (clamp 1) → original books the 1 scrapped unit (300 rev / 100 cogs), resale books 2 (600 / 200) → revenue delta 900, cogs delta 300; a fully-scrapped freebie reject still keeps its −200. |

## Settlement-delta defender highlights (still accepted)

Single-cash-input design guarantees cashPaidOut + debtOffset = refundAmount in
every branch; `dinarsSchema.min(0)` blocks negative cash; the debt unit uses
the proven conditional-UPDATE pattern inside BEGIN IMMEDIATE; legacy
settlement backfill is idempotent (row-invariant can't match post-split rows).

## Verdict

No blockers. Money/stock/debt/report invariants are deterministic and tested;
both PR findings closed with dedicated regressions.