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
 * Post one movement and resync the item cache. The caller must already be
 * inside a transaction; a multi-movement flow calls this in a loop in the same
 * unit (recording order — the store's rowid — preserves the inflow-first
 * ordering of a purchase correction).
 *
 * Validation is total: the FIFO snapshot for an outflow and the whole-history
 * projection both run before anything is written, so a rejected movement
 * leaves the ledger untouched.
 */
export async function recordStockMovement(
  tx: StockPostingTx,
  spec: StockMovementSpec,
): Promise<PostedStockMovement> {
  const item = (await tx.getItemsByIds([spec.itemId])).get(spec.itemId);
  if (item === undefined) throw new StockItemMissingError(spec.itemId);

  const existing = await tx.listStockMovements(spec.itemId);
  // the replay fallback is always the item's cached cost: the single home of
  // the ADR-0002 blend for a legacy inflow with no stored unit cost
  const fallbackUnitCost = item.costPrice;
  const occurredAt =
    spec.backdateTo !== undefined
      ? saleMovementTime(spec.backdateTo, existing)
      : (spec.occurredAt ?? localDateTime());

  const unitCost =
    spec.delta > 0
      ? (spec.unitCost ?? item.costPrice)
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
  await tx.setItemStockAndCost(spec.itemId, projection.stockOnHand, costPrice);

  return { movement, stockOnHand: projection.stockOnHand, costPrice, outflowCost };
}

/** Read-only whole-history projection (stock on hand + FIFO layers). No write. */
export async function itemStockProjection(
  tx: Pick<StorePort, "listStockMovements">,
  itemId: string,
  opts: { fallbackUnitCost?: number } = {},
): Promise<LedgerProjection> {
  return projectLedger(await tx.listStockMovements(itemId), opts);
}
