# #295 — Client freshness: a sale in one window must show in the other

**Branch:** `t3/295-client-freshness-1` · **Base:** `bff7a1a`
**Commits:** `f4856e0` (the change) → `6f39a41` (the debate fixes) → `97c9612`
(the evidence) → `f16890d` (the test-audit and code-review fixes)
**Tier:** Standard. **Status:** lane done — committed, not pushed, no PR, no merge.

## The two questions, answered first

### 1. Does TanStack Query's focus refetch already satisfy criterion 1?

**No.** `apps/web/src/main.tsx` builds `new QueryClient()` with no defaults, so
`refetchOnWindowFocus: true` and `staleTime: 0` apply. A window the owner
*clicks into* refetches its stale queries — that path needs nothing from this
ticket. The case it cannot cover is a window that is on screen but never
focused: two windows side by side, the one behind the other still visible. No
focus event fires there, so the number on screen stays exactly as old as the
last read made it.

Measured in `tests/e2e/client-freshness.spec.ts` (the spec's own output):

```
#295 measurement: converged in 4963ms; reader visibility=visible, focus events=0, visibility flips=0
```

The reader tab never flipped to visible (the event TanStack v5's focus
manager actually listens to is `visibilitychange`, not `focus`), was never
reloaded, was never clicked, and issued no mutation — so the bounded tick
was the only refetch trigger left that could have carried the change. The
elapsed time is reported as a measurement, not asserted as a bound: the
tick's phase against the sale is arbitrary, so a fast convergence would not
mean a focus refetch happened.

### 2. What is the smallest honest change for criterion 3?

**A repeat-window guard on the existing append-only ledger.** The ledger
never overwrites a movement, so two windows posting the same adjustment do
not overwrite each other — they append twice, and the stock moves twice for
one intention. `stockAddManual` now refuses the second post inside a
30-second window with `ORPCError("CONFLICT", { message:
"STOCK_ADJUSTMENT_DUPLICATE" })`; the first write stands.

The guard compares the incoming request against every movement **recorded**
inside the window, using the identity the request **expressed**: the item,
the kind, the signed quantity, the reason, plus a caller-supplied business
date and a caller-supplied cost when there is one. Two fields stay out on
purpose:

- a **server-stamped** date — two identical requests carry different stamps,
  so a stamp in the identity would make the guard dead on arrival (the trap
  #177 closed for supplier adjustments with its `serverStamped` rule);
- a **derived** cost — an inflow that said no cost means "at the item's
  cost", and the server derives that at posting time. The first posting
  moves the average, so a derived cost in the identity would let the retry
  of a no-cost adjustment slip past.

**No schema column, no `packages/contracts` change, no new procedure, no
package, no port beyond loopback.** The `#181`-style `idempotencyKey` on the
input schema is exactly the contracts change criterion 4 forbids.

## What changed

**API**

- `apps/api/src/lib/stock-adjustment.ts` (new) — the identity of one stock
  adjustment, the 30s window, the cutoff, and the comparison.
- `apps/api/src/rpc/router.ts` — `stockAddManual` posts inside
  `withTransactionImmediate` (the guard reads and then writes, so the write
  lock comes first) and refuses a repeat with `CONFLICT` /
  `STOCK_ADJUSTMENT_DUPLICATE`.
- `apps/api/src/store/port.ts` + `drizzle-store.ts` — one new read,
  `listStockMovementsSince(itemId, recordedAfter)`: the movements recorded
  after a local stamp, in insertion order, with the window applied in sql.

**Web**

- `apps/web/src/lib/freshness.ts` (new) — `HOT_COUNTER_REFETCH_MS = 5_000` and
  `hotCounterRefresh(refreshMs)`: the tick plus
  `refetchIntervalInBackground`, because the unfocused window is the case
  the tick exists for.
- `apps/web/src/pages/items.tsx` — the items table (stock on hand) polls on
  that tick. It had no interval at all before.
- `apps/web/src/pages/dashboard.tsx` — the landing summary polls on the same
  tick, shortened from 60s.
- `apps/web/src/pages/stock.tsx` — an item's history (the running stock
  column) polls too.
- `apps/web/src/lib/pending-returns.ts` — the shared count ticks in the
  background, so the shell badge converges in an unfocused window.
- `apps/web/src/lib/i18n.ts` — the refusal reads
  "نفس تعديل المخزون مسجّل قبل لحظات — لم يُطبَّق مرتين. غيّر سبب التعديل أو أعد
  المحاولة بعد قليل." — the raw code never reaches the owner.

**Tests**

- `apps/api/src/lib/stock-adjustment.test.ts` — 8 tests: the identity
  separates the actions that move the stock differently; a cost the request
  did not express is not compared; a server-stamped date is not compared and
  a caller-supplied one is; the cutoff lands on the window's edge in the
  server's own format.
- `apps/api/src/store/stock-ledger-store.test.ts` — the window in sql.
- `apps/api/src/rpc/router.test.ts` — 4 tests: two clients, one refusal,
  the first write survives; a different adjustment right after still records;
  an intervening movement does not hide the repeat; a no-cost repeat after
  the average moved is still refused.
- `apps/web/src/pages/items.test.tsx` — the list polls, the query carries the
  background flag, and the refusal is actionable.
- `tests/e2e/client-freshness.spec.ts` — two windows, one sale, no reload.
- `tests/e2e-selection.map.json` — the new spec is reachable from the
  feature rules (the selection test failed without it).

## The commands, and what they said

| Command | Result |
|---|---|
| `bun test apps/api/src/lib/stock-adjustment.test.ts` | 8 pass, 0 fail |
| `bun test apps/api/src/rpc/router.test.ts` | 263 pass, 0 fail |
| `bun test apps/api/src/store/stock-ledger-store.test.ts` | 7 pass, 0 fail |
| `bun test` (in `apps/web`) — `src/pages/items.test.tsx` | 58 pass, 0 fail |
| `bun test` (in `apps/web`) — `items.test.tsx` + `dashboard.test.tsx` | 95 pass, 0 fail |
| `bun run test` (full unit suite, heavy queue) | api 1076, web 1432, scripts 97 — **0 fail** |
| `bun run test:e2e` (heavy queue) | **104 passed (6.7m)** |
| `bun run lint` | 0 errors |
| `bun run typecheck` | 4 tasks successful |
| `bun run skills:check` | 32 skills in sync |

**Ablations — the new tests are red without the fix:**

- the API guard disabled → the router test fails (exit 1);
- the web tick removed → the two hot-counter tests fail (exit 1);
- the guard narrowed back to "the newest movement only" → the two new router
  tests fail (exit 1);
- dropping the derived-cost rule → the re-derived-cost test fails (exit 1).

## Deliberately left alone

- **No push, no PR, no merge** — parent-only work.
- **No schema, no migration, no `packages/contracts` change** — criterion 4.
- **No package added, no `bun add` / `bunx` / `npx`** — only
  `bun install --frozen-lockfile`.
- **No push channel, no outbox, no offline queue** — out of scope by the
  ticket; the tick is the honest v1 answer.
- **The 60s midnight day-lag** on the dashboard is now ≤5s. It was documented
  as deliberate; the read is cheap enough that the shorter tick is the
  point.
- **The item's ledger is not hashed** — the guard is a repeat-window, not a
  content hash over the whole history.
- **The `refreshMs` prop on the two pages** is test surface area. The
  dashboard shipped it before this change; the alternative (a context or an
  env knob) is worse.
- **A second identical adjustment inside 30s is refused.** The escape hatch
  the predicate offers is the reason: a different reason is a different
  action. The refusal says so.
- **The read-cost numbers are one measurement, not a promise** — 0.65 ms per
  `dashboardSummary` and 0.27 ms per `itemsList` (50 rows), sql only, on a
  shop of 20 items and 500 movements. There is no committed benchmark.

## The lenses

- **Debate** — critic + defender on `zen-proxy/glm-5.3-flash-free`
  (never the author's model). Two blockers and five majors came out of it;
  all are fixed in `6f39a41`. Evidence:
  `.scratch/reviews/295/6f39a41-debate.md`.
- **Test-audit** — round 1 found 5 things to fix and 9 gaps; the five fixes
  are in `f16890d` (the exact refusal message, the premise of the no-cost
  test, a concurrent-post test, the e2e's focus isolation, the cost rule).
  Round-1 output: `.scratch/reviews/295/round1-test-audit.md`.
- **Code-review** — round 1: standards *met with gaps*, spec *met with gaps*;
  the gaps are fixed in `f16890d`. Round-1 output:
  `.scratch/reviews/295/round1-code-review.md`.
- Round 2 of both lenses runs against `f16890d`; its evidence files land
  next to the round-1 ones.
