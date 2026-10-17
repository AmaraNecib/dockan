import { useTranslation } from "react-i18next";

import { formatMoney } from "@/lib/money-format";
import { cn } from "@/lib/utils";

/**
 * #254 — the ONE place a DZD amount and its currency are rendered.
 *
 * Shape, and why it is fixed:
 *
 * - the figures are one LTR isolate (a `dir="ltr"` span), because Western
 *   digits in an RTL sentence must not be reordered (#119/#166);
 * - a ledger sign (`+` / `−`) is rendered INSIDE that isolate, glued to the
 *   digits it belongs to. A sign outside the isolate is a neutral run: the RTL
 *   row lays it out first, so it lands at the far end of the cell with the
 *   Arabic currency between it and its number — measured in the #254 screenshot
 *   as `92500 د.ج −` reading left-to-right;
 * - the currency is a separate RTL run after a real space, so it is drawn to
 *   the LEFT of the figures in an RTL page — the order the printed sheet uses
 *   and pins (`tests/e2e/invoice-print-a4.spec.ts`). Both surfaces go through
 *   this component, so the two placements can no longer drift.
 *
 * The two runs carry `data-testid="money-figures"` and `money-currency` (no
 * styles) so a test can measure which side the currency lands on in a real
 * browser; `textContent` cannot see a bidi reversal
 * (`.agents/wisdom/2026-10-01-rtl-dates-bidi-and-align.md`).
 *
 * The sign/colour CONVENTION for a supplier balance (whether a sign shows at
 * all, and what green means) is an owner decision and is not made here: this
 * component only places what the caller gives it.
 */
export function Money({
  value,
  sign,
  amountClassName,
  currencyClassName,
}: {
  value: number;
  /** a ledger sign, rendered inside the isolate before the digits */
  sign?: "+" | "−";
  amountClassName?: string;
  currencyClassName?: string;
}) {
  const { t } = useTranslation();
  // A caller that supplies a ledger sign supplies the magnitude: reading the
  // sign of `value` too would print `− -100`.
  const figures = formatMoney(sign === undefined ? value : Math.abs(value));
  return (
    <>
      <span dir="ltr" data-testid="money-figures" className={amountClassName}>
        {sign === undefined ? "" : `${sign} `}
        {figures}
      </span>{" "}
      <span data-testid="money-currency" className={currencyClassName}>{t("currencyDinar")}</span>
    </>
  );
}

/** A DZD amount on screen: grouped digits, mono tabular figures. */
export function Amount({ value, sign, className }: { value: number; sign?: "+" | "−"; className?: string }) {
  return (
    <Money
      value={value}
      sign={sign}
      amountClassName={cn("font-mono tabular-nums", className)}
      // the currency sat inside the figures' mono span before #254; keep its
      // type so unifying the placement is the only visual change
      currencyClassName="font-mono tabular-nums"
    />
  );
}
