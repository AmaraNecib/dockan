import { useQuery } from "@tanstack/react-query";

import { orpc } from "./rpc";

/**
 * One shared pending-return count query for the shell badge and the dashboard
 * notice. Callers must tell `isError` apart from a confirmed zero so a failed
 * read is never rendered as "nothing pending" (round-2 finding 1).
 *
 * `refreshMs` is REQUIRED, not defaulted: the badge and the notice live in
 * the window the owner is NOT looking at, so the interval is a product
 * decision the call site makes, and a silent default would let a new call
 * site poll at a pace nobody chose. Both call sites pass `SLOW_REFETCH_MS`:
 * #295 made two counters hot and never named this badge, so it keeps the
 * CADENCE it had. The background flag is new on this branch and is the one
 * thing #295 gave this hook: a hidden window's interval would otherwise stop.
 * For a visible window the flag changes nothing — see `freshness.ts`'s header
 * for which lever carries which case.
 */
export function usePendingReturnsCount(refreshMs: number) {
  return useQuery({
    ...orpc.returnsPendingCount.queryOptions(),
    refetchInterval: refreshMs,
    // a hidden window keeps its badge current; a visible one already ticks,
    // flag or no flag (freshness.ts: the focus manager answers from
    // document.visibilityState, so `isFocused()` is true for a visible window
    // even when the OS never gave it the keyboard)
    refetchIntervalInBackground: true,
  });
}
