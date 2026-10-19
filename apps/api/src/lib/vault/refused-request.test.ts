import { describe, expect, it } from "bun:test";

import { ReclaimRetry, type ReclaimTimerHandle } from "./reclaim-retry";
import { RECLAIM_RETRY_PATH, isReclaimRetry } from "./refused-request";

/**
 * #277 + greptile P2 on #298: serving a refusal and asking the folder again
 * must not be the same event.
 *
 * The refused start used to run a reclaim attempt on EVERY request. The attempt
 * cancelled the armed backoff tick and re-armed it at the cap, so a client
 * polling faster than the cap kept the automatic tick from ever firing: the
 * attempt rate was the client's, not the schedule's. Only the owner's explicit
 * retry asks the folder now.
 */

/** The minimum of the real loop's scheduler the rate question needs. */
function armedTicks() {
  const waiting: (() => void)[] = [];
  const cancelled: number[] = [];
  let next = 1;
  return {
    cancelled,
    schedule(fn: () => void): ReclaimTimerHandle {
      waiting.push(fn);
      return { native: next++ };
    },
    cancel(handle: ReclaimTimerHandle): void {
      // SAFETY: this scheduler minted the handle itself, so its native field is
      // the counter it was built from
      cancelled.push(handle.native as number);
    },
    fireNext(): void {
      waiting.shift()?.();
    },
    pending(): number {
      return waiting.length;
    },
  };
}

describe("a refused start's request handling (#277, greptile P2 on #298)", () => {
  it("serves a status poll as a poll, not as a retry", () => {
    // the app polls this route on every screen and every retry; it must never
    // be the thing that asks the folder
    expect(isReclaimRetry("GET", "/api/vault/status")).toBe(false);
    expect(isReclaimRetry("GET", "/api/vault/status?ts=1")).toBe(false);
    expect(isReclaimRetry("HEAD", "/api/vault/status")).toBe(false);
  });

  it("treats only the explicit retry as a retry", () => {
    expect(isReclaimRetry("POST", RECLAIM_RETRY_PATH)).toBe(true);
    // a browser prefetch, a link or a cached GET must not take the folder
    expect(isReclaimRetry("GET", RECLAIM_RETRY_PATH)).toBe(false);
    expect(isReclaimRetry("POST", "/api/vault/reclaim-more")).toBe(false);
    expect(isReclaimRetry("POST", `${RECLAIM_RETRY_PATH}/extra`)).toBe(false);
  });

  it("keeps the automatic schedule firing while a client polls faster than the cap", () => {
    const clock = armedTicks();
    let attempts = 0;
    const retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        return { ok: false, owner: undefined };
      },
      onAcquired: () => {},
      backoffMs: [15_000],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    expect(clock.pending()).toBe(1);

    // the client polls far faster than the fifteen-second cap, and every poll
    // is routed exactly as main.ts routes it
    for (let poll = 0; poll < 200; poll += 1) {
      if (isReclaimRetry("GET", "/api/vault/status")) retry.trigger();
    }
    expect(attempts).toBe(0);
    expect(clock.cancelled).toHaveLength(0);

    // the schedule the loop armed at start still fires on its own
    clock.fireNext();
    expect(attempts).toBe(1);
    // and the next tick is armed from the loop, not from a request
    expect(clock.pending()).toBe(1);
  });
});
