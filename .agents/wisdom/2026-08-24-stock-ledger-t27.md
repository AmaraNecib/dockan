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

## 3. Run Greptile BEFORE piling docs/skills commits onto a feature branch
Both the CLI (`--branch origin/develop`) and the bot refuse to review >100 changed
files. Our branch carried ~100k lines of `.agents/skills` + shadcn scaffolding, so the
CLI path failed and only the explicit `@greptile-apps review` tag bypass worked.
Next time: push the feature code and request review first; ride infra/docs commits
afterwards or in their own branch/PR.

## 4. Parallel Playwright specs share one wiped-once database
`playwright.config.ts` starts servers once per run; all spec files run against the SAME
DB in parallel workers. Any new spec that creates items can break older specs' loose
assertions (`getByText('منخفض')` resolving to 2 elements). Rules of thumb: unique item
names that aren't substrings of other specs' names; scope assertions to your own row
(`row.getByText(...)`); prefer `toHaveText` over `toContainText` for numeric cells;
remember threshold-0 items are ALWAYS low-stock at quantity 0.

## 5. oRPC + react-query narrowing
`useQuery(...).isPending === false` does NOT narrow `.data` for TS (status could be
error) — guard with `query.isPending || !query.data`. And `historyWithRemaining`-style
helpers should be generic (`<T extends LedgerMovement>`) so callers passing full DB rows
get full row types back instead of a stripped projection shape.

## 6. Review battery economics
Four parallel reviewer subagents (critic/defender/test-auditor/spec-reviewer) on a
~600-line diff cost ~4 min wall time and produced 1 MAJOR + several actionable MINORs,
including two real router-level test gaps. Worth it for high-assurance tier; skip the
defender leg for Standard-tier work and fold its claims into the critic prompt.
