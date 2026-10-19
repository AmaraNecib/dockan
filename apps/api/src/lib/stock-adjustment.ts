import type { MovementKind, StockMovement } from "@dokan/contracts";

import { localDateTime } from "./logger";

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
 * so the guard compares the incoming request against what was recorded
 * recently.
 *
 * WHAT THE IDENTITY IS. The fields that make two adjustments the same action:
 * the item, the kind, the signed quantity, the unit cost and the reason. Two
 * of those join only when the CALLER expressed them:
 *
 *   - the business date: a server-stamped date cannot tell a retry apart,
 *     because two identical requests would differ on it and never match (the
 *     trap #177 closed for supplier adjustments with its `serverStamped`
 *     rule). A caller-supplied date IS part of the identity.
 *   - the unit cost: an inflow that carried no cost means "at the item's
 *     cost", and the server derives that cost at posting time. A derived
 *     value is not part of what the request expressed, so it is not part of
 *     the identity — otherwise the first posting would move the average and
 *     the retry would compute a different cost and slip past the guard.
 */

/**
 * How long after a movement the same action is still "the same action".
 *
 * A retry lands in seconds (the API is loopback; a lost connection fails
 * fast) and a double-clicked save lands in under a second. Thirty seconds
 * covers both with room to spare, while a deliberate second adjustment — the
 * owner carrying in two batches of the same item — is typed, not fired, and
 * lands outside the window. The refusal says what happened, so an operator
 * who means it twice submits again a moment later, or changes the reason: a
 * different reason is a different action, and the reason box is the escape
 * hatch the predicate actually offers.
 */
export const REPEAT_WINDOW_MS = 30_000;

/** The fields that make two stock adjustments the same action. */
export interface StockAdjustment {
  readonly itemId: string;
  readonly kind: MovementKind;
  /** signed quantity: positive = stock in, negative = stock out */
  readonly delta: number;
  /**
   * The unit cost the request expressed, or undefined when it expressed none
   * (an inflow at the item's cost, or an outflow — the seam records those
   * costless). undefined means "not part of the identity".
   */
  readonly unitCost: number | null | undefined;
  readonly reason: string | null;
  /**
   * The business date the CALLER supplied, or null when the server stamps it.
   *
   * A server-stamped date is not part of the identity: two identical
   * requests would carry different stamps and never match. A caller-supplied
   * date is: two adjustments dated differently are two actions.
   */
  readonly occurredAt: string | null;
}

/**
 * The local stamp of "now minus the window" — the lower bound of the repeat
 * window.
 *
 * The format is the server's local "YYYY-MM-DDTHH:mm:ss" (the same one
 * `createdAt` stores), fixed width and one timezone, so the store can compare
 * it against a recorded stamp without parsing a date.
 */
export function repeatCutoff(now: Date = new Date()): string {
  return localDateTime(new Date(now.getTime() - REPEAT_WINDOW_MS));
}

/**
 * The unit cost a request EXPRESSES — what goes into the identity.
 *
 * An outflow is recorded costless by the posting seam, so its cost is not
 * part of the identity. A correction with no cost is a no-op and is recorded
 * as one. An inflow with no explicit cost means "at the item's cost", and the
 * server derives that at posting time, so it is left out of the identity
 * (see the module doc).
 */
export function expressUnitCost(
  delta: number,
  unitCost: number | null | undefined
): number | null | undefined {
  if (delta < 0) return undefined;
  if (delta === 0) return unitCost ?? null;
  return unitCost;
}

/**
 * Whether `recorded` is the same action as `request`.
 *
 * The request leads: the fields it did not express (a server-stamped date, an
 * inflow's derived cost) are not compared, and everything it did express is
 * compared field by field — so a null reason or a null cost matches only a
 * null, and an adjustment with a reason never matches one without.
 */
export function matchesAdjustment(request: StockAdjustment, recorded: StockMovement): boolean {
  if (request.itemId !== recorded.itemId) return false;
  if (request.kind !== recorded.kind) return false;
  if (request.delta !== recorded.delta) return false;
  if (request.unitCost !== undefined && request.unitCost !== recorded.unitCost) return false;
  if (request.reason !== recorded.reason) return false;
  // a server-stamped date is not part of the identity; a caller-supplied one is
  return request.occurredAt === null || request.occurredAt === recorded.occurredAt;
}
