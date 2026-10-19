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
   `tests/e2e/client-freshness.spec.ts`: the background window took **0 focus
   events** and still converged in 4984ms — one tick, with the focus path
   provably not involved.
2. **The smallest honest change for criterion 3?** A repeat-window guard on
   the existing append-only ledger — no schema column, no `packages/contracts`
   change, no new procedure. The ledger never overwrites a movement, so two
   windows posting the same adjustment do not overwrite each other: they
   append twice, and the stock moves twice for one intention. The guard
   refuses the second post inside a 30-second window and lets the first
   stand.

## What changes

| Area | Change |
|---|---|
| `apps/api/src/lib/stock-adjustment.ts` (new) | The identity of one stock adjustment (item, kind, signed delta, effective unit cost, reason) and the 30s window inside which a second copy of it is a repeat. `occurredAt` is deliberately **not** part of the identity — the server stamps it per request, so two identical requests would differ on it and never match (the trap #177 closed for supplier adjustments). |
| `apps/api/src/rpc/router.ts` | `stockAddManual` now posts inside `withTransactionImmediate` and refuses a repeat with `ORPCError("CONFLICT", { message: "STOCK_ADJUSTMENT_DUPLICATE" })`. The write lock comes first: the guard reads the last recorded movement and then writes, so a deferred transaction would let a second writer's read land on a stale snapshot. |
| `apps/api/src/store/port.ts`, `drizzle-store.ts` | One new read, `lastStockMovement(itemId)`: the movement recorded **last** in insertion order (`rowid`), not business-date order. It exists so the guard needs one row instead of the whole ledger, which the posting seam reads anyway. |
| `apps/web/src/lib/freshness.ts` (new) | The bounded tick the hot counters ride: `HOT_COUNTER_REFETCH_MS = 5_000`, and `hotCounterRefresh(refreshMs)` — the tick plus `refetchIntervalInBackground`, because the unfocused window is the case the tick exists for. |
| `apps/web/src/pages/items.tsx` | The items table (stock on hand) polls on that tick. It had no interval at all: the stock column only moved on a focus event or an explicit invalidation. |
| `apps/web/src/pages/dashboard.tsx` | The landing summary (today's sales, low stock) polls on the same tick, shortened from 60s. The old comment documented the 60s lag across midnight as deliberate; the measurement below says the read is cheap enough that 5s costs nothing measurable. |
| `apps/web/src/lib/i18n.ts` | The refusal gets a message: `STOCK_ADJUSTMENT_DUPLICATE` → "نفس تعديل المخزون مسجّل قبل لحظات — لم يُطبَّق مرتين". |

## Why 5 seconds

Two bounds, and only one of them is the server's.

- **Server cost.** Measured on this machine against a shop of 20 items and
  500 stock movements: `dashboardSummary` **0.65 ms** per read, `itemsList`
  (50 rows) **0.27 ms** per read. One window ticking every five seconds
  spends about 0.01% of a core; two windows about twice that. The api answers
  on the loopback interface and both reads are local sql over a local file.
- **Human cost.** A stock number at most five seconds behind is a number the
  owner can act on. The same number at sixty seconds is one they have to
  re-check by hand — which is the complaint #294 records.

The measured convergence in the e2e: the background window showed the new
numbers **4984ms** after the sale, with **0 focus events**. The headless
browser reports the background tab as `visible`, so the focus count — not the
visibility flag — is the proof that the focus path was not what carried the
change.

## Interfaces

No public API changes. The new store read is internal to the api
(`StorePort.lastStockMovement`), the web changes are query options, and
`packages/contracts` is untouched.

## Dependencies

None added. `bun install --frozen-lockfile` only; no `bun add`, no `bunx`,
no `npx`. No port beyond loopback: the api stays on `127.0.0.1` and the web
on the vite dev port.

## Planned tests

| Test | Where | Proves |
|---|---|---|
| Adjustment identity + repeat window | `apps/api/src/lib/stock-adjustment.test.ts` | The pure half: the signature separates the actions that move the stock differently; the window expires; the cost compared is the one the ledger will hold. |
| Two clients, one refusal, first write survives | `apps/api/src/rpc/router.test.ts` | The wire half: a second client posting the same adjustment gets `CONFLICT` / `STOCK_ADJUSTMENT_DUPLICATE`, one movement exists, the stock moved once, and a *different* adjustment right after still records. |
| The items list polls | `apps/web/src/pages/items.test.tsx` | The table re-reads on the tick and the query carries the background flag. |
| The refusal is actionable | `apps/web/src/pages/items.test.tsx` | The raw code never reaches the owner; the Arabic message does. |
| Two windows measured against each other | `tests/e2e/client-freshness.spec.ts` | A sale in window A moves today's sales and the stock on hand in window B, with no reload, no click and no focus event. |

**Ablation (both halves proven red without the fix):** the API guard
disabled → `1 fail` (exit 1); the web tick removed → `2 fail` (exit 1).

## Risks

- **A deliberate second adjustment inside 30s is refused.** The window
  covers a double-clicked save and a re-sent request, not a typed second
  batch. The refusal says what happened, so an operator who means it twice
  submits again a moment later.
- **The guard compares against the last movement only.** Two identical
  adjustments separated by a *different* adjustment are both recorded — the
  guard is a repeat-window, not a content hash over the whole ledger.
- **The polling multiplies read load with the number of open windows.** Bounded
  and measured above; it is off in the vault's read-only paths (a read never
  marks the store dirty).
- **`refetchIntervalInBackground` keeps a hidden tab reading.** That is the
  point, and it is one small query per tick.
- **The 5s tick is a behaviour change on the dashboard** (was 60s). It
  shortens the midnight day-lag the old comment documented, and it costs
  ~0.01% of a core per window.
