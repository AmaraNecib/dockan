/**
 * #180 — the single grouped-amount parser shared by every money input.
 *
 * `parseWholeAmount` / `parseWholePercentage` are the strict digits-only
 * readers (either digit script, #210); `parseGroupedAmount` additionally accepts
 * valid 3-digit thousands grouping (comma, whitespace, Arabic thousands
 * separator), and REJECTS decimals and malformed separators instead of deleting a
 * separator and returning a different number (the reported `1 000,00` → 100000
 * silent 100× bug). The bulk opening balance and the single-entry money fields
 * both use this one reader, so a grouped string can never mean two numbers.
 *
 * `normalizeArabicIndicDigits` is the one normalisation step they all share: it
 * maps either Arabic digit script and drops a pasted bidi mark at the edge of a
 * draft (#227), so a pasted number reads like the same number typed. (An
 * interior pasted mark is left in place and refused — see the helper below.)
 */

/** Otherwise-valid thousands separators between 3-digit groups (comma,
 * whitespace, Arabic thousands separator, non-breaking space). */
const STRIP_GROUPING = /[,\s\u066C\u00A0]/gu;
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/gu;
const EXTENDED_ARABIC_INDIC_DIGITS = /[\u06F0-\u06F9]/gu;
/**
 * The invisible bidi marks a paste can carry at the *edge* of a numeric draft:
 * U+061C (ALM), U+200E/U+200F (LRM/RLM), the embeddings U+202A..U+202C
 * (LRE/RLE/PDF) and the isolates U+2066..U+2069 (LRI/RLI/FSI/PDI).
 *
 * Only *edge* occurrences are dropped (#227). A mark *inside* a draft can split
 * a digit run and let the RTL page reorder it — measured in Chromium with
 * `dir="rtl"`, `1\u200f2` renders as `21` — so reading the logical order would
 * return a number the owner never saw. An interior mark is left in place, which
 * makes the strict readers refuse the draft: a safe refusal, never a different
 * number.
 *
 * The directional *overrides* U+202D (LRO) and U+202E (RLO) are never dropped,
 * edge or not: an override displays a run in forced order, so the logical digit
 * characters a paste carries can differ from the number the owner saw.
 */
const PASTED_BIDI_MARKS = /[\u061C\u200E\u200F\u202A-\u202C\u2066-\u2069]/gu;
/** Draft content for the edge test: not whitespace and not one of the marks. */
const DRAFT_CONTENT = /[^\s\u061C\u200E\u200F\u202A-\u202C\u2066-\u2069]/u;

/**
 * Drop the pasted bidi marks that sit outside the draft's content — leading,
 * trailing, or among surrounding whitespace, which is the shape a copy out of
 * RTL text produces. A mark with content on both sides is left for the reader to
 * refuse (see `PASTED_BIDI_MARKS`).
 */
function stripEdgeBidiMarks(draft: string): string {
  const first = draft.search(DRAFT_CONTENT);
  if (first === -1) return draft.replace(PASTED_BIDI_MARKS, "");
  let last = first;
  for (let index = draft.length - 1; index > first; index -= 1) {
    if (DRAFT_CONTENT.test(draft[index] ?? "")) {
      last = index;
      break;
    }
  }
  return draft.replace(PASTED_BIDI_MARKS, (mark: string, offset: number) =>
    offset < first || offset > last ? "" : mark,
  );
}

/**
 * Map Arabic-Indic (`٥`) and Extended Arabic-Indic (`۵`) digits to their ASCII
 * form, drop the pasted bidi marks at the edge of a draft, and leave every other
 * character untouched. One normalizer for the amount and invoice-draft readers,
 * so a digit one accepts the other cannot reject (the #198 quantity/amount
 * mismatch). Every money reader in this module normalises through it, so a
 * value typed in either script — or pasted out of RTL text (#227) — reads the
 * same (#210).
 */
export function normalizeArabicIndicDigits(draft: string): string {
  return stripEdgeBidiMarks(draft)
    .replace(ARABIC_INDIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/**
 * A digits-only whole-DZD draft in either digit script, or null when it is not
 * a usable integer. The ASCII read is unchanged: `normalizeArabicIndicDigits`
 * leaves every ASCII code point untouched.
 */
export function parseWholeAmount(draft: string): number | null {
  const trimmed = normalizeArabicIndicDigits(draft).trim();
  if (trimmed === "" || !/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** A digits-only 0..100 whole-percentage draft in either digit script, or null when unusable. */
export function parseWholePercentage(draft: string): number | null {
  const trimmed = normalizeArabicIndicDigits(draft).trim();
  if (trimmed === "" || !/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > 100) return null;
  return value;
}

/**
 * The permissive numeric read the sale override/discount drafts always used
 * (`Number(draft)`), with digits normalized first. It is deliberately NOT a
 * strict reader: `1e3`, `0x10`, `12.5`, and `"" → 0` keep the behaviour they had,
 * so widening the digit script cannot tighten an ASCII value. Only the digit
 * script moves; ASCII input is `Number(draft)` untouched.
 */
export function parseLooseNumber(draft: string): number {
  return Number(normalizeArabicIndicDigits(draft));
}

/**
 * A whole-DZD draft. Accepts plain digits and VALID thousands grouping
 * (`1 000`, `1,000`, `٢٥٬٠٠٠`) plus Arabic-Indic digits. A decimal or a
 * malformed separators draft (`1 000,00`, `1,5`, `1 00`, `1,0000`) is REJECTED
 * instead of deleting the separator and returning a different number.
 */
export function parseGroupedAmount(draft: string): number | null {
  const normalized = normalizeArabicIndicDigits(draft).trim();
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
