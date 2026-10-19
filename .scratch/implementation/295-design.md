# #295 — Client freshness: a sale in one window must show in the other

Thin slice of #294 (v1 local-first multi-client). Two windows, one API, one
SQLite file.

- **Base commit:** `bff7a1a` (local `develop`, bun 1.4.3 pinned)
- **Branch:** `t3/295-client-freshness-1`
- **Review tier:** **Standard** — the diff touches the API's money path (a
  stock adjustment), the web's hot counters and a store port, but it invents
  no schema, no auth rule and no deploy step, so none of the five
  High-assurance failure modes in `docs/engineering-workflow.md` apply.

## The two questions the report has to answer first

1. **Does TanStack Query's focus refetch already satisfy criterion 1?** No.
   `apps/web/src/main.tsx` builds `new QueryClient()` with no defaults, so
   `refetchOnWindowFocus: true` and `staleTime: 0` apply: a window that
   regains focus refetches its stale queries. That covers the window the
   owner *clicks into*. It does not cover a window that is visible but never
   focused — two windows side by side, the one behind the other still on
   screen. No focus event fires there, so the number on screen stays exactly
   as old as the last read made it. Measured in
   `tests/e2e/client-freshness.spec.ts`: the background window took **0
   visibility flips** (the event TanStack v5's focus manager actually listens
   to — `visibilitychange`, not `focus`) and still converged.
2. **The smallest honest change for criterion 3?** A repeat-window guard on
   the existing append-only ledger — no schema column, no `packages/contracts`
   change, no new procedure. The ledger never overwrites a movement, so two
   windows posting the same adjustment do not overwrite each other: they
   append twice, and the stock moves twice for one intention. The guard
   refuses the second post inside a 10-second window and lets the first
   stand.

## What changes

