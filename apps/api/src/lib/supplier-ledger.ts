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
import type { SupplierEntryKind } from "@dokan/contracts";

/** The wire union, imported rather than restated. It was hand-declared here, and
 * that copy is what the table's `satisfies` checked — so adding a kind to
 * `supplierEntryKinds` left this table silently unexhaustive: the compiler
 * complained at seven assignment sites instead of naming the missing row, and a
 * reader could satisfy those without ever opening the table. The guard is only a
 * guard when it keys off the union every other package already reads. */
export type { SupplierEntryKind } from "@dokan/contracts";

/** The direction of a manual adjustment (issue 176). «يسالنا» (WE_OWE) = he asks
 * us: the shop owes the supplier more, money leaves us; «نسالوه» (THEY_OWE) = we
 * ask him: the shop owes less / moves toward credit. */
export type SupplierAdjustmentDirection = "WE_OWE" | "THEY_OWE";

/**
 * What ONE entry kind means to the supplier balance (#317): the sign it always
 * carries, or — for a kind whose sign is the row's own decision — the sign per
 * direction together with the fact that a direction is REQUIRED.
 *
 * This is the single rule both readers consume: `supplierEntrySign` looks it up
 * here, and `drizzle-store.ts` generates its SQL from this same table at module
 * load. Adding a kind, or changing a sign, is one edit that both obey — the two
 * readers cannot drift by editing one and not the other.
 */
export type SupplierEntryRule =
  | { directionRequired: false; sign: 1 | -1 }
  | { directionRequired: true; directions: Readonly<Record<SupplierAdjustmentDirection, 1 | -1>> };

/**
 * The rule table. Sign convention (#260): **positive = the supplier owes us** (we
 * hold a credit), **negative = we owe the supplier**. The sign describes the
 * direction of the BALANCE, not a cash movement: a balance of −1000 means we owe
 * him 1000, which may settle later by offsetting a future invoice with no cash
 * involved at all. So WE_OWE (money leaves us) is −1 and THEY_OWE (money comes to
 * us) is +1, and every kind negates with it: a PURCHASE makes us owe (negative), a
 * PAYMENT reduces that debt (positive).
 *
 * `satisfies Record<SupplierEntryKind, …>` makes the compiler refuse a kind that
 * has no rule, and `SUPPLIER_ENTRY_KINDS` is derived from the table rather than
 * typed a second time.
 */
export const SUPPLIER_ENTRY_RULES = {
  PURCHASE: { directionRequired: false, sign: -1 },
  PAYMENT: { directionRequired: false, sign: 1 },
  RETURN: { directionRequired: false, sign: 1 },
  REFUND: { directionRequired: false, sign: -1 },
  // a wrongly-signed money row is worse than an error, so a missing direction is
  // refused rather than defaulted (issue 176, #317)
  ADJUSTMENT: { directionRequired: true, directions: { WE_OWE: -1, THEY_OWE: 1 } },
} as const satisfies Record<SupplierEntryKind, SupplierEntryRule>;

/** Every entry kind, read out of the rule table so a new kind cannot be added to
 * the union and forgotten by a loop or a caller. */
// SAFETY: the table is declared `satisfies Record<SupplierEntryKind, …>`, so its
// keys are exactly the union's members; only the readonly view needs asserting.
const SUPPLIER_ENTRY_KIND_LIST = Object.keys(SUPPLIER_ENTRY_RULES) as readonly SupplierEntryKind[];
export { SUPPLIER_ENTRY_KIND_LIST as SUPPLIER_ENTRY_KINDS };

/**
 * The rule for one kind, or undefined when the table has none.
 *
 * The parameter is a plain `string` on purpose: no CHECK restricts
 * `supplier_account_entries.kind` to these five values (`db/schema.ts` constrains
 * only that an ADJUSTMENT carries a direction), so a row the write seams cannot
 * produce but a migrated database can hold reaches the fold as any text at all.
 * A caller typed against `SupplierEntryKind` still widens here, so an unknown
 * kind is a refusal rather than a crash.
 *
 * `Object.hasOwn`, never `in` or a bare index: the table is an object literal, so
 * a miss would otherwise answer with `Object.prototype`'s `toString` and hand an
 * object where a rule belongs.
 */
export function supplierEntryRule(kind: string): SupplierEntryRule | undefined {
  if (!Object.hasOwn(SUPPLIER_ENTRY_RULES, kind)) return undefined;
  // SAFETY: Object.hasOwn proved the key is one of the table's own keys, and the
  // table satisfies Record<SupplierEntryKind, …>, so those keys are exactly the
  // union's members.
  return SUPPLIER_ENTRY_RULES[kind as SupplierEntryKind];
}

/** What a refusal observed. Every field is optional because the readers know
 * different amounts: the fold has the row, the SQL aggregate has only the account
 * it grouped. Nothing here is inferred — a field is OMITTED when the read did not
 * see it, and null when the read saw a row that carried no value. The message
 * reads those two apart (`(unread by this read)` versus `(none)`), so a refusal
 * never sends the owner to a row it never looked at, and never reports an
 * absence it did not observe either. */
