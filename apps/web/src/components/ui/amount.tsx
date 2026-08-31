import { cn } from "@/lib/utils";

/**
 * Renders a DZD amount with LTR isolation and tabular figures.
 * Ensures Western Arabic numerals (0123) render correctly in RTL context
 * and columns align in tables.
 */
export function Amount({
  value,
  className,
  suffix = "دج",
}: {
  value: number | string;
  className?: string;
  suffix?: string;
}) {
  return (
    <span dir="ltr" className={cn("font-mono tabular-nums", className)}>
      {value} {suffix}
    </span>
  );
}
