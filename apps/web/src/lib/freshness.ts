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
 * sixty seconds is a number they have to re-check by hand.
 *
 * WHICH LEVER CARRIES WHICH CASE, because the two are easy to swap. In
 * `@tanstack/query-core@5.101.4`
 * (`node_modules/@tanstack/query-core/build/modern/focusManager.js:55-60`)
 * `isFocused()` falls back to `document.visibilityState !== "hidden"`; its
 * only listener is `visibilitychange` (`:12-15`), and nothing the browser
 * emits ever assigns `#focused`, so a VISIBLE window reads as focused whether
 * or not the OS gave it the keyboard. Two cases follow:
 *
 *   - visible but unfocused — two windows side by side, the case this ticket
 *     is about. `isFocused()` is already true, so the interval runs with or
 *     without `refetchIntervalInBackground`. The TICK is the only thing that
 *     converges this window: no `visibilitychange` ever arrives, so
 *     `refetchOnWindowFocus` never fires either.
 *   - hidden or minimized. `isFocused()` is false and the interval survives
 *     only because the flag is set. That is all the flag does.
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
 * The tick for a party's balance — the debts drill-down and the refund preview.
 *
 * Same value as `LEDGER_REFETCH_MS` and for a different read: that one bounds a
 * geo whole-ledger projection, this one a single party's open invoices (#340).
 * They are separate constants on purpose — tuning the ledger's bound must not
 * silently move a money panel, and the day one of the two reads changes shape
 * the other's justification is still true.
 */
export const PARTY_BALANCE_REFETCH_MS = 15_000;

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
    // load-bearing only while the document is HIDDEN: for a visible window
    // `isFocused()` is already true, because it answers from
    // `document.visibilityState` and not from OS focus (focusManager.js:55-60)
    // — see the header. A hidden tab's timers are throttled by the browser
    // (about 1/s, and about 1/min under Chromium's intensive throttling), so a
    // minimized window converges on that degraded pace, not on this bound.
    refetchIntervalInBackground: true,
  } as const;
}
