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
 * Identity key for a customer/supplier phone (issue 120). Absent or empty
 * clears the value (null, so SQLite keeps treating unset phones as distinct);
 * an Algerian mobile normalizes to the canonical +213 form; anything else is
 * cleaned of separators and kept verbatim, so a shop landline stays storable.
 * Shared by the api store, the uniqueness rule and the web picker's matching.
 */
export function normalizePartyPhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return normalizeAlgerianPhone(trimmed) ?? trimmed.replace(/[\s.()-]/g, "");
}

/** The better-auth username: the normalized phone without the leading +. */
export function phoneToUsername(normalized: string): string {
  return normalized.slice(1);
}