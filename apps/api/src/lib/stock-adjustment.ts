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
 * The window covers the two threats and nothing more: a double-clicked save
 * (under a second) and a lost response re-sent as the same action (the
 * #115 rule — the API is loopback, so a lost connection fails fast and the
 * retry lands in the same second or the next).
 *
 * It is deliberately short. A typed second adjustment takes a few seconds,
 * not thirty, so a wide window would refuse a deliberate second batch of the
 * same item — and the way past that refusal (a different reason) writes a
 * reason the owner only typed to get past the guard into the ledger. Ten
 * seconds keeps the guard on the threats and lets an owner who means it
 * twice simply do it a moment later.
 */
export const REPEAT_WINDOW_MS = 10_000;

/** The fields that make two stock adjustments the same action. */
export interface StockAdjustment {
  readonly itemId: string;
  readonly kind: MovementKind;
  /** signed quantity: positive = stock in, negative = stock out */
  readonly delta: number;
  /**
   * The unit cost the request expressed, or undefined when it expressed
   * nothing the server would not have derived (an inflow at the item's cost,
   * or an outflow — the seam records those costless). undefined means "not
   * part of the identity".
   */
  readonly unitCost: number | undefined;
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
 * The cost is part of the identity only when it carries information the
 * server would not have derived on its own:
 *
 *   - an outflow is recorded costless by the posting seam, so its cost says
 *     nothing;
 *   - an inflow with no cost means "at the item's cost";
 *   - an inflow whose cost IS the item's current cost says the same thing
 *     the server would have derived — and the web pre-fills the cost field
 *     with exactly that number, so a retry after the average moved would
 *     otherwise carry a different cost and slip past the guard.
 *
 * A cost of the owner's own (different from the current one) is part of the
 * identity: "add five at 300" is not "add five".
 */
export function expressUnitCost(
  delta: number,
  unitCost: number | null | undefined,
  derivedCost: number
): number | undefined {
  if (delta < 0) return undefined;
  if (unitCost === undefined) return undefined;
  if (unitCost === null) return undefined;
  if (unitCost === derivedCost) return undefined;
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
