/**
 * Printed-document formatting. The paper uses the app-wide Algerian
 * date/time shape (`01/10/2026 00:34`: day first, 24-hour clock) and
 * Western, grouped digits — never the browser locale, whose Arabic locale
 * would print Arabic-Indic digits and reorder the fields.
 *
 * TODO(dates): swap `formatPrintDateTime` to lib/dates.ts once #119 lands —
 * that lane owns the single app-wide formatter; this copy exists only until
 * then.
 */

const PRINT_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/**
 * `2026-10-01T00:34:15` → `01/10/2026 00:34`. A date-only value (`2026-10-01`)
 * keeps the date alone, because there is no time to show. Anything that is not
 * an ISO local value passes through untouched rather than printing `NaN`.
 */
export function formatPrintDateTime(raw: string): string {
  const match = PRINT_DATE_TIME.exec(raw);
  if (match === null) return raw;
  const [, year, month, day, hours, minutes] = match;
  const date = `${day}/${month}/${year}`;
  return hours === undefined || minutes === undefined ? date : `${date} ${hours}:${minutes}`;
}

/**
 * Whole-dinar amount with thousands separators (`1234567` → `1,234,567`),
 * pinned to `en-US` so the digits stay Western on every machine. Negative
 * values keep their sign for discounts.
 */
export function formatPrintAmount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
