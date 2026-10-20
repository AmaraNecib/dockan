# #295 — Client freshness: a sale in one window must show in the other

Thin slice of #294 (v1 local-first multi-client). Two windows, one API, one
SQLite file.

- **Base commit:** `bff7a1a` (local `develop`, bun 1.4.3 pinned), merged with
  `origin/develop` `223d54a1` (#308) before the final commit
- **Branch:** `t3/295-client-freshness-1`
- **Review tier:** **Standard** — the diff touches the API's money path (a
  stock adjustment), the web's hot counters and a store port, but it invents
  no column, no auth rule and no deploy step, so none of the five
  High-assurance failure modes in `docs/engineering-workflow.md` apply.

## The two questions the report has to answer first

1. **Does TanStack Query's focus refetch already satisfy criterion 1?** No,
   and the mechanism is narrower than "it listens to the wrong event".
   `apps/web/src/main.tsx` builds `new QueryClient()` with no defaults, so
   `refetchOnWindowFocus: true` and `staleTime: 0` apply: a window that
   becomes VISIBLE again refetches its stale queries. In
   `@tanstack/query-core@5.101.4`
   (`node_modules/@tanstack/query-core/build/modern/focusManager.js:55-60`)
   `isFocused()` falls back to `document.visibilityState !== "hidden"`, the
   manager registers `visibilitychange` and nothing else (`:12-15`), and
   nothing the browser emits ever sets `#focused`. So two cases:
   **visible but unfocused** — two windows side by side, the one behind the
   other still on screen — is `isFocused() === true`, the interval runs with or
   without the background flag, and no `visibilitychange` ever arrives, so the
   bounded tick is the ONLY refetch trigger; **hidden or minimized** is
   `isFocused() === false`, where only `refetchIntervalInBackground: true`
   keeps the interval alive, and Chromium throttles a hidden tab's timers
   (about 1/s, about 1/min under intensive throttling), so that window
   converges on the throttled pace rather than on 5 s. Measured in
   `tests/e2e/client-freshness.spec.ts`: two tests, one per case. The
   visible-unfocused reader took **0 visibility flips** and **0 focus events**
   and still converged in **4004 ms**; the hidden reader converged in
   **3971 ms** with the same counters at zero.
2. **The smallest honest change for criterion 3?** A repeat-window guard on
   the existing append-only ledger — no schema column, no `packages/contracts`
   change, no new procedure, plus one additive index. The ledger never
   overwrites a movement, so two windows posting the same adjustment do not
   overwrite each other: they append twice, and the stock moves twice for one
   intention. The guard refuses the second post inside a 10-second window and
   lets the first stand.

## What changes