| Area | Change |
|---|---|
| `apps/api/src/lib/stock-adjustment.ts` (new) | The identity of one stock adjustment (item, kind, signed delta, the cost the request *expressed*, the reason) and the 10s window inside which a second copy of it is a repeat. Two fields join the identity only when the caller expressed them: a **server-stamped** `occurredAt` cannot tell a retry apart (two identical requests would differ on it — the trap #177 closed for supplier adjustments), and a cost the **server would have derived anyway** is not part of what the request said. The second one matters more than it looks: the web pre-fills the cost field with the item's current cost, and a focus refetch refreshes that pre-fill, so a retry after the average moved carries a different number that means exactly the same thing. A cost of the owner's own (different from the current one) IS part of the identity: "add five at 300" is not "add five". A caller-supplied date IS part of the identity too: two adjustments dated differently are two actions. |
| `apps/api/src/rpc/router.ts` | `stockAddManual` now posts inside `withTransactionImmediate` and refuses a repeat with `ORPCError("CONFLICT", { message: "STOCK_ADJUSTMENT_DUPLICATE" })`. The write lock comes first: the guard reads and then writes, so a deferred transaction would let a second writer's read land on a stale snapshot. |
| `apps/api/src/store/port.ts`, `drizzle-store.ts` | One new read, `listStockMovementsSince(itemId, recordedAfter)`: the movements **recorded** after a local stamp, in insertion order. The window is applied in sql, so the guard reads the handful of rows inside it rather than the whole ledger. The comparison against the recorded rows happens in the guard, not in the store — the identity is business policy, not a query. |
| `apps/web/src/lib/freshness.ts` (new) | The bounded tick the hot counters ride: `HOT_COUNTER_REFETCH_MS = 5_000`, and `hotCounterRefresh(refreshMs)` — the tick plus `refetchIntervalInBackground`, because the unfocused window is the case the tick exists for. |
| `apps/web/src/pages/items.tsx` | The items table (stock on hand) polls on that tick. It had no interval at all: the stock column only moved on a focus event or an explicit invalidation. |
| `apps/web/src/pages/dashboard.tsx` | The landing summary (today's sales, low stock) polls on the same tick, shortened from 60s. The same `REFRESH_MS` also rides the shared pending-return count and the onboarding checklist, which the old comment documented as deliberate at 60s. |
| `apps/web/src/pages/stock.tsx` | An item's history (the running stock column) polls too, on a slower tick (15s, `LEDGER_REFETCH_MS`): the history read re-reads the whole ledger and projects it, so its cost grows with the shop's history, and the store serializes its calls on one connection — a fast tick there would hold the queue a sale write waits on. |
| `apps/web/src/lib/pending-returns.ts`, `components/app/app-shell.tsx` | The shared count carries `refetchIntervalInBackground` and the shell badge asks for the hot bound: the badge lives in the shell, which is on screen in the window the owner is *not* looking at. |
| `apps/web/src/lib/i18n.ts` | The refusal gets a message the owner can act on: `STOCK_ADJUSTMENT_DUPLICATE` → "نفس تعديل المخزون مسجّل قبل لحظات — لم يُطبَّق مرتين. غيّر سبب التعديل أو أعد المحاولة بعد قليل." |

## Why 5 seconds

Two bounds, and only one of them is the server's.

- **Server cost.** Measured once on this machine against a shop of 20 items
  and 500 stock movements: `dashboardSummary` **0.65 ms** per read,
  `itemsList` (50 rows) **0.27 ms** per read — the sql only, not the oRPC
  round trip. One window ticking every five seconds spends about 0.01% of a
  core on those reads; two windows about twice that. The api answers on the
  loopback interface and both reads are local sql over a local file. There is
  no committed benchmark for the numbers, so treat them as one measurement,
  not a promise. Two more reads ride the tick — the pending-return count and
  the onboarding checklist (both tiny) — and the item history has a 15s tick
  of its own, because its cost grows with the ledger.
- **Human cost.** A stock number at most five seconds behind is a number the
  owner can act on. The same number at sixty seconds is one they have to
  re-check by hand — which is the complaint #294 records.

The measured convergence in the e2e (one run, one machine): the background
window showed the new numbers **4963ms** after the sale. The elapsed time is a *measurement*, not
the proof: the tick's phase against the sale is arbitrary, so a fast
convergence would not mean a focus refetch happened. The proof is the
isolation — the reader tab never flipped to visible, was never reloaded and
never interacted with, and the reader window issued no mutation, so the
bounded tick was the only refetch trigger left.

## Interfaces

No public API changes. The new store read is internal to the api
(`StorePort.listStockMovementsSince`), the web changes are query options, and
`packages/contracts` is untouched.

## Dependencies

None added. `bun install --frozen-lockfile` only; no `bun add`, no `bunx`,
no `npx`. No port beyond loopback: the api stays on `127.0.0.1` and the web
on the vite dev port.

## Tests

| Test | Where | Proves |
|---|---|---|
| Adjustment identity + window | `apps/api/src/lib/stock-adjustment.test.ts` | The pure half: the identity separates the actions that move the stock differently; a cost the request did not express is not compared; a server-stamped date is not compared, a caller-supplied one is; the cutoff lands on the window's edge in the format the store records. |
| The window in sql | `apps/api/src/store/stock-ledger-store.test.ts` | `listStockMovementsSince` returns the movements recorded after a stamp, in insertion order, and nothing after a later stamp. |
| Two clients, one refusal, first write survives | `apps/api/src/rpc/router.test.ts` | The wire half: a second client posting the same adjustment gets `CONFLICT` / `STOCK_ADJUSTMENT_DUPLICATE`, one movement exists, the stock moved once, and a *different* adjustment right after still records. |
| An intervening movement does not hide the repeat | `apps/api/src/rpc/router.test.ts` | The guard compares against every movement inside the window, not only the newest one: a second movement posted between the two copies does not push the row the guard looks for out of sight. |
| A no-cost repeat after the average moved | `apps/api/src/rpc/router.test.ts` | The cost the request did not express is not in the identity, so the retry of a no-cost adjustment is still refused after the item's average moved. |
| The items list polls | `apps/web/src/pages/items.test.tsx` | The table re-reads on the tick and the query carries the background flag. |
| The refusal is actionable | `apps/web/src/pages/items.test.tsx` | The raw code never reaches the owner; the Arabic message does. |
| Two windows measured against each other | `tests/e2e/client-freshness.spec.ts` | A sale in window A moves today's sales and the stock on hand in window B, with no reload, no click and no visibility flip. |

**Ablation (both halves proven red without the fix):** the API guard
disabled → `1 fail` (exit 1); the web tick removed → `2 fail` (exit 1); the
guard narrowed back to "the newest movement only" → the two new router tests
fail (exit 1).

## Risks

- **A deliberate second adjustment inside 10s is refused.** The window
  covers the two threats and nothing more: a double-clicked save (under a
  second) and a lost response re-sent as the same action (the #115 rule,
  which lands in the same second or the next). A typed second batch takes a
  few seconds too, so it is refused as well — the way past that is a moment
  later, not a different reason typed to get past the guard and into the
  ledger.
- **A no-cost repeat is refused against a movement that carried a cost.** An
  inflow that said no cost means "at the item's cost", so the cost is not
  part of the identity — and that makes "add five" match "add five at 300".
  The same escape hatch applies: a different reason, or a moment later.
- **The polling multiplies read load with the number of open windows.**
  Bounded and measured above; it is off in the vault's read-only paths (a
  read never marks the store dirty). The item history is the one read whose
  cost grows with the shop, which is why it ticks on its own slower bound.
- **A duplicated SALE is still posted twice.** The guard covers
  `stockAddManual` only. `invoicesCreate` has no repeat guard, and giving it
  one is a second slice of this ticket, not this one.
- **The headless e2e never hides a tab.** The reader reports `visible` for
  the whole run, so the hidden-tab branch of `refetchIntervalInBackground`
  is not exercised there; what the spec shows is the unfocused window.
- **`refetchIntervalInBackground` keeps a hidden tab reading.** That is the
  point, and it is one small query per tick.
- **The 5s tick is a behaviour change on the dashboard** (was 60s), and it
  carries the shared pending-return count and the onboarding checklist with
  it. It shortens the midnight day-lag the old comment documented, and it
  costs ~0.01% of a core per window.
