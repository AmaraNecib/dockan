## Verdict

**2 Majors, 9 Minors.** The API half is in good shape; the two claims the ticket actually sells — "a background window converges" and "a repeat is accepted once the window passes" — are still **unproven**, and the brief overstates the second one.

---

## Round-1 status (one line each)

- **FIXED** — guard compares every row in the window (`router.ts:699` `.some()` over the full result), and the intervening-movement test discriminates.
- **FIXED** — derived cost dropped from the identity; the re-derived-cost test fails if that rule is removed (I checked the failure path: incoming cost 200 vs recorded 100/300 would slip through).
- **FIXED** — exact message assertion `toBe("STOCK_ADJUSTMENT_DUPLICATE")`; the web mock no longer fakes a `code` contract the web never reads.
- **FIXED** — the no-cost test asserts its premise (100 / 300 /200).
- **FIXED** — concurrent-post test added.
- **FIXED** — design doc's read cost and blast radius.
- **NOT FIXED** — the e2e still cannot hide a tab → finding **1** (and it is fixable now, not a runner wall).
- **NOT FIXED** — the web unit test asserts options, not the runtime effect → finding **1**.
- **NOT FIXED (disclosed)** — a duplicated SALE has no repeat guard.
- **NOT FIXED** — fourth copy of the seed-rpc helper → finding **9**.
- **PARTIALLY FIXED, and the brief overstates it** — the "store-level expiry test" is a filter-direction test with `2020`/`2099` cutoffs → finding **2**.

---

## Findings

