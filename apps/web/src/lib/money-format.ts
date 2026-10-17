/**
 * #254 — the one whole-DZD formatter for BOTH the screen and the printed sheet.
 *
 * Digits are grouped with Western grouping (`1234567` → `1,234,567`) and pinned
 * to `en-US`, never the browser locale: the Arabic locale would print
 * Arabic-Indic digits, and a locale-driven formatter is untestable across
 * machines (see `.agents/wisdom/2026-08-25-real-clock-fixtures-and-time-format-traps.md`).
 * Negative values keep their sign for discounts and signed balances.
 *
 * There is deliberately no second money formatter: a per-surface copy is how
 * the screen ended up printing `92500` while the paper printed `92,500`.
 */

const groupedWestern = new Intl.NumberFormat("en-US");

/**
 * `1234567` → `1,234,567`; negatives keep their sign (`-28,800`).
 *
 * A negative zero prints `0`, never `-0`: `reports.tsx` shows COGS as a
 * negation, and a zero figure must not read as a signed one.
 *
 * Amounts are whole DZD by contract, so this is a formatter, not a rounding
 * gate: a fractional value is formatted as `Intl` sees it (up to three
 * decimals) and the tests pin that, rather than silently inventing a rule.
 */
export function formatMoney(value: number): string {
  return groupedWestern.format(Object.is(value, -0) ? 0 : value);
}
