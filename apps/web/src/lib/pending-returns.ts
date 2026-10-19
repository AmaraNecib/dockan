import { useQuery } from "@tanstack/react-query";

import { orpc } from "./rpc";

/**
 * How often the pending-return count re-checks the server when no mutation
 * invalidates it. The shell badge and the dashboard notice share the one
 * `returnsPendingCount` key, so a mutation invalidates both; polling plus the
 * default window-focus refetch keeps a second window's change from leaving the
 * badge stale for the whole session (round-2 finding 2).
 */
export const PENDING_RETURNS_REFRESH_MS = 60_000;

/**
 * One shared pending-return count query for the shell badge and the dashboard
 * notice. Callers must tell `isError` apart from a confirmed zero so a failed
 * read is never rendered as "nothing pending" (round-2 finding 1).
 */
export function usePendingReturnsCount(refreshMs: number = PENDING_RETURNS_REFRESH_MS) {
  return useQuery({
    ...orpc.returnsPendingCount.queryOptions(),
    refetchInterval: refreshMs,
    // the badge lives in the shell, which is on screen in the window the owner
    // is NOT looking at — the same reason the hot counters tick in the
    // background (#295)
    refetchIntervalInBackground: true,
  });
}
