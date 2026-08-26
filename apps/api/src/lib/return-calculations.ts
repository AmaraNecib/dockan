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

/**
 * Compute every line's refund plus the record total. Pure and deterministic.
 *
 * Quantities are CONSOLIDATED by invoiceLineId FIRST — split entries of the
 * same line (e.g. a request with [qty 2, qty 1] of one 3-unit line) are
 * priced once.
 *
 * Pricing is SEQUENCE-AWARE per line: `prior` carries what earlier returns on
 * the same line already refunded (quantity + whole-DZD amount). A partial
 * return prices at `qty × round(net/sold)`, capped so the cumulative refund
 * can never exceed the line's net; the COMPLETING return — the one that
 * returns the last unreturned units (prior + this request's qty = sold) —
 * settles the exact remainder `net − alreadyRefunded`, rounding only at the
 * last partial. Consequence: qty 1 then qty 2 on a 101-DZD/3-unit line
 * settles 34 then 67 — 101 exactly, never 34 + 68 = 102.
 */
export function computeReturnRefund(
  lines: readonly ReturnRefundLineInput[],
  prior?: ReadonlyMap<string, { quantity: number; refundAmount: number }>,
): ReturnRefundComputation {
  const consolidated = new Map<string, ReturnRefundLineInput & { quantity: number }>();
  for (const line of lines) {
    const existing = consolidated.get(line.invoiceLineId);
    if (existing === undefined) {
      consolidated.set(line.invoiceLineId, { ...line });
    } else {
      consolidated.set(line.invoiceLineId, { ...existing, quantity: existing.quantity + line.quantity });
    }
  }
  const result = [...consolidated.values()].map((line) => {
    const refundUnitPrice = refundUnitPriceFor(line.netTotal, line.lineQuantity);
    const priorQty = prior?.get(line.invoiceLineId)?.quantity ?? 0;
    const priorRefund = prior?.get(line.invoiceLineId)?.refundAmount ?? 0;
    const remaining = Math.max(0, line.netTotal - priorRefund);
    // completing return: every unreturned unit comes back — settle the exact
    // remainder so the line's cumulative refund is netTotal precisely
    const completing = priorQty + line.quantity >= line.lineQuantity;
    const refundAmount = completing ? remaining : Math.min(line.quantity * refundUnitPrice, remaining);
    return {
      invoiceLineId: line.invoiceLineId,
      quantity: line.quantity,
      refundUnitPrice,
      refundAmount,
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