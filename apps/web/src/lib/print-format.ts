/**
 * Printed-document formatting. Dates use the app-wide day-first formatter in
 * lib/dates.ts (`formatDate` / `formatDateTime`, #119); the one thing the
 * paper adds is grouped Western digits — never the browser locale, whose
 * Arabic locale would print Arabic-Indic digits.
 */

/**
 * Whole-dinar amount with thousands separators (`1234567` → `1,234,567`),
 * pinned to `en-US` so the digits stay Western on every machine. Negative
 * values keep their sign for discounts.
 */
export function formatPrintAmount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
