/**
 * In-memory attempt limiter for the unauthenticated `firstTimeSetup` RPC.
 *
 * Provisioning hashes a caller-supplied password before it commits, so a
 * public endpoint is a deliberate CPU cost. The limiter bounds attempts per
 * process: a short, bounded lockout after N attempts inside a window, with
 * attempts older than the window not counting, and a success clearing the
 * state. It is not persisted — a restart clears it, which costs nothing
 * against a local attacker who can already kill or replace the process; the
 * persisted, vault-wide limiter is the recovery lane's job (ADR-0008 §4.3).
 *
 * The counter is global to the process on purpose: the phone in the input is
 * caller-supplied, so per-phone keys would be defeated by rotation, and
 * provisioning is a one-time event on an empty database.
 */

export type SetupThrottleStatus = {
  allowed: boolean;
  /** ms until the lockout lifts; 0 when allowed */
  retryAfterMs: number;
};

export type SetupThrottleOptions = {
  /** attempts tolerated inside one window before locking */
  maxAttempts?: number;
  /** how long a lockout lasts */
  lockoutMs?: number;
  /** attempts older than this (since the first one) stop counting */
  windowMs?: number;
  /** injectable clock for deterministic tests */
  now?: () => number;
};

export type SetupThrottle = {
  check(): SetupThrottleStatus;
  recordAttempt(): void;
  recordSuccess(): void;
};

export function createSetupThrottle(options: SetupThrottleOptions = {}): SetupThrottle {
  const maxAttempts = options.maxAttempts ?? 5;
  const lockoutMs = options.lockoutMs ?? 30_000;
  const windowMs = options.windowMs ?? 5 * 60_000;
  const clockNow = options.now ?? Date.now;

  let attempts = 0;
  let firstAttemptAt: number | null = null;
  let lockedUntil = 0;

  return {
    check(): SetupThrottleStatus {
      const now = clockNow();
      if (lockedUntil > now) {
        return { allowed: false, retryAfterMs: lockedUntil - now };
      }
      // pure time comparison: a lifted lockout needs no state mutation here
      return { allowed: true, retryAfterMs: 0 };
    },

    recordAttempt(): void {
      const now = clockNow();
      // While locked, an attempt is a no-op: hammering cannot extend the
      // lockout, which stays bounded by construction.
      if (lockedUntil > now) return;
      // decay: an attempt trail older than the window is not a burst
      if (firstAttemptAt !== null && now - firstAttemptAt > windowMs) {
        attempts = 0;
        firstAttemptAt = null;
      }
      if (firstAttemptAt === null) firstAttemptAt = now;
      attempts += 1;
      if (attempts >= maxAttempts) {
        lockedUntil = now + lockoutMs;
        // the lockout IS the penalty; restart counting after it lifts
        attempts = 0;
        firstAttemptAt = null;
      }
    },

    recordSuccess(): void {
      attempts = 0;
      firstAttemptAt = null;
      lockedUntil = 0;
    },
  };
}
