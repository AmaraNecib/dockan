import { beforeEach, describe, expect, it } from "bun:test";

import { createSetupThrottle } from "./setup-throttle";

/** tunables under test, spelled out so the assertions document the defaults */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;
const WINDOW_MS = 5 * 60_000;

describe("createSetupThrottle", () => {
  let now: number;
  let throttle: ReturnType<typeof createSetupThrottle>;

  beforeEach(() => {
    now = 1_000_000;
    // inject the clock: no real sleeping, fully deterministic (see wisdom
    // 2026-08-24 deterministic timing tests)
    throttle = createSetupThrottle({ now: () => now });
  });

  const attempt = () => throttle.recordAttempt();

  it("allows attempts while none are recorded", () => {
    expect(throttle.check()).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("stays allowed below the attempt threshold", () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) attempt();
    expect(throttle.check().allowed).toBe(true);
  });

  it("locks after the threshold attempts and reports retryAfterMs", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) attempt();
    const status = throttle.check();
    expect(status.allowed).toBe(false);
    expect(status.retryAfterMs).toBe(LOCKOUT_MS);
  });

  it("unlocks once the lockout passes and a success clears everything", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) attempt();
    expect(throttle.check().allowed).toBe(false);

    now += LOCKOUT_MS + 1; // wait past the lockout
    expect(throttle.check()).toEqual({ allowed: true, retryAfterMs: 0 });

    throttle.recordSuccess(); // a completed setup clears the state
    attempt(); // ...a later retry must not inherit the old count
    expect(throttle.check().allowed).toBe(true);
  });

  it("requires a fresh burst to lock again once the lockout lifted", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) attempt();
    now += LOCKOUT_MS + 1;
    expect(throttle.check().allowed).toBe(true);
    // counting restarted from zero after the lockout: one more attempt must
    // not instantly re-lock (no creep toward a permanent lock)
    attempt();
    expect(throttle.check().allowed).toBe(true);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) attempt();
    expect(throttle.check().allowed).toBe(false);
    expect(throttle.check().retryAfterMs).toBe(LOCKOUT_MS);
  });

  it("lets scattered attempts decay instead of accumulating into a lockout", () => {
    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      attempt();
      now += WINDOW_MS / 2;
      expect(throttle.check().allowed).toBe(true);
    }
  });

  it("reports a shrinking retryAfterMs as the lockout burns down", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) attempt();
    now += LOCKOUT_MS / 2;
    expect(throttle.check().retryAfterMs).toBe(LOCKOUT_MS / 2);
  });

  it("honors custom tunables", () => {
    const tuned = createSetupThrottle({ now: () => now, maxAttempts: 2, lockoutMs: 5_000, windowMs: 60_000 });
    tuned.recordAttempt();
    expect(tuned.check().allowed).toBe(true);
    tuned.recordAttempt();
    expect(tuned.check()).toEqual({ allowed: false, retryAfterMs: 5_000 });
    now += 5_001;
    expect(tuned.check().allowed).toBe(true);
  });

  it("never extends the lockout while locked (bounded by construction)", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) attempt();
    const deadline = now + LOCKOUT_MS;
    expect(throttle.check().retryAfterMs).toBe(LOCKOUT_MS);

    // hammer with an ADVANCING clock: attempts while locked are no-ops, so
    // the deadline must not move forward
    for (let i = 0; i < MAX_ATTEMPTS * 4; i++) {
      now += 1_000;
      attempt();
    }
    expect(throttle.check().retryAfterMs).toBe(deadline - now);
    expect(throttle.check().retryAfterMs).toBeLessThan(LOCKOUT_MS);

    // and the original deadline still lifts it
    now = deadline + 1;
    expect(throttle.check()).toEqual({ allowed: true, retryAfterMs: 0 });
  });
});
