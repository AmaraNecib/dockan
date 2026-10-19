/**
 * The refused start's reclaim loop (#277).
 *
 * A start refused because another copy owns the folder serves the in-use
 * refusal and keeps trying to take the folder. The loop is deliberately
 * boring: one attempt per tick, a bounded backoff, and an in-flight guard, so
 * a scheduled tick and a deliberate retry can never race into two reclaims.
 * The attempt, the success action and the timers are injected, so the backoff
 * is covered by a unit test that never sleeps for it.
 *
 * It does not know about the lock or the vault: the caller owns the attempt so
 * this file stays pure scheduling. It also does not report WHAT the attempt
 * found — the caller's `attempt` records that itself (the refusal it is serving
 * is built from the error the attempt caught), and a hook nobody consumed was
 * only a second, unused path for the same fact (greptile S4 on #298).
 */

/** What one reclaim attempt established. */
export type ReclaimAttemptResult = { ok: true } | { ok: false };

/**
 * An opaque scheduled tick. The module stores and returns it untouched, so it
 * carries the runtime timer inside rather than being the timer type itself: the
 * production scheduler wraps its native handle, and a test can use its own
 * token for a synchronous (no-sleep) run.
 */
export type ReclaimTimerHandle = { readonly native: ReturnType<typeof setTimeout> | number };

export type ReclaimRetryOptions = {
  /** Try to take the folder once. Must not throw: report failure as `ok:false`. */
  attempt: () => ReclaimAttemptResult;
  /** Runs exactly once, when an attempt takes the folder. */
  onAcquired: () => void;
  /** Bounded schedule (ms); the last entry repeats. */
  backoffMs?: readonly number[];
  /** Timer seams, so tests drive the schedule synchronously. */
  schedule?: (fn: () => void, ms: number) => ReclaimTimerHandle;
  cancel?: (handle: ReclaimTimerHandle) => void;
};

/**
 * Bounded: the last entry repeats, so a folder held forever never spins the
 * CPU and never grows the log. The first wait is short (a crashed holder is
 * usually noticed right away), then the gap doubles up to fifteen seconds.
 */
export const DEFAULT_RECLAIM_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

export class ReclaimRetry {
  private readonly backoff: readonly number[];
  private readonly schedule: (fn: () => void, ms: number) => ReclaimTimerHandle;
  private readonly cancel: (handle: ReclaimTimerHandle) => void;
  private pending: ReclaimTimerHandle | undefined;
  /** Consecutive failed attempts: it indexes the backoff schedule. */
  private attempts = 0;
  private acquired = false;
  private inFlight = false;
  private stopped = false;

  constructor(private readonly options: ReclaimRetryOptions) {
    this.backoff = options.backoffMs ?? DEFAULT_RECLAIM_BACKOFF_MS;
    if (this.backoff.length === 0) throw new Error("the reclaim backoff must have at least one interval");
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const native = setTimeout(fn, ms);
        // a pending reclaim must never keep a closing process alive
        native.unref?.();
        return { native };
      });
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle.native));
  }

  /** True after an attempt has taken the folder. */
  get taken(): boolean {
    return this.acquired;
  }

  /** Schedule the first automatic tick. Idempotent. */
  start(): void {
    if (this.acquired || this.stopped || this.pending !== undefined) return;
    this.scheduleNext();
  }

  /**
   * Re-check immediately, so a deliberate retry is never slower than the
   * automatic one. Returns true when the attempt took the folder.
   *
   * It does NOT touch the armed tick. It used to cancel and re-arm it, which
   * made the schedule a function of the caller: a client polling faster than
   * the cap cancelled the pending tick before it could fire, re-armed it at the
   * cap, and the automatic reclaim never ran at all. An attempt here is an
   * EXTRA attempt on top of the schedule, never a replacement for it (greptile
   * P2 on #298).
   */
  trigger(): boolean {
    if (this.acquired || this.stopped) return this.acquired;
    // one attempt at a time: a request landing while the loop is already
    // deciding must not start a second reclaim and race it
    if (this.inFlight) return false;
    const ok = this.runAttempt();
    // only when nothing is armed (a trigger before start): the schedule stays
    // the loop's own business otherwise
    if (!ok && this.pending === undefined) this.scheduleNext();
    return ok;
  }

  /** Stop the loop (shutdown). Idempotent. */
  stop(): void {
    this.stopped = true;
    this.cancelPending();
  }

  private scheduleNext(): void {
    if (this.stopped || this.acquired) return;
    const index = Math.min(this.attempts, this.backoff.length - 1);
    // SAFETY: index is clamped to the last element's index, which the
    // constructor guarantees exists (a non-empty schedule)
    const delay = this.backoff[index]!;
    this.pending = this.schedule(() => this.tick(), delay);
  }

  private tick(): void {
    this.pending = undefined;
    if (this.stopped || this.acquired) return;
    if (!this.runAttempt()) this.scheduleNext();
  }

  private runAttempt(): boolean {
    if (this.acquired || this.inFlight) return this.acquired;
    this.inFlight = true;
    try {
      let result: ReclaimAttemptResult;
      try {
        result = this.options.attempt();
      } catch {
        // The attempt broke its half of the contract ("must not throw: report
        // failure as ok:false"). The exception must not escape into the timer
        // callback, where it would kill the loop and strand the refusal: the
        // failure is reported as a refusal instead, and the cadence continues.
        result = { ok: false };
      }
      if (result.ok) {
        // A loop that was stopped while this attempt was running reports no
        // acquisition: the caller is shutting down, and an acquisition
        // reported now would publish a port record for a listener that is
        // already closing. The folder is released by the owner's exit hook.
        if (this.stopped) return false;
        this.acquired = true;
        this.cancelPending();
        this.options.onAcquired();
        return true;
      }
      this.attempts += 1;
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  private cancelPending(): void {
    if (this.pending === undefined) return;
    this.cancel(this.pending);
    this.pending = undefined;
  }
}
