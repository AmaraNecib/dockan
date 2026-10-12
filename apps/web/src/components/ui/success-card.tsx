import type { ReactNode } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shared post-save confirmation card (issue #159). One shape for the sale,
 * purchase, return and payment flows: a check mark, the result line, an
 * optional secondary detail line, then a single action row.
 *
 * The row is a wrapping flex in the document's RTL direction, so the first
 * action sits on the right (the primary), and `<SuccessCardSpacer />` pushes
 * the trailing "new / again" action to the far edge. Colour comes only from
 * theme tokens — no raw colours.
 *
 * `role="status"` keeps the save announcement in the same assistive-tech live
 * region the old inline `<p role="status">` provided; callers keep their flow
 * test id on the card root.
 */
export function SuccessCard({
  title,
  detail,
  testId,
  className,
  children,
}: {
  title: ReactNode;
  detail?: ReactNode;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      role="status"
      className={cn("rounded-lg border border-success/40 bg-success/10 p-4", className)}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-success text-success-foreground"
        >
          <Check className="size-3.5" strokeWidth={3} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          {hasDetail(detail) && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-dashed border-success/40 pt-3">
        {children}
      </div>
    </div>
  );
}

/** Pushes the trailing action to the far edge of the RTL action row. */
export function SuccessCardSpacer() {
  return <span aria-hidden="true" className="flex-1" />;
}

/** A detail line is shown only when it actually carries content: `null`,
 * `undefined`, `false` and the empty string must not render an empty styled
 * paragraph (the callers gate on server amounts that can be zero). */
function hasDetail(detail: ReactNode): boolean {
  return detail !== undefined && detail !== null && detail !== false && detail !== "";
}
