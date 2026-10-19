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
 * this file stays pure scheduling.
 */

/** What one reclaim attempt established. `owner` is the holder when refused. */
export type ReclaimAttemptResult<TOwner> = { ok: true } | { ok: false; owner: TOwner | undefined };

/**
 * An opaque scheduled tick. The module stores and returns it untouched, so it
 * carries the runtime timer inside rather than being the timer type itself: the
 * production scheduler wraps its native handle, and a test can use its own
 * token for a synchronous (no-sleep) run.
 */
export type ReclaimTimerHandle = { readonly native: ReturnType<typeof setTimeout> | number };

export type ReclaimRetryOptions<TOwner> = {
  /** Try to take the folder once. Must not throw: report failure as `ok:false`. */
  attempt: () => ReclaimAttemptResult<TOwner>;
  /** Runs exactly once, when an attempt takes the folder. */
  onAcquired: () => void;
  /** The holder named by a failed attempt, for the refusal copy. */
  onRefused?: (owner: TOwner | undefined) => void;
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

export class ReclaimRetry<TOwner> {
  private readonly backoff: readonly number[];
  private readonly schedule: (fn: () => void, ms: number) => ReclaimTimerHandle;
  private readonly cancel: (handle: ReclaimTimerHandle) => void;
  private pending: ReclaimTimerHandle | undefined;
  /** Consecutive failed attempts: it indexes the backoff schedule. */
  private attempts = 0;
  private acquired = false;
  private inFlight = false;
  private stopped = false;

  constructor(private readonly options: ReclaimRetryOptions<TOwner>) {
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
   * Re-check immediately, cancelling the pending tick, so a deliberate retry
   * is never slower than the automatic one. Returns true when the attempt
   * took the folder.
   */
  trigger(): boolean {
    if (this.acquired || this.stopped) return this.acquired;
    // one attempt at a time: a request landing while the loop is already
    // deciding must not start a second reclaim and race it
    if (this.inFlight) return false;
    this.cancelPending();
    const ok = this.runAttempt();
    if (!ok) this.scheduleNext();
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
      let result: ReclaimAttemptResult<TOwner>;
      try {
        result = this.options.attempt();
      } catch {
        // The attempt broke its half of the contract ("must not throw: report
        // failure as ok:false"). The exception must not escape into the timer
        // callback, where it would kill the loop and strand the refusal: the
        // failure is reported as a refusal instead, and the cadence continues.
        result = { ok: false, owner: undefined };
      }
      if (result.ok) {
        this.acquired = true;
        this.cancelPending();
        this.options.onAcquired();
        return true;
      }
      this.attempts += 1;
      this.options.onRefused?.(result.owner);
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
