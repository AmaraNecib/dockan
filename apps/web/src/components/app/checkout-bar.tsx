import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface CheckoutBarProps {
  testId: string;
  children: ReactNode;
  className?: string;
}

/**
 * Sticky completion bar for the invoice flows, holding the total and the finish
 * action in the viewport at short window heights.
 *
 * It publishes its own height as `--checkout-bar-height`, which the global
 * focus rule uses for scroll clearance. The bar grows when a debt notice or a
 * save error appears, and a fixed clearance would then leave a keyboard-focused
 * control hidden behind it — so the clearance is measured rather than guessed.
 */
export function CheckoutBar({ testId, children, className }: CheckoutBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (bar === null) return;

    const publishHeight = () => {
      document.documentElement.style.setProperty("--checkout-bar-height", `${bar.offsetHeight}px`);
    };

    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(bar);

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--checkout-bar-height");
    };
  }, []);

  return (
    <div
      ref={barRef}
      className={cn("sticky bottom-0 z-10 -mx-6 border-t border-border bg-card px-6 py-3", className)}
      data-testid={testId}
    >
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}