| Area | Change |
|---|---|
| `apps/api/src/lib/stock-adjustment.ts` (new) | The identity of one stock adjustment (item, kind, signed delta, reason, the row's origin `ref`, the cost the request *expressed*) and the 10s window inside which a second copy of it is a repeat. The window is nominal: the effective interval is **(9 s, 10 s]** because `localDateTime` has no sub-second field, the store compares with `gt`, and the cutoff floors `now`. Three fields join the identity only when the caller expressed them: a **server-stamped** `occurredAt` cannot tell a retry apart (two identical requests would differ on it — the trap #177 closed for supplier adjustments), and a cost the **server would have derived anyway** is not part of what the request said. The second one matters more than it looks: the web pre-fills the cost field with the item's current cost, and a refetch refreshes that pre-fill, so a retry after the average moved carries a different number that means exactly the same thing. A cost of the owner's own (different from the current one) IS part of the identity: "add five at 300" is not "add five". A caller-supplied date IS part of the identity too: two adjustments dated differently are two actions. `ref` is in the identity for every row: an owner's typed adjustment has none, a server-posted correction carries its document, so the two can never be mistaken for each other. A blank reason is normalized to `null` before the check and before the write — the contract trims, so `"   "` and "untouched" used to be two identities. |
| `apps/api/src/rpc/router.ts` | `stockAddManual` now posts inside `withTransactionImmediate` and refuses a repeat with `ORPCError("CONFLICT", { message: "STOCK_ADJUSTMENT_DUPLICATE" })`. The write lock comes first, like every other money path in the file. Today that is defence in depth, not a live guarantee — the store funnels every transaction through one connection, so nothing can interleave either way — which is why the choice is pinned as a CALL in `router.test.ts` rather than left to a comment. |
| `apps/api/src/store/port.ts`, `drizzle-store.ts` | One new read, `listStockMovementsSince(itemId, recordedAfter)`: the movements **recorded** after a local stamp, in insertion order. The window is applied in sql, so the guard reads the handful of rows inside it rather than the whole ledger. The comparison against the recorded rows happens in the guard, not in the store — the identity is business policy, not a query. |
| `apps/api/src/db/schema.ts` | One index, `idx_stock_movements_item` on `stock_movements(item_id, created_at)`, because the window read runs while the adjustment holds the write lock and would otherwise full-scan the ledger. Additive and idempotent like every line in `SCHEMA_DDL`: no column, no `CURRENT_SCHEMA_VERSION` bump (stays 6), no backfill, no row rewrite. |
| `apps/web/src/lib/freshness.ts` (new) | The bounded tick the hot counters ride: `HOT_COUNTER_REFETCH_MS = 5_000`, and `hotCounterRefresh(refreshMs)` — the tick plus `refetchIntervalInBackground`, which is what keeps a HIDDEN window's interval alive. The module's header states which lever carries which case, because that is the part that is easy to get backwards. |
| `apps/web/src/pages/items.tsx` | The items table (stock on hand) polls on that tick. It had no interval at all: the stock column only moved on a focus event or an explicit invalidation. An open edit draft keeps its row on screen when a poll pushes it off the page, so Save and Cancel do not disappear while `draftDirty` blocks every other row — and that row is read LIVE (`liveDraftRow`): the page window while it holds the row, the `itemsAll` catalog read on the same tick while it does not. A row rendered from the draft's own snapshot would freeze its stock number and low-stock badge for as long as the edit stayed open, because the poll never touches a row the page no longer holds. |
| `apps/web/src/pages/dashboard.tsx` | The landing summary (today's sales, low stock) polls on the same hot tick, shortened from 60s. The shared pending-return count rides `SLOW_REFETCH_MS` (60s) and the checklist's progress read rides it too, with `refetchIntervalInBackground: false` spelled out — its server read WRITES, so a 5s heartbeat would be a preference write and a vault persist every 5s. |
| `apps/web/src/pages/stock.tsx` | An item's history (the running stock column) polls too, on a slower tick (15s, `LEDGER_REFETCH_MS`): the history read re-reads the whole ledger and projects it, so its cost grows with the shop's history, and the store serializes its calls on one connection — a fast tick there would hold the queue a sale write waits on. |
| `apps/web/src/lib/pending-returns.ts`, `components/app/app-shell.tsx` | The shared count carries `refetchIntervalInBackground` — new on this branch, and the one thing #295 gives this hook — and both call sites ask for the CALM bound (`SLOW_REFETCH_MS`), the cadence the badge already had. `app-shell.test.tsx` observes that interval on the query observer. |
| `apps/web/src/lib/i18n.ts` | The refusal gets a message the owner can act on: `STOCK_ADJUSTMENT_DUPLICATE` → "نفس تعديل المخزون مسجّل قبل لحظات — لم يُطبَّق مرتين. أعد المحاولة بعد قليل." It does not tell them to type a different reason: the way past the guard is time, and a reason typed to get past it would land in the permanent ledger. |

## Why 5 seconds

Two bounds, and only one of them is the server's.

- **Server cost.** Measured once on this machine against a shop of 20 items
  and 500 stock movements: `dashboardSummary` **0.65 ms** per read,
  `itemsList` (50 rows) **0.27 ms** per read — the sql only, not the oRPC
  round trip. One window ticking every five seconds spends about 0.01% of a
  core on those reads; two windows about twice that. The api answers on the
  loopback interface and both reads are local sql over a local file. There is
  no committed benchmark for the numbers, so treat them as one measurement,
  not a promise. The item history has a 15s tick of its own, because its cost
  grows with the ledger; the pending-return badge and the onboarding checklist
  ride the 60s calm bound and are not part of this tick.
- **Human cost.** A stock number at most five seconds behind is a number the
  owner can act on. The same number at sixty seconds is one they have to
  re-check by hand — which is the complaint #294 records.

The measured convergence in the e2e (one run, one machine, at the head): the
visible-unfocused reader showed the new numbers **4004 ms** after the sale, the
hidden one **3971 ms**. The elapsed time is a *measurement*, not the proof: the
tick's phase against the sale is arbitrary, so a fast convergence would not
mean a focus refetch happened. The proof is the isolation — the reader took no
focus event and no visibility flip, was never reloaded and never interacted
with, and issued no mutation, so the bounded tick was the only refetch trigger
left.

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
| The window in sql, and the index | `apps/api/src/store/stock-ledger-store.test.ts` | `listStockMovementsSince` returns the movements recorded after a stamp, in insertion order, and nothing after a later stamp; `EXPLAIN QUERY PLAN` names the index, so removing it fails a test. |
| Two clients, one refusal, first write survives | `apps/api/src/rpc/router.test.ts` | The wire half: a second client posting the same adjustment gets `CONFLICT` / `STOCK_ADJUSTMENT_DUPLICATE`, one movement exists, the stock moved once, and a *different* adjustment right after still records. |
| An intervening movement does not hide the repeat | `apps/api/src/rpc/router.test.ts` | The guard compares against every movement inside the window, not only the newest one. |
| A no-cost repeat after the average moved | `apps/api/src/rpc/router.test.ts` | The cost the request did not express is not in the identity, so the retry of a no-cost adjustment is still refused after the item's average moved. |
| A blank reason and no reason are one identity | `apps/api/src/rpc/router.test.ts` | Both orders (blank first, blank second): one movement, a `null` reason in the ledger, and the second post refused. Each order kills a different half of the normalization. |
| The guard opens the write lock | `apps/api/src/rpc/router.test.ts` | A store wrapper records which transaction variant the handler asked for; `withTransaction` in place of `withTransactionImmediate` fails the test. |
| The items list polls, and an open draft survives its row leaving the page | `apps/web/src/pages/items.test.tsx` | The table re-reads on the tick and the query carries the background flag; a poll that drops the edited row still leaves Save and Cancel reachable, and cancelling lifts the block on the other rows. The away row is also kept LIVE: with the page omitting it and the catalog still holding it, the next poll's stock number and low-stock badge move it too. |
| The pending-return number moves | `apps/web/src/pages/dashboard.test.tsx` | The notice's count is asserted on screen after a tick, not merely that a second fetch happened. |
| The shell badge rides the calm bound | `apps/web/src/components/app/app-shell.test.tsx` | The observer's `refetchInterval` is `SLOW_REFETCH_MS`; the hot bound fails the test. |
| The refusal is actionable | `apps/web/src/pages/items.test.tsx` | The raw code never reaches the owner; the Arabic message does. |
| Two windows measured against each other | `tests/e2e/client-freshness.spec.ts` | A sale in window A moves today's sales and the stock on hand in window B with no reload, no click and no visibility flip — once with the reader VISIBLE and unfocused (the ticket), once with it hidden (the background flag). |

**Ablation (both halves proven red without the fix):** the API guard disabled
→ `1 fail` (exit 1); the web tick removed → `2 fail` (exit 1); the guard
narrowed back to "the newest movement only" → the two new router tests fail
(exit 1); `refetchIntervalInBackground` deleted → the hidden-reader e2e test
fails and the visible-unfocused one passes (exit 1).

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
  The way past is the same: a moment later.
- **The polling multiplies read load with the number of open windows.**
  Bounded and measured above; it is off in the vault's read-only paths (a
  read never marks the store dirty). The item history is the one read whose
  cost grows with the shop, which is why it ticks on its own slower bound.
- **A duplicated SALE is still posted twice.** The guard covers
  `stockAddManual` only. `invoicesCreate` has no repeat guard, and giving it
  one is a second slice of this ticket, not this one.
- **The headless runner never hides a tab**, so the hidden-reader test has the
  page shadow `document.visibilityState`; the counters that decide the
  assertion read the browser's own state at `Document.prototype`, so the
  assertion can still fail. What the hidden test proves is the branch, not a
  real minimized window.
- **`refetchIntervalInBackground` keeps a hidden tab reading, at the browser's
  throttled pace.** A minimized window converges in about a minute rather
  than in five seconds, and a frozen tab not at all. The ticket's case — two
  visible windows — does not depend on the flag.
- **The 5s tick is a behaviour change on the dashboard** (was 60s). It
  shortens the midnight day-lag the old comment documented, and it costs
  ~0.01% of a core per window. The pending-return count and the onboarding
  checklist do NOT ride it: they keep 60s.
