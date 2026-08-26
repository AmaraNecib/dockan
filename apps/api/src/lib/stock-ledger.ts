import type { movementKinds } from "@dokan/contracts";

/**
 * Pure stock-ledger math (ticket 27, seam 1). No IO, no clocks — every
 * function takes movements as data and returns derived values. The store
 * owns persistence; the router owns validation; this module only does math,
 * so corrupt history fails loudly here instead of silently lying downstream
 * (stock feeds COGS/profit — see docs/adr/0002).
 */

export type MovementKind = (typeof movementKinds)[number];

export interface LedgerMovement {
  kind: MovementKind;
  /** signed quantity: positive = stock in, negative = stock out */
  delta: number;
  /** per-unit cost of an inflow; null for outflows */
  unitCost: number | null;
  occurredAt: string;
  /** store rowid tiebreaker for identical timestamps; array order wins when absent */
  seq?: number;
}

export interface FifoLayer {
  quantity: number;
  unitCost: number;
}

/** Exact layer cost of one outflow: `totalCost` before rounding, plus the
 * ADR-0005 whole-DZD per-unit snapshot. The report sums `totalCost` because
 * `quantity × unitCost` drifts by up to half a DZD per unit. */
export interface FifoOutflowCost {
  totalCost: number;
  unitCost: number;
}

export interface LedgerProjection {
  stockOnHand: number;
  layers: FifoLayer[];
}

export class StockLedgerError extends Error {
  constructor(
    public readonly code: "STOCK_NEGATIVE",
    message: string,
  ) {
    super(message);
    this.name = "StockLedgerError";
  }
}

