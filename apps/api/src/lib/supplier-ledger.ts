/**
 * Pure supplier-account math (issue 161). No IO, no clocks. The router owns
 * persistence and validation; this module owns the signed-ledger arithmetic,
 * the oldest-first allocation, the excess-to-credit split, and the invoice
 * paid/remaining derivation, so every money decision is unit-testable without
 * SQL.
 */

/** #258 — the number format lives in one place: a legacy INV-0001 and a new
 * SUP-0002 order by their trailing digits. */
import { documentNumberSequence as invoiceSequence } from "./document-number";

export type SupplierEntryKind = "PURCHASE" | "PAYMENT" | "RETURN" | "REFUND" | "ADJUSTMENT";

/** The direction of a manual adjustment (issue 176). «نسالوه» = the shop owes
 * the supplier more; «يسالنا» = the shop owes less / moves toward credit. */
export type SupplierAdjustmentDirection = "WE_OWE" | "THEY_OWE";

/** The sign one entry kind contributes to the supplier balance.
 * Positive = the shop owes the supplier; negative = the shop is ahead. An
 * ADJUSTMENT's sign comes from its direction, so a missing one is refused
 * rather than guessed (a wrongly-signed money row is worse than an error). */
export function supplierEntrySign(
  kind: SupplierEntryKind,
  direction: SupplierAdjustmentDirection | null = null,
): 1 | -1 {
  if (kind === "ADJUSTMENT") {
    if (direction === "WE_OWE") return 1;
    if (direction === "THEY_OWE") return -1;
    throw new Error("a supplier adjustment entry needs a direction");
  }
  return kind === "PURCHASE" || kind === "REFUND" ? 1 : -1;
}

/** The signed balance of a supplier account: Σ amount × sign(kind). */
export function supplierBalance(
  entries: readonly { kind: SupplierEntryKind; amount: number; direction?: SupplierAdjustmentDirection | null }[],
): number {
  return entries.reduce((sum, entry) => sum + supplierEntrySign(entry.kind, entry.direction ?? null) * entry.amount, 0);
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

/**
 * #181 — one adjustment's dedup identity, shared by the guarded write, the
 * duplicate guard, and the DB backfill so they can never drift. When
 * `idempotencyKey` is present the computed key is `key:[supplierId, key]`;
 * otherwise it is the #177 signature, where `serverStamped` drops the timestamp
 * because the server minted it and a retry cannot be told apart by time. `ref`
 * is part of neither form.
 */
export type AdjustmentDedupInput = {
  supplierId: string;
  direction: SupplierAdjustmentDirection;
  amount: number;
  reason: string | null;
  occurredAt: string;
  invoiceId: string | null;
  /** #177 — true when the server stamped `occurredAt` because the caller omitted it */
  serverStamped?: boolean;
  /** #181 — an explicit client idempotency key; when present the computed key is
   * this key (the guard still keeps the #177 signature as a backstop) */
  idempotencyKey?: string | null;
};

/**
 * The canonical dedup key of a manual adjustment. JSON encodes the tuple, so a
 * null column and an empty string stay distinct and no caller text can forge a
 * separator; the `key:` / `sig:` prefixes keep the two namespaces apart. A key
 * is scoped to the account, exactly like the signature is. `ref` is in neither
 * form, so changing it never changes the key.
 */
export function adjustmentDedupKey(input: AdjustmentDedupInput): string {
  if (hasExplicitIdempotencyKey(input)) {
    // hasExplicitIdempotencyKey proved a trimmed non-empty value exists
    return `key:${JSON.stringify([input.supplierId, (input.idempotencyKey ?? "").trim()])}`;
  }
  return `sig:${JSON.stringify([
    input.supplierId,
    input.direction,
    input.amount,
    input.reason,
    input.invoiceId,
    input.serverStamped === true ? null : input.occurredAt,
  ])}`;
}

/**
 * True when the caller sent a usable explicit key (trimmed, non-empty). The
 * guard and `adjustmentDedupKey` share this one predicate, so the key branch
 * cannot be entered on one side and not the other.
 */
export function hasExplicitIdempotencyKey(input: { idempotencyKey?: string | null }): boolean {
  const idempotencyKey = input.idempotencyKey?.trim();
  return idempotencyKey !== undefined && idempotencyKey !== "";
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
