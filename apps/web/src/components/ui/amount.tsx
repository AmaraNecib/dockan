import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/**
 * Renders a DZD amount with LTR isolation and tabular figures.
 * Ensures Western Arabic numerals (0123) render correctly in RTL context
 * and columns align in tables. The currency suffix comes from the catalog so
 * the amount never carries its own copy.
 */
export function Amount({
  value,
  className,
  suffix,
}: {
  value: number | string;
  className?: string;
  suffix?: string;
}) {
  const { t } = useTranslation();
  return (
    <span dir="ltr" className={cn("font-mono tabular-nums", className)}>
      {value} {suffix ?? t("currencyDinar")}
    </span>
  );
}
