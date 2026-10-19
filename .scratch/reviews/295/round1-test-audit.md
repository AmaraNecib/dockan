**Verdict: 5 findings need fixing before merge; 9 more are gaps worth closing. The pure half of the change is solid; the e2e and the window's expiry path are not.**

Fix first, worst first:

1. `tests/e2e/client-freshness.spec.ts:156` — the e2e never asserts the reader window was **hidden**, so it passes whether or not `refetchIntervalInBackground` works.
2. `apps/api/src/rpc/router.test.ts:529` — "refuses a no-cost repeat after the item's average moved" never asserts the average moved; the test passes even if the server stops deriving costs.
3. `apps/api/src/rpc/router.test.ts:466` — `toContain("STOCK_ADJUSTMENT_DUPLICATE")` tolerates a decorated message that `serverErrorKey` (strict `/^[A-Z][A-Z0-9_]*$/`) rejects → the owner would see `errorGeneric`.
4. No test anywhere proves a repeat **after the window** is accepted — the documented escape hatch is unverified.
5. Two clients posting **at once** is never exercised; every new router test posts sequentially.

---

## 1. EDGE CASE HUNTER

### E1 — Major — `tests/e2e/client-freshness.spec.ts:156-157`
**What breaks.** The spec's whole claim is "a window that is visible but unfocused converged". The only assertion is `expect(readerEvents.visibleFlips).toBe(0)` — that proves the *focus path* did not fire. It does not prove the reader was **hidden**. `visibility` is read at line 156 and then only interpolated into the measurement string at line 158; `focusEvents` is likewise measured, never asserted.

If the reader target reports `visibilityState === "visible"` for its whole life (which is what a headless Chromium tab does unless it is genuinely backgrounded), then the tick that carried the sale was an ordinary **foreground** `refetchInterval`, and `refetchIntervalInBackground` — the entire reason `apps/web/src/lib/freshness.ts:44` exists — was never exercised. The test would be green with the feature broken.

**Fix.**
```ts
const visibility = await reader.evaluate(() => document.visibilityState);
expect(readerEvents.visibleFlips).toBe(0);
expect(readerEvents.focusEvents).toBe(0);
// the precondition the whole spec rests on: the reader was NOT the visible tab
expect(visibility, "the reader window was not backgrounded — the tick was a foreground tick").toBe("hidden");
```
If the headless runner cannot hide a tab, force it (CDP `Emulation.setPageVisibilityOverride`) or fail loudly with the reason — a spec that cannot establish its precondition should not assert the conclusion.

### E2 — Major — `apps/api/src/lib/stock-adjustment.test.ts:88-90`, `apps/api/src/store/stock-ledger-store.test.ts:95-121`, `apps/api/src/rpc/router.test.ts:448-556`
**What breaks.** Nothing in the change tests that a repeat **outside** the 30s window is accepted. The unit test only asserts `REPEAT_WINDOW_MS === 30_000`; the store test uses cutoffs of `2020-01-01` and `2099-01-01`; every router post lands inside the window. Change the window to 30 minutes, or make `repeatCutoff` return yesterday, and **every test in the change still passes** — while the operator who means it twice is refused forever. That is the first item in the design doc's own Risks table.

**Fix** (store level, no clock injection needed):
```ts
const now = new Date();
await store.insertStockMovement({ itemId: item.id, kind: "MANUAL_ADJUSTMENT", delta: 5, unitCost: 100, reason: "delivery", ref: null, occurredAt: null });
expect(await store.listStockMovementsSince(item.id, repeatCutoff(now))).toHaveLength(1);
// 31 seconds later the same row has fallen out of the window
expect(await store.listStockMovementsSince(item.id, repeatCutoff(new Date(now.getTime() + 31_000)))).toHaveLength(0);
```
At the wire level this needs a clock injected into `repeatCutoff` (`apps/api/src/lib/stock-adjustment.ts:78`) so the router can be tested past the boundary.

