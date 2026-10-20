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
 * bound it had.
 */
export function usePendingReturnsCount(refreshMs: number) {
  return useQuery({
    ...orpc.returnsPendingCount.queryOptions(),
    refetchInterval: refreshMs,
    // the badge lives in the shell, which is on screen in the window the owner
    // is NOT looking at — the same reason the hot counters tick in the
    // background (#295)
    refetchIntervalInBackground: true,
  });
}
