# Issue 143 — Deepen the movement-posting seam

Tier: **High-assurance** (stock valuation feeds COGS/profit — ADR-0002/0005).
Base: `origin/develop` @ `da44b50` (merge-base = HEAD; no rebase needed).
Branch: `feat-143-movement-seam`.

## Problem

"read ledger → build candidate movement → validate (no negative stock) → insert
movement → recompute the ADR-0002 weighted average → write `items.stockOnHand` /
`items.costPrice`" is re-implemented at every stock-write call site in
`apps/api/src/rpc/router.ts`, each with its own `fallbackUnitCost`, candidate
shape, and ordering. The invariant has no single home, and the sites disagree on
the outflow rule.

The issue's table lists six sites. The current code actually has **nine**
stock-write sites (three post-date the architecture-review snapshot):
`itemsCreateWithStock` (opening), `itemsUpdate` (ADR-0002 cost correction),
`stockAddManual`, `suppliersReturn`, `invoicesCreate·SALE`,
`invoicesCreate·PURCHASE`, `returnsCreate`, `returnsReject`,
`purchasesCorrectLine`.

## Decisions — replay consistency (the crux)

**Unify on full-ledger replay.** `stockAddManual` currently preserves the cached
`costPrice` when `delta < 0`; the other eight replay. ADR-0005 states it
plainly: *"every inflow blends into the moving weighted average, outflows only
reduce quantity, and the average is replayed from the full ledger after any
write."* ADR-0002's amendment repeats the replay rule. The ADRs settle the
disagreement, so the module always replays; the preserve branch is removed.

Observable consequence: for an **in-sync cache** and a non-backdated outflow the
two rules agree (an outflow never changes the running average), and every
existing test passes unchanged. They diverge only for a **backdated outflow**,
where replay is the ADR-correct value — e.g. layers `10@100` (t1), `10@300`
(t2), then a 5-unit outflow backdated between t1 and t2: replay yields
`(100×5 + 300×10)/15 = 233`, while preserving yields the stale `200`. A test
pins 233. No `decisionRequest` is required: the ADRs plus the issue's Q2 settle
it.

**Second deliberate unification — the replay fallback.** `stockAddManual`'s
inflow replay passed **no** `fallbackUnitCost`, so a legacy inflow row with a
`null` unit cost contributed `0`; the other sites passed `item.costPrice`.
The seam makes the fallback uniform for every site — the replay always uses the
item's cached `costPrice` — so a null-cost legacy inflow blends at the item's
cached cost. No current code path writes a positive-delta null-cost row, so this
is latent, but it is the same class of "one home for the invariant" fix as the
outflow rule; a unit test pins the fallback blend. Both unifications are
deliberate and reviewed in the debate evidence.

**Accepted side effects (not drift).** `itemsUpdate` now writes
`projection.stockOnHand` (full-history) instead of the cached integer, and the
other sites likewise resync from the projection; on an already-drifted cache
this *repairs* the value rather than preserving the drift, which is the
intended "fail loudly / self-heal" stance. `recordStockMovement` re-reads the
item it is about (`getItemsByIds`) rather than trusting a caller-cached
`costPrice`, so the module is safe on its own interface; the extra read is one
indexed lookup inside the caller's transaction. `StockItemMissingError` maps to
`BAD_REQUEST ITEM_NOT_FOUND` (matching the historical `stockAddManual` refusal);
it is a backstop because every call site pre-validates the item.

## Module interface — `apps/api/src/lib/stock-posting.ts`

```ts
export type StockPostingTx = Pick<StorePort,
  "getItemsByIds" | "listStockMovements" | "insertStockMovement" | "setItemStockAndCost">;

export interface StockMovementSpec {
  itemId: string;
  kind: MovementKind;
  delta: number;
  /** explicit cost; delta>0 defaults to the item's cached costPrice,
   *  delta<0 is always null, delta===0 uses the explicit value (correction) */
  unitCost?: number | null;
  reason?: string | null;
  ref?: string | null;
  returnMark?: ReturnMark | null;
  /** explicit moment; defaults to the wall clock */
  occurredAt?: string;
  /** SALE only: business date; the movement is bounded to the newest inflow */
  backdateTo?: string;
}

export interface PostedStockMovement {
  movement: StockMovement;
  stockOnHand: number;
  costPrice: number;                   // resynced ADR-0002 average
  outflowCost: FifoOutflowCost | null; // present iff delta < 0
}

export class StockItemMissingError extends Error {}

export async function recordStockMovement(tx: StockPostingTx, spec: StockMovementSpec): Promise<PostedStockMovement>;

/** Read-only projection for clamps/history; no writes. */
export async function itemStockProjection(tx, itemId, opts?): Promise<LedgerProjection>;
```

