/**
 * #180 — the single grouped-amount parser shared by every money input.
 *
 * `parseWholeAmount` / `parseWholePercentage` are the strict digits-only
 * readers; `parseGroupedAmount` additionally accepts valid 3-digit thousands
 * grouping (comma, whitespace, Arabic thousands separator) and Arabic-Indic
 * digits, and REJECTS decimals and malformed separators instead of deleting a
 * separator and returning a different number (the reported `1 000,00` → 100000
 * silent 100× bug). The bulk opening balance and the single-entry money fields
 * both use this one reader, so a grouped string can never mean two numbers.
 */

/** Otherwise-valid thousands separators between 3-digit groups (comma,
 * whitespace, Arabic thousands separator, non-breaking space). */
const STRIP_GROUPING = /[,\s\u066C\u00A0]/gu;
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/gu;
const EXTENDED_ARABIC_INDIC_DIGITS = /[\u06F0-\u06F9]/gu;

/** A digits-only whole-DZD draft, or null when it is not a usable integer. */
export function parseWholeAmount(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === "" || !/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** A digits-only 0..100 whole-percentage draft, or null when unusable. */
export function parseWholePercentage(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === "" || !/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > 100) return null;
  return value;
}

/**
 * A whole-DZD draft. Accepts plain digits and VALID thousands grouping
 * (`1 000`, `1,000`, `٢٥٬٠٠٠`) plus Arabic-Indic digits. A decimal or a
 * malformed separators draft (`1 000,00`, `1,5`, `1 00`, `1,0000`) is REJECTED
 * instead of deleting the separator and returning a different number.
 */
export function parseGroupedAmount(draft: string): number | null {
  const normalized = draft
    .replace(ARABIC_INDIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .trim();
  if (normalized === "") return null;
  // valid grouping: an optional 1-3 digit lead, then groups of exactly 3
  const plain = /^\d+$/u.test(normalized);
  const grouped = /^\d{1,3}(?:[,\s\u066C\u00A0]\d{3})+$/u.test(normalized);
  if (!plain && !grouped) return null;
  return parseWholeAmount(normalized.replace(STRIP_GROUPING, ""));
}

/**
 * The amount ⇄ percentage link of a «مبلغ أو نسبة» pair (#162). Both directions
 * round to whole DZD/percent and clamp to 0..100, so the two sides of the pair
 * can never disagree about the same share.
 */

/** Whole-DZD amount for `percentage` percent of `referenceTotal` (p clamped 0..100). */
export function amountFromPercentage(referenceTotal: number, percentage: number): number {
  const capped = Math.min(100, Math.max(0, percentage));
  return Math.round((referenceTotal * capped) / 100);
}

/** Whole-percent share `amount` is of `referenceTotal` (clamped 0..100). */
export function percentageFromAmount(referenceTotal: number, amount: number): number {
  if (referenceTotal <= 0) return 0;
  const raw = (amount / referenceTotal) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * True when a non-empty percentage draft is not a whole 0..100 percent (e.g.
 * "12.5", "abc"). Callers must reject this BEFORE saving: the amount field is
 * cleared for such a draft, and an empty amount is the legitimate "unpaid / zero
 * cash" choice — so an invalid percentage would otherwise be silently recorded
 * as that choice.
 */
export function percentageDraftInvalid(draft: string): boolean {
  return draft.trim() !== "" && parseWholePercentage(draft) === null;
}
