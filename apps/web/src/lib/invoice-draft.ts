import type { Item } from "@dokan/contracts";

import {
  amountFromPercentage,
  normalizeArabicIndicDigits,
  parseGroupedAmount,
  parseLooseNumber,
  parseWholePercentage,
  percentageDraftInvalid,
  percentageFromAmount,
} from "@/lib/amount-parse";

/**
 * #146, one invoice-draft module behind the sale and purchase screens.
 *
 * `sale.tsx` and `purchase.tsx` had drifted: sale parsed a quantity *draft*
 * (a transient empty field is legal, an invalid draft resolves to 0 and stays
 * visible), purchase wrote `Number(event.target.value)` and silently kept the
 * previous value. This module owns the shared draft mechanics: the line list,
 * one quantity parser, line and invoice totals, the initial-payment pair, and
 * the per-kind pricing rule callers supply. A draft bug is fixed once and both
 * screens behave the same for the same owner action.
 *
 * Everything here is pure and React-free. The reducer and the rules are
 * unit-tested without a render; `use-invoice-draft.ts` wraps them for React.
 */

/**
 * A share-of-a-reference value: an invoice discount or a per-line negotiated
 * price. Both inputs share this shape and both spell «nothing chosen» as "".
 */
export type AmountKind = "" | "AMOUNT" | "PERCENTAGE";

/**
 * One draft line: the item plus the raw quantity text the owner is typing.
 * Empty is a valid transient while typing. See `parseQuantityDraft`.
 */
export interface DraftLine {
  item: Item;
  quantityDraft: string;
}

/** A SALE line: the base draft plus an optional negotiated unit price. */
export interface SaleDraftLine extends DraftLine {
  overrideType: AmountKind;
  overrideValue: string;
}

/**
 * A PURCHASE line: the base draft plus the unit cost actually paid. The cost is
 * a resolved number, not a draft. See `nextUnitCost`.
 */
export interface PurchaseDraftLine extends DraftLine {
  unitCost: number;
}

/**
 * Cap mirroring the RPC contract's line-quantity max
 * (`invoiceLineInputSchema.quantity` is `.int().positive().max(1_000_000)`).
 * An oversized draft is refused client-side instead of surfacing an opaque
 * server error.
 */
export const MAX_DRAFT_QUANTITY = 1_000_000;

/**
 * Resolve a cart quantity draft to its effective line quantity. Empty,
 * non-integer, zero, or over-cap drafts yield 0 (invalid). The input never
 * rewrites the draft, so clearing it stays visually empty instead of snapping
 * back to the previous value (the field is NOT a controlled number). Only an
 * explicit add-line action (scan or duplicate picker entry) repairs a cleared
 * draft, by bumping it to one unit.
 *
 * Digits are normalized with the same reader the amount fields use, so an
 * Arabic-Indic `٥` bills five units instead of refusing a number the owner can
 * plainly read (#198 decision). The sale price-override and discount inputs now
 * share that reader too (#210), so the same typed value resolves in every field.
 * The reader stays digits-only: no grouping separators, exactly as before.
 */
export function parseQuantityDraft(draft: string): number {
  const trimmed = normalizeArabicIndicDigits(draft).trim();
  if (trimmed === "" || !/^\d+$/u.test(trimmed)) return 0;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DRAFT_QUANTITY ? value : 0;
}

/** True when the draft cannot form a sellable or purchasable line. */
export function quantityDraftInvalid(draft: string): boolean {
  return parseQuantityDraft(draft) < 1;
}

/** The quantity a draft line bills at; 0 while the draft is unusable. */
export function lineQuantity(line: DraftLine): number {
  return parseQuantityDraft(line.quantityDraft);
}

/**
 * The first line error message in draft order, or null when every line is
 * commit-ready. The caller supplies the per-kind message for a single line, so
 * the pages keep their own copy while the ordering rule lives here. This also
 * keeps one line's override and quantity checks adjacent, which preserves the
 * message an already-invalid multi-line cart used to surface.
 */
export function firstLineError<T extends DraftLine>(lines: readonly T[], errorFor: (line: T) => string | null): string | null {
  for (const line of lines) {
    const message = errorFor(line);
    if (message !== null) return message;
  }
  return null;
}

/** A per-line predicate plus the message it surfaces when it fails. */
export interface LineCheck<T> {
  invalid: (line: T) => boolean;
  message: string;
}

/** A check with no per-line predicate: whether it failed and its message. */
export interface Check {
  invalid: boolean;
  message: string;
}

/**
 * The inputs one invoice screen hands to `firstCommitError`. The five slots are
 * the canonical checks in canonical order; a screen omits only the checks it
 * does not have (purchase has no price override and no invoice discount).
 */
export interface CommitChecks<T extends DraftLine> {
  /** the cart */
  lines: readonly T[];
  /** shown when the cart has no lines */
  linesEmpty: string;
  /** true when an exact typed party name matches a saved record and must be picked */
  partyNeedsChoice: boolean;
  partyNeedsChoiceMessage: string;
  /** sale's per-line price override; checked before the same line's quantity */
  override?: LineCheck<T>;
  /** the per-line quantity */
  quantity: LineCheck<T>;
  /** sale's invoice discount, a second input to the total */
  discount?: Check;
  /** the initial payment, derived from the total the checks above can zero */
  payment: Check;
}

/**
 * The one commit order, shared by the sale and purchase screens:
 *
 *   empty cart → party → per-line (override before quantity) → discount → payment
 *
 * Every later check is derived from an earlier input: the total comes from the
 * lines and (on sale) the discount, and the payment compares against that
 * total. So a cleared quantity or an over-100% discount that zeroes the total
 * would make a typed payment fail its amount-vs-total check and mask the real
 * problem as «invalid payment». The order is therefore: validate the raw drafts
 * before the values derived from them. #188 found the same masking bug in
 * purchase first and sale second precisely because this rule lived in two
 * places; it now lives here, once. Returns the message for the first failing
 * check, or null when the draft is commit-ready.
 */
export function firstCommitError<T extends DraftLine>(checks: CommitChecks<T>): string | null {
  if (checks.lines.length === 0) return checks.linesEmpty;
  if (checks.partyNeedsChoice) return checks.partyNeedsChoiceMessage;
  const lineError = firstLineError(checks.lines, (line) => {
    if (checks.override?.invalid(line) === true) return checks.override.message;
    if (checks.quantity.invalid(line)) return checks.quantity.message;
    return null;
  });
  if (lineError !== null) return lineError;
  if (checks.discount?.invalid === true) return checks.discount.message;
  if (checks.payment.invalid) return checks.payment.message;
  return null;
}

/** A non-negative numeric draft in either digit script, or `fallback` when it is unreadable. */
export function nonNegativeOr(value: string, fallback: number): number {
  const parsed = parseLooseNumber(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * True when a draft carries no value once the shared digits + bidi
 * normalisation is applied. A paste can leave an invisible mark behind
 * (`"\u200f"`, the #227 mark stripped by `normalizeArabicIndicDigits`), and a
 * bidi mark is a `Cf` format character, not whitespace — so a raw `.trim()`
 * check reads it as a chosen value, while the loose `Number()` bills it as 0.
 * Both the price and the guard go through this one predicate, so a mark-only
 * draft is «nothing chosen» in both, exactly as an empty draft is.
 */
function draftBlank(draft: string): boolean {
  return normalizeArabicIndicDigits(draft).trim() === "";
}

/**
 * The unit price a SALE line bills at: the item's selling price, negotiated by
 * the line's override when one is chosen. AMOUNT is the price itself; a
 * PERCENTAGE is a share of the default price; both round to whole DZD.
 */
export function saleUnitPrice(line: SaleDraftLine): number {
  const value = nonNegativeOr(line.overrideValue, line.item.sellingPrice);
  if (draftBlank(line.overrideValue)) return line.item.sellingPrice;
  if (line.overrideType === "AMOUNT") return Math.round(value);
  if (line.overrideType === "PERCENTAGE") return Math.round((line.item.sellingPrice * value) / 100);
  return line.item.sellingPrice;
}

/**
 * A chosen price override must carry a usable value: empty input parses to 0
 * (`Number("") === 0`) and would bill the line as free while the preview still
 * shows the default price, so it is rejected before submission. A draft that is
 * blank after normalisation — a bare pasted bidi mark (#227) — is the same free
 * line and is rejected by the same check.
 */
export function saleOverrideInvalid(line: Pick<SaleDraftLine, "overrideType" | "overrideValue">): boolean {
  if (line.overrideType === "") return false;
  if (draftBlank(line.overrideValue)) return true;
  const value = parseLooseNumber(line.overrideValue);
  if (!Number.isFinite(value)) return true;
  if (line.overrideType === "AMOUNT") return !Number.isInteger(value) || value < 0;
  return !Number.isInteger(value) || value < 0 || value > 100;
}

/** The unit price a PURCHASE line bills at: the cost actually paid. */
export function purchaseUnitPrice(line: PurchaseDraftLine): number {
  return line.unitCost;
}

/**
 * Read the edited unit-cost text for a PURCHASE line. This field is a
 * controlled money field, not a quantity draft: a cleared field is an explicit
 * zero (as it always was, `Number("") === 0`), a whole non-negative number is
 * that value, and anything else keeps the previous value instead of
 * transiently billing the line at zero mid-edit. The reader is deliberately
 * the same `Number` check the page used before #146, now digit-normalised
 * (`parseLooseNumber`), so no reachable ASCII input changes which number the
 * line bills and an Arabic-Indic draft reads like its ASCII twin (#225).
 */
export function nextUnitCost(value: string, previous: number): number {
  const parsed = parseLooseNumber(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : previous;
}

/** Accept only the two real amount kinds; anything else means «none chosen». */
export function toAmountKind(value: string): AmountKind {
  return value === "AMOUNT" || value === "PERCENTAGE" ? value : "";
}

// --- line list --------------------------------------------------------------

/**
 * Add an item to the draft, merging a repeat pick into the existing line. The
 * merge bumps the effective quantity by one, which repairs a cleared or invalid
 * draft to a single unit. It clamps at `MAX_DRAFT_QUANTITY`, so a scan on a
 * line already at the cap keeps that line valid instead of zeroing it.
 */
export function addDraftLine<T extends DraftLine>(lines: readonly T[], line: T): T[] {
  const existing = lines.find((entry) => entry.item.id === line.item.id);
  if (existing === undefined) return [...lines, line];
  return lines.map((entry) =>
    entry.item.id === line.item.id
      ? { ...entry, quantityDraft: String(Math.min(lineQuantity(entry) + 1, MAX_DRAFT_QUANTITY)) }
      : entry,
  );
}

/** Set one line's raw quantity text (the draft stays exactly as typed). */
export function setDraftQuantity<T extends DraftLine>(lines: readonly T[], itemId: string, draft: string): T[] {
  return lines.map((entry) => (entry.item.id === itemId ? { ...entry, quantityDraft: draft } : entry));
}

/** Merge kind-specific fields (price override, unit cost) into one line. */
export function patchDraftLine<T extends DraftLine>(lines: readonly T[], itemId: string, patch: Partial<T>): T[] {
  return lines.map((entry) => (entry.item.id === itemId ? { ...entry, ...patch } : entry));
}

/** Drop one line. Removing the last line is the caller's cue to clear discounts. */
export function removeDraftLine<T extends DraftLine>(lines: readonly T[], itemId: string): T[] {
  return lines.filter((entry) => entry.item.id !== itemId);
}

export type DraftAction<T extends DraftLine> =
  | { type: "add"; line: T }
  | { type: "quantity"; itemId: string; draft: string }
  | { type: "patch"; itemId: string; patch: Partial<T> }
  | { type: "remove"; itemId: string }
  | { type: "reset" };

/**
 * The pure reducer behind the draft hook. Kept framework-free so the line-list
 * rules are unit-tested without React.
 */
export function draftReducer<T extends DraftLine>(lines: readonly T[], action: DraftAction<T>): T[] {
  switch (action.type) {
    case "add":
      return addDraftLine(lines, action.line);
    case "quantity":
      return setDraftQuantity(lines, action.itemId, action.draft);
    case "patch":
      return patchDraftLine(lines, action.itemId, action.patch);
    case "remove":
      return removeDraftLine(lines, action.itemId);
    case "reset":
      return [];
  }
}

// --- totals -----------------------------------------------------------------

/** Whole-DZD subtotal: each line's effective quantity times its unit price. */
export function draftSubtotal<T extends DraftLine>(lines: readonly T[], unitPrice: (line: T) => number): number {
  return lines.reduce((sum, line) => sum + lineQuantity(line) * unitPrice(line), 0);
}

/**
 * The invoice discount in whole DZD. An amount is capped at the subtotal; a
 * percentage rounds like every other money figure and is capped at the subtotal
 * too, so a 100% discount can never make the total negative.
 */
export function discountAmountFor(subtotal: number, type: AmountKind, draft: string): number {
  if (type === "") return 0;
  const value = nonNegativeOr(draft, 0);
  if (type === "AMOUNT") return Math.min(value, subtotal);
  return Math.min(Math.round((subtotal * value) / 100), subtotal);
}

/** The checkout row's three pinned numbers. */
export interface DraftTotals {
  subtotal: number;
  discountAmount: number;
  total: number;
}

/**
 * The sale screen's totals path. Purchase passes no discount, so it reads the
 * hook's `subtotal` directly; the subtraction and the discount cap still live
 * here, once.
 */
export function draftTotals<T extends DraftLine>(
  lines: readonly T[],
  unitPrice: (line: T) => number,
  discountType: AmountKind,
  discountValue: string,
): DraftTotals {
  const subtotal = draftSubtotal(lines, unitPrice);
  const discountAmount = discountAmountFor(subtotal, discountType, discountValue);
  return { subtotal, discountAmount, total: subtotal - discountAmount };
}

// --- initial payment (amount to percentage pair, #162) ----------------------

export type PaymentSource = "amount" | "percentage" | null;

/** The linked pair plus which field the owner last edited. */
export interface PaymentPair {
  amount: string;
  percentage: string;
  source: PaymentSource;
}

export const EMPTY_PAYMENT_PAIR: PaymentPair = { amount: "", percentage: "", source: null };

/** Whether two pair states are the same, so a hook can keep object identity. */
export function paymentPairUnchanged(a: PaymentPair, b: PaymentPair): boolean {
  return a.amount === b.amount && a.percentage === b.percentage && a.source === b.source;
}

/**
 * The next linked state of an initial-payment pair when the reference total
 * changes: an untouched pair follows the full total, an edited percentage
 * rescales the amount, an edited amount re-derives the percentage, and a
 * percentage-based payment falls to zero when a discount zeroes the total.
 * Recomputing from the same values is a no-op, so the transition converges.
 */
export function nextPaymentPair(total: number, current: PaymentPair): PaymentPair {
  if (total === 0) {
    // a percentage-based payment must fall to zero when a discount zeroes the
    // total, or the old positive amount is sent and the api rejects it
    if (current.source === "percentage") return { amount: "0", percentage: current.percentage, source: current.source };
    // an amount typed while the cart was still empty (no reference yet) is the
    // owner's to keep; an untouched pair follows the empty cart
    if (current.source === null) return EMPTY_PAYMENT_PAIR;
    return current;
  }
  if (current.source === null) return { amount: String(total), percentage: "100", source: current.source };
  if (current.source === "percentage") {
    const percentage = parseWholePercentage(current.percentage);
    if (percentage === null) return current;
    return { amount: String(amountFromPercentage(total, percentage)), percentage: current.percentage, source: current.source };
  }
  const amount = parseGroupedAmount(current.amount);
  return {
    amount: current.amount,
    percentage: amount === null ? "" : String(percentageFromAmount(total, amount)),
    source: current.source,
  };
}

/**
 * Resolve a pre-commit payment pair to the `initialPaid` the invoice carries.
 * `paid: undefined` means «nothing paid now»: an empty or zero draft, or a
 * percentage that rounds to zero, so the whole total becomes debt. Invalid
 * drafts (a non-whole percentage, an unreadable amount, or an amount above the
 * total) report `ok: false` so the caller surfaces its own message. The api
 * rejects an overpayment, so an over-total draft is not a zero-debt commit.
 */
export type InitialPaidResolution = { ok: true; paid: number | undefined } | { ok: false };

export function resolveInitialPaid(total: number, amountDraft: string, percentageDraft: string): InitialPaidResolution {
  if (percentageDraftInvalid(percentageDraft)) return { ok: false };
  const paid = amountDraft.trim() === "" ? undefined : parseGroupedAmount(amountDraft);
  if (paid === null) return { ok: false };
  if (paid !== undefined && paid > total) return { ok: false };
  return { ok: true, paid: paid === 0 ? undefined : paid };
}

/**
 * The `initialPaid` a commit-ready draft carries, from a resolution
 * `firstCommitError` accepted. The helper returns null only when
 * `payment.invalid` is false, and both pages derive that from `!paid.ok`; a
 * rejected resolution here means the two drifted, so fail loudly instead of
 * sending no initial payment (which would book the whole invoice as debt).
 */
export function resolvedInitialPaid(paid: InitialPaidResolution): number | undefined {
  if (!paid.ok) throw new Error("firstCommitError did not refuse an invalid initial payment");
  return paid.paid;
}