`recordStockMovement` owns the whole sequence: fetch item (typed missing error),
read the full ledger, choose `occurredAt` (`saleMovementTime` when `backdateTo`),
default the inflow cost, take the FIFO snapshot + validate for outflows
(`fifoOutflowCost`), validate the projection (`projectLedger`), insert one
movement, replay the average (`weightedAverageCost`), write the cache
(`setItemStockAndCost`). Multi-movement callers call it in a loop inside the
same transaction; rowid order preserves inflow-first (correction) ordering.

The pure math in `stock-ledger.ts` stays pure; this module is the IO seam.
Deliberately not a `StorePort` method (Q3): the weighted-average replay is
business math, and booking it into the port would force the PostgreSQL adapter
to re-implement it.

## Router changes

- One error mapper to oRPC (`StockItemMissingError` → `BAD_REQUEST
  ITEM_NOT_FOUND`, `StockLedgerError` → `BAD_REQUEST <code>`), replacing the
  inline `try/catch` blocks.
- All **nine** write sites call `recordStockMovement`; the router no longer
  calls `projectLedger`, `weightedAverageCost`, or `setItemStockAndCost` for
  stock writes (DoD). `itemsHistory` derives its `stockOnHand` from the
  `historyWithRemaining` rows it already computes; `returnsReject`'s clamp uses
  `itemStockProjection`.
- Extending from six to nine is required by the issue's DoD ("no longer called
  from router.ts for stock writes") and keeps one home for the invariant. It is
  behaviour-preserving for all existing tests.
- Reordering inside `invoicesCreate·SALE`: the module posts+returns the FIFO
  snapshot, and the invoice line is stamped from it. No FK dependency changes
  (the invoice exists; the movement's `ref` points at it).

## Out of scope (scope fence)

`apps/api/src/lib/stock-ledger.ts` pure math (untouched), schema, contracts,
procedure list, router split (candidate 2), invoice-draft module (candidate 3),
migrations (candidate 4), `StorePort` roles (candidate 5). No direct edits to
unrelated handlers.

## Planned tests

Unit — `apps/api/src/lib/stock-posting.test.ts` (fake `StockPostingTx`):
inflow blend; inflow default cost; pure outflow (average + no stored unit cost +
null `outflowCost`); SALE FIFO `costAtSale`/`cogsExact`; negative-stock
rejection writes nothing; backdated SALE time clamped to newest inflow;
item-missing; zero-delta cost correction; **chosen outflow rule** (backdated
outflow replays to 233); **uniform null-cost inflow fallback**.

Wire parity — `router.test.ts` "movement posting seam (issue 143)": one test per
call site asserting exact movement rows, `stockOnHand`, and `costPrice` golden
values (stockAddManual inflow/outflow, SALE, PURCHASE, returnsCreate,
returnsReject, purchasesCorrectLine, suppliersReturn, itemsUpdate,
itemsCreateWithStock).

E2E — no new user-facing flow; the existing `stock-ledger.spec.ts`,
`sale-checkout.spec.ts`, `purchase-intake.spec.ts`, `returns.spec.ts`,
`supplier-account.spec.ts` suites are the regression gate (full Playwright run
in Guard 1/2).

## Risks

1. Silent numeric drift at any call site — mitigated by per-site golden tests +
   the existing wire suite.
2. `invoicesCreate·SALE` reorder — mitigated by asserting line `costAtSale` /
   `cogsExact` and ledger rows.
3. `returnsReject` per-line loop vs one aggregate replay — outflows do not move
   the average, so the final cache is identical; asserted directly.
4. `itemsUpdate`/`itemsCreateWithStock`/`suppliersReturn` now project whole
   history — valid data is unchanged; corrupt history fails loudly (intended).
