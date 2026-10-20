/**
 * #295 — the bounded tick the hot counters ride.
 *
 * WHY A TICK AT ALL. TanStack Query refetches a stale query when the window
 * regains focus, so a window the owner clicks into catches up on its own.
 * What that cannot cover is a window that stays open and never gets the
 * focus: two windows side by side on one screen, the one behind the other
 * still visible but unfocused. No focus event fires there, so the number on
 * screen stays exactly as old as the last read made it — which is the v1
 * multi-client gap #294 describes ("a sale in one window must move the
 * stock number in the other").
 *
 * A bounded tick closes it: the counter re-reads the server on a schedule, so
 * the two windows converge without anybody clicking anything.
 *
 * WHY FIVE SECONDS. Two bounds, and only one of them is the server's.
 *
 * The server bound is comfortable: the api answers on the loopback interface
 * and both hot reads are local sql over a local file. Measured on this
 * machine against a shop of 20 items and 500 stock movements —
 * `dashboardSummary` 0.65 ms per read, `itemsList` (50 rows) 0.27 ms per
 * read — so one window ticking every five seconds spends about 0.01% of a
 * core, and two windows about twice that.
 *
 * The binding bound is the human one: a stock number that is at most five
 * seconds behind is a number the owner can act on, and the same number at
 * sixty seconds is a number they have to re-check by hand. The tick is
 * backgrounded as well, because a window the owner is not looking at is
 * exactly the window that has to catch up on its own.
 */
export const HOT_COUNTER_REFETCH_MS = 5_000;

/**
 * The tick for an item's ledger, slower than the counters'.
 *
 * The history read re-reads the WHOLE ledger and projects it, so its cost
 * grows with the shop's history, and the store serializes its calls on one
 * connection — a tick that holds that queue delays the sale writes waiting
 * on it. The running stock column still has to converge; a ledger is not a
 * counter, and fifteen seconds is a number an owner can act on.
 */
export const LEDGER_REFETCH_MS = 15_000;

/**
 * The calm cadence: the bound the queries #295 did NOT make hot keep.
 *
 * Two call sites, both of them for a query that must not ride the 5 s tick:
 *
 *   - the pending-returns badge, whose own bound was 60 s (#118) and which no
 *     criterion of #295 names;
 *   - the getting-started checklist's progress read, which is not a counter at
 *     all and whose SERVER read WRITES (the milestone upsert), so a 5 s
 *     heartbeat would be a preference write and a vault persist every 5 s.
 *
 * Sixty seconds is what both had before #295: the pre-ticket behaviour kept on
 * purpose, not a new pace.
 */
export const SLOW_REFETCH_MS = 60_000;

/**
 * The query options every hot counter carries.
 *
 * `refreshMs` is injectable so a test can run the same wiring on a fast
 * clock; the shipped default is the bound above.
 */
export function hotCounterRefresh(refreshMs: number = HOT_COUNTER_REFETCH_MS) {
  return {
    refetchInterval: refreshMs,
    // a background tab still polls: the unfocused window is the case the
    // tick exists for
    refetchIntervalInBackground: true,
  } as const;
}