### 1 — Major — `tests/e2e/client-freshness.spec.ts:145-164` + `apps/web/src/lib/freshness.ts:50-56`
**The e2e passes with `refetchIntervalInBackground` deleted.** The reader reports `visibility=visible` (your own measurement), and TanStack v5.101.4 gates the interval on `this.options.refetchIntervalInBackground || focusManager.isFocused()` (`query-core/build/modern/queryObserver.js:215`), where `focusManager.isFocused()` falls back to `globalThis.document?.visibilityState !== "hidden"` (`focusManager.js:66-69` — `#focused` is never set to a boolean by TanStack's own setup). The reader is visible ⇒ `isFocused()` is true ⇒ the interval fires **with or without the flag**. Remove `refetchIntervalInBackground: true` from `freshness.ts` and the spec stays green, the measurement stays ~4963 ms, the flip counters stay 0.

So the ticket's central runtime claim — *an unfocused/hidden window keeps counting* — is pinned only as an option object (`items.test.tsx:432-442`), never as behaviour.

**Fix (no new tooling).** In the reader, fake the hidden document *without* dispatching the event, so the focus path stays off:
```ts
await reader.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
});
```
Now `focusManager.isFocused()` is false, the poll only happens because of the flag, and `await expect(...).toPass()` fails without it. Then assert the precondition round 1 asked for: `expect(await reader.evaluate(() => document.visibilityState)).toBe("hidden")`. Do **not** dispatch `visibilitychange` — that would fire the focus refetch and destroy the isolation proof.

The design doc's Risks line ("the headless runner never hides a tab") reads as a wall; it is a missing override.

### 2 — Major — `apps/api/src/store/stock-ledger-store.test.ts:95-122` and `apps/api/src/rpc/router.ts:699`
**The 30-second expiry is still unproven.** The new store test reads with `"2020-01-01"` and `"2099-01-01"` — it proves the filter direction, not the window. Change `REPEAT_WINDOW_MS` to 30 minutes (or make `repeatCutoff` return yesterday) and **every test in the change still passes**, while the operator who means it twice is refused for half an hour — the first entry in the design doc's own Risks table.

**Fix, store level** (the round-1 recipe, still not implemented):
```ts
const now = new Date();
expect(await store.listStockMovementsSince(item.id, repeatCutoff(now))).toHaveLength(1);
expect(await store.listStockMovementsSince(item.id, repeatCutoff(new Date(now.getTime() + 31_000)))).toHaveLength(0);
```
**Fix, wire level:** `repeatCutoff(now = new Date())` already takes a clock, but `router.ts:699` calls `repeatCutoff()` — give the handler a seam (`deps.now?: () => Date`, defaulting to `() => new Date()`), post the same adjustment twice with a 31 s gap, assert **two** movements and `stockOnHand === 10`.

### 3 — Minor — `apps/web/src/pages/items.test.tsx:427-430`
Round 1's Q3, still open: `itemsListFetches >= 2` proves a second *read*, not that the stock column moved. A page that polls and renders a stale value passes. **Fix:** mutate the fixture mid-test (`items[0]!.stockOnHand = 7`) and assert the cell (`[data-testid="stock-after-cell"]`), the unit-level twin of what the e2e does for the dashboard.

### 4 — Minor — `apps/web/src/lib/freshness.ts:31,42`
`HOT_COUNTER_REFETCH_MS = 5_000` and `LEDGER_REFETCH_MS = 15_000` are asserted nowhere — the items test asserts the *injected* `20`. Typo `5_000 → 500` and every test in the repo passes. **Fix:** a 6-line `apps/web/src/lib/freshness.test.ts` asserting both constants and that `hotCounterRefresh()` defaults to5000 with `refetchIntervalInBackground: true`.

### 5 — Minor — `apps/web/src/pages/dashboard.tsx:55`, `apps/web/src/pages/stock.tsx:329`, `apps/web/src/lib/pending-returns.ts:19-28`
Three of the six changed web files have no test for their new options. The dashboard's existing test proves the *interval* fires (`dashboard.test.tsx:487`), but nobody asserts its `refetchIntervalInBackground`. The ledger page's tick is hard-wired to `LEDGER_REFETCH_MS` — not injectable, so a fast-clock test cannot be written without a `refreshMs` prop like the items page got. The badge's background flag is asserted nowhere. **Fix:** one `observer.options` assertion per query, and give `ItemHistoryPage` a `refreshMs` prop.

### 6 — Minor — `apps/api/src/rpc/router.test.ts:440-616`
Three cases the web actually sends are untested on the wire: a **blank reason** (`stock.tsx:113` sends `reason: undefined` → `null`; every new test sends a reason), a **negative delta** (the removal path, the one the form most easily double-clicks since the cost field is hidden), and a **caller-supplied `occurredAt`** (the contract allows it; the identity treats it as part of the action, so "two dated adjustments are two actions" is unproven). **Fix:** three short router tests — same delta/no reason twice → refused; `delta: -5` twice → refused, one movement, stock back where it started; same date twice → refused, a different date → accepted.

### 7 — Minor — `apps/api/src/store/stock-ledger-store.test.ts:95-122`
The store read's `itemId` predicate is covered only by test order: the file shares one DB and never truncates, so the filter is exercised because an *earlier* test inserted rows for another item. Run it alone (`bun test -t "reads only the movements"`) and it passes with `eq(stockMovements.itemId, itemId)` deleted. **Fix:** two items, one movement each, read one item's window, assert only that item's rows.

### 8 — Minor — `apps/api/src/store/drizzle-store.ts:1609-1619`
The window edge is untested: `gt(createdAt, cutoff)` is strict and `created_at` has one-second resolution, so the effective window is 29–30 s and a row recorded *in* the cutoff second falls out. **Fix:** read with a cutoff equal to the row's own `created_at` → 0 rows; one second earlier → 1 row.

### 9 — Minor — `tests/e2e/client-freshness.spec.ts:66-88`
The fourth local copy of the seed-RPC helper omits the `x-vault-session` header that `readRpc` forwards (`tests/e2e/rpc-helpers.ts:170`). A vault-mode run of this spec would be refused at the seed. **Fix:** add `callRpc<T>(page, procedure, input)` to `rpc-helpers.ts` (forwarding the header) and delete the copy.

### 10 — Minor — `apps/api/src/rpc/router.ts:1008`, `:1932`, `apps/api/src/store/drizzle-store.ts:1248` vs `apps/api/src/lib/stock-adjustment.ts:120-134`
New observation: the guard compares system rows as if they were user actions. `SUPPLIER_RETURN` (router.ts:1008), the scrap rows (router.ts:1932) and the opening balance (`drizzle-store.ts:1248`) are all `kind: "MANUAL_ADJUSTMENT"`, so a user row whose reason happens to equal one of those tokens matches them. Narrow, but the fix is cheap: skip rows whose reason is a system token, or add `ref`/`returnMark` to the identity, plus one test. (Return-originated stock-ins are `kind: "SALE"` — checked, no collision there.)

### 11 — Minor — `apps/web/src/lib/pending-returns.ts:12`
`PENDING_RETURNS_REFRESH_MS = 60_000` is now dead: both call sites pass 5 s explicitly, so the constant survives only as the hook's default and reads like the badge's real cadence. Delete it or point the call sites at it.

---

## Checked and found sound

- **The pure identity half** (`stock-adjustment.test.ts`): every branch of `matchesAdjustment` is reached — itemId, kind, delta, expressed cost, unexpressed cost, reason, null reason, server-stamped date, caller-supplied date — and the assertions are behavioural, not tautological. `expressUnitCost`'s three cases (no cost / equal to current / own cost) plus the outflow case are covered.
- **`repeatCutoff`'s expectation is timezone-independent** — `localDateTime` is pinned to `Africa/Algiers` (no DST).
- **The window is applied to `created_at`, not `occurred_at`** — correct, and the store test's backdated row proves it. The `created_at` column is `TEXT` with the same fixed-width format, so the lexicographic `gt` is chronological.
- **The refusal writes nothing** — thrown inside the transaction; the tests assert movement count and `stockOnHand` afterwards.
- **The exact message reaches the owner** — the server sends a bare code, `serverErrorKey`'s `/^[A-Z][A-Z0-9_]*$/` accepts it, and the existing `apps/web/src/lib/i18n.test.ts` router-source sweep already covers the new Arabic copy.
- **The web never sends `occurredAt`** (`stock.tsx:113`) — the server stamps it, so the identity's date rule cannot silently kill the guard. Checked.
- **The items test's mounts are unmounted in `afterEach`** — no leaked intervals, so the shared fetch counter is isolated per test.
- **The e2e's `salesBefore + 1` exact equality is safe** (`workers: 1`); the `"5 / 5"` assertion matches the store's `stockOnHand <= threshold` and the dashboard's rendering.
- **The new `StorePort` method is inherited by every test double** (they spread `...store`), and the vault store wraps the same drizzle store.
- **The dashboard's existing test** (`dashboard.test.tsx:487`) already covers the new spread's effect.

---

**Next:** implement finding 1's `visibilityState` override in `tests/e2e/client-freshness.spec.ts`, then run the spec once with `refetchIntervalInBackground: true` removed — it must go red. That one run converts the ticket's headline claim from asserted to proven.