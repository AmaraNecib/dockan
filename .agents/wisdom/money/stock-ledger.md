# Wisdom — 2026-08-24 · Stock ledger ticket #27 (feat/27-stock-ledger)

## 1. Backdated ledger writes must not blend against present holdings
When a cached aggregate (`items.cost_price`, ADR-0002 weighted average) is kept in sync
with an append-only history, blending a NEW row against CURRENT holdings is only valid
if the row lands after every existing movement. For backdated inserts, recompute the
aggregate from the history's own remaining layers instead
(`router.ts stockAddManual` `isNewest` guard → layer value/qty).
Caught by Greptile as P1; unit blend tests alone don't catch it — always add a
backdate-path regression when `occurredAt` is caller-supplied.

## 2. Count-then-insert guards are racy across processes — make them one statement
"Check zero rows, then insert" is fine inside one serialized connection but breaks with
two processes on the same SQLite file. Use a single conditional statement:
`INSERT … SELECT … WHERE NOT EXISTS (…)` — atomic at SQLite statement level.
(Greptile P2.)

## Shared-database E2E tests need scoped assertions
Check the current Playwright config and fixtures for database ownership and worker
count. At this revision the shared suite uses one worker, not parallel workers.
Sequential specs can still leave data that affects later assertions. Any new spec that creates items can break older specs' loose
assertions (`getByText('منخفض')` resolving to 2 elements). Rules of thumb: unique item
names that aren't substrings of other specs' names; scope assertions to your own row
(`row.getByText(...)`); prefer `toHaveText` over `toContainText` for numeric cells;
remember threshold-0 items are ALWAYS low-stock at quantity 0.

## 5. oRPC + react-query narrowing
`useQuery(...).isPending === false` does NOT narrow `.data` for TS (status could be
error) — guard with `query.isPending || !query.data`. And `historyWithRemaining`-style
helpers should be generic (`<T extends LedgerMovement>`) so callers passing full DB rows
get full row types back instead of a stripped projection shape.
