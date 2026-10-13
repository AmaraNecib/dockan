/**
 * Pure supplier-account math (issue 161). No IO, no clocks. The router owns
 * persistence and validation; this module owns the signed-ledger arithmetic,
 * the oldest-first allocation, the excess-to-credit split, and the invoice
 * paid/remaining derivation, so every money decision is unit-testable without
 * SQL.
 */

export type SupplierEntryKind = "PURCHASE" | "PAYMENT" | "RETURN" | "REFUND";

/** The sign one entry kind contributes to the supplier balance.
 * Positive = the shop owes the supplier; negative = the shop is ahead. */
export function supplierEntrySign(kind: SupplierEntryKind): 1 | -1 {
  return kind === "PURCHASE" || kind === "REFUND" ? 1 : -1;
}

/** The signed balance of a supplier account: Σ amount × sign(kind). */
export function supplierBalance(entries: readonly { kind: SupplierEntryKind; amount: number }[]): number {
  return entries.reduce((sum, entry) => sum + supplierEntrySign(entry.kind) * entry.amount, 0);
}

/** How much of `amount` fits an invoice that still owes `remaining`; the rest
 * becomes credit. Both operands are whole DZD, non-negative. */
export function splitAgainstRemaining(amount: number, remaining: number) {
  const attached = Math.max(0, Math.min(amount, remaining));
  return { attached, credit: amount - attached };
}

/** How much cash the shop may still receive from the supplier: the size of
 * the credit (a negative balance), never a positive amount. A refund or a
 * return's cash-back may not exceed this. */
export function availableSupplierCredit(balance: number): number {
  return Math.max(0, -balance);
}

/** The charge a purchase opens on the supplier account, or null when the
 * invoice is free: the ledger's `CHECK (amount > 0)` would reject a zero-value
 * entry, and a free purchase still must save with its stock intake. */
export function supplierChargeEntryAmount(totalAmount: number): number | null {
  return totalAmount > 0 ? totalAmount : null;
}

export interface AllocatableInvoice {
  id: string;
  invoiceDate: string;
  createdAt: string;
  invoiceNumber: string;
  remainingAmount: number;
}

export interface Allocation {
  invoice: AllocatableInvoice;
  /** whole DZD applied to this invoice; never above its remaining */
  applied: number;
}

/** The trailing digits of an INV-%04d number; a non-numeric number sorts as 0. */
function invoiceSequence(invoiceNumber: string): number {
  const digits = /(\d+)\s*$/u.exec(invoiceNumber);
  return digits === null ? 0 : Number(digits[1]);
}

/**
 * Spread `amount` over the still-owed invoices, **oldest first** (invoice date,
 * then creation, then the numeric invoice number, then id — all deterministic).
 * Each invoice takes at most its remaining, so an allocation can never exceed
 * what is owed; the tail of an oversized amount is left undistributed (it
 * becomes the supplier credit). Mirrors the customer-side distribution so both
 * directions settle the same way.
 */
export function allocateOldestFirst(invoices: readonly AllocatableInvoice[], amount: number): Allocation[] {
  const ordered = [...invoices]
    .filter((invoice) => invoice.remainingAmount > 0)
    .sort((a, b) => {
      if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? -1 : 1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      const sequence = invoiceSequence(a.invoiceNumber) - invoiceSequence(b.invoiceNumber);
      if (sequence !== 0) return sequence;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  let left = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;
  return ordered.map((invoice) => {
    const applied = Math.min(invoice.remainingAmount, left);
    left -= applied;
    return { invoice, applied };
  });
}

/**
 * The invoice's paid amount derived from the PAYMENT entries that name it,
 * capped at the invoice total. A purchase return does not count as "paid"
 * money: it is surfaced separately as `returnCreditAmount` on the invoice
 * detail, so the printed header reconciles as `total − paid − returnCredit =
 * remaining` (the same shape the sale side uses). The store writes the cache
 * through a conditional UPDATE, and a store test proves the two agree.
 */
export function deriveInvoicePaid(
  entries: readonly { kind: SupplierEntryKind; amount: number; invoiceId: string | null }[],
  invoiceId: string,
  totalAmount: number,
): number {
  const paid = entries
    .filter((entry) => entry.invoiceId === invoiceId && entry.kind === "PAYMENT")
    .reduce((sum, entry) => sum + entry.amount, 0);
  return Math.min(totalAmount, Math.max(0, paid));
}

/**
 * How a purchase return's value settles: the part that can still reduce the
 * invoice's remaining debt, and the part that becomes supplier credit. When the
 * return names no invoice, everything is credit.
 */
export function supplierReturnSplit(
  returnValue: number,
  invoiceRemaining: number | null,
) {
  if (invoiceRemaining === null) return { debtReduction: 0, credit: returnValue };
  const debtReduction = Math.max(0, Math.min(returnValue, invoiceRemaining));
  return { debtReduction, credit: returnValue - debtReduction };
}
