import type { Item, ReturnMark, StockMovement } from "@dokan/contracts";

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
  movementId?: string;
  kind: MovementKind;
  /** signed quantity: positive = stock in, negative = stock out */
  delta: number;
  /**
   * Explicit per-unit cost. An inflow with none defaults to the item's cached
   * `costPrice`; an outflow always stores `null` (a cost on an outflow would be
   * a misleading "fact"); a zero-delta cost correction passes the new cost.
   */
  unitCost?: number | null;
  /** Explicitly unknown cost; bypasses legacy cached-cost fallback. */
  costPending?: boolean;
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
 * The item cache a movement leaves behind: the stock on hand and the
 * ADR-0002 weighted-average cost.
 */
type ItemCache = { stockOnHand: number; costPrice: number };

/**
 * The rows one posting batch reads once, and the running cache its movements
 * leave behind. The batch and the single post share this state, so the single
 * post is the length-one case of the same code and not a second
 * implementation of it.
 */
type BatchState = {
  /** the batch's items, read once for the whole batch */
  items: Map<string, Item>;
  /** each item's whole history, read once */
  history: Map<string, Array<StockMovement & { seq: number }>>;
  /** the running cache a sequence of single posts would have written */
  running: Map<string, ItemCache>;
  /** the movements this batch has already posted, per item */
  appended: Map<string, LedgerMovement[]>;
};

/**
 * Read the batch's rows: one item read for the whole batch, then one history
 * read per distinct item, no matter how many movements that item carries in
 * the batch (one batched item read, then one history read per item).
 */
async function readBatchState(
  tx: StockPostingTx,
  specs: readonly StockMovementSpec[],
): Promise<BatchState> {
  const itemIds = [...new Set(specs.map((spec) => spec.itemId))];
  const items = await tx.getItemsByIds(itemIds);
  const history = new Map<string, Array<StockMovement & { seq: number }>>();
  for (const itemId of itemIds) {
    history.set(itemId, await tx.listStockMovements(itemId));
  }
  return { items, history, running: new Map(), appended: new Map() };
}

/**
 * The cache the batch's last movement for this item left behind. A missing
 * item is reported when its first movement is reached, exactly like the
 * single-post path, so error precedence is unchanged.
 */
function cacheFor(state: BatchState, itemId: string): ItemCache {
  const cached = state.running.get(itemId);
  if (cached !== undefined) return cached;
  const item = state.items.get(itemId);
  if (item === undefined) throw new StockItemMissingError(itemId);
  const cache = { stockOnHand: item.stockOnHand, costPrice: item.costPrice };
  state.running.set(itemId, cache);
  return cache;
}

/**
 * Post one movement against the batch's state and return what it posted: the
 * inserted movement, the whole-history projection and the FIFO layer cost.
 */
async function postOne(
  tx: StockPostingTx,
  state: BatchState,
  spec: StockMovementSpec,
): Promise<PostedStockMovement> {
  const existing: LedgerMovement[] = [
    ...(state.history.get(spec.itemId) ?? []),
    ...(state.appended.get(spec.itemId) ?? []),
  ];
  const cache = cacheFor(state, spec.itemId);
  // the replay fallback is always the item's cached cost: the single home of
  // the ADR-0002 blend for a legacy inflow with no stored unit cost
  const fallbackUnitCost = cache.costPrice;
  const occurredAt =
    spec.backdateTo !== undefined
      ? saleMovementTime(spec.backdateTo, existing)
      : (spec.occurredAt ?? localDateTime());

  const unitCost =
    spec.delta > 0
      ? (spec.costPending === true ? null : (spec.unitCost ?? cache.costPrice))
      : spec.delta < 0
        ? null
        : (spec.unitCost ?? null);

  const candidate: LedgerMovement = {
    kind: spec.kind,
    delta: spec.delta,
    unitCost,
    reason: spec.reason ?? null,
    occurredAt,
    costPending: spec.costPending === true,
    seq: undefined,
  };

  // an outflow stamps its FIFO layer cost (ADR-0005) and rejects an oversell;
  // the whole-history projection then validates the candidate in order
  const outflowCost =
    spec.delta < 0 ? fifoOutflowCost(existing, -spec.delta, { fallbackUnitCost }) : null;
  const projection = projectLedger([...existing, candidate], { fallbackUnitCost });

  const movement = await tx.insertStockMovement({
    id: spec.movementId,
    itemId: spec.itemId,
    kind: spec.kind,
    delta: spec.delta,
    unitCost,
    costPending: spec.costPending === true,
    reason: spec.reason ?? null,
    ref: spec.ref ?? null,
    returnMark: spec.returnMark ?? null,
    occurredAt,
  });

  // ADR-0002/0005: the average is replayed from the full ledger after ANY
  // write, outflows included. No per-insertion-position special-casing.
  const containsPendingCost = [...existing, candidate].some((movement) => movement.costPending === true);
  const costPrice = containsPendingCost
    ? cache.costPrice
    : weightedAverageCost([...existing, candidate], { fallbackUnitCost });
  state.appended.set(spec.itemId, [...(state.appended.get(spec.itemId) ?? []), candidate]);
  cache.stockOnHand = projection.stockOnHand;
  cache.costPrice = costPrice;
  return { movement, stockOnHand: projection.stockOnHand, costPrice, outflowCost };
}

/** Write the item caches the batch's movements left behind: one write per item. */
async function writeBatchCaches(tx: StockPostingTx, state: BatchState): Promise<void> {
  for (const [itemId, cache] of state.running) {
    await tx.setItemStockAndCost(itemId, cache.stockOnHand, cache.costPrice);
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
 * re-reading the same rows (each read a store round-trip and SQL sort) per line
 * would block every other store request; the in-memory replay still runs once
 * per movement, which is cheap next to the round-trips it replaces.
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

  const state = await readBatchState(tx, specs);
  const posted: PostedStockMovement[] = [];
  for (const spec of specs) {
    posted.push(await postOne(tx, state, spec));
  }

  // one cache write per item, after the item's whole batch landed
  await writeBatchCaches(tx, state);
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
  const state = await readBatchState(tx, [spec]);
  const posted = await postOne(tx, state, spec);
  await writeBatchCaches(tx, state);
  return posted;
}

/** Read-only whole-history projection (stock on hand + FIFO layers). No write. */
export async function itemStockProjection(
  tx: Pick<StorePort, "listStockMovements">,
  itemId: string,
  opts: { fallbackUnitCost?: number } = {},
): Promise<LedgerProjection> {
  return projectLedger(await tx.listStockMovements(itemId), opts);
}
