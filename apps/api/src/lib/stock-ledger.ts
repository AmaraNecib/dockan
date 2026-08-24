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
