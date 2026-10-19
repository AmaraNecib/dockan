## Verdict

**Standards: met with gaps.** **Spec: met with gaps.** No Blocker. The guard's core logic is correct; the gaps are a stale comment, one unreachable branch, an incomplete cost bound, and a doc sentence the code does not honour.

Ranked worst first. Each finding: severity, `file:line`, what breaks, the fix.

---

# SPEC axis

### 1. Major — `.scratch/implementation/295-design.md:51-57` (the "Why 5 seconds" bound) and `apps/web/src/pages/stock.tsx:323-327`
The cost argument measures **two** reads (`dashboardSummary`, `itemsList`). The diff ships **four** polled reads. Two are unmeasured, and one of them is unbounded in the ledger's length:

- `itemsHistory` (`router.ts:722-745`) re-reads the **whole** ledger and runs a full `historyWithRemaining` projection on every tick — a cost that grows with the ledger, not a constant.
- The store is single-connection and **globally serialized** (`drizzle-store.ts:740-751` — every plain store call takes the one job queue). A whole-ledger projection every 5s holds that queue, which is the same queue a sale write waits on. The dashboard also polls `returnsPendingCount` + `onboardingProgress` (3 queries/tick, not 1), so "about 0.01% of a core" understates it.
- Fix (cheap): give the history page a longer tick (15–30s) and say so in the doc, or measure `itemsHistory` and restate the bound for all four reads.

### 2. Minor — `apps/api/src/lib/stock-adjustment.ts:88-100` (the cost arm of the identity)
The identity compares the cost **only when the request expressed one**. A retry that re-derives its cost therefore escapes the guard, and the web does re-derive it: `stock.tsx:53-68` re-prefills the untouched cost field from `itemsAll`, which a focus refetch refreshes (TanStack `staleTime: 0`). Sequence: window A posts "add 5 at 100" (average moves to 105) → window B's form is refetched on focus and now says 105 → window B posts the same intention → `105 !== 100` → **no match, stock moves twice**.

This is the design doc's own principle ("a derived value is not what the request expressed") applied to the wrong side: it excludes the *server's* derived cost but keeps the *client's* re-derived one. Fix: state the asymmetry in the doc, and pin it with a test (retry-with-a-different-cost is not refused) so the hole is visible rather than implied.

### 3. Minor — `.scratch/implementation/295-design.md:43` vs `apps/web/src/components/app/app-shell.tsx:140`
The doc says "The same `REFRESH_MS` also rides the shared pending-return count (**the shell badge**)". The dashboard does pass 5s (`dashboard.tsx:59`), but the shell badge calls `usePendingReturnsCount()` with no argument → `PENDING_RETURNS_REFRESH_MS = 60_000` (`pending-returns.ts:12`). The two observers share one query key, so the badge updates at 5s only while a dashboard is mounted; a badge-only window still converges in 60s. Fix: reword the doc row, or pass the 5s bound from the shell.

### 4. Minor — `tests/e2e/client-freshness.spec.ts` (whole file) and the design doc's evidence claims
- The **4984 ms** figure (design doc:65) is one run on one machine; nothing in the repo reproduces it. The doc hedges correctly ("a measurement, not a proof"), but the number reads as a fact. Keep it as a sample, labelled as one.
- The proof is by **elimination** (no visible-flip, no reload, no mutation in the reader). The repo's own e2e wisdom says "count the wire, don't assert UI absence" (`.agents/wisdom/e2e/deterministic-timing-tests.md:3`). A reader-side RPC count would close the last unnamed trigger (a reconnect refetch). Fix: count the reader's `dashboardSummary` requests around the sale and assert the delta ≥ 1.
- The ablation claims live only in the commit bodies. `docs/verification-and-merge-gate.md` §1 requires the failing-first run and the ablation proof **in the PR evidence comment**, with the failing assertion named.

### 5. Minor (scope, not a defect) — `apps/api/src/rpc/router.ts:665-700`
The guard covers `stockAddManual` only. `invoicesCreate` has no repeat guard, so a **duplicated sale** — the exact action the e2e demonstrates moving between windows — still posts twice. The design doc is honest that this is the smallest honest slice, but the parent should state the limit in the PR rather than let "two windows, one API" read as "no double-post anywhere".

---

# STANDARDS axis

### 1. Minor — `apps/api/src/rpc/router.ts:671`
The comment still justifies `withTransactionImmediate` with "the guard below compares the request with **the movement that was recorded last**" — stale since `6f39a41` changed it to compare every row in the window (the code says so 23 lines below, at `:694`). A comment that misdescribes the code under it is the kind of thing the next reader trusts. Fix: "compares the request with every movement recorded inside the window".

### 2. Minor — `apps/api/src/rpc/router.ts:292`
A stray extra blank line between `postStock` and the next doc block, left over from the first commit. Fix: delete one line.

