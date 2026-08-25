/**
 * In-memory attempt lockout for the unauthenticated authResetPassword RPC
 * (issue #52). Fixed lockout after N wrong-secret guesses, with three
 * bounds that keep it DoS-safe on the loopback / shared-laptop threat model:
 *
 * - the lockout is SHORT and bounded — a mis-typed reset mid provisioning
 *   never locks anything forever;
 * - failures older than `windowMs` stop counting, so scattered mistypes
 *   minutes apart never accumulate into a lockout;
 * - a successful reset clears all state.
 *
 * The counter is GLOBAL to the process on purpose: the reset endpoint is the
 * only unauthenticated surface of a single-admin app, and the phone in the
 * input is attacker-supplied, so per-phone keys would be defeated by rotation.
 * State lives in memory: a restart clears it, which costs nothing against a
 * local attacker who can already kill or replace the process.
 */

export type ResetThrottleStatus = {
  allowed: boolean;
  /** ms until the lockout lifts; 0 when allowed */
  retryAfterMs: number;
};

export type ResetThrottleOptions = {
  /** wrong-secret failures tolerated inside one window before locking */
  maxFailures?: number;
  /** how long a lockout lasts */
  lockoutMs?: number;
  /** failures older than this (since the first one) stop counting */
  windowMs?: number;
  /** injectable clock for deterministic tests */
  now?: () => number;
};

export type ResetThrottle = {
  check(): ResetThrottleStatus;
  recordFailure(): void;
  recordSuccess(): void;
};

export function createResetThrottle(options: ResetThrottleOptions = {}): ResetThrottle {
  const maxFailures = options.maxFailures ?? 5;
  const lockoutMs = options.lockoutMs ?? 30_000;
  const windowMs = options.windowMs ?? 5 * 60_000;
  const clockNow = options.now ?? Date.now;

  let failures = 0;
  let firstFailureAt: number | null = null;
  let lockedUntil = 0;

  return {
    check(): ResetThrottleStatus {
      const now = clockNow();
      if (lockedUntil > now) {
        return { allowed: false, retryAfterMs: lockedUntil - now };
      }
      // the lockout lifted: start a fresh window rather than creeping toward
      // a permanent lock
      lockedUntil = 0;
      return { allowed: true, retryAfterMs: 0 };
    },

    recordFailure(): void {
      const now = clockNow();
      // decay: a failure trail older than the window is not an attack burst
      if (firstFailureAt !== null && now - firstFailureAt > windowMs) {
        failures = 0;
        firstFailureAt = null;
      }
      if (firstFailureAt === null) firstFailureAt = now;
      failures += 1;
      if (failures >= maxFailures) {
        lockedUntil = now + lockoutMs;
        // the lockout IS the penalty; restart counting after it lifts
        failures = 0;
        firstFailureAt = null;
      }
    },

    recordSuccess(): void {
      failures = 0;
      firstFailureAt = null;
      lockedUntil = 0;
    },
  };
}