### E3 — Major — `apps/api/src/rpc/router.test.ts:460-556` (all four posts are sequential)
**What breaks.** The v1 multi-client scenario is two windows posting at once; every new test does `await client...` then `await secondClient...`. The change's stated reason for `withTransaction` → `withTransactionImmediate` (`apps/api/src/rpc/router.ts:669-673`, "a second writer's read lands on a stale snapshot") is therefore never exercised. Honest caveat: `runSerialized` (`apps/api/src/store/drizzle-store.ts:789`) already serializes every store call on the one connection, so in this single-process shape immediate-vs-deferred is **unobservable** — the guard's safety rests on that queue, which no test asserts either. The test below still pins the behaviour that matters.

**Fix.**
```ts
const results = await Promise.allSettled([
  client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, reason: "count" }),
  secondClient.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, reason: "count" }),
]);
expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
expect((rejected.reason as { code?: string }).code).toBe("CONFLICT");
const history = await client.itemsHistory({ itemId: item.id });
expect(history.movements).toHaveLength(1);
expect(history.stockOnHand).toBe(5);
```

### E4 — Minor — `apps/api/src/store/drizzle-store.ts:1617`
**What breaks.** The window is applied with a strict `gt` against a **one-second-resolution** `created_at` string. The effective window is therefore 29–30s, not 30s: a repeat 29.5s after the first is missed whenever the request lands early in a second. Nothing pins this, and the store test's `2020`/`2099` stamps are too far away to notice. A movement recorded *exactly at* the cutoff second is excluded — that is the edge the audit brief asks about, and it is untested.

**Fix** (store test): insert a movement, read with a cutoff equal to the row's own `created_at` → expect 0 rows (strict `>`); read with a cutoff one second earlier → expect 1 row. That documents the edge instead of leaving it to arithmetic.

### E5 — Minor — no router test posts a negative delta
**What breaks.** `expressUnitCost(delta < 0) → undefined` (`apps/api/src/lib/stock-adjustment.ts:95`) is only exercised in the pure unit test (`stock-adjustment.test.ts:70-74`). The removal path — the one the web form most easily double-clicks, since the cost field is hidden for removals (`apps/web/src/pages/stock.tsx:107`) — is untested on the wire. Add: post `{ delta: -5, reason: "count" }` twice → second refused, one movement, stock back where it started.

### E6 — Minor — `packages/contracts/src/core.ts:1405` (`occurredAt` is caller-settable)
**What breaks.** The identity treats a caller-supplied date as part of the action (`stock-adjustment.ts:113`), but no router test supplies one, so the "two dated adjustments are two actions" half of the rule is unproven on the wire. The repo already has both halves for suppliers (`router.test.ts:2096` "refuses a retry that omits the date", `:2752` "refuses a keyed retry whose timestamp changed") — the stock path should match. Fix: same date twice → refused; a different date → accepted (2 movements).

### E7 — Minor — no router test posts without a reason
**What breaks.** The web sends `reason: undefined` for a blank reason (`apps/web/src/pages/stock.tsx:113`), which the API maps to `null` and the seam records as `null`. Two such posts should be refused; only the pure unit test covers `reason: null` (`stock-adjustment.test.ts:60`). One wire case closes it.

### E8 — Minor — no browser-level test of the refusal
**What breaks.** The ticket's write half ("two windows posting the same adjustment") is proven only at the API level with a hand-built client. Nothing drives two real windows posting the same form. A browser test would also close the mock-fidelity gap in Q1, because the real oRPC client's `err.message` would be the thing under test.

---

## 2. COVERAGE ANALYST

Production branches the changed tests do **not** reach:

