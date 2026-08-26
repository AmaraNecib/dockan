# Issue 43 — sale-flow deferred hardening follow-ups

Tier: High-assurance (money/inventory invariants). Base SHA: `0de1265`.
Scope: web sale page, API invoice/sale path, stock-ledger math, profit report,
store migration, ADR note. Out of scope: BEGIN IMMEDIATE conversion of remaining
deferred units (see "Deferred transactions" below).

## 1. Exact per-line COGS

### Check: can reports derive exact per-line COGS from current snapshots?

No. `invoice_lines.cost_at_sale` is the FIFO-weighted unit cost **rounded to
whole DZD** (`Math.round(totalCost / quantity)` in `fifoCostForOutflow`), and
the report computes `cogs = Σ quantity × costAtSale`. Rounding is lossy — the
exact layer total cannot be recovered from the rounded average (ADR-0005
documents the drift: layers 2×10 + 1×15, 3-unit sale → rounded 12 vs exact
11.67), and replaying the ledger later is not stable because backdated inserts
re-order the layers a historical sale consumed. ADR-0005 already defers exactly
this: "exact per-line COGS would need an additive column". So a real gap
exists: add the minimal additive column.

### Change

- New column `invoice_lines.cogs_exact INTEGER NOT NULL DEFAULT 0` — exact
  total COGS of the stock this line consumed, before any rounding:
  - SALE: `Σ (layer units × layer unitCost)` from `fifoOutflowCost`.
  - PURCHASE: `quantity × unitPrice` (the cost basis), equal to `net_total`.
- Migration in `ensureSaleColumns` (marker `migration.cogsExactV1`, same
  single-transaction ALTER + backfill + marker pattern as `saleColumnsV1`).
  Backfill `SET cogs_exact = quantity * cost_at_sale` — exact for legacy
  PURCHASE rows (cost was the unit cost), the documented approximation for any
  legacy SALE row (none exist pre-#30; SALE was a stub). Target restriction
  `WHERE cogs_exact = 0 AND quantity > 0 AND cost_at_sale > 0` keeps the
  UPDATE re-run-safe and never rewrites real zero-cost lines.
- `ProfitSaleLine` gains `cogsExact`; `computeProfitReport` uses it:
  `cogs = Σ line.cogsExact`. `listSaleLinesForProfit` selects it with a
  defensive `COALESCE(l.cogs_exact, l.quantity * l.cost_at_sale)`.
- `fifoCostForOutflow` refactors to delegate to a new `fifoOutflowCost`
  returning `{ totalCost, unitCost }` — public API unchanged.
- ADR-0005 "Tradeoff accepted" paragraph updated: the follow-up landed.

## 2. invoiceDate-driven stock movement timestamps

### Ledger invariants (ADR-0002/0005 + stock-ledger tests)

- The ledger is append-only; all reads replay a deterministic
  `ordered()` sort (occurredAt, then seq/rowid).
- Full-ledger replay must never throw `STOCK_NEGATIVE` (projectLedger /
  historyWithRemaining fail loudly).
- Sale lines snapshot FIFO cost at creation; the cached `cost_price`/stock is
  recomputed by full replay after every write.
- Backdated inflows already exist (`stockAddManual` accepts `occurredAt`) and
  shift layer allocation for older sales — snapshots freeze the numbers.

A sale movement dated `invoiceDate` sorts at that row's `occurredAt`. If that
date precedes an inflow the sale's units came from, replay consumes layers
that "don't exist yet": e.g. purchases 5@100 (Jun 1) + 3@200 (Jun 5), sale of 6
dated Jun 3 → at Jun 3 stock is 5 < 6 → `STOCK_NEGATIVE`. The bound fixes
this.

### Rule (pure, in stock-ledger.ts)

`occurredAt = max(invoiceDate T00:00:00, newest inflow occurredAt)` where
"inflow" is any `delta > 0` movement for the item **at creation time** (the
issue's suggested "last purchase movement" generalizes to any inflow: a
positive `MANUAL_ADJUSTMENT` adds a cost layer too). With the rule:

- The dated sale always sorts after every existing inflow, so it can only
  consume layers that exist at its date — replay of old + new rows stays
  valid by construction.
- `fifoCostForOutflow(existing, …)` and `projectLedger([...existing,
  candidate])` keep using creation-time state; snapshots and the
  stock/cost caches are unchanged (recomputed from full replay).
- A later backdated **inflow** only adds stock; it never invalidates replay.
- Sorted order semantics: dated rows order by business date, undated rows by
  wall clock; equal instants break on rowid (insertion order) — consistent
  between creation-time math and report-time replay.

Applied only when the caller **explicitly** supplies `invoiceDate`
(`input.invoiceDate !== undefined`). Omitted dates keep `localDateTime()` —
the default forward-sale flow is byte-identical to today.

## 3. Cart quantity input cannot be cleared

`value={String(line.quantity)}` is a controlled number field; clearing it
fires `Number("") === 0`, fails the `>= 1` guard, state never changes, and the
DOM snaps back — the field is stuck. Rewrite the line state to carry a string
draft:

- `SaleLine.quantity: number` → `SaleLine.quantityDraft: string`; the input
  binds the raw draft so any keystroke (including empty) sticks.
- Pure helpers exported for unit tests: `parseQuantityDraft(draft)` → effective
  quantity (`0` when empty/whitespace/non-integer-or-`< 1`), and
  `quantityDraftInvalid(draft)`.
- Totals, line totals, and the RPC payload parse the draft; submit refuses any
  line with an invalid draft (`saleInvalidQuantity` error) without touching
  the cart.
- E2E: after the oversell error, `fill("")` sticks as empty and saving refuses
  with the invalid-quantity error; the cart line survives.

## Tests

- Unit (stock-ledger): `fifoOutflowCost` exact totals (ADR-0005 examples);
  `saleMovementTime` bounds (no movements, latest inflow wins, outflows
  ignored); replay-validity property: an un-clamped backdate throws
  `STOCK_NEGATIVE` while the clamped time replays cleanly.
- API router: backdated sale `occurredAt` follows invoiceDate; clamped to the
  last inflow when purchases postdate it; costAtSale/cogsExact on SALE lines;
  purchase lines carry exact cogsExact; profit report uses exact COGS through
  the wire seam.
- Store: migration adds + backfills `cogs_exact` (interrupted-boot self-heal).
- Web: `sale.test.ts` draft-parsing unit tests.
- E2E (ticket30.spec.ts, content-only): cleared-quantity regression.

## Risks

- Legacy SALE rows (pre-#30, none exist) get the `quantity × costAtSale`
  approximation — documented, not silently exact.
- Explicit-dated movement times reorder same-day rows vs. wall-clock movement
  times; snapshots stay frozen so numbers never shift, only history order.
- Additive DTO field on `InvoiceLine` (contract) is backward-compatible.

## Deferred transactions (out of scope, noted not refactored)

`BEGIN IMMEDIATE` was pre-empted for `invoicesPay` by #48
(`withTransactionImmediate`). Units still using deferred `withTransaction`:
`itemsCreate`, `itemsCreateWithStock`, `itemsUpdate`,
`stockAddManual`, `invoicesCreate` (SALE + PURCHASE), purchase intake
(link/correction units around router.ts lines 690–953), `expenseCategoriesCreate`.
Not converted in this PR.