# Debate — returns & refunds (high-assurance, incl. settlement split)

Tier: High-assurance (money + stock + debt invariants). Base SHA: `9b6ee41`.
Head SHA: `1de4a3c`. Evidence reviewed: design doc `.scratch/implementation/
59-design.md` and diff `git diff 9b6ee41...1de4a3c`.

Review rounds: base-feature debate (mission 53796ce2), settlement-delta review
(mission 2281d97f), and two PR-review passes (findings P1–P2, findings S1–S2).

## Base debate — dispositions carried forward

Full-return exactness, no list row cap, clamped reject removal, persisted
review annotation, split-sum + debt-floor invariants, settled-cash soft
warning, rejection-keeps-loss convention, report per-unit closed booking.
All fixed; none reopened by the PR reviews.

## PR review findings (external, all validated)

| # | Finding | Disposition |
|---|---------|-------------|
| P1 | Duplicate entries of one line priced per entry → per-entry rounding could over-refund | **Fixed (fd09134):** computeReturnRefund consolidates by invoiceLineId before pricing. |
| P2 | Reject treated as restoring the ENTIRE original sale when units were resold → double-booking | **Fixed (fd09134):** per-unit closed booking (bookedQty = sold − held − (rejectedQty − rejectedScrapQty)); scrapped-now stays, resold booked by the resale. |
| S1 | SEQUENTIAL partial returns on a non-even line each rounded independently → qty 1 then qty 2 on a 101/3 line settled 34 + 68 = 102, never the exact 101 | **Fixed (1de4a3c):** sequence-aware pricing — `computeReturnRefund(lines, prior)` passes per-line {quantity, refundAmount}; partials price at qty × round(net/sold) capped at the remaining value (so the cumulative refund can never exceed netTotal), and the COMPLETING return (prior + qty = sold) settles the exact remainder with a single final rounding. Regressions: sequential 1+2 → 34 + 67 = 101; partials then remainder → exact full-line total; many 1-unit partials never over-refund cumulatively. |
| S2 | Reject with multiple lines of the SAME item created one per-item scrap movement whose full quantity joined to EVERY line → each line understated resold → excess original revenue/COGS booked | **Fixed (1de4a3c):** reject emits ONE clamped MANUAL_ADJUSTMENT per RETURN LINE (FIFO allocation of the clamped budget across same-item lines), each carrying the line id as a reason suffix (`#<lineId>`); the profit report's scrap attribution joins on that suffix, exact per line. Regression: return A(2)+B(1), resell 2, reject (clamp 1 → A) → A books 1 unit + resale books 2 = revenue 900 / cogs 300, each unit once. |

## Locale-neutral API (owner comments on router.ts:874/928)

The api no longer emits Arabic literals for returns: movement reasons and
activity summaries are stable keys + structured tokens (`RETURN_RECORDED`,
`RETURN_REVIEWED <rtn> <ACCEPTED|REJECTED> <amount>`,
`RETURN_REJECTED_DAMAGED <rtn>[ — <note>] #<lineId>`). The web owns the copy:
activity + item-history views translate known keys via i18n; all new
components use `t()` (incl. `t("dzd")` instead of the DZD literal). A guard
test scans the feature's new source files for Arabic characters. Existing
Arabic in files outside this PR's diff is the separate repo-wide chore.

## Verdict

No blockers. Split-sum, debt-floor, atomic debt unit, report booking, and
now the refund sequence and per-line scrap attribution are all deterministic
and tested; both latest PR findings closed with regressions.