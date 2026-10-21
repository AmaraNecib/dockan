import { useBlocker } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef } from "react";

export interface DiscardNavigationGuard {
  /** True while a navigation is held, waiting for the owner's answer. */
  blocked: boolean;
  /** How many lines the held navigation would throw away. */
  lineCount: number;
  /** Let the held navigation happen: the work is discarded on purpose. */
  discard(): void;
  /** Refuse the held navigation: the screen stays exactly as it was. */
  stay(): void;
}

export interface DiscardNavigationGuardOptions {
  /** True while the screen holds work a navigation would throw away. */
  dirty: boolean;
  /** How many lines that work is; the prompt names it. */
  lineCount: number;
}

/**
 * #321 — hold a navigation while the screen holds work worth keeping.
 *
 * The cart is work the owner typed: a purchase line carries a product, a
 * quantity and a unit cost, and twenty of them vanish with a sidebar click.
 * The guard therefore sits at the ROUTER, not at the link: every way out of
 * the screen (a sidebar link, the header action, the browser's back button, a
 * reload) asks the same question, and a link the owner opens in a new tab
 * leaves this tab's cart alone because this tab never navigates.
 *
 * The dirty rule is the caller's, not the hook's: the sale screen counts a
 * typed customer and a typed discount as work, the purchase screen counts the
 * cart's lines. Sharing the rule would silently drop one screen's fields.
 *
 * The blocker answers with the LIVE dirty flag, never with the value captured
 * when its callback was created: the callback is registered once and outlives
 * the render that created it. The ref is synced in a layout effect, so it is
 * already current before the browser can deliver the click or the popstate that
 * starts a navigation (the same rule as #204's write gates).
 */
export function useDiscardNavigationGuard({ dirty, lineCount }: DiscardNavigationGuardOptions): DiscardNavigationGuard {
  const live = useRef({ dirty, lineCount });
  useLayoutEffect(() => {
    live.current = { dirty, lineCount };
  }, [dirty, lineCount]);

  const shouldBlock = useCallback(() => live.current.dirty, []);

  const resolver = useBlocker({
    shouldBlockFn: shouldBlock,
    // The browser's own unload prompt follows the same rule: a screen with
    // nothing to lose leaves without a prompt.
    enableBeforeUnload: shouldBlock,
    withResolver: true,
  });

  const discard = useCallback(() => resolver.proceed?.(), [resolver]);
  const stay = useCallback(() => resolver.reset?.(), [resolver]);

  return { blocked: resolver.status === "blocked", lineCount, discard, stay };
}
