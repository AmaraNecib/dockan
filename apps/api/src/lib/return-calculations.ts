/**
 * Pure returns math (seam 1). No IO, no clocks — every function takes line
 * facts and already-returned quantities as data and returns derived values.
 * The router owns persistence and validation; this module only does whole-DZD
 * refund arithmetic and the per-line cap bookkeeping, so money decisions are
 * unit-testable without SQL.
 *
 * Refund basis (documented decision): the customer gets back, per returned
 * unit, the effective per-unit amount they actually paid — the line's net
 * total (gross minus the allocated invoice-discount share) divided by its
 * SOLD quantity, rounded to whole DZD like every other money figure in the
 * app. A FULL-line return is the exact special case: when every sold unit
 * comes back, the refund is the line's net total precisely (round-half drift
 * would refund a DZD the customer never paid). A line's partial refund is
 * quantity × that unit; the record total is the sum. Refunding at the
 * pre-discount unitPrice instead would over-refund whenever the invoice
 * carried a discount.
 */

export interface ReturnRefundLineInput {
  invoiceLineId: string;
  /** the line's net amount the customer paid (whole DZD) */
  netTotal: number;
  /** units SOLD on the invoice line — the denominator of the effective
   * per-unit price (a partial return divides by the sold count, not the
   * returned count, so refundUnitPrice matches what the customer paid) */
  lineQuantity: number;
  /** units being returned (≤ lineQuantity) */
  quantity: number;
}

export interface ReturnLineRefund {
  invoiceLineId: string;
  quantity: number;
  /** whole-DZD per-unit refund: round(netTotal / quantity) */
  refundUnitPrice: number;
  /** quantity × refundUnitPrice */
  refundAmount: number;
}

export interface ReturnRefundComputation {
  lines: ReturnLineRefund[];
  /** whole DZD the shop hands back */
  refundTotal: number;
}

/** Effective per-unit price the customer paid, rounded to whole DZD. */
export function refundUnitPriceFor(netTotal: number, lineQuantity: number): number {
  if (!Number.isInteger(lineQuantity) || lineQuantity <= 0) throw new Error("line quantity must be a positive integer");
  if (!Number.isFinite(netTotal) || netTotal < 0) throw new Error("net total must be a non-negative whole DZD amount");
  return Math.round(netTotal / lineQuantity);
}

/**
 * The whole-DZD refund for `quantity` returned units of one line. A full
 * return (every sold unit back) refunds the line's net total EXACTLY — the
 * round-half-up unit price could otherwise refund one DZD the customer never
 * paid (e.g. net 101 over 3 units). Partial returns price at the rounded
 * effective unit price.
 */
export function lineRefundAmount(quantity: number, netTotal: number, lineQuantity: number): number {
  if (quantity === lineQuantity) return netTotal;
  return quantity * refundUnitPriceFor(netTotal, lineQuantity);
}

/** Compute every line's refund plus the record total. Pure and deterministic. */
export function computeReturnRefund(lines: readonly ReturnRefundLineInput[]): ReturnRefundComputation {
  const result = lines.map((line) => {
    const refundUnitPrice = refundUnitPriceFor(line.netTotal, line.lineQuantity);
    return {
      invoiceLineId: line.invoiceLineId,
      quantity: line.quantity,
      refundUnitPrice,
      refundAmount: line.quantity === line.lineQuantity ? line.netTotal : line.quantity * refundUnitPrice,
    };
  });
  const refundTotal = result.reduce((sum, line) => sum + line.refundAmount, 0);
  return { lines: result, refundTotal };
}

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