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

/**
 * Read a normalised whole-number draft: digits only, no sign, no exponent,
 * safe-integer bounded. `parseWholeNumber` passes `normalizeArabicIndicDigits`
 * output; `parseSignedWholeNumber` passes the magnitude of a draft it has
 * ALREADY judged sign-aware. Neither call may normalise again — a second edge
 * strip would drop a mark that was interior to the signed draft and was just
 * refused (#227 round 2). Tests and converts only; never normalises.
 */
function readNormalizedDigits(draft: string): number | null {
  if (!/^\d+$/.test(draft)) return null;
  const parsed = Number(draft);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A plain non-negative whole number: digits only (either script), no sign, no exponent. */
export function parseWholeNumber(text: string): number | null {
  return readNormalizedDigits(normalizeArabicIndicDigits(text).trim());
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
  // A mark in front of the sign keeps the raw draft unsigned, so the shared
  // reader refuses the `-` — a safe refusal pinned since #227 round 1.
  // Accepting it is a separate behaviour change (an edge mark before a sign)
  // that wants its own RTL display-order proof; deferred, not dismissed.
  if (!trimmed.startsWith("-")) return parseWholeNumber(trimmed);
  // Judge the WHOLE normalised signed draft while the sign is still attached.
  // `-` is content to `stripEdgeBidiMarks`, so a mark that is interior in the
  // signed draft stays interior here and this sign-aware gate refuses it.
  // Slicing the sign off first and letting `parseWholeNumber` re-normalise would
  // re-parent that mark to the magnitude's edge and silently strip it
  // (`"-\u200f5"` → -5) — the #227 round-2 finding. `\s*` keeps the
  // pre-existing `"- 5"` read, pinned below.
  const normalized = normalizeArabicIndicDigits(trimmed);
  if (!/^-\s*\d+$/u.test(normalized)) return null;
  const magnitude = readNormalizedDigits(normalized.slice(1).trim());
  return magnitude === null ? null : -magnitude;
}
