/** Accepts Algerian mobile forms: 0550123123, +213550123123, 213550123123,
 * optionally with spaces/dashes/periods. Returns the +213-normalized number
 * or null when the input is not an Algerian mobile number. */
export function normalizeAlgerianPhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s.()-]/g, "");
  const match = cleaned.match(/^(?:(\+213)|(00213)|(0)|(213))?([5-7]\d{8})$/);
  if (match === null) return null;
  const local = match[5];
  if (local === undefined) return null;
  return `+213${local}`;
}

/** The better-auth username: the normalized phone without the leading +. */
export function phoneToUsername(normalized: string): string {
  return normalized.slice(1);
}