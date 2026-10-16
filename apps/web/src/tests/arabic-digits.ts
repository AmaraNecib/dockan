/**
 * #225 — the Arabic-Indic digit scripts, for tests that pin a numeric reader
 * against its ASCII twin.
 *
 * Deliberately a hand-written map, NOT the production normaliser: importing
 * `normalizeArabicIndicDigits` here would make every pin tautological (the test
 * would assert the reader agrees with the code it is testing).
 */

/** Arabic-Indic digits U+0660..U+0669 (`٥`). */
export const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
/** Extended Arabic-Indic digits U+06F0..U+06F9 (`۵`). */
export const EXTENDED_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Rewrite every ASCII digit in `ascii` to its Arabic-Indic twin: `"42"` → `"٤٢"`. */
export function toArabicIndic(ascii: string): string {
  return ascii.replace(/\d/gu, (digit) => ARABIC_INDIC[Number(digit)]!);
}

/** Rewrite every ASCII digit in `ascii` to its Extended Arabic-Indic twin. */
export function toExtendedArabicIndic(ascii: string): string {
  return ascii.replace(/\d/gu, (digit) => EXTENDED_ARABIC_INDIC[Number(digit)]!);
}
