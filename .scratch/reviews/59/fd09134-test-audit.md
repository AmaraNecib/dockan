# Test audit — returns & refunds (incl. settlement split + PR fixes)

Tier: High-assurance. Base SHA: `9b6ee41`. Head SHA: `fd09134`.

Reviewers: reviewer subagents (edge-case hunter, coverage analyst, quality
reviewer — mission 53796ce2), settlement-delta review (mission 2281d97f), and
external PR #62 findings (both validated by dedicated regressions below).

## Commands (at head)

- `bun test apps/api/src` — 407 pass / 0 fail
- `bun test` (apps/web) — 121 pass / 0 fail
- `DOKAN_PORT=4336 DOKAN_WEB_PORT=5191 bun run test:e2e -- --workers=1` — 18 pass

## PR-finding regressions

| Finding | Regression | Layer |
|---|---|---|
| P1: duplicate entries over-refund | net-101 line, request [qty 2, qty 1] → refundTotal 101 (never 102), ONE return line (qty 3, unit 34, amount 101), ONE marked movement — plus unit tests for consolidated full AND partial splits | wire + unit |
| P2: reject-after-resale double-booking | return 3 / resell 2 / reject (clamp 1) → report deltas: revenue +900, cogs +300 (original books the scrapped 1 at 300/100; resale books 2 at 600/200); pending phase un-books the line; stock 0 after reject — plus unit tests for bookedQty full/excluded/full-scrap/partial-scale | wire + unit |

## Carried dispositions (unchanged)

- Reject-after-resale stock clamp `[5,2,5,1,0]`; full-line exact refunds;
  negative-netTotal guard; rejected-returns count toward the returnable cap
  (accepted+documented); debt-offset conditional + sequential caps; legacy
  settlement migration idempotency; soft settled-cash warning; freebie-return
  report unwind + fully-scrapped freebie keeps its loss; freebie loss regression.

## Quality (grade B)

Behavior-stating names, exact money/replay/report assertions, layered seams.
Residual notes (accepted): React act() warnings mirror the existing suite;
web test fixture duplication is test-only; duplicated-item-in-one-invoice
report attribution is documented as fuzzy (of normal use, one line per item —
the UI carts by item).

## Verdict

Every money/stock/debt/report invariant has a deterministic test; both PR
findings are closed by regressions at the wire and unit seams.