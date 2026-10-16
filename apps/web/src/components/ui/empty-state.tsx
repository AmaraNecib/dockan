import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Names the single next step, in the product's voice. */
  title: string;
  /** Explains how to take that step, or why the list is empty when it cannot. */
  hint?: string;
  /** Decorative icon; hidden from assistive tech by this wrapper. */
  icon?: ReactNode;
  /** The one pressable next step, or one primary plus at most one secondary.
   * Omit entirely on a read-only list with no honest action. */
  action?: ReactNode;
  /** Extra classes for the surface the state sits on (border, background, spacing). */
  className?: string;
  /** Lets a spec scope its assertions to this state instead of the whole page. */
  testId?: string;
}

/**
 * Teaching empty state: names what to do next, explains it, and carries the
 * single pressable action. Not a card — it sits inside the panel it belongs to
 * so the surface hierarchy stays flat (operate.md: empty states teach the
 * interface, not "nothing here").
 *
 * A read-only list passes `title` + `hint` only; inventing an action there is
 * worse than a plain statement (issue #96). When an action exists, keep it to
 * one primary step (a second, quieter link is allowed when a list genuinely
 * has two origins, e.g. sale vs purchase invoices).
 */
export function EmptyState({ title, hint, icon, action, className, testId }: EmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-center gap-2 px-4 py-8 text-center", className)}
      data-testid={testId}
    >
      {icon !== undefined && (
        <div className="text-muted-foreground" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="font-medium">{title}</h3>
      {hint !== undefined && <p className="max-w-md text-sm text-muted-foreground">{hint}</p>}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
