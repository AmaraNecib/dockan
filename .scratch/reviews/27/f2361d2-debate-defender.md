# Review evidence — defender
Base: 3bbad9c  Head: f2361d2

## Review — Defender brief, ticket #27 stock ledger (diff `3bbad9c...f2361d2`)

### Defense (a): no stored `stockAfter`; per-request derivation is correct and cheap enough

**CLAIM:** Deriving projection on read (instead of persisting `stockAfter`) is the right trade at shop scale.
**EVIDENCE:** `apps/api/src/lib/stock-ledger.ts:60-96` — `projectLedger` is a single O(n log n) sort + linear FIFO pass over one item's movements; `historyWithRemaining` (`stock-ledger.ts:110-124`) is a linear pass. Reads: `apps/api/src/rpc/router.ts` `itemsHistory` replays only that item's rows via `listStockMovements` (single indexed-by-FK SQLite query, ordered by `occurred_at, rowid`, `drizzle-store.ts` listStockMovements). Writes replay once inside the transaction (`router.ts` `stockAddManual`). A single-admin shop on bun:sqlite has hundreds-to-low-thousands of movements per item; this is microseconds of in-process CPU with zero cache-invalidation surface.
**VERDICT: HELD.** Storing `stockAfter` would create mutable derived columns contradicting the append-only invariant and requiring rewrite-on-backfill; per-request derivation keeps raw facts immutable and can never drift. Note for the future: when invoice sales land (#later tickets), movement volume grows but stays well within this cost model; snapshotting would be premature now.

### Defense (b): zero-count backfill guard is genuinely idempotent even under race

**CLAIM:** A concurrent `setup()` and manual adjustment cannot double-insert an opening row.
**EVIDENCE:** `apps/api/src/store/drizzle-store.ts` — every store method, including `setup`, is wrapped by `serializeStore` (`return serializeStore(store)` at file end; `wrapEntry` skips only `withTransaction`). `withTransaction` itself enters via `runSerialized` and holds the queue for BEGIN→COMMIT/ROLLBACK; external calls queue behind it. So `setup()`'s count-then-insert loop and a `stockAddManual` transaction are strictly sequential on the single connection — the count guard cannot observe a stale zero while an adjustment commits. The bypass wrapper `directSeed` never escapes `withTransaction`. Test evidence: `stock-ledger-store.test.ts` "running setup twice must NOT duplicate" passes (3 runs → 1 row).
**VERDICT: HELD**, with a scoped caveat honestly conceded: safety rests on **single-process, single-connection** access to the SQLite file. Two OS processes opening the same DB could interleave count-then-insert outside SQLite's write lock. That is a pre-existing architectural assumption of this app (single connection in `Connection`, single admin), not a defect introduced here — but it should be recorded as a residual risk.

### Defense (c): string comparison of Algeria-local ISO timestamps is safe

**CLAIM:** Lexicographic ordering equals chronological ordering for these timestamps.
**EVIDENCE:** `packages/contracts/src/core.ts:17-20` — `localDateTimeSchema` enforces fixed-width `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/`; producer `localDateTime()` in `apps/api/src/lib/logger.ts:13-26` emits zero-padded `en-CA` output normalized to exactly that shape (including the `"24:"→"00:"` fix). Algeria is UTC+1 **with no DST** (comment, logger.ts:8), so there are no repeated/skipped local hours to collapse ties ambiguously. Fixed-width, zero-padded strings sort identically by byte order and time. Same-second ambiguity is resolved deterministically by `seq` (rowid) in both SQL (`drizzle-store.ts` ORDER BY occurred_at, rowid) and pure math (`ordered()`, `stock-ledger.ts:38-51`, tested in `stock-ledger.test.ts` "orders same-timestamp movements by seq"). `stockAsOf` slices the same fixed-width prefix (`stock-ledger.ts:100`).
**VERDICT: HELD.**

### Defense (d): rejecting negative projected stock at write time

**CLAIM:** Write-time rejection is correct, not merely convenient.
**EVIDENCE:** `router.ts` `stockAddManual` validates the *entire projected history including the candidate* via `historyWithRemaining([...existing, candidate])` before insert, throwing `STOCK_NEGATIVE` as BAD_REQUEST; the pure functions throw identically (`projectLedger` `stock-ledger.ts:79-83,90-93`; `historyWithRemaining` :115-117). The check, insert, and `setItemStockAndCost` all sit in one `withTransaction` (rollback proven by store test "rolls both back"), so no TOCTOU window exists given defense (b)'s serialization.
**VERDICT: HELD.** The alternative — accept negatives and clamp at read — is actively wrong here: the ledger feeds future COGS/profit money math (ADR-0002), and a negative layer would make FIFO cost silently meaningless. Failing loud at the write boundary converts corruption into a user-visible "الكمية غير متوفرة في المخزون" error (e2e step 5 asserts this exact path).

### Defense (e): `items.stock_on_hand` dual-write vs "raw facts separate from derived calcs"

**CLAIM:** Keeping the column as a transactionally-synced cache does not violate the acceptance criterion.
**EVIDENCE:** History is never mutated: `stock_movements` has no UPDATE/DELETE anywhere ("append-only; no update or delete exists by design", `port.ts`; confirmed in schema + store). The criterion requires derived values be computed from movements without mutating history — satisfied: `itemsHistory` derives purely from rows (`router.ts` itemsHistory). `setItemStockAndCost` writes only the *cache*, atomically with the movement inside the transaction (`router.ts` stockAddManual; rollback test covers both sides). Existing pre-ledger data remains compatible via the `reason="opening"` backfill (`drizzle-store.ts` setup), which imports old facts into the ledger rather than rewriting them.
**VERDICT: HELD**, conceding the operational risk: the design now has two sources of truth where correctness depends on every future writer dual-writing. Today the only writers are `stockAddManual` and the backfill, both correct; when invoice tickets call `setItemStockAndCost` they MUST also insert movements or drift returns silently. Recommend a follow-up consistency check (e.g., debug endpoint comparing `stock_on_hand` vs `projectLedger`) when invoices land.

### Other findings

- **Correct:** deterministic tie-breaking verified end-to-end (SQL rowid order ↔ pure-math `seq`, `stock-ledger-store.test.ts` ordering test); candidate-without-seq sorts last among equal timestamps matching its guaranteed-larger rowid (`router.ts` candidate construction).
- **Note (low):** `StockLedgerError` escaping `itemsHistory` on corrupt history surfaces as a 500 rather than a translated key. Fail-loud is arguably intended (module docstring says so); acceptable.
- **Note (low):** `setup()` does one `$count` query per item each boot — N+1 at startup, trivial at shop scale.
- **Note (info):** diff contains large unrelated noise (skills docs, shadcn scaffolding, lockfile) riding along with #27; not a blocker but widens review surface.

### Verification run

`bun test apps/api/src/lib/stock-ledger.test.ts apps/api/src/store/stock-ledger-store.test.ts` → **19 pass / 0 fail** (36 assertions, 612ms).

```