# Issue 144 — an owner-edited cost price is a ledger fact (design)

Tier: **high-assurance** (stock valuation feeds COGS/profit — ADR-0002 / ADR-0005).
Base: `develop` @ `e119c13`. Branch: `feat/stock-cost-price`.
Owner decision: **option (a)** — a manual cost edit becomes an explicit ledger movement.

## Problem

`itemsUpdate` writes `items.costPrice` directly with no `stock_movements` row. Every
inflow/outflow replays `costPrice` from the full ledger via `weightedAverageCost`, so
the manual edit is silently discarded at the next write. Nothing records the edit.

## Rule (the zero-quantity case)

The ADR-0002 replay `(oldQty*oldCost + qty*cost)/(oldQty+qty)` is undefined when the
movement's `qty` is 0. We define an explicit **cost correction** movement:

> A `MANUAL_ADJUSTMENT` with `delta === 0`, a non-null `unitCost`, and
> `reason === "COST_CORRECTION"` sets the running weighted average to `unitCost`
> without changing quantity. Any other zero-delta movement is a no-op.

Replay (`weightedAverageCost`), chronological:

- `delta > 0` → blend (`averageCostAfter`), unchanged.
- `delta === 0 && unitCost !== null && reason === COST_CORRECTION` → `average = unitCost`.
- otherwise → unchanged.
- `quantity += delta` always.

Properties:

- **Quantity** never changes (delta 0).
- **Zero on-hand**: average is set to `unitCost`; a later inflow blends with weight
  `currentQty = 0`, so the correction cannot corrupt a later inflow.
- **Later inflow**: `(correctedQty*correctedCost + inboundQty*cost)/…` — correct.
- **Later outflow**: average untouched; quantity only.
- **FIFO layers** are untouched (delta 0 adds no layer). ADR-0005 already separates
  FIFO `costAtSale` from the live average; the correction revalues the live cache
  only. Documented in ADR-0002.

Gating on `reason === "COST_CORRECTION"` is deliberate: the legacy opening-balance
backfill also writes zero-delta rows (`reason: "opening"`) for zero-stock items and
must stay a replay no-op.

## Changes

- `store` (drizzle): no DDL. `stock_movements` already allows `delta = 0`, `reason`,
  and nullable `unit_cost`; `activities.type` is free TEXT.
- `apps/api/src/lib/stock-ledger.ts` — `LedgerMovement.reason?`; correction branch in
  `weightedAverageCost`; export `COST_CORRECTION_REASON`.
- `apps/api/src/rpc/router.ts` `itemsUpdate` — same transaction as the item update:
  read the current item, append the correction movement when the cost actually
  changes, replay `weightedAverageCost`, write non-cost fields via `updateItem`
  (cost omitted), `setItemStockAndCost` with the replayed cost, and write one
  `ITEM_COST_CORRECTED` activity row (plus the existing `ITEM_UPDATED`).
- `packages/contracts` — add `ITEM_COST_CORRECTED` to `activityTypes`.
- web — `activity.tsx` summary branch; `stock.tsx` reason branch; `i18n.ts` copy.
- docs — ADR-0002 amendment; CONTEXT glossary line.

## Schema version

No version bump: no stored shape changed. The new value rides the existing free-TEXT
`activities.type` column and the existing `stock_movements` shape. The version gate is
untouched; a newer DB still refuses cleanly (covered by existing tests).

## Tests (must fail without the fix)

- Pure: correction sets average; correction + inflow blends; correction on empty is
  ignored by the next inflow; outflow keeps the corrected average; opening row (delta
  0, `reason: "opening"`) stays a no-op.
- Router: edit cost → purchase replay survives; edit cost → sale/outflow replay
  survives; cost-only correction leaves quantity and average correct (and appends the
  movement); manual quantity adjustment still blends; one activity row per correction
  (not per replay); concurrent edit + purchase is consistent with the final ledger.
- Store: close/reopen keeps the corrected cost and the movement.
- Web: the new activity summary token translates; reason token translates.
- E2E: edit the cost, then add stock; the corrected cost survives the blend.

## Round 2 (review findings)

- **Future-dated inflow**: the correction was dated at the wall clock, so an
  existing future-dated inflow replayed after it and blended over the edit
  (edit to 300 stored 250). Superseded by the round-3 ordering rule below.
- **Neutral zero-delta styling**: the history quantity cell styled every
  non-positive delta as a destructive outflow, so a cost correction showed a
  red 0. `movementDeltaClass` returns success for inflows, destructive for
  outflows, and neutral for a zero-delta event.

## Round 3 (review finding) — recording-order precedence

The round-2 fix moved the correction's timestamp to `max(now, newest row)`.
That made the correction survive a future-dated row but swallowed any purchase
recorded afterwards whose date was earlier than that future row (a later
purchase dated now replayed before the correction and was overridden: cost
stayed 300 instead of blending to 250).

Precedence is now **recording order**, not business date. `weightedAverageCost`
walks the ledger by store rowid `seq` (input order for pure callers), splitting
it into segments at each correction. Inside a segment ordinary movements replay
in `occurredAt` order exactly as before. A correction resets the running average
to its unit cost for the on-hand quantity, so it applies after everything
recorded before it and before everything recorded after it. No movement's
stored `occurredAt` is rewritten, and with no corrections the whole ledger is a
single segment, so ordinary backdated purchases/outflows are unchanged.
`costCorrectionTime` is gone; the correction is dated at the wall clock again.

```
10@100 ─┐
        ├─ segment (flushed by occurredAt) ─ avg 150, qty 20
10@200 ─┘   (dated 2999)
correction 300 ───────────────────────────── avg 300, qty 20
10@150 (now, recorded after) ─────────────── blend (20×300+10×150)/30 = 250
```
