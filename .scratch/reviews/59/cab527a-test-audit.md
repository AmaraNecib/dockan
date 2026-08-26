# Test audit — returns & refunds

Tier: High-assurance. Base SHA: `9b6ee41`. Head SHA: `cab527a`.

Reviewers: reviewer subagents (edge-case hunter, coverage analyst, quality
reviewer). Full outputs captured from the workflow run (mission 53796ce2) and
the quality follow-up run (mission 4a6bb75a).

## Commands

- `bun test apps/api/src` — 388 pass / 0 fail
- `bun test` (apps/web) — 115 pass / 0 fail
- `DOKAN_PORT=4336 DOKAN_WEB_PORT=5191 bun run test:e2e -- --workers=1` — 18 pass

## Edge-case findings and dispositions

| Finding | Risk | Disposition |
|---|---|---|
| Reject-after-resale → STOCK_NEGATIVE deadlock (returned goods salable immediately, reviewed later) | 🔴 | **Fixed (cab527a):** reject clamps removal to available stock; wire test added (`[5,2,5,1,0]` replay). |
| Rejected/damaged returns still count toward the per-line cap | 🟡 | **Accepted, documented:** the goods physically came back and their stock was removed, so re-returning them is impossible; the cap consuming the line budget is the defensible reading. |
| Round-half drift on full returns | 🟡 | **Fixed (cab527a):** full-line returns refund netTotal exactly; partials keep the rounded unit. |
| Negative netTotal via raised discount | 🟡 | **Fixed (cab527a):** `refundUnitPriceFor` refuses non-negative netTotal; allocation math already floors at subtotal so it is unreachable in practice. |
| Duplicate line entries create duplicate return rows/movements | 🟡 | **Accepted (documented):** cap sums request-internal duplicates; each entry becomes its own return line by design; the web form exposes one input per line so only direct API misuse hits it. |
| Reject/accept when an item row is missing | 🟡 | **Dismissed (unreachable):** FK on `stock_movements.item_id` prevents deletion while movements exist. |

## Coverage findings

- Every acceptance criterion covered at ≥1 seam: cap refusal (unit + wire +
  web + e2e), refund math (pure + wire + voucher), stock back + mark
  (wire + store + e2e), review accept/reject (wire + web), voucher content
  (pure projection + render + e2e route).
- Diversity: discount case, partial return, free line, FIFO multi-layer,
  boundary, double-review concurrency, damaged reject, resale clamp.
- Gap noted (accepted): the e2e exercises accept only — reject (damaged) is
  covered by router + web tests; a reject e2e flow was considered out of scope
  for one spec.
- Doc/behavior mismatch (schema comment promised rejection reasons on
  `returns.reason`) — **fixed in cab527a** (`setReturnReason`).

## Quality findings (grade B)

- Strong: test names state behavior; assertions are exact (refund math,
  `stockAfter` replay sequences, mark transitions, error code+message).
- ⚠ Existing-suite isolation coupling (shared sqlite across describes) is the
  codebase's pre-existing pattern; my tests follow it with cross-test-safe
  assertions (scoped counts, delta-based report checks). Full isolation
  refactor is out of scope, noted.
- ⚠ React `act()` warnings from mutation-settle state updates mirror the
  existing `invoice.test.tsx` pattern; non-blocking, tests green.
- Fixture duplication of the `ReturnDetail` factory across four test files —
  accepted (test-only, low risk); a shared util is a future tidy-up.

## Verdict

No missing test that would break a money or stock invariant remains after the
fix commit. Residual notes are cosmetic or pre-existing suite-wide patterns.