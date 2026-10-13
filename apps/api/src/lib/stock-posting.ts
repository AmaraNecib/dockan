import type { ReturnMark, StockMovement } from "@dokan/contracts";

import type { StorePort } from "../store/port";
import { localDateTime } from "./logger";
import {
  fifoOutflowCost,
  projectLedger,
  saleMovementTime,
  weightedAverageCost,
  type FifoOutflowCost,
  type LedgerMovement,
  type LedgerProjection,
  type MovementKind,
} from "./stock-ledger";

/**
 * The movement-posting seam (issue 143). One deep module owns the whole
 * sequence every stock write used to re-implement:
 *
 *   read the ledger → build the candidate movement → take the FIFO snapshot
 *   and validate (no negative stock) → insert the movement → replay the
 *   ADR-0002 weighted average → write `items.stockOnHand` / `items.costPrice`.
 *
 * Callers state intent; the invariant lives here once. The pure math stays in
 * `stock-ledger.ts`; this module is the IO seam and the single home of the
 * ADR-0002/0005 rule. It is deliberately not a `StorePort` method: the average
 * replay is business math, and putting it in the port would force the planned
 * PostgreSQL adapter to re-implement it (against ADR-0003).
 */

/** The subset of the store transaction this module needs; small enough to fake
 * in unit tests, satisfied by `StorePort`'s transaction handle. */
export type StockPostingTx = Pick<
  StorePort,
  "getItemsByIds" | "listStockMovements" | "insertStockMovement" | "setItemStockAndCost"
>;

export interface StockMovementSpec {
  itemId: string;
  kind: MovementKind;
  /** signed quantity: positive = stock in, negative = stock out */
  delta: number;
  /**
   * Explicit per-unit cost. An inflow with none defaults to the item's cached
   * `costPrice`; an outflow always stores `null` (a cost on an outflow would be
   * a misleading "fact"); a zero-delta cost correction passes the new cost.
   */
  unitCost?: number | null;
  reason?: string | null;
  ref?: string | null;
  returnMark?: ReturnMark | null;
  /** Wall-clock moment the movement is recorded at; defaults to now. */
  occurredAt?: string;
  /**
   * SALE only: the invoice's explicit business date. When present the movement
   * time is the issue-43 bound `saleMovementTime(backdateTo, existing)`, so a
   * dated sale can never sort ahead of the inflow it consumes.
   */
  backdateTo?: string;
}

export interface PostedStockMovement {
  movement: StockMovement;
  /** stock on hand after the movement, from the whole-history projection */
  stockOnHand: number;
  /** resynced ADR-0002 weighted-average cost written to the item cache */
  costPrice: number;
  /** FIFO layer cost of the outflow; present iff `delta < 0`, else null */
  outflowCost: FifoOutflowCost | null;
}

/** The item named by a movement spec does not exist. */
export class StockItemMissingError extends Error {
  constructor(public readonly itemId: string) {
    super(`stock item ${itemId} not found`);
    this.name = "StockItemMissingError";
  }
}

/**
 * Post a batch of movements and resync the touched item caches.
 *
 * The item row and the item's whole history are read ONCE per distinct item,
 * each movement still replays against the ledger (and against the running
 * cache a sequence of single posts would have written) so every candidate is
 * validated in order, and each item's cache is written ONCE after its last
 * movement. A supported return can carry 200 lines of a handful of items, so
 * re-reading and re-sorting the same history per line would block every other
 * store request.
 *
 * This is the single implementation of the ADR-0002/0005 rule; the one-item
 * `recordStockMovement` is the length-one case over it. The caller must
 * already be inside a transaction; recording order (store rowid) preserves
 * spec order, so an inflow-first correction pair stays inflow-first.
 *
 * Validation is total: every candidate's FIFO snapshot and whole-history
 * projection run before the matching insert, so a rejected movement leaves the
 * ledger untouched (the enclosing transaction rolls the earlier rows back).
 */
