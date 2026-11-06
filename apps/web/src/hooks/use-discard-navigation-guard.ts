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
  /** A submitted write cannot be discarded or navigated away from. */
  pending?: boolean;
  /** A synchronous write flag for attempts made before React commits the next render. */
  pendingRef?: Readonly<{ current: boolean }>;
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
 * The dirty rule is the caller's, not the hook's: the sale screen counts a typed
 * customer and a typed discount as work, the purchase screen counts the cart's
 * lines AND a typed supplier, note, payment amount, quick-add field or half-made
 * line. Each screen passes a predicate it owns (`purchaseCartDirty`, sale's
 * `draftDirty`); sharing the predicate would silently drop one screen's fields,
 * which is what a review round measured when the two were wired together.
 *
 * The blocker answers with the LIVE dirty flag, never with the value captured
 * when its callback was created: the callback is registered once and outlives
 * the render that created it. The ref is synced in a layout effect, so it is
 * already current before the browser can deliver the click or the popstate that
 * starts a navigation (the same rule as #204's write gates).
 */
export function useDiscardNavigationGuard({ dirty, lineCount, pending = false, pendingRef }: DiscardNavigationGuardOptions): DiscardNavigationGuard {
  const live = useRef({ dirty, lineCount, pending });
  useLayoutEffect(() => {
    live.current = { dirty, lineCount, pending };
  }, [dirty, lineCount, pending]);

  const shouldBlock = useCallback(() => live.current.dirty || live.current.pending || pendingRef?.current === true, [pendingRef]);

  const resolver = useBlocker({
    shouldBlockFn: shouldBlock,
    // The browser's own unload prompt follows the same rule: a screen with
    // nothing to lose leaves without a prompt.
    enableBeforeUnload: shouldBlock,
    withResolver: true,
  });

  // Refuse the attempt, rather than holding a destination until the write settles.
  // A response arriving under another dialog must leave the saved result here.
  useLayoutEffect(() => {
    if (pending && resolver.status === "blocked") resolver.reset?.();
  }, [pending, resolver]);

  const discard = useCallback(() => {
    if (live.current.pending) resolver.reset?.();
    else resolver.proceed?.();
  }, [resolver]);
  const stay = useCallback(() => resolver.reset?.(), [resolver]);

  return { blocked: resolver.status === "blocked" && !pending, lineCount, discard, stay };
}