export type UnsignableSupplierEntryRefusal = {
  /** the row's kind, or null when the read could not name one (the SQL aggregate) */
  kind?: string | null;
  /** the direction the row carried; null when the fold saw a row carrying none,
   * omitted when the read never saw the row */
  direction?: string | null;
  /** the entry, when the caller has the row in hand */
  entryId?: string | null;
  /** the account the un-signable row belongs to */
  supplierId?: string | null;
};

/**
 * The typed refusal for a row the rule table cannot sign: an unknown kind (the
 * column has no CHECK), an ADJUSTMENT with no usable direction, or a direction
 * that is not one the table defines. It names what the reader observed — the
 * kind, the direction it got, the entry and the supplier where they are known —
 * so the data can be fixed instead of guessed at. Both readers throw THIS class
 * (#317), so a direction-less row fails every screen together rather than signing
 * negative on one and throwing on another.
 */
export class UnsignableSupplierEntryError extends Error {
  readonly kind: string | null;
  /** the direction the read observed, null when it observed none OR when it never
   * saw the row; `message` says which of the two, because a field alone cannot */
  readonly direction: string | null;
  readonly entryId: string | null;
  readonly supplierId: string | null;

  constructor(refusal: UnsignableSupplierEntryRefusal = {}) {
    const entry = refusal.entryId ?? null;
    const supplier = refusal.supplierId ?? null;
    const kind = refusal.kind ?? null;
    // an OMITTED direction is a read that never saw the row; a null one is a row
    // that carried none. Reporting the second when the first happened is the same
    // invented observation as naming a kind the read did not see (#329 round 2).
    const direction =
      refusal.direction === undefined ? "(unread by this read)" : (refusal.direction ?? "(none)");
    super(
      `supplier account entry ${entry ?? "(no id)"}${supplier === null ? "" : ` of supplier ${supplier}`} cannot be signed: ` +
        `kind ${kind ?? "(unread by this read)"}, direction ${direction}`,
    );
    this.name = "UnsignableSupplierEntryError";
    this.kind = kind;
    this.direction = refusal.direction ?? null;
    this.entryId = entry;
    this.supplierId = supplier;
  }
}

/**
 * The sign one entry kind contributes to the supplier balance (#260), read from
 * the one rule table (#317).
 *
 * A fixed kind ignores the direction it was handed: only ADJUSTMENT takes its sign
 * from a direction, and a missing or undefined one there is refused rather than
 * defaulted. The parameter types are the runtime types, not the union: a corrupt
 * row is exactly the case this function has to answer for. `entryId` and
 * `supplierId` are optional context for that refusal (the fold passes both so the
 * error names the row and the account).
 */
export function supplierEntrySign(
  kind: string,
  direction: string | null = null,
  entryId: string | null = null,
  supplierId: string | null = null,
): 1 | -1 {
  const rule = supplierEntryRule(kind);
  if (rule === undefined) throw new UnsignableSupplierEntryError({ kind, direction, entryId, supplierId });
  if (!rule.directionRequired) return rule.sign;
  // `Object.hasOwn`, not `in`: `directions` is an object literal, so `in` answers
  // true for `toString`, `constructor` and `valueOf` and would return a FUNCTION
  // where a sign belongs. A direction the table does not define cannot sign
  // anything, and that includes a direction the type system never saw.
  if (direction !== null && Object.hasOwn(rule.directions, direction)) {
    // SAFETY: Object.hasOwn proved the key is one of the record's own keys, and
    // the record is keyed by the direction union.
    return rule.directions[direction as SupplierAdjustmentDirection];
  }
  throw new UnsignableSupplierEntryError({ kind, direction, entryId, supplierId });
}

/** The signed balance of a supplier account: Σ amount × sign(kind). `supplierId`
 * is context for the refusal only: without it the error names the entry but not
 * the account whose screens are blank. */
export function supplierBalance(
  entries: readonly { id?: string; kind: SupplierEntryKind; amount: number; direction?: SupplierAdjustmentDirection | null }[],
  supplierId: string | null = null,
): number {
  return entries.reduce(
    (sum, entry) => sum + supplierEntrySign(entry.kind, entry.direction ?? null, entry.id ?? null, supplierId) * entry.amount,
    0,
  );
}

/** How much of `amount` fits an invoice that still owes `remaining`; the rest
 * becomes credit. Both operands are whole DZD, non-negative. */
export function splitAgainstRemaining(amount: number, remaining: number) {
  const attached = Math.max(0, Math.min(amount, remaining));
  return { attached, credit: amount - attached };
}

/** How much cash the shop may still receive from the supplier: the size of the
 * credit (**a positive balance** under the #260 convention), never a negative
 * amount. A refund or a return's cash-back may not exceed this. */
export function availableSupplierCredit(balance: number): number {
  return Math.max(0, balance);
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
