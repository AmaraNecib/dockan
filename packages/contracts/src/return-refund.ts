/**
 * Refund arithmetic for returns — shared by the api and the web bundle.
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
 *
 * This lives in `@dokan/contracts` rather than the api because BOTH sides need
 * it: the api prices the persisted refund, and the invoice screen previews the
 * same figure before submit. The preview was once restated client-side and
 * drifted on the COMPLETING return — net 101 over 3 units refunds 34 then 67,
 * never 34 + 34 = 68 — so the owner was promised one DZD more cash than the
 * server would settle. One implementation, two callers, no mirror to drift.
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

// ---------------------------------------------------------------------------
// #256 — which refund method a return DEFAULTS to.
// ---------------------------------------------------------------------------

export interface ReturnSettlementDefaultInput {
  /** whole DZD the return is worth (what has to be settled somehow) */
  returnValue: number;
  /** the remaining debt on the invoice the return is recorded against — the
   * only debt this return record can relieve (the accepted offset is applied
   * to that invoice, and the invoice header reconciles it via returnCredit) */
  invoiceDebt: number;
  /** the party's total outstanding debt across every invoice, or null while
   * that read has not resolved yet (the web preview reads it separately) */
  partyDebt: number | null;
}

/** Why the default could not pick a method: the return outgrew the debt that
 * could absorb it here, or the party's debt lives on other invoices (applying
 * a return across invoices is an owner decision that is still open). */
export type ReturnSettlementDefaultReason = "EXCEEDS_DEBT" | "DEBT_ELSEWHERE";

export type ReturnSettlementDefault =
  | { method: "DEBT" }
  | { method: "CASH" }
  | { method: "UNDECIDED"; reason: ReturnSettlementDefaultReason }
  | { method: "UNRESOLVED" };

/**
 * The owner's rule (#256): default the refund to the party's debt, cash only
 * when there is no debt. Debt-first is decided by ONE test — can this invoice's
 * remaining debt absorb the whole return? When it can, all of it goes to the
 * debt. When it cannot, the default REFUSES rather than guessing a split:
 * either the return outgrew the party's whole debt, or the debt sits on another
 * invoice the return cannot reach (`EXCEEDS_DEBT` / `DEBT_ELSEWHERE` — the two
 * owner questions this scope deliberately left open). A refusal is safe because
 * the owner can always pick cash or a custom split explicitly; a silent
 * debt/cash split on money is not.
 */
export function returnSettlementDefault(input: ReturnSettlementDefaultInput): ReturnSettlementDefault {
  // the invoice's own debt answers it alone — no party read needed
  if (input.returnValue <= input.invoiceDebt) return { method: "DEBT" };
  // past here the answer depends on the party's tab, which may not have loaded
  if (input.partyDebt === null) return { method: "UNRESOLVED" };
  if (input.partyDebt <= 0) return { method: "CASH" };
  return { method: "UNDECIDED", reason: input.invoiceDebt <= 0 ? "DEBT_ELSEWHERE" : "EXCEEDS_DEBT" };
}