export async function recordStockMovements(
  tx: StockPostingTx,
  specs: readonly StockMovementSpec[],
): Promise<PostedStockMovement[]> {
  if (specs.length === 0) return [];

  // one item read and one history read per distinct item, no matter how many
  // movements that item carries in this batch
  const itemIds = [...new Set(specs.map((spec) => spec.itemId))];
  const items = await tx.getItemsByIds(itemIds);
  for (const itemId of itemIds) {
    if (!items.has(itemId)) throw new StockItemMissingError(itemId);
  }
  const history = new Map<string, Array<StockMovement & { seq: number }>>();
  for (const itemId of itemIds) {
    history.set(itemId, await tx.listStockMovements(itemId));
  }

  // the running cache a sequence of single posts would have written: each
  // movement's fallback (and an inflow's default unit cost) is what the
  // previous movement in this batch left in the cache
  const running = new Map<string, { stockOnHand: number; costPrice: number }>();
  for (const itemId of itemIds) {
    const item = items.get(itemId)!;
    running.set(itemId, { stockOnHand: item.stockOnHand, costPrice: item.costPrice });
  }

  const appended = new Map<string, LedgerMovement[]>();
  const posted: PostedStockMovement[] = [];
  for (const spec of specs) {
    const existing: LedgerMovement[] = [
      ...(history.get(spec.itemId) ?? []),
      ...(appended.get(spec.itemId) ?? []),
    ];
    const cache = running.get(spec.itemId)!;
    // the replay fallback is always the item's cached cost: the single home of
    // the ADR-0002 blend for a legacy inflow with no stored unit cost
    const fallbackUnitCost = cache.costPrice;
    const occurredAt =
      spec.backdateTo !== undefined
        ? saleMovementTime(spec.backdateTo, existing)
        : (spec.occurredAt ?? localDateTime());

    const unitCost =
      spec.delta > 0
        ? (spec.unitCost ?? cache.costPrice)
        : spec.delta < 0
          ? null
          : (spec.unitCost ?? null);

    const candidate: LedgerMovement = {
      kind: spec.kind,
      delta: spec.delta,
      unitCost,
      reason: spec.reason ?? null,
      occurredAt,
      seq: undefined,
    };

    // an outflow stamps its FIFO layer cost (ADR-0005) and rejects an oversell;
    // the whole-history projection then validates the candidate in order
    const outflowCost =
      spec.delta < 0 ? fifoOutflowCost(existing, -spec.delta, { fallbackUnitCost }) : null;
    const projection = projectLedger([...existing, candidate], { fallbackUnitCost });

    const movement = await tx.insertStockMovement({
      itemId: spec.itemId,
      kind: spec.kind,
      delta: spec.delta,
      unitCost,
      reason: spec.reason ?? null,
      ref: spec.ref ?? null,
      returnMark: spec.returnMark ?? null,
      occurredAt,
    });

    // ADR-0002/0005: the average is replayed from the full ledger after ANY
    // write, outflows included. No per-insertion-position special-casing.
    const costPrice = weightedAverageCost([...existing, candidate], { fallbackUnitCost });
    appended.set(spec.itemId, [...(appended.get(spec.itemId) ?? []), candidate]);
    cache.stockOnHand = projection.stockOnHand;
    cache.costPrice = costPrice;
    posted.push({ movement, stockOnHand: projection.stockOnHand, costPrice, outflowCost });
  }

  // one cache write per item, after the item's whole batch landed
  for (const itemId of itemIds) {
    const cache = running.get(itemId)!;
    await tx.setItemStockAndCost(itemId, cache.stockOnHand, cache.costPrice);
  }
  return posted;
}

/**
 * Post one movement and resync the item cache. The caller must already be
 * inside a transaction; the length-one case of `recordStockMovements`, so the
 * rule lives in exactly one place.
 */
export async function recordStockMovement(
  tx: StockPostingTx,
  spec: StockMovementSpec,
): Promise<PostedStockMovement> {
  const [posted] = await recordStockMovements(tx, [spec]);
  // SAFETY: the batch returns exactly one result per spec, and we passed one
  return posted!;
}

/** Read-only whole-history projection (stock on hand + FIFO layers). No write. */
export async function itemStockProjection(
  tx: Pick<StorePort, "listStockMovements">,
  itemId: string,
  opts: { fallbackUnitCost?: number } = {},
): Promise<LedgerProjection> {
  return projectLedger(await tx.listStockMovements(itemId), opts);
}
