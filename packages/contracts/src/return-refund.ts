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
  /** the remaining debt on the invoice the return is recorded against */
  invoiceDebt: number;
  /** the party's total outstanding debt across every invoice, or null while
   * that read has not resolved yet (the web preview reads it separately) */
  partyDebt: number | null;
}

export type ReturnSettlementDefault =
  | { method: "DEBT" }
  | { method: "SPLIT"; debtOffset: number; cashPaidOut: number }
  | { method: "CASH" }
  | { method: "UNRESOLVED" };

/**
 * The owner's rule (#256), as APPROVED in round 2
 * (`.scratch/notes/decisions-money-ar.html`): the default takes the refund off
 * the party's DEBT, and comes back as cash only when he owes nothing.
 *
 * The debt is the party's whole tab — "in this invoice or in another invoice"
 * (the owner's words), so this invoice's own debt is not the bound:
 *
 * - the tab covers the return → `DEBT`: the whole return reduces the debt, and
 *   the api allocates it across the party's open invoices oldest-first;
 * - the return exceeds the tab → `SPLIT`: the tab goes to zero and the rest is
 *   handed back as cash (his example: debt 4 000, return 5 000 → 4 000 off the
 *   debt, 1 000 cash);
 * - nothing owed anywhere → `CASH`.
 *
 * Round 2 replaced the round-1 refusals (`UNDECIDED` / `EXCEEDS_DEBT` /
 * `DEBT_ELSEWHERE`) with those two answers; nothing is refused any more. A
 * `returnValue` of 0 is always `DEBT` — there is no split to decide, and a
 * zero-value return must never be blocked.
 */
export function returnSettlementDefault(input: ReturnSettlementDefaultInput): ReturnSettlementDefault {
  // the invoice's own debt answers it alone — no party read needed
  if (input.returnValue <= input.invoiceDebt) return { method: "DEBT" };
  // past here the answer depends on the party's tab, which may not have loaded
  if (input.partyDebt === null) return { method: "UNRESOLVED" };
  // SAFETY: the party read is a sum that includes this invoice, but a caller
  // that hands in only the other invoices' debt must still get the bound right
  const debt = Math.max(input.invoiceDebt, input.partyDebt);
  if (debt <= 0) return { method: "CASH" };
  if (input.returnValue <= debt) return { method: "DEBT" };
  return { method: "SPLIT", debtOffset: debt, cashPaidOut: input.returnValue - debt };
}

/** The two money numbers a return record stores. */
export interface ReturnRefundSplit {
  /** taken off the debt; settled when the owner accepts the return (#68) */
  debtOffset: number;
  /** handed to the customer now */
  cashPaidOut: number;
}

/**
 * The derived default's numbers, or null while the party read has not landed
 * (the web previews nothing then; the api's debt read is synchronous, so it
 * never sees `UNRESOLVED`). `cashPaidOut + debtOffset` always equals
 * `returnValue`.
 */
export function derivedRefundSplit(settlement: ReturnSettlementDefault, returnValue: number): ReturnRefundSplit | null {
  switch (settlement.method) {
    case "DEBT":
      return { debtOffset: returnValue, cashPaidOut: 0 };
    case "CASH":
      return { debtOffset: 0, cashPaidOut: returnValue };
    case "SPLIT":
      return { debtOffset: settlement.debtOffset, cashPaidOut: settlement.cashPaidOut };
    case "UNRESOLVED":
      return null;
  }
}

/**
 * The owner's EXPLICIT choice (a `cashPaidOut` was sent): the debt takes what
 * the cash does not cover, capped at THIS invoice's remaining — #162's warned
 * cap, where the excess swings back to cash. Unchanged by #256, which only
 * changed what the app picks when the owner does not. One implementation, so
 * the api's write and the web's preview cannot disagree.
 */
export function explicitRefundSplit(input: { returnValue: number; cashPaidOut: number; invoiceDebt: number }): ReturnRefundSplit {
  const cash = Math.max(0, Math.min(input.cashPaidOut, input.returnValue));
  const debtOffset = Math.min(Math.max(0, input.returnValue - cash), Math.max(0, input.invoiceDebt));
  return { debtOffset, cashPaidOut: input.returnValue - debtOffset };
}

// ---------------------------------------------------------------------------
// Allocation order — the convention the payment panel already applies (#164).
// ---------------------------------------------------------------------------

/** The invoice fields the oldest-first order needs (structural, so a lean row reads too). */
export interface OldestFirstInvoiceKey {
  id: string;
  invoiceDate: string;
  createdAt: string;
  invoiceNumber: string;
}

/**
 * Oldest first: invoice date, then creation, then the invoice number's numeric
 * sequence, then id — all deterministic. `createdAt` has second precision, so
 * two invoices created in the same second would otherwise fall to a random
 * UUID and take the money in a different order on different runs; the number's
 * sequence is the tie-break that actually reflects creation order (`INV-0010`
 * must sort after `INV-0009`, so it is compared numerically, not lexically).
 * Lives here, next to the refund arithmetic, because BOTH the payment panel and
 * the api's cross-invoice refund allocation must call the one comparator.
 */
export function compareInvoicesOldestFirst(a: OldestFirstInvoiceKey, b: OldestFirstInvoiceKey): number {
  if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  const sequence = invoiceSequence(a.invoiceNumber) - invoiceSequence(b.invoiceNumber);
  if (sequence !== 0) return sequence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A sorted COPY (the caller's array is never reordered in place). */
export function sortInvoicesOldestFirst<T extends OldestFirstInvoiceKey>(invoices: readonly T[]): T[] {
  return [...invoices].sort(compareInvoicesOldestFirst);
}

/** The trailing number of an INV-%04d number; a non-numeric number sorts as 0. */
function invoiceSequence(invoiceNumber: string): number {
  const digits = /(\d+)\s*$/u.exec(invoiceNumber);
  return digits === null ? 0 : Number(digits[1]);
}
