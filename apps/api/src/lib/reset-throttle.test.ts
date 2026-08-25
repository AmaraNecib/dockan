import { beforeEach, describe, expect, it } from "bun:test";

import { createResetThrottle } from "./reset-throttle";

/** tunables under test, spelled out so the assertions document the defaults */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;
const WINDOW_MS = 5 * 60_000;

describe("createResetThrottle", () => {
  let now: number;
  let throttle: ReturnType<typeof createResetThrottle>;

  beforeEach(() => {
    now = 1_000_000;
    // inject the clock: no real sleeping, fully deterministic (see wisdom
    // 2026-08-24 deterministic timing tests)
    throttle = createResetThrottle({ now: () => now });
  });

  const fail = () => throttle.recordFailure();

  it("allows attempts while no failures are recorded", () => {
    expect(throttle.check()).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("stays allowed below the failure threshold", () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) fail();
    expect(throttle.check().allowed).toBe(true);
  });

  it("locks after the threshold consecutive failures and reports retryAfterMs", () => {
    for (let i = 0; i < MAX_FAILURES; i++) fail();
    const status = throttle.check();
    expect(status.allowed).toBe(false);
    expect(status.retryAfterMs).toBe(LOCKOUT_MS);
  });

  it("unlocks once the lockout passes and a success clears everything", () => {
    for (let i = 0; i < MAX_FAILURES; i++) fail();
    expect(throttle.check().allowed).toBe(false);

    now += LOCKOUT_MS + 1; // wait past the lockout
    expect(throttle.check()).toEqual({ allowed: true, retryAfterMs: 0 });

    throttle.recordSuccess(); // the correct secret went through
    fail(); // ...a later typo must not inherit the old count
    expect(throttle.check().allowed).toBe(true);
  });

  it("requires a fresh burst to lock again once the lockout lifted", () => {
    for (let i = 0; i < MAX_FAILURES; i++) fail();
    now += LOCKOUT_MS + 1;
    expect(throttle.check().allowed).toBe(true);
    // counting restarted from zero after the lockout: one more wrong guess
    // must not instantly re-lock (no creep toward a permanent lock)
    fail();
    expect(throttle.check().allowed).toBe(true);
    for (let i = 0; i < MAX_FAILURES - 1; i++) fail();
    expect(throttle.check().allowed).toBe(false);
    expect(throttle.check().retryAfterMs).toBe(LOCKOUT_MS);
  });

  it("lets scattered failures decay instead of accumulating into a lockout", () => {
    // mis-typed resets during provisioning, minutes apart: no lockout ever
    for (let i = 0; i < MAX_FAILURES * 3; i++) {
      fail();
      now += WINDOW_MS / 2;
      expect(throttle.check().allowed).toBe(true);
    }
  });

  it("reports a shrinking retryAfterMs as the lockout burns down", () => {
    for (let i = 0; i < MAX_FAILURES; i++) fail();
    now += LOCKOUT_MS / 2;
    expect(throttle.check().retryAfterMs).toBe(LOCKOUT_MS / 2);
  });
});
