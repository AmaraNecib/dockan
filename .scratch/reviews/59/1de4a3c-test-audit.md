# Test audit — returns & refunds (incl. settlement split + PR fixes)

Tier: High-assurance. Base SHA: `9b6ee41`. Head SHA: `1de4a3c`.

Reviewers: reviewer subagents (edge-case hunter, coverage analyst, quality
reviewer — mission 53796ce2), settlement-delta review (mission 2281d97f), and
three external PR finding waves (P1–P2 @ fd09134, S1–S2 @ 1de4a3c, plus the
locale-neutral api/translation directive).

## Commands (at head)

- `bun test apps/api/src` — 418 pass / 0 fail (incl. the 5-file locale guard)
- `bun test` (apps/web) — 121 pass / 0 fail
- `DOKAN_PORT=4336 DOKAN_WEB_PORT=5191 bun run test:e2e -- --workers=1` — 18 pass
- `bun run typecheck` 3/3, `bun run lint` 0 errors

## PR-finding regressions

| Finding | Regression | Layer |
|---|---|---|
| P1 dedupe-first refunds | split entries of one line price once (101/3 as 101) | unit + wire |
| P2 reject-resale double-booking | bookedQty per-unit closed booking; report deltas | unit + wire |
| S1 sequence-aware partials | sequential 1+2 → 34+67 = 101; partials-then-remainder exact (19+19+58 = 96); six 1-unit partials never exceed 101 cumulatively; wire: 34+67 = 101 then cap refuses more | unit + wire |
| S2 per-line reject scrap | return A(2)+B(1) same item, resell 2, reject → per-line scrap via `#<lineId>` suffix; report revenue 900 / cogs 300; one movement per line visible in history | unit + wire + store |
| Locale-neutral api | wire tests assert key reasons (`RETURN_RECORDED`, `RETURN_REJECTED_DAMAGED`); 5-file Arabic guard test (new api seam + new web components/pages); e2e still asserts Arabic via the translated ui (`مرجوع`, `900 دج`) | api + web + e2e |

## Carried dispositions (unchanged)

Reject-after-resale stock clamp `[5,2,5,1,0]`; full-line exact refunds;
negative-netTotal guard; rejected returns count toward the returnable cap
(accepted+documented); debt-offset conditional + sequential caps; legacy
settlement migration idempotency; settled-cash soft warning; freebie-return
report unwind + fully-scrapped freebie keeps its loss; freebie loss regression.

## Quality (grade B)

Behavior-stating names, exact money/replay/report assertions, layered seams, a
deterministic migration test, and a source-level locale guard. Residual notes
(accepted): React act() warnings mirror the existing suite; web test fixture
duplication is test-only; the FIFO scrap allocation across same-item lines is
documented (order = return-line order).

## Verdict

Every money/stock/debt/report/locale invariant has a deterministic test; all
PR findings closed with regressions at the unit and wire seams.