| # | Uncovered | Where | Test that would cover it |
|---|---|---|---|
| C1 | `refetchIntervalInBackground` on the dashboard summary; the 60s → 5s change | `apps/web/src/pages/dashboard.tsx:55` | `apps/web/src/pages/dashboard.test.tsx` was **not** changed; it mounts with `refreshMs: 20` and never inspects the observer. Add the same two assertions the items test has (`:440-441`) against the `dashboardSummary` observer. |
| C2 | The item-history page's tick — entirely untested | `apps/web/src/pages/stock.tsx:328` | No test file touches `ItemHistoryPage`'s new options. Note `hotCounterRefresh()` is called with **no argument** there, so the value is hard-wired to 5 000 and not injectable; a fast-clock test needs a `refreshMs` prop like the items page got. |
| C3 | `refetchIntervalInBackground` on the shared badge count | `apps/web/src/lib/pending-returns.ts:20-27` | Assert the observer options in `apps/web/src/components/app/app-sidebar.test.tsx` (that file mocks the hook today). |
| C4 | `HOT_COUNTER_REFETCH_MS = 5_000` is asserted **nowhere** | `apps/web/src/lib/freshness.ts:31` | The items test asserts the *injected* 20 (`:440`), so a typo in the default (`5_000` → `500` → `50_000`) passes every test in the repo. A `apps/web/src/lib/freshness.test.ts` asserting the constant and `hotCounterRefresh()`'s default closes it. |
| C5 | The new store read's `itemId` predicate | `apps/api/src/store/drizzle-store.ts:1617` | `stock-ledger-store.test.ts:97-120` creates **one** item. Delete the `eq(stockMovements.itemId, itemId)` and the test still passes. Fix: two items, one movement each, read one item's window → only that item's rows. |
| C6 | `delta === 0` in `expressUnitCost` is **unreachable in production** | `apps/api/src/lib/stock-adjustment.ts:96` | `packages/contracts/src/core.ts:1400` refines `delta` to non-zero, and `dinarsSchema` (`:18`) is not nullable, so `unitCost: null` can never reach the wire either. The branch and the `null` member of `number \| null \| undefined` are only exercised by the pure unit test. Either drop them or say they are defensive. |
| C7 | The `occurredAt` branch of `matchesAdjustment` on the wire | `apps/api/src/rpc/router.ts:690` | See E6. |
| C8 | The `delta < 0` branch of `expressUnitCost` on the wire | `apps/api/src/rpc/router.ts:688` | See E5. |

**Covered by an existing test I did not need to look for — and it is sound:** `apps/web/src/lib/i18n.test.ts:206-255` scans the *real* router source for `message: "CODE"` literals and asserts every code resolves to real Arabic copy that never falls back to `errorGeneric`. It picks up `STOCK_ADJUSTMENT_DUPLICATE` automatically, so the new `apps/web/src/lib/i18n.ts:443` copy is already covered without a changed file.

---

## 3. QUALITY REVIEWER

### Q1 — Major — `apps/web/src/pages/items.test.tsx:207-216` + `apps/api/src/rpc/router.test.ts:466,517,548`
**What breaks.** The web test hand-builds the error it asserts on:
```ts
throw Object.assign(new Error(stockRefuses), { code: "CONFLICT" });
```
The production path is `tError(err.message)` (`apps/web/src/pages/stock.tsx:89`) → `serverErrorKey` (`apps/web/src/lib/i18n.ts:1174`), which accepts only a **bare** `/^[A-Z][A-Z0-9_]*$/` message. Meanwhile the API side asserts `toContain("STOCK_ADJUSTMENT_DUPLICATE")` — "contains" tolerates a decorated message like `"[CONFLICT] STOCK_ADJUSTMENT_DUPLICATE"`, which `serverErrorKey` rejects, silently rendering `errorGeneric`. The mock therefore proves the mapping for a string the test itself invented, and `code: "CONFLICT"` is decoration the web never reads (`err.code` is used nowhere in `items.tsx`/`stock.tsx`).

**Fix.** Make the API assertion exact — `expect(refused!.message).toBe("STOCK_ADJUSTMENT_DUPLICATE")` — and drop the unused `code` from the mock so it cannot imply a contract the web does not have. If oRPC does decorate the message, that is a **production** bug the current tests hide: the server must send the bare code, or the web must map it.

### Q2 — Major — `apps/api/src/rpc/router.test.ts:529-556`
**What breaks.** The test is named "refuses a no-cost repeat after the item's average moved", but it never asserts that the average moved, nor that the first row carries the derived cost. It only asserts 2 movements and `stockOnHand === 10`. If the server stopped deriving the inflow cost (recording `null` instead of `100`), the guard would still refuse — because the identity skips an unexpressed cost — and the test would still be green, while its stated premise is false.

**Fix.**
```ts
expect(history.movements[0].unitCost).toBe(100); // the cost the seam derived
expect(history.movements[1].unitCost).toBe(300); // the cost the second window expressed
const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
expect(row.costPrice).toBe(200);                 // the average really moved (100 -> 200)
```
(Order holds: `itemsHistory` sorts by `occurredAt` then `rowid`, and both posts are server-stamped in order.)

### Q3 — Minor — `apps/web/src/pages/items.test.tsx:427-430`
**What breaks.** `await waitFor(() => itemsListFetches >= 2)` proves a second read happened. Nothing proves the **stock column** changed — the name says "so the stock column converges". A page that polls and then renders a stale value passes. The second test (`:432-442`) pins the options, so the gap is the outcome.

**Fix.** Change the fixture mid-test and assert the cell:
```ts
await mount({ refreshMs: 20 });
await waitFor(() => itemsListFetches >= 1);
items[0]!.stockOnHand = 7; // the server moved onawait waitFor(() => el<HTMLElement>('[data-testid="stock-after-cell"]').textContent?.includes("7") === true);
```
That is the unit-level twin of what the e2e does for the dashboard.

### Q4 — Minor — `tests/e2e/client-freshness.spec.ts:52-70`
**What breaks.** A fourth local copy of the seed-RPC envelope helper (the commit body admits it), while `tests/e2e/rpc-helpers.ts` already owns `readRpc`. The shared helper only lacks an input-carrying variant. Fix: add `callRpc<T>(page, procedure, input)` to `rpc-helpers.ts` (it must also forward the `x-vault-session` header that `readRpc` forwards, `:118-127`) and use it here, instead of adding a fifth copy when the next spec needs one.

---

## Checked and found sound

- **The pure identity half** (`apps/api/src/lib/stock-adjustment.test.ts`): every branch of `matchesAdjustment` is reached — itemId, kind, delta, expressed cost, unexpressed cost, reason, null reason, server-stamped date, caller-supplied date — and the assertions are behavioural, not tautological. `repeatCutoff` is asserted in the store's exact format.
- **`repeatCutoff`'s expectation is deterministic**, not machine-timezone dependent: `localDateTime` is pinned to `Africa/Algiers` (UTC+1, no DST) at `apps/api/src/lib/logger.ts:4,26`. Dropped as a false alarm.
- **The i18n copy** — already covered by the existing router-source sweep (`apps/web/src/lib/i18n.test.ts:206-255`); no new test needed.
- **The rollback claim is real.** The refusal is thrown inside the transaction, and the router tests assert `movements` length and `stockOnHand` afterwards, so the second post writes nothing.
- **The guard reads every row in the window**, not just the newest: `apps/api/src/rpc/router.ts:697-701` uses `.some(...)` over the full `listStockMovementsSince` result, which matches the commit's ablation claim that narrowing it back fails the two new router tests.
- **The store's window is applied to `created_at`, not `occurred_at`** — correct, and the store test's backdated-movement case proves it.
- **The e2e's exact `salesBefore + 1`** is not a flake: `playwright.config.ts` sets `workers: 1`, so no other spec can add a sale concurrently.
- **The reported elapsed time not being asserted is correct**, per `e2e/observed-window-not-deadline` — the measurement is a measurement. Only the *precondition* (E1) needed asserting.
- **The `withTransaction` → `withTransactionImmediate` switch** is a sound change on its own terms; it is simply unobservable in this single-connection, `runSerialized` shape (see E3).
- **`apps/web/src/lib/i18n.ts:443`** — the copy says what to do next, matching the repo's refusal-copy convention.

**False alarms dropped:** machine-timezone dependence of the cutoff test; the `salesBefore + 1` exact equality; the `delta === 0` branch as a *bug* (it is dead code, not a defect — see C6); "the guard never sees a caller-supplied date" (the contract does allow it — it is merely untested, E6).