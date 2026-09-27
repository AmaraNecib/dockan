import type { ReactNode } from "react";

interface EmptyStateProps {
  /** Names the single next step, in the product's voice. */
  title: string;
  /** Explains how to take that step. */
  hint?: string;
  /** Decorative icon; hidden from assistive tech by this wrapper. */
  icon?: ReactNode;
  /** The one pressable next step. */
  action?: ReactNode;
}

/**
 * Teaching empty state: names what to do next, explains it, and carries the
 * single pressable action. Not a card — it sits inside the panel it belongs to
 * so the surface hierarchy stays flat (operate.md: empty states teach the
 * interface, not "nothing here").
 */
export function EmptyState({ title, hint, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
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
