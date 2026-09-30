/**
 * Parsers for the numeric fields the owner types: money in dinars and stock
 * quantities.
 *
 * `Number()` alone is too generous for these fields — it accepts `"1e3"`,
 * `"0x10"`, `" 12 "` and `"Infinity"`, so a stray keystroke can persist a value
 * the operator never saw. These parse the digits they actually typed and return
 * `null` for everything else, including values too large to represent exactly
 * (`Number.isSafeInteger`).
 */

/** A plain non-negative whole number: digits only, no sign, no exponent. */
export function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A whole number that may be negative: stock movements in and out. */
export function parseSignedWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("-")) {
    const magnitude = parseWholeNumber(trimmed.slice(1));
    return magnitude === null ? null : -magnitude;
  }
  return parseWholeNumber(trimmed);
}
