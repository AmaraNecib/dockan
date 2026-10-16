/**
 * Parsers for the numeric fields the owner types: money in dinars and stock
 * quantities.
 *
 * `Number()` alone is too generous for these fields — it accepts `"1e3"`,
 * `"0x10"`, `" 12 "` and `"Infinity"`, so a stray keystroke can persist a value
 * the operator never saw. These parse the digits they actually typed and return
 * `null` for everything else, including values too large to represent exactly
 * (`Number.isSafeInteger`).
 *
 * The digit script is normalised through the one shared reader
 * (`normalizeArabicIndicDigits`, #210/#225), so an Arabic-Indic `٥` reads as
 * five wherever an ASCII `5` does. ASCII input is untouched: the strict
 * digits-only test and the `Number` read keep the exact meaning they had.
 */

import { normalizeArabicIndicDigits } from "./amount-parse";

/** A plain non-negative whole number: digits only (either script), no sign, no exponent. */
export function parseWholeNumber(text: string): number | null {
  const trimmed = normalizeArabicIndicDigits(text).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * What the shared opening-stock field resolved to.
 *
 * The reasons exist so each form can pick its own invalid-value message: a
 * value that cannot be read is a different mistake from a value the path
 * requires but did not get.
 */
export type OpeningStockResolution =
  | { ok: true; value: number }
  | { ok: false; reason: "required" | "invalid" };

/**
 * Resolve the opening-stock input the item forms share. A blank field is an
 * explicit zero on the plain create path, but the unknown scan's "create with
 * stock" path promised an opening movement, so `required` refuses blank and 0.
 * The blank→0 mapping, the positive bound, and which refusal wins live here
 * once; callers only choose the message per reason.
 */
export function resolveOpeningStock(text: string, required: boolean): OpeningStockResolution {
  const trimmed = text.trim();
  if (trimmed === "") return required ? { ok: false, reason: "required" } : { ok: true, value: 0 };
  const parsed = parseWholeNumber(trimmed);
  if (parsed === null) return { ok: false, reason: "invalid" };
  if (required && parsed < 1) return { ok: false, reason: "required" };
  return { ok: true, value: parsed };
}

/** A whole number that may be negative: stock movements in and out. The sign
 * stays the ASCII `-`; only the digit script is widened (#225). */
export function parseSignedWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("-")) {
    const magnitude = parseWholeNumber(trimmed.slice(1));
    return magnitude === null ? null : -magnitude;
  }
  return parseWholeNumber(trimmed);
}
