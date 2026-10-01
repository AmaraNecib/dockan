/**
 * Algerian mobile phone handling, shared by api, web and contracts schemas.
 * Accepted forms: 0550123123, +213550123123, 213550123123, 00213550123123,
 * plus 06/07 for the second digit, optionally with spaces/dashes/parens.
 * The canonical form returned is "+213" + 9 digits.
 */
const MOBILE_RE = /^(?:(\+213)|(00213)|(0)|(213))?([5-7]\d{8})$/;

export function normalizeAlgerianPhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s.()-]/g, "");
  const match = cleaned.match(MOBILE_RE);
  const local = match?.[5];
  if (local === undefined) return null;
  return `+213${local}`;
}

export function isValidAlgerianPhone(raw: string): boolean {
  return normalizeAlgerianPhone(raw) !== null;
}

/**
 * Bidi/zero-width controls Arabic-first UIs inject on copy/paste (WhatsApp,
 * word processors). `\s` does not match them, so they must be stripped before
 * matching or the same number becomes two identities. Includes U+061C ARABIC
 * LETTER MARK, which is not a format control but behaves like one here.
 */
const PHONE_INVISIBLE_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Fold Arabic-Indic (٠-٩, U+0660-0669) and Extended Arabic-Indic (۰-۹,
 * U+06F0-06F9) digits to ASCII. An Arabic keyboard produces these by default,
 * so `٠٥٥٠١٢٣٤٥٦` and `0550123456` must be one identity — in the store and in
 * the picker's digit search. Exported so the web query heuristics share it.
 */
export function foldArabicDigits(raw: string): string {
  return raw.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (digit) => {
    // SAFETY: the regex above matched exactly one code point, so codePointAt(0)
    // is a number
    const code = digit.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * Identity key for a customer/supplier phone (issue 120). Absent, empty or
 * separator-only clears the value (null, so SQLite keeps treating unset
 * phones as distinct); Arabic-Indic digits fold to ASCII; invisible bidi
 * marks are stripped; an Algerian mobile normalizes to the canonical +213
 * form; anything else is cleaned of separators and kept verbatim, so a shop
 * landline stays storable.
 * Shared by the api store, the uniqueness rule and the web picker's matching.
 */
export function normalizePartyPhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = foldArabicDigits(trimmed).replace(PHONE_INVISIBLE_RE, "");
  const mobile = normalizeAlgerianPhone(cleaned);
  if (mobile !== null) return mobile;
  const fallback = cleaned.replace(/[\s.()-]/g, "");
  // "..." / " - " / a lone bidi mark clean away to nothing: an unset phone,
  // never an empty-string identity that the second walk-in would collide on
  return fallback === "" ? null : fallback;
}

/** The better-auth username: the normalized phone without the leading +. */
export function phoneToUsername(normalized: string): string {
  return normalized.slice(1);
}