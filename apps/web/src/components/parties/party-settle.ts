import type { Invoice } from "@dokan/contracts";

/**
 * #164 (customer half) — the pure half of the in-page settlement: which
 * invoices are still owed, the unpaid total, and how a payment spreads over
 * them. Kept free of React and the rpc seam so the ordering and the per-invoice
 * cap are unit-tested directly.
 */

/** Invoices with something still owed, in the order the api returned them. */
export function unpaidInvoices(invoices: readonly Invoice[]): Invoice[] {
  return invoices.filter((invoice) => invoice.remainingAmount > 0);
}

/** Whole-DZD sum of every unpaid invoice's remaining. */
export function unpaidTotal(invoices: readonly Invoice[]): number {
  return unpaidInvoices(invoices).reduce((sum, invoice) => sum + invoice.remainingAmount, 0);
}

export interface DistributionLine {
  invoice: Invoice;
  /** whole DZD applied to this invoice; never above its remaining */
  applied: number;
}

/**
 * Spread `amount` over the unpaid invoices, **oldest first** (invoice date,
 * then creation, then id — all deterministic). Each invoice takes at most its
 * remaining, so the payment can never exceed what is owed; the tail of an
 * oversized amount is simply left undistributed (`sum(applied) <= amount`).
 * The preview and the persisted per-invoice payments both read this one plan.
 */
export function distributePayment(invoices: readonly Invoice[], amount: number): DistributionLine[] {
  const ordered = [...unpaidInvoices(invoices)].sort((a, b) => {
    if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  let left = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;
  return ordered.map((invoice) => {
    const applied = Math.min(invoice.remainingAmount, left);
    left -= applied;
    return { invoice, applied };
  });
}

/** The settle amount's boundary: digits-only whole DZD, 1..max. */
export function settleAmountError(draft: string, max: number): "INVALID" | "EXCEEDS" | null {
  const trimmed = draft.trim();
  if (!/^\d+$/u.test(trimmed)) return "INVALID";
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return "INVALID";
  if (value > max) return "EXCEEDS";
  return null;
}
