# Greptile PR review (#32) — findings & resolutions
Base: 3bbad9c · Fix commit HEAD recorded at push time

## P1 — Backdated inflows use current quantity for averageCostAfter — FIXED
apps/api/src/rpc/router.ts (stockAddManual): cost blending now applies only when the
candidate lands after every existing movement (`isNewest` guard). Backdated inflows
recompute `cost_price` from the ledger's remaining FIFO layer value/qty — position-
independent and consistent with history. Regression test added (router.test.ts,
"stock ledger — backdated inflows"): 10@100 + 10@200 → blend 150; backdated +5@50 →
layers 5@50/10@100/10@200 → costPrice recomputed to 130, stockAfter ordering asserted.

## P2 — Opening backfill not atomic across processes — FIXED
apps/api/src/store/drizzle-store.ts (setup): replaced count-then-insert with a single
conditional statement (`INSERT … SELECT … WHERE NOT EXISTS`), atomic at SQLite's
statement level. Idempotency tests unchanged and passing.

## Evidence
- typecheck 3/3 · oxlint clean · bun test 87 pass · e2e 3 passed
- Prior battery: f2361d2-*.md + verification pass 14379f0-code-review.md (READY)

## Round 2 — Greptile 4/5 finding: backdated inflows switch costing models — FIXED
Valid finding. The round-1 fix (remaining FIFO layer value) used the wrong valuation
model for cost_price. Replaced with the model-correct approach:
`weightedAverageCost()` in apps/api/src/lib/stock-ledger.ts replays the FULL ledger
chronologically under ADR-0002 (inflows blend into the running average; outflows only
reduce quantity). Router now uses it for every inflow write — no per-position
special cases at all. Position-independent by construction.

New unit tests pin the exact property Greptile flagged: after a sale consumes the
entire cheap layer, cost_price stays 200 (ADR-0002), NOT 300 (FIFO layer avg).
Backdated regression test still passes with replay math (130).

Gates: typecheck 3/3 · oxlint clean · bun test 90 pass · e2e 3 passed.