### 3. Minor — `apps/api/src/lib/stock-adjustment.ts:96`
`if (delta === 0) return unitCost ?? null;` is **unreachable**: the contract forbids `delta: 0` (`packages/contracts/src/core.ts:1401`), and the only producer of a zero-delta movement is the cost correction in `itemsUpdate` (`router.ts:618-626`) — a different procedure this guard never sees. So the module's documented "a correction with no cost is a no-op and is recorded as one" describes a case the guard does not cover, and the `null` in the return type is dead. Fix: drop the branch (and the `null` from the type), or extend the guard to the cost-correction path and say which.

### 4. Minor (parent obligation) — `docs/verification-and-merge-gate.md` §1
This diff changes **wording** (a new Arabic refusal) and **e2e behaviour** (a new spec), and touches `apps/web/**`. The PR evidence comment must carry before/after images, an inline-playing GIF and the mp4 link. Not a code defect; flagging so it is not missed at merge.

---

# Checked and found sound

- **Guard logic.** `expressUnitCost` / `matchesAdjustment` / `repeatCutoff` are correct against the real posting seam (`stock-posting.ts:140-147`): inflow explicit cost → recorded as-is; inflow no cost → `undefined` (cost not compared) and the seam derives the average; outflow → `undefined` and the seam records `null`; zero-delta → seam records `spec.unitCost ?? null`. `reason` and `occurredAt` are passed through verbatim on both sides (contract trims `reason`, `occurredAt` is `localDateTimeSchema`).
- **The "no cost" path is `undefined` end to end** — `dinarsSchema` is not nullable (`core.ts:18`) and the web sends `undefined` (`stock.tsx:115`), so the identity's `undefined` arm is the live one and the `null` arm cannot be reached from the wire.
- **The window's clock.** `createdAt` is `now() = localDateTime()` (`drizzle-store.ts:89`) and the cutoff is `localDateTime(now - 30s)` — same function, same fixed-width Algeria-local format, so the SQL `gt(createdAt, cutoff)` string comparison is chronologically correct. `gt` is strict, so the effective window is 29–30 s.
- **The transaction discipline.** `withTransactionImmediate` is the right primitive for a read-then-write guard, and it matches `money/stock-ledger.md` point 2. `directSeed(store)` copies every own key, so the tx handle really has `listStockMovementsSince`; `MUTATING_METHODS` correctly leaves the new read out.
- **The "compare every row in the window" fix** (`6f39a41`) is real: the store read filters on `itemId` + `createdAt > cutoff` in SQL and orders by `rowid`, so an intervening movement cannot hide the row the guard looks for. The router tests cover it.
- **The `tx` handle, the port surface, and the test doubles**: every `StorePort` literal in `router.test.ts` / `backups.test.ts` spreads `...store`, so the new method breaks nothing — `tsc --noEmit` is clean for `apps/api` **and** `apps/web`, and `oxlint` (with the anti-slop plugin) is clean repo-wide.
- **Anti-slop and the SAFETY rule.** No `shape` in a symbol name, no `object` parameter, no `unknown` parameter, no runtime `typeof`, no `vi/jest.mock` (bun's `mock.module` is outside the rule's scope). Every new type assertion carries a `SAFETY:` comment (`router.test.ts`, `client-freshness.spec.ts`).
- **Commit hygiene.** Both commits carry `Model:` / `Thinking:` / `Harness:` / `Agent:` trailers; the design doc is at the workflow's path (`.scratch/implementation/295-design.md`); no dependency, schema or `packages/contracts` change — the doc's "no schema / no contracts" claim is true; the "no public API changes" claim is true (the port is internal).
- **The e2e-selection map wiring** is required by the map's own contract and is correct — `scripts/e2e-selection.test.ts` passes (35/35).
- **The i18n mapping**: `STOCK_ADJUSTMENT_DUPLICATE` is UPPER_SNAKE, lives in `resources.ar.translation`, and `serverErrorKey` gates on `/^[A-Z][A-Z0-9_]*$/` then `Object.hasOwn` — the key resolves and the raw code never reaches the owner.
- **Wisdom actually applied**: the server-stamped-date rule mirrors `#177`'s `serverStamped` (`drizzle-store.ts:1419`); the enumerated match fields satisfy `adjustment-dedup-key-and-index.md` point 8; the refusal is explicit and actionable, and *not* recording the refused ask is the right call (recording it would double-apply); the e2e reports observed time rather than a deadline.

## False alarms I dropped

- *"The store's job queue already serializes every transaction unit, so `BEGIN IMMEDIATE` is redundant and the doc's reason is wrong."* Wrong — the job queue serializes units **within one process**; `BEGIN IMMEDIATE` is what makes the read-then-write safe against a second process on the same file, which is exactly what `money/stock-ledger.md` point 2 asks for. The doc's reason stands.
- *"The web sends `unitCost: null` for a blank cost, so the identity's `null` arm never matches and the guard is a no-op."* Wrong — the contract rejects `null` and the web sends `undefined`.
- *"The new port method breaks the `StorePort` test literals / the tx handle lacks it."* Wrong — `...store` spreads and `directSeed` copies every key; `tsc` is clean.
- *"`createdAt` and the cutoff use different formats, so the window comparison is garbage."* Wrong — both are `localDateTime()`.

**Standards: met with gaps. Spec: met with gaps.**