/** Deterministic ordering: by occurredAt, then seq (rowid), then input order. */
function ordered<T extends LedgerMovement>(movements: readonly T[]): T[] {
  return movements
    .map((movement, index) => ({ movement, index }))
    .sort((a, b) => {
      if (a.movement.occurredAt !== b.movement.occurredAt) {
        return a.movement.occurredAt < b.movement.occurredAt ? -1 : 1;
      }
      if (a.movement.seq !== undefined && b.movement.seq !== undefined && a.movement.seq !== b.movement.seq) {
        return a.movement.seq - b.movement.seq;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.movement);
}

/**
 * FIFO projection over the full movement list. Inflows push cost layers
 * (unit_cost ?? fallbackUnitCost); outflows consume oldest-first.
 * Throws STOCK_NEGATIVE when any step would drive stock below zero.
 */
export function projectLedger(
  movements: readonly LedgerMovement[],
  opts: { fallbackUnitCost?: number } = {},
): LedgerProjection {
  const layers: FifoLayer[] = [];
  let stockOnHand = 0;
  for (const movement of ordered(movements)) {
    if (movement.delta > 0) {
      const unitCost = movement.unitCost ?? opts.fallbackUnitCost ?? 0;
      const last = layers.at(-1);
      if (last !== undefined && last.unitCost === unitCost) {
        last.quantity += movement.delta;
      } else {
        layers.push({ quantity: movement.delta, unitCost });
      }
      stockOnHand += movement.delta;
    } else if (movement.delta < 0) {
      let remaining = -movement.delta;
      if (remaining > stockOnHand) {
        throw new StockLedgerError("STOCK_NEGATIVE", `sale of ${remaining} exceeds stock ${stockOnHand}`);
      }
      while (remaining > 0) {
        const oldest = layers[0];
        if (oldest === undefined) {
          throw new StockLedgerError("STOCK_NEGATIVE", "consumption exhausted all cost layers");
        }
        if (oldest.quantity <= remaining) {
          remaining -= oldest.quantity;
          layers.shift();
        } else {
          oldest.quantity -= remaining;
          remaining = 0;
        }
      }
      stockOnHand += movement.delta;
    }
  }
  return { stockOnHand, layers };
}

/** Stock on hand as of an Algeria-local date ("YYYY-MM-DD", inclusive). */
export function stockAsOf(movements: readonly LedgerMovement[], dateIso: string): number {
  return projectLedger(movements.filter((m) => m.occurredAt.slice(0, 10) <= dateIso)).stockOnHand;
}

export interface HistoryRow extends LedgerMovement {
  stockAfter: number;
}

/** Per-movement derived remaining stock for the history view. Generic so
 * callers passing full store rows get the row shape back, not just the
 * ledger-math subset. */
export function historyWithRemaining<T extends LedgerMovement>(movements: readonly T[]): Array<T & { stockAfter: number }> {
  const rows = ordered(movements);
  let running = 0;
  return rows.map((movement) => {
    running += movement.delta;
    if (running < 0) {
      throw new StockLedgerError("STOCK_NEGATIVE", `history dips to ${running}`);
    }
    return { ...movement, stockAfter: running };
  });
}

/**
 * Exact FIFO layer cost for a sale plus its rounded unit snapshot.
 * Validation matches fifoCostForOutflow: quantity must be a positive integer
 * and must not exceed the stock projected from `movements` (STOCK_NEGATIVE).
 */
export function fifoOutflowCost(
  movements: readonly LedgerMovement[],
  quantity: number,
  opts: { fallbackUnitCost?: number } = {},
): FifoOutflowCost {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("quantity must be a positive integer");
  const projection = projectLedger(movements, opts);
  if (quantity > projection.stockOnHand) {
    throw new StockLedgerError("STOCK_NEGATIVE", `sale of ${quantity} exceeds stock ${projection.stockOnHand}`);
  }
  let remaining = quantity;
  let totalCost = 0;
  for (const layer of projection.layers) {
    const take = Math.min(layer.quantity, remaining);
    totalCost += take * layer.unitCost;
    remaining -= take;
    if (remaining === 0) break;
  }
  return { totalCost, unitCost: Math.round(totalCost / quantity) };
}

/**
 * Average FIFO unit cost for a sale from the current layers. The returned
 * value is an integer DZD snapshot; the ledger itself remains the source of
 * truth for the exact layers and the caller validates the resulting outflow.
 */
export function fifoCostForOutflow(
  movements: readonly LedgerMovement[],
  quantity: number,
  opts: { fallbackUnitCost?: number } = {},
): number {
  return fifoOutflowCost(movements, quantity, opts).unitCost;
}

/**
 * Movement timestamp for a sale whose invoice explicitly carries a business
 * date (`invoiceDate`, Algeria-local). The profit report already attributes
 * revenue/COGS to that date; this rule carries the same dating into the stock
 * ledger so the item history and day-level stockAsOf slices agree with the
 * invoice.
 *
 * Bound: never earlier than the newest INFLOW (delta > 0) movement for the
 * item — the issue's "never before the last purchase movement" generalized,
 * because a positive MANUAL_ADJUSTMENT also adds cost layers. A dated sale
 * therefore always sorts after every inflow that existed when it was created,
 * so FIFO replay can never consume layers that did not exist at the sale's
 * date (un-clamped, e.g. [5@100 on Jun 1, 3@200 on Jun 5] with a 6-unit sale
 * dated Jun 3 would replay STOCK_NEGATIVE). Later backdated inflows only add
 * stock, so they cannot invalidate the replay either.
 *
 * Same-day rows order by rowid (insertion order) exactly like today; dated
 * rows order by business date rather than wall clock, which is documented
 * here and in ADR-0005. Cost snapshots stay frozen at creation time.
 */
export function saleMovementTime(invoiceDate: string, movements: readonly LedgerMovement[]): string {
  let latestInflow = "";
  for (const movement of movements) {
    if (movement.delta > 0 && movement.occurredAt > latestInflow) {
      latestInflow = movement.occurredAt;
    }
  }
  const dayStart = `${invoiceDate}T00:00:00`;
  return latestInflow !== "" && latestInflow > dayStart ? latestInflow : dayStart;
}

/** ADR-0002 weighted average after an inflow lands on top of current holdings. */
export function averageCostAfter(
  currentAvgCost: number,
  currentQty: number,
  inboundQty: number,
  inboundUnitCost: number,
): number {
  const totalQty = currentQty + inboundQty;
  if (totalQty === 0) return currentAvgCost;
  return Math.round((currentAvgCost * currentQty + inboundUnitCost * inboundQty) / totalQty);
}

/**
 * Recompute the ADR-0002 running weighted average from scratch by replaying
 * the full ledger chronologically: inflows blend into the running average,
 * outflows only reduce quantity. Position-independent — this is the single
 * source of truth for `cost_price` after ANY write, including backdated
 * inserts, so callers never need special-case math per insertion point.
 */
export function weightedAverageCost(
  movements: readonly LedgerMovement[],
  opts: { fallbackUnitCost?: number } = {},
): number {
  let quantity = 0;
  let average = 0;
  for (const movement of ordered(movements)) {
    if (movement.delta > 0) {
      average = averageCostAfter(
        average,
        quantity,
        movement.delta,
        movement.unitCost ?? opts.fallbackUnitCost ?? 0,
      );
    }
    quantity += movement.delta;
  }
  return average;
}
