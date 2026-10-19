import type { MovementKind } from "@dokan/contracts";

/**
 * #295 — the identity of one stock adjustment, and the window inside which a
 * second copy of it is a repeat rather than a second action.
 *
 * WHY THIS EXISTS. The v1 multi-client shape (#294) is two windows on one
 * API. The stock ledger is append-only, so two windows that post the SAME
 * adjustment do not overwrite each other — they append twice, and the stock
 * moves twice for one intention: a double-clicked save, a lost response
 * re-sent as the same action (the #115 rule), or the same form open in two
 * windows. The ledger cannot tell that second movement from a genuine one,
 * so the guard compares the incoming request against what was just recorded.
 *
 * WHAT THE IDENTITY IS. The five fields that make two adjustments the same
 * action: the item, the kind, the signed quantity, the unit cost and the
 * reason. The timestamp is NOT part of it — the server stamps `occurredAt` per
 * request, so two identical requests would differ on it and never match (the
 * trap #177 closed for supplier adjustments with its `serverStamped` rule).
 */

/**
 * How long after a movement the same action is still "the same action".
 *
 * A retry lands in seconds (the API is loopback; a lost connection fails
 * fast) and a double-clicked save lands in under a second. Thirty seconds
 * covers both with room to spare, while a deliberate second adjustment — the
 * owner carrying in two batches of the same item — is typed, not fired, and
 * lands outside the window. The refusal says what happened, so an operator
 * who means it twice submits again a moment later.
 */
export const REPEAT_WINDOW_MS = 30_000;

/** The fields that make two stock adjustments the same action. */
export interface StockAdjustment {
  readonly itemId: string;
  readonly kind: MovementKind;
  /** signed quantity: positive = stock in, negative = stock out */
  readonly delta: number;
  /** per-unit cost of an inflow; null for an outflow */
  readonly unitCost: number | null;
  readonly reason: string | null;
}

/** A movement as the guard sees it: its identity and when it was recorded. */
export interface RecordedAdjustment {
  readonly adjustment: StockAdjustment;
  /**
   * The movement's RECORDING stamp, "YYYY-MM-DD HH:mm:ss" in the server's
   * local time — not its business date. A backdated adjustment still records
   * now, and it is "now" that decides whether a later request is a repeat.
   */
  readonly recordedAt: string;
}

/**
 * The unit cost a request will be RECORDED with.
 *
 * An inflow without a cost takes the item's cached average cost and an
 * outflow never carries one — the same defaults the posting seam applies, so
 * the guard compares the cost the ledger will hold, not the one the request
 * happened to spell out.
 */
export function effectiveUnitCost(delta: number, unitCost: number | undefined, cachedCost: number): number | null {
  if (delta > 0) return unitCost ?? cachedCost;
  if (delta < 0) return null;
  return unitCost ?? null;
}

/** The identity of one action. Stable across processes and free of ordering. */
export function stockAdjustmentSignature(adjustment: StockAdjustment): string {
  return JSON.stringify([adjustment.itemId, adjustment.kind, adjustment.delta, adjustment.unitCost, adjustment.reason]);
}

/**
 * Whether `last` is the same action as `incoming`, recorded inside the
 * window.
 *
 * `cutoff` is the local stamp of "now minus the window"; both stamps share
 * one fixed-width format and one timezone, so the comparison is chronological
 * without any date parsing.
 */
export function isRepeatedAdjustment(
  last: RecordedAdjustment | undefined,
  incoming: StockAdjustment,
  cutoff: string,
): boolean {
  if (last === undefined) return false;
  // older than the window: a genuine second adjustment
  if (last.recordedAt <= cutoff) return false;
  return stockAdjustmentSignature(last.adjustment) === stockAdjustmentSignature(incoming);
}
