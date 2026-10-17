/**
 * Pure returns math that is NOT shared with the web bundle (seam 1). No IO, no
 * clocks — every function takes line facts and already-returned quantities as
 * data and returns derived values. The router owns persistence and validation;
 * this module does the per-line cap bookkeeping and the profit report's booked
 * attribution, so money decisions are unit-testable without SQL.
 *
 * The refund arithmetic itself now lives in `@dokan/contracts`
 * (`return-refund.ts`) because the invoice screen previews the same figure the
 * api prices. It used to be restated client-side and drifted on the completing
 * return; re-exported here so existing callers and tests keep this import path.
 */

export {
  compareInvoicesOldestFirst,
  computeReturnRefund,
  derivedRefundSplit,
  explicitRefundSplit,
  lineRefundAmount,
  refundUnitPriceFor,
  returnSettlementDefault,
  sortInvoicesOldestFirst,
  type OldestFirstInvoiceKey,
  type ReturnLineRefund,
  type ReturnRefundComputation,
  type ReturnRefundLineInput,
  type ReturnRefundSplit,
  type ReturnSettlementDefault,
  type ReturnSettlementDefaultInput,
} from "@dokan/contracts";

/** What a line can still return today: sold minus already returned, floored at 0. */
export function remainingReturnable(sold: number, alreadyReturned: number): number {
  return Math.max(0, sold - alreadyReturned);
}

export interface ReturnCapViolation {
  invoiceLineId: string;
  requested: number;
  remaining: number;
}

/**
 * Per-original-line return aggregates the profit report needs (the store
 * reads them; this module turns them into booked revenue/COGS).
 */
export interface SaleLineReturnStats {
  /** returned quantity under PENDING or ACCEPTED returns (goods held in inventory) */
  heldQty: number;
  /** returned quantity under REJECTED returns */
  rejectedQty: number;
  /** of the rejected quantity, the units the reject physically SCRAPPED — the
   * still-on-hand portion at review time (the clamp never scraps resold units) */
  rejectedScrapQty: number;
}

/** A SALE line's booked revenue/COGS after returns (whole DZD). */
export interface BookedSaleLine {
  bookedQty: number;
  netTotal: number;
  cogsExact: number;
}

/**
 * Whole-DZD revenue/COGS a SALE line books AFTER returns.
 *
 * Per unit of the original line:
 * - held (pending/accepted) returns UN-book the unit: the goods are back in
 *   inventory, or will be rebooked by a later sale.
 * - rejected returns un-book only the RESOLD units (rejectedQty −
 *   rejectedScrapQty): those are a completed sale cycle booked by the RESALE
 *   invoice, so keeping them in the original line too would double-book
 *   revenue+COGS. The SCRAPPED-now units stay booked in the original line —
 *   scrapping is a realized cost of that sale, which is exactly what keeps a
 *   rejected freebie's loss visible (a fully-scrapped return has scrap = its
 *   whole quantity, so the line keeps booking).
 *
 * bookedQty = sold − heldReturned − (rejectedReturned − rejectedScrap). When
 * it reaches 0 the line is excluded entirely (exact); when it is less than the
 * sold count the line's revenue/COGS scale proportionally with ONE whole-DZD
 * rounding (only reachable in the reject-resale case) — otherwise the exact
 * cogsExact / netTotal pass through untouched.
 */
export function bookSaleLineForReturns(
  line: { quantity: number; netTotal: number; cogsExact: number },
  stats: SaleLineReturnStats,
): BookedSaleLine {
  const resold = Math.max(0, stats.rejectedQty - stats.rejectedScrapQty);
  const bookedQty = line.quantity - stats.heldQty - resold;
  if (bookedQty <= 0) return { bookedQty: 0, netTotal: 0, cogsExact: 0 } satisfies BookedSaleLine;
  if (bookedQty >= line.quantity) {
    // the whole line stands: exact snapshots, no drift
    return { bookedQty, netTotal: line.netTotal, cogsExact: line.cogsExact } satisfies BookedSaleLine;
  }
  return {
    bookedQty,
    netTotal: Math.round((line.netTotal * bookedQty) / line.quantity),
    cogsExact: Math.round((line.cogsExact * bookedQty) / line.quantity),
  } satisfies BookedSaleLine;
}

/**
 * First over-return violation in a request, or null when every requested line
 * stays inside its cap. This is the "sold − already returned" bound of the
 * spec: each return references its original invoice line, so an item with
 * several lines on one invoice is capped line-by-line (the sharpest bound).
 * Entries for the same line accumulate WITHIN the request too, so a pair of
 * [l:2, l:2] against a line that sold 3 is refused even though each entry
 * alone fits.
 */
export function returnCapViolation(
  requested: readonly { invoiceLineId: string; quantity: number }[],
  lines: readonly { id: string; quantity: number }[],
  alreadyReturned: ReadonlyMap<string, number>,
): ReturnCapViolation | null {
  const byLine = new Map(lines.map((line) => [line.id, line]));
  const requestedByLine = new Map<string, number>();
  for (const entry of requested) {
    requestedByLine.set(entry.invoiceLineId, (requestedByLine.get(entry.invoiceLineId) ?? 0) + entry.quantity);
  }
  for (const [invoiceLineId, quantity] of requestedByLine) {
    const line = byLine.get(invoiceLineId);
    if (line === undefined) continue; // unknown line is the router's job
    const remaining = remainingReturnable(line.quantity, alreadyReturned.get(invoiceLineId) ?? 0);
    if (quantity > remaining) {
      return { invoiceLineId, requested: quantity, remaining };
    }
  }
  return null;
}