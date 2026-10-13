import type { Item } from "@dokan/contracts";

import {
  amountFromPercentage,
  parseGroupedAmount,
  parseWholePercentage,
  percentageDraftInvalid,
  percentageFromAmount,
} from "@/lib/amount-parse";
import { parseWholeNumber } from "@/lib/numeric-input";

/**
 * #146 — one invoice-draft module behind the sale and purchase screens.
 *
 * `sale.tsx` and `purchase.tsx` had drifted: sale parsed a quantity *draft*
 * (a transient empty field is legal, an invalid draft resolves to 0 and stays
 * visible), purchase wrote `Number(event.target.value)` and silently kept the
 * previous value. This module owns the shared draft mechanics — the line list,
 * one quantity parser, line/invoice totals, the initial-payment pair, and the
 * per-kind pricing rule callers supply — so a draft bug is fixed once and both
 * screens behave the same for the same owner action.
 *
 * Everything here is pure and React-free: the reducer and the rules are
 * unit-tested without a render. `use-invoice-draft.ts` wraps them for React.
 */

/** Which screen owns the draft. The kind changes copy and the pricing rule only. */
export type DraftKind = "SALE" | "PURCHASE";

/**
 * A share-of-a-reference value: an invoice discount or a per-line negotiated
 * price. Both inputs share this shape and both spell «nothing chosen» as "".
 */
export type AmountKind = "" | "AMOUNT" | "PERCENTAGE";
export type DiscountType = AmountKind;
export type OverrideType = AmountKind;

/**
 * One draft line: the item plus the raw quantity text the owner is typing.
 * Empty is a valid transient while typing — see `parseQuantityDraft`.
 */
export interface DraftLine {
  item: Item;
  quantityDraft: string;
}

/** A SALE line: the base draft plus an optional negotiated unit price. */
export interface SaleDraftLine extends DraftLine {
  overrideType: OverrideType;
  overrideValue: string;
}

/**
 * A PURCHASE line: the base draft plus the unit cost actually paid. The cost is
 * a resolved number, not a draft — see `nextUnitCost`.
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
 * non-integer, zero, or over-cap drafts yield 0 (invalid); the input never
 * rewrites the draft, so clearing it stays visually empty instead of snapping
 * back to the previous value (the field is NOT a controlled number). Only an
 * explicit add-line action (scan / duplicate picker entry) repairs a cleared
 * draft to a single unit.
 */
export function parseQuantityDraft(draft: string): number {
  const trimmed = draft.trim();
  if (trimmed === "" || !/^\d+$/u.test(trimmed)) return 0;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DRAFT_QUANTITY ? value : 0;
}

/** True when the draft cannot form a sellable/purchasable line (empty, zero, or garbage). */
export function quantityDraftInvalid(draft: string): boolean {
  return parseQuantityDraft(draft) < 1;
}

/** The quantity a draft line currently bills at; 0 while the draft is unusable. */
export function lineQuantity(line: DraftLine): number {
  return parseQuantityDraft(line.quantityDraft);
}

/** A non-negative numeric draft, or `fallback` when it is unreadable. */
export function nonNegativeOr(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The unit price a SALE line bills at: the item's selling price, negotiated by
 * the line's override when one is chosen. AMOUNT is the price itself; a
 * PERCENTAGE is a share of the default price; both round to whole DZD.
 */
export function saleUnitPrice(line: SaleDraftLine): number {
  const value = nonNegativeOr(line.overrideValue, line.item.sellingPrice);
  if (line.overrideValue.trim() === "") return line.item.sellingPrice;
  if (line.overrideType === "AMOUNT") return Math.round(value);
  if (line.overrideType === "PERCENTAGE") return Math.round((line.item.sellingPrice * value) / 100);
  return line.item.sellingPrice;
}

/**
 * A chosen price override must carry a usable value: empty input parses to 0
 * (Number("") === 0) and would bill the line as free while the preview still
 * shows the default price, so it is rejected before submission.
 */
export function saleOverrideInvalid(line: Pick<SaleDraftLine, "overrideType" | "overrideValue">): boolean {
  if (line.overrideType === "") return false;
  if (line.overrideValue.trim() === "") return true;
  const value = Number(line.overrideValue);
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
 * zero (as it always was — `Number("") === 0`), digits are that whole number,
 * and an unreadable draft keeps the previous value rather than transiently
 * billing the line at zero mid-edit. The reader is the repo's strict
 * `parseWholeNumber`, so a stray `1e3` / `0x10` can never persist a value the
 * operator never typed (the old `Number()` reader accepted both).
 */
export function nextUnitCost(value: string, previous: number): number {
  if (value.trim() === "") return 0;
  const parsed = parseWholeNumber(value);
  return parsed === null ? previous : parsed;
}

/** Accept only the two real amount kinds; anything else means «none chosen». */
export function toAmountKind(value: string): AmountKind {
  return value === "AMOUNT" || value === "PERCENTAGE" ? value : "";
}
export const toDiscountType = toAmountKind;
export const toOverrideType = toAmountKind;

// --- line list --------------------------------------------------------------

/**
 * Add an item to the draft, merging a repeat pick into the existing line. The
 * merge bumps the effective quantity by one, which repairs a cleared/invalid
 * draft to a single unit (a scan or picker entry is an explicit add action).
 */
export function addDraftLine<T extends DraftLine>(lines: readonly T[], line: T): T[] {
  const existing = lines.find((entry) => entry.item.id === line.item.id);
  if (existing === undefined) return [...lines, line];
  return lines.map((entry) =>
    entry.item.id === line.item.id ? { ...entry, quantityDraft: String(lineQuantity(entry) + 1) } : entry,
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
 * percentage rounds like every other money figure and is capped at the
 * subtotal too, so a 100% discount can never make the total negative.
 */
export function discountAmountFor(subtotal: number, type: DiscountType, draft: string): number {
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

export function draftTotals<T extends DraftLine>(
  lines: readonly T[],
  unitPrice: (line: T) => number,
  discountType: DiscountType,
  discountValue: string,
): DraftTotals {
  const subtotal = draftSubtotal(lines, unitPrice);
  const discountAmount = discountAmountFor(subtotal, discountType, discountValue);
  return { subtotal, discountAmount, total: subtotal - discountAmount };
}

// --- initial payment (amount ⇄ percentage pair, #162) -----------------------

export type PaymentSource = "amount" | "percentage" | null;

/** The linked pair plus which field the owner last edited. */
export interface PaymentPair {
  amount: string;
  percentage: string;
  source: PaymentSource;
}

export const EMPTY_PAYMENT_PAIR: PaymentPair = { amount: "", percentage: "", source: null };

function samePair(a: PaymentPair, b: PaymentPair): boolean {
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

/** Whether `nextPaymentPair` would change anything; lets the hook keep identity. */
export function paymentPairUnchanged(a: PaymentPair, b: PaymentPair): boolean {
  return samePair(a, b);
}

/**
 * Resolve a pre-commit payment pair to the `initialPaid` the invoice carries.
 * `paid: undefined` means «nothing paid now» (the whole total becomes debt): an
 * empty or zero draft, or a percentage that rounds to zero. Invalid drafts — a
 * non-whole percentage, an unreadable amount, or an amount above the total —
 * report `ok: false` so the caller surfaces its own message; the api rejects an
 * overpayment, so an over-total draft is not a zero-debt commit.
 */
export type InitialPaidResolution = { ok: true; paid: number | undefined } | { ok: false };

export function resolveInitialPaid(total: number, pair: PaymentPair): InitialPaidResolution {
  if (percentageDraftInvalid(pair.percentage)) return { ok: false };
  const paid = pair.amount.trim() === "" ? undefined : parseGroupedAmount(pair.amount);
  if (paid === null) return { ok: false };
  if (paid !== undefined && paid > total) return { ok: false };
  return { ok: true, paid: paid === 0 ? undefined : paid };
}
