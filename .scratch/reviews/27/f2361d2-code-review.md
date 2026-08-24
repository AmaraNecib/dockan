# Review evidence — spec-reviewer
Base: 3bbad9c  Head: f2361d2

## Review

Scope reviewed: `git show f2361d2` (the ticket #27 commit) plus surrounding files at HEAD of `feat/27-stock-ledger`. The wider `3bbad9c...f2361d2` range also contains unrelated commits (shadcn/ui, agent skills docs, ADR-0004) — reviewed only where they intersect ticket 27 files (e.g., `apps/web/src/components/ui/*`, `bun.lock`).

### Criterion-by-criterion

**(1) Movements record kind/delta/unitCost/reason/occurredAt — PASS; `ref` wiring — GAP (minor, scoped)**
- Schema: `apps/api/src/db/schema.ts` (`stock_movements`: kind, delta, unit_cost, reason, ref, occurred_at, created_at) + additive DDL line in `SCHEMA_DDL`. Contracts mirror it: `packages/contracts/src/core.ts` `stockMovementSchema`.
- `stockAddManual` (apps/api/src/rpc/router.ts:150–188) records kind=`MANUAL_ADJUSTMENT`, signed delta, unitCost (defaults to `item.costPrice` for inflows), reason, occurredAt (defaults to server-local now). All present.
- **GAP:** `ref` is defined in schema/contract/design doc ("invoice id when kind=SALE/PURCHASE-from-invoice", `.scratch/implementation/27-design.md`) but **no code path ever writes anything except `ref: null`** (router.ts insert, setup backfill). Acceptable for ticket 27 since invoice integration is a later ticket, but it is effectively dead plumbing today.

**(2) Deterministic same-timestamp ordering — PASS**
- Store: `drizzle-store.ts:listStockMovements` orders by `occurred_at, rowid` and exposes `seq`. Ledger math: `ordered()` in apps/api/src/lib/stock-ledger.ts:37–51 (occurredAt → seq → input index), used by `projectLedger` and `historyWithRemaining`.
- Tested at both seams: store test asserts tie pair keeps insertion order with ascending seq (apps/api/src/store/stock-ledger-store.test.ts:57–63); pure test proves seq-1 layer is FIFO-consumed first (stock-ledger.test.ts "orders same-timestamp movements by seq").

**(3) Stock-as-of-date derived without mutating history — PASS (library), GAP (exposure)**
- `stockAsOf()` filters by `occurredAt.slice(0,10) <= dateIso` and replays — no writes; immutability of inputs is explicitly tested ("does not mutate the input array").
- **GAP:** `stockAsOf` is not exposed via any RPC procedure or UI control, even though `.scratch/implementation/27-design.md` promises an e2e "stock-as-of date control returns earlier value" — that e2e step does not exist in tests/e2e/ticket27.spec.ts. Capability delivered, exposure missing; document or defer explicitly.

**(4) Item history view with details + derived remaining stock — PASS**
- `itemsHistory` procedure returns movements with derived `stockAfter` + `stockOnHand` recomputed from movements (router.ts:190–199); raw facts stored, balance derived — matches AC.
- UI: `ItemHistoryPage` (apps/web/src/pages/stock.tsx:130–180) renders date, kind (localized), reason (with "رصيد افتتاحي" marker for opening rows), signed colored delta, and `stock-after`; wired from items list link (items.tsx) and route (router.tsx). Skeletons + empty state present.
- **Note:** the history table does **not** display `unitCost` — for a HIGH-ASSURANCE money-math feature, showing per-unit cost on inflows would materially help auditability. Not an AC violation ("movement details" arguably includes it), but worth a follow-up.

**(5) Backward compatibility & invoice-flow divergence — GAP (undocumented risk)**
- Existing tables untouched (additive DDL only); existing items/invoices data unaffected; opening backfill guarded by zero-count and tested idempotent (store tests "backfills exactly once… running setup twice must NOT duplicate"; "never touches items that already have movements") — matches the owner-approved decision.
- **The real residual risk:** `StorePort.setItemStockAndCost` remains a public fast-path writer that does **not** write ledger movements (port.ts:41, drizzle-store.ts:306). Today `stockAddManual` is the only runtime writer and it dual-writes inside `withTransaction` (approved decision; atomicity rollback-tested). But nothing structurally prevents a future invoice transaction from mutating `stock_on_hand`/`cost_price` without a movement — at which point `itemsHistory.stockOnHand` (derived) silently diverges from `items.stock_on_hand` (fast path), and the ledger stops being a trustworthy COGS source. The design doc lists concurrency/timezone risks but **does not document this dual-source-of-truth gap**. Acceptable scope for ticket 27 only if recorded as a known limitation/follow-up ticket.
- Related edge: if an invoice-only change happens between startups, the next `setup()` will backfill an "opening" row for that still-zero-movement item at its *current* stock — coincidentally resynchronizing, but creating a synthetic fact that masks the intervening sales/purchases.

**(6) API/UI/tests cover add-stock/history — PASS**
- API: `stockAddManual` + `itemsHistory` wired into contract (app-contract.ts) with zod validation (nonzero integer delta, optional occurredAt).
- Negative-stock rejection validated against the *full projected history* before write (router.ts), surfaced as `STOCK_NEGATIVE` with Arabic i18n message.
- Tests: pure-math suite (FIFO layers, ties, invariants, stockAsOf, weighted average), store suite (ordering, backfill idempotency, tx atomicity), Playwright e2e covering setup → item → add stock → list reflects stock → history row with stock-after → oversell rejection with translated error. Good coverage of the happy path and the key failure mode.

### Standards
- **Bun-only:** tests use `bun:test`; no pnpm/npm invocations in ticket files. PASS.
- **i18n Arabic-first:** all 20 new keys added with Arabic strings in the primary resource block (apps/web/src/lib/i18n.ts); `STOCK_NEGATIVE` error key included. PASS.
- **Secrets:** none introduced. PASS.

### Documented vs undocumented gaps
- Documented (in design doc): synthetic-opening visual marker, timezone handling, single-connection concurrency caveat, negative-stock fail-loud.
- **Undocumented:** (a) invoice-flow divergence risk via bare `setItemStockAndCost`; (b) `ref` never populated; (c) `stockAsOf` implemented/tested but not exposed (design doc implies UI exposure); (d) unitCost omitted from history table.

**Verdict: no blockers.** Mergeable for ticket 27 provided gap (a) is written down as a known limitation / follow-up ticket before invoice work begins — it is the one finding that touches the HIGH-ASSURANCE money-math axis.

```
acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Full review of git show f2361d2 against issue #27 AC: all six criteria verified with file:line evidence; 4 PASS, 4 non-blocking gaps (ref unwired, stockAsOf unexposed, unitCost hidden in history UI, undocumented invoice-flow divergence risk); no blockers."
    }
  ],
  "changedFiles": [
    "apps/api/src/db/schema.ts",
    "apps/api/src/lib/stock-ledger.ts",
    "apps/api/src/lib/stock-ledger.test.ts",
    "apps/api/src/store/drizzle-store.ts",
    "apps/api/src/store/port.ts",
    "apps/api/src/store/stock-ledger-store.test.ts",
    "apps/api/src/rpc/router.ts",
    "packages/contracts/src/core.ts",
    "packages/contracts/src/app-contract.ts",
    "apps/web/src/pages/stock.tsx",
    "apps/web/src/pages/items.tsx",
    "apps/web/src/lib/i18n.ts",
    "tests/e2e/ticket27.spec.ts"
  ],
  "testsAddedOrUpdated": [
    "apps/api/src/lib/stock-ledger.test.ts",
    "apps/api/src/store/stock-ledger-store.test.ts",
    "tests/e2e/ticket27.spec.ts"
  ],
  "commandsRun": [
    {
      "command": "git log --oneline 3bbad9c..f2361d2 && git diff --stat 3bbad9c...f2361d2 && git show f2361d2 --stat",
      "result": "passed",
      "summary": "Isolated ticket-27 commit f2361d2 from unrelated range commits"
    },
    {
      "command": "git show f2361d2 -- apps/api packages/contracts apps/web tests/e2e",
      "result": "passed",
      "summary": "Read complete ticket-27 diff across api/contracts/web/e2e"
    }
  ],
  "validationOutput": [
    "Static review only; did not execute test suites (review-only subagent, evidence gathered from diff and file contents)"
  ],
  "residualRisks": [
    "setItemStockAndCost is a public store writer that bypasses the ledger; a future invoice flow using it without insertStockMovement would make itemsHistory-derived stock diverge silently from items.stock_on_hand (COGS/profit integrity risk)",
    "setup() backfill on next startup converts invoice-only stock changes into a synthetic 'opening' fact, masking real intermediate history for zero-movement items",
    "unitCost not rendered in history table reduces auditability of cost-bearing movements"
  ],
  "noStagedFiles": true,
  "diffSummary": "Ticket #27: append-only stock_movements table + contracts, pure FIFO ledger module, stockAddManual/itemsHistory RPC procedures with in-transaction dual-write, idempotent opening-balance backfill, Arabic-first history page and add-stock form, unit/store/e2e tests.",
  "reviewFindings": [
    "note: apps/api/src/rpc/router.ts:170 - ref always inserted as null; column designed for invoice linkage but no writer exists (defer to invoice ticket, document)",
    "gap: apps/api/src/lib/stock-ledger.ts:97 - stockAsOf implemented and unit-tested but not exposed via any RPC/UI path despite design doc promising an e2e stock-as-of control",
    "note: apps/web/src/pages/stock.tsx:157-176 - history table omits unitCost column (auditability of money-math movements)",
    "gap: apps/api/src/store/port.ts:41 - setItemStockAndCost allows ledger-bypassing writes; dual-source-of-truth risk undocumented in .scratch/implementation/27-design.md",
    "pass: deterministic ordering implemented (drizzle-store listStockMovements ORDER BY occurred_at,rowid; ordered() seq tiebreaker) and tested at both seams",
    "pass: opening backfill zero-count guard idempotency proven by store tests; additive DDL preserves existing items/invoices data",
    "pass: oversell rejected against full projected history pre-write with STOCK_NEGATIVE i18n key; covered by unit, store, and e2e tests"
  ],
  "manualNotes": "Range 3bbad9c...f2361d2 contains unrelated commits (shadcn/ui, agent skills docs ~98k lines, ADR-0004); review focused on commit f2361d2 which is the entire ticket-27 change. Recommend filing a follow-up ticket to require dual-write whenever any caller touches setItemStockAndCost, before invoice work starts."
}
```