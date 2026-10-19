**Verdict: Standards — met with gaps. Spec — met with gaps.** No Blocker. The guard's core is correct and the round-1 holes are genuinely closed. What is left is one behaviour that refuses a legitimate action, one window boundary nobody pinned, and a batch of test gaps that let the constants drift.

---

# Round-1 status (one line each)

**Fixed and confirmed:** guard compares every row in the window · derived cost dropped from the identity · refusal message is actionable and exact (`toBe`, not `toContain`) · no-cost test asserts its premise (`unitCost` 100/300, `costPrice` 200) · concurrent-post test added · stale "newest movement" comment rewritten · unreachable `delta === 0` branch removed · design doc names four reads and labels the numbers as one measurement.

**Still open:** the hidden-tab branch of `refetchIntervalInBackground` is exercised nowhere (e2e reader reports visible; unit test asserts the option, not the effect) · duplicated SALE (`invoicesCreate`) has no repeat guard · fourth copy of the seed-rpc envelope, while `tests/e2e/rpc-helpers.ts` already owns `readRpc`.

---

# SPEC axis

### 1. Major — `apps/api/src/lib/stock-adjustment.ts:45` (`REPEAT_WINDOW_MS = 30_000`), `apps/api/src/rpc/router.ts:699-701`, `apps/web/src/pages/stock.tsx:117`

The 30s window refuses a legitimate second adjustment, and the only escape hatch writes a fake reason into the ledger.

**What breaks.** The web sends `reason: undefined` for a blank reason field (`stock.tsx:117`), the API maps that to `null`, and the identity compares `reason` strictly (`stock-adjustment.ts:126`). So two deliveries of the same quantity of the same item inside30s — the reason box empty in both — are the *same action* by the predicate, and the second is refused with `STOCK_ADJUSTMENT_DUPLICATE`. A typed second batch takes about three seconds, not thirty: the design doc's justification ("a deliberate second adjustment … is typed, not fired, and lands outside the window", Risks) is factually wrong about its own guard.

The escape hatch the doc points at is "change the reason" — which means the ledger records a reason the operator typed only to get past the guard (`"2"`, `"again"`). That reason is business data, shown in the item history.

**Fix.** Cut the window to what the doc itself says the threat is: `REPEAT_WINDOW_MS = 10_000` (a double-click lands in under a second, a re-sent request in the same second or two). Then correct the Risks bullet to say the window covers a double-click and a re-send, and that a *typed* second batch inside ten seconds is refused too, with the reason box as the escape. A 30s window buys nothing the10s one does not.

### 2. Major — `apps/api/src/store/stock-ledger-store.test.ts:119-121`

The window's expiry is not pinned; the documented escape hatch is still unproven.

**What breaks.** The store test reads the window with `"2020-01-01T00:00:00"` and `"2099-01-01T00:00:00"`. Both are far outside the 30s window, so **changing `REPEAT_WINDOW_MS` to 30 minutes leaves every test in the branch green** — the exact failure the round-1 audit named ("the operator who means it twice is refused forever"). The audit's own suggested fix was to use `repeatCutoff(new Date(now.getTime() + 31_000))`; the branch instead added a far-future stamp, which proves the SQL filter and nothing about the window.

**Fix.** In `stock-ledger-store.test.ts`, insert a movement, then assert it is inside `repeatCutoff(now)` and gone at `repeatCutoff(new Date(now.getTime() + 31_000))`. For the wire, `repeatCutoff` already takes a `Date` (`stock-adjustment.ts:79`) — give the router a clock seam (e.g. `deps.now?.() ?? new Date()`) so one router test can post the same adjustment twice 31s apart and assert it is *accepted*.

### 3. Minor — `apps/web/src/lib/freshness.ts:55`, `tests/e2e/client-freshness.spec.ts:162-164`

`refetchIntervalInBackground: true` is asserted only as an option value; nothing proves the behaviour it exists for.

**What breaks.** happy-dom has no hidden tab, so the unit test cannot exercise it; the e2e's reader reports `visible` for the whole run (the design doc says so), so the e2e exercises the *foreground* interval instead. The flag is therefore never proven to do anything — and it is the reason the module exists ("a window the owner is not looking at is exactly the window that has to catch up on its own").

**Fix.** Force the reader hidden in the e2e with CDP `Emulation.setPageVisibilityOverride` (the round-1 audit's E1 fix), assert `visibility === "hidden"` before the sale, and assert the convergence anyway. If that is not possible in this runner, soften `freshness.ts` to say the flag is set but unproven, and keep the design doc's Risks bullet as the disclosure.

### 4. Minor — `apps/web/src/pages/dashboard.tsx:96-101`

The onboarding-checklist query rides the tick but not the background flag.

**What breaks.** `freshness.ts` says "the query options every hot counter carries" and lists `refetchIntervalInBackground`. The dashboard's `onboardingProgress` query sets only `refetchInterval: refreshMs` (`dashboard.tsx:101`), so in an unfocused window the checklist does not converge — the same gap the badge and the counters were fixed for. The design doc's dashboard row claims the checklist rides `REFRESH_MS`; it does, but only half of it.

**Fix.** `...hotCounterRefresh(refreshMs)` on that query, same as the summary.

### 5. Minor — `tests/e2e/client-freshness.spec.ts:162-165`

The reader's visibility is logged, never asserted, and the design doc states it as a fact.

**What breaks.** The spec reads `document.visibilityState` and interpolates it into the measurement string; the design doc's Risks bullet says "the reader reports `visible` for the whole run" as an established fact about the runner. If a future Chromium hides the background tab, the spec silently starts exercising the hidden-tab branch while the doc still says it does not — the doc and the runner drift apart silently.

**Fix.** Assert `visibility` explicitly (`expect(visibility).toBe("visible")` pins today's precondition; `"hidden"` after CDP forcing pins the stronger one). One line either way.

### 6. Minor — `apps/web/src/pages/items.test.tsx:429`, `tests/e2e/client-freshness.spec.ts` (the reader sits on the dashboard)

The ticket's headline surface — the items table's stock column — has no end-to-end proof.

**What breaks.** The e2e proves the *dashboard's* counters converge. The items table's 5s tick is the surface the ticket names ("a sale in one window must show in the other"), and its only test counts fetches (`itemsListFetches >= 2`) without asserting the rendered cell: a page that polls and then renders a stale value passes. The stock-on-hand cell that the owner reads is never asserted anywhere after a change.

**Fix.** In `items.test.tsx`, mutate the fixture mid-test (`items[0]!.stockOnHand = 7`) and assert the stock cell shows `7` — the unit-level twin of the e2e. Optionally open `/items` in the reader window in the e2e and assert the row's stock moved.

### 7. Minor — `apps/web/src/lib/freshness.ts:31`

`HOT_COUNTER_REFETCH_MS = 5_000` is asserted nowhere.

**What breaks.** The items test asserts the *injected* `20` (`items.test.tsx:440`), so a typo in the default (`5_000` → `50_000`) passes every test in the repo and silently changes the shipped behaviour. The round-1 audit's C4 is still open.

**Fix.** A three-line `apps/web/src/lib/freshness.test.ts`: assert the constant and that `hotCounterRefresh()` defaults to it.

### 8. Minor — `apps/api/src/store/drizzle-store.ts:1617`

The store read's `itemId` predicate is untested.

**What breaks.** The store test creates **one** item, so deleting `eq(stockMovements.itemId, itemId)` from the new read leaves the suite green — the read would then return every item's movements and the guard would compare against other items' rows.

**Fix.** Two items, one movement each; read one item's window and assert only that item's row comes back.

### 9. Minor — `apps/api/src/rpc/router.test.ts` (wire-level gaps that remain)

Three identity arms are proven only in the pure unit test, never on the wire: a **negative delta** (the removal path — the one the web form most easily double-clicks, since the cost field is hidden for removals), a **caller-supplied `occurredAt`** ("two dated adjustments are two actions"), and a **null reason** (what the web actually sends for a blank reason — the common case, and the one finding #1 turns on).

**Fix.** One router test each: post `{delta: -5}` twice → second refused; post the same adjustment with two different `occurredAt` values → both recorded; post twice with no reason → second refused.

### 10. Minor — `apps/api/src/rpc/router.ts:1273` (`invoicesCreate`)

A duplicated sale still posts twice. The sale form disables its own button while `createInvoice.isPending` (`sale.tsx:506`), so a double-click inside one window is covered — but two windows can each save a sale, and the server has no guard. The design doc discloses this as "a second slice of this ticket"; the parent should carry it into the PR body, because "two windows, one API" otherwise reads as "no double-post anywhere".

### 11. Minor — `.scratch/implementation/295-design.md` (Tests table)

The doc's test table lists 8 cases; the diff adds 6 router tests, 8 unit tests and 3 web tests. The concurrent-post case, the re-derived-cost case and the "different adjustment right after" case are not in the table, and the "window in sql" row does not say it pins a far-future stamp rather than the 30s boundary (finding #2). The doc is the spec's own account; it should match the code.

---

# STANDARDS axis

### 12. Minor — `tests/e2e/client-freshness.spec.ts:47-73`

A fourth copy of the seed-RPC envelope, while `tests/e2e/rpc-helpers.ts` already owns `readRpc` (with the `x-vault-session` header the new copy omits).

**What breaks.** The round-1 audit's Q4 named the fix exactly: add an input-carrying `callRpc<T>(page, procedure, input)` to `rpc-helpers.ts` and use it. `money/display-vs-recording-order.md` had already flagged the extraction as the follow-up. The lane's own commit body says "the next spec that needs a seed call should do it rather than copy the envelope again" — this lane was that next spec, so it deferred a follow-up it was the subject of, and the copy it added is the one missing the vault header.

**Fix.** Move the helper into `tests/e2e/rpc-helpers.ts` as `seedRpc` (forwarding `x-vault-session` like `readRpc`), use it here, and point the three older specs at it in the same change.

### 13. Minor (parent obligation — this blocks the Standard-tier gate) — `.scratch/reviews/295/6f39a41-debate.md`

The debate evidence is stale at HEAD `f16890d`, and the round-1 evidence files are not in the shape `guard` looks for.

**What breaks.** `guard` requires, for each evidence file `.scratch/reviews/<issue-id>/<sha>-*.md`, that the SHA match HEAD or that only non-reviewable files changed since. `git diff --name-only 6f39a41 f16890d` lists `apps/api/src/rpc/router.ts`, `apps/api/src/lib/stock-adjustment.ts`, `apps/api/src/rpc/router.test.ts`, `apps/web/**`, `tests/e2e/client-freshness.spec.ts` — all reviewable. So the debate evidence is **stale**, and the Standard tier requires a non-stale debate. Separately, `round1-code-review.md` and `round1-test-audit.md` do not carry a SHA, so guard's loop cannot see them at all.

**Fix.** Run all three lenses at `f16890d` and name the files `f16890d-debate.md`, `f16890d-test-audit.md`, `f16890d-code-review.md` (this review is the third).

### 14. Minor — `apps/api/src/rpc/router.ts:290-291`

The stray double blank line between `postStock` and the next doc block, left over from the first commit, is still there (round-1 Standards #2, not fixed). Delete one line.

### 15. Minor — commit `97c9612`

The commit "record the debate evidence and the lane report" — whose body says ".scratch only: no code, no reviewable file" — also rewrote two unrelated ticket-#96 review screenshots (`.scratch/reviews/96/screenshots/round2/*.png`). Binary churn from another ticket rides a #295 branch. Restore them to the base state, or land them in a #96 commit.

### 16. Minor — `.agents/wisdom/money/stock-ledger.md` point 2 vs the lane's reading

The lane cites point 2 ("a count-then-insert guard is racy … make them one statement") as applied, but applied a different remedy: `BEGIN IMMEDIATE` around a read-then-write rather than a single conditional statement. The remedy is sound for this v1 shape (one process, every money writer takes the write lock), but the divergence from the wisdom's prescription is unrecorded, and point 2 is the note a future lane will read before adding a second guard.

**Fix (parent).** Append to `money/stock-ledger.md` point 2 — or to the lane's report — that for a guard inside `withTransactionImmediate`, the write lock is this repo's substitute for the single conditional statement, and the boundary is that every writer of the same rows must take the write lock.

### 17. Minor — `.scratch/implementation/295-report.md`

The report says "router.test.ts — 4 tests"; the diff adds six (the concurrent-post and re-derived-cost cases are missing from the list). The parent reads this file first; fix the count so the reviewer's evidence and the report agree.

---

# Checked and found sound

- **The guard's transaction discipline.** `withTransactionImmediate` (`router.ts:674`) is the right primitive for a read-then-write: the write lock comes before the first read. The tx handle is `directSeed(store)` (`drizzle-store.ts:775`), so the guard's `tx.listStockMovementsSince` is unqueued and cannot deadlock behind its own unit — `MUTATING_METHODS` correctly leaves the new read out, and the write is not marked dirty on the read path.
- **The window's clock.** `created_at` is `text` (`schema.ts:250`), written by `now() = localDateTime()` (`drizzle-store.ts:89`), and the cutoff is `localDateTime(now − 30s)` — same fixed-width Africa/Algiers format, so the SQL `gt` is a valid lexicographic comparison. `gt` is strict, so the effective window is 29–30s; harmless, and the boundary is now worth pinning (finding #2).
- **The identity's other arms.** `kind` and signed `delta` compare exactly; `reason` is strict including `null` vs `null`; a caller-supplied `occurredAt` is compared against the recorded one verbatim (the seam stores `spec.occurredAt ?? localDateTime()`, so the strings match exactly); the server-stamped case is excluded, matching #177's `serverStamped` rule.
- **The cost rule's derivation.** `expressUnitCost` mirrors the posting seam exactly (`stock-posting.ts:150-155`): inflow with an explicit cost → recorded as-is; inflow with no cost → the item's cached average; outflow → recorded `null`, so the cost is correctly dropped from the identity; a cost equal to the item's current average is dropped because the web pre-fills that number (`stock.tsx:60-70`).
- **The i18n path.** `STOCK_ADJUSTMENT_DUPLICATE` is UPPER_SNAKE, lives in `resources.ar.translation` (`i18n.ts:443`), and `serverErrorKey` gates on `/^[A-Z][A-Z0-9_]*$/` + `Object.hasOwn` — the key resolves and the raw code never reaches the owner. The existing `i18n.test.ts` sweep over the router source picks it up automatically.
- **The web refusal path.** `tError(err.message)` is the established pattern (`stock.tsx:89`), and the mock now throws a bare `Error(code)` with no invented `code` decoration — the web test proves the mapping for the string the server actually sends.
- **The e2e's timing discipline.** `expect(async () => …).toPass({timeout: 20_000})` is an observed window, not a wall-clock deadline, and the elapsed time is logged, not asserted — that is `e2e/observed-window-not-deadline` honoured. `workers: 1` in `playwright.config.ts` is why `salesBefore + 1` is exact.
- **The map wiring.** `tests/e2e-selection.map.json` lists the new spec in the items and dashboard rules, as its own contract requires; `tests/e2e/**` is `always_full`, so this branch triggers a full e2e run in CI regardless.
- **Anti-slop and the SAFETY rule.** No `unknown` parameter, no `shape` in a symbol name, no `typeof` at runtime, no object parameter. Every new type assertion carries a `SAFETY:` comment (`router.test.ts`, `client-freshness.spec.ts`).
- **Commit hygiene.** All four commits carry `Model:` / `Thinking:` / `Harness:` / `Agent:` trailers; the design doc sits at the workflow's path; no dependency, schema, contract or package change — the doc's "no public API changes" claim holds (`StorePort` is internal).

**Standards: met with gaps. Spec: met with gaps.**