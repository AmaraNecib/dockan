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

/** `1234567` → `1,234,567`; negatives keep their sign (`-28,800`). */
export function formatMoney(value: number): string {
  return groupedWestern.format(value);
}
