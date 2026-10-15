/**
 * Algerian mobile phone handling, shared by api, web and contracts schemas.
 * Accepted forms: 0550123123, +213550123123, 213550123123, 00213550123123,
 * plus 06/07 for the second digit, optionally with spaces/dashes/parens.
 * The canonical form returned is "+213" + 9 digits.
 */
const MOBILE_RE = /^(?:(\+213)|(00213)|(0)|(213))?([5-7]\d{8})$/;

export function normalizeAlgerianPhone(raw: string): string | null {
  // Arabic-Indic and Extended Arabic-Indic digits are what an Arabic keyboard
  // produces by default; fold them to ASCII before matching so ٠٥٥٠١٢٣١٢٣ and
  // 0550123123 are one identity and the owner can never be locked out by the
  // numerals of the language the app is written in (issue #108).
  const cleaned = foldArabicDigits(raw).replace(/[\s.()-]/g, "");
  const match = cleaned.match(MOBILE_RE);
  const local = match?.[5];
  if (local === undefined) return null;
  return `+213${local}`;
}

export function isValidAlgerianPhone(raw: string): boolean {
  return normalizeAlgerianPhone(raw) !== null;
}

/**
 * The LOCAL display form of a stored phone: the canonical +213 form reads back
 * as the local 0-prefixed number (`+213667295778` -> `0667295778`) with no
 * spaces or dashes. Arabic-Indic digits fold first (normalizeAlgerianPhone
 * already does this); an already-local value comes back unchanged; anything
 * that is not the Algerian mobile shape (a landline, a foreign number, junk) is
 * returned verbatim so the owner never sees a blank or a mangled number.
 * Storage stays canonical — this is display only.
 */
export function displayAlgerianPhone(raw: string): string {
  const canonical = normalizeAlgerianPhone(foldArabicDigits(raw));
  if (canonical === null) return raw;
  return `0${canonical.slice("+213".length)}`;
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

/** A numeric identity: digits, at most one leading `+`. */
const PARTY_PHONE_NUMERIC_RE = /^\+?\d+$/;

/**
 * The phone-text rule (issue 129): a present phone is a valid identity only
 * when it is numeric after the SAME cleaning `normalizePartyPhone` applies —
 * fold Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits to ASCII,
 * strip invisible bidi marks, strip the separators space/dot/parens/dash —
 * optionally with one leading `+`.
 *
 * Absent, empty or separator-only text is valid: the phone is optional and
 * clears to unset, so a walk-in with no number still saves. Arabic-Indic
 * digits are ACCEPTED and normalised to Western because the owner's Arabic
 * keyboard produces them by default (issue #108); rejecting them would lock
 * the owner out of the primary input.
 *
 * Deliberately NOT the Algerian-mobile shape: `normalizePartyPhone` keeps a
 * shop landline (`023551234`) and a foreign number (`+33123456789`) storable,
 * so requiring the mobile regex here would reject a legitimate identity.
 * Shared by the api store (authoritative), the contract and the web forms.
 */
export function isPartyPhoneText(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const cleaned = foldArabicDigits(raw).replace(PHONE_INVISIBLE_RE, "").replace(/[\s.()-]/g, "");
  return cleaned === "" || PARTY_PHONE_NUMERIC_RE.test(cleaned);
}

/**
 * Identity key for a customer/supplier phone (issue 120). Absent, empty or
 * separator-only clears the value (null, so SQLite keeps treating unset
 * phones as distinct); Arabic-Indic digits fold to ASCII; invisible bidi
 * marks are stripped; an Algerian mobile normalizes to the canonical +213
 * form; anything else is cleaned of separators and kept verbatim, so a shop
 * landline stays storable.
 * Shared by the api store, the uniqueness rule and the web picker's matching.
 * A caller that persists a NEW value must first accept it with
 * `isPartyPhoneText` (issue 129); this function stays permissive so legacy
 * rows still match themselves and `displayAlgerianPhone` renders them.
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