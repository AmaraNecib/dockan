import { describe, expect, it } from "bun:test";

import { ReclaimRetry, type ReclaimTimerHandle } from "./reclaim-retry";
import { RECLAIM_RETRY_PATH, answerReclaimRetry, isReclaimRetry } from "./refused-request";

/**
 * #277 + greptile P2 on #298: serving a refusal and asking the folder again
 * must not be the same event.
 *
 * The refused start used to run a reclaim attempt on EVERY request. The attempt
 * cancelled the armed backoff tick and re-armed it at the cap, so a client
 * polling faster than the cap kept the automatic tick from ever firing: the
 * attempt rate was the client's, not the schedule's. Only the owner's explicit
 * retry asks the folder now.
 *
 * The poll below runs through `answerReclaimRetry`, the function the refused
 * handler calls, so this test can fail: if the retry branch ever answers polls
 * again (or if it cancelled and re-armed the armed tick, which is the P2
 * regression), `attempts` or `cancelled` move.
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

  it("answers a malformed url as a poll instead of throwing into the handler", () => {
    // the predicate runs on the request path: an unparseable url is not a retry
    expect(() => isReclaimRetry("POST", "http://[")).not.toThrow();
    expect(isReclaimRetry("POST", "http://[")).toBe(false);
  });

  it("answers 200 with `taken` for the retry, and asks once", () => {
    let asked = 0;
    const response = answerReclaimRetry(new Request(`http://localhost${RECLAIM_RETRY_PATH}`, { method: "POST" }), () => {
      asked += 1;
      return true;
    });
    expect(response?.status).toBe(200);
    expect(asked).toBe(1);
  });

  it("keeps the automatic schedule firing while a client polls faster than the cap", async () => {
    const clock = armedTicks();
    let attempts = 0;
    const retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        return { ok: false };
      },
      onAcquired: () => {},
      backoffMs: [15_000],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    expect(clock.pending()).toBe(1);

    // the client polls far faster than the fifteen-second cap, and every poll
    // goes through the handler's own retry branch
    for (let poll = 0; poll < 200; poll += 1) {
      const answered = answerReclaimRetry(new Request(`http://localhost/api/vault/status?ts=${poll}`), () => retry.trigger());
      // a poll is served as the refusal, never answered as a retry
      expect(answered).toBeUndefined();
    }
    // ...and it asked the folder zero times, and never touched the armed tick
    expect(attempts).toBe(0);
    expect(clock.cancelled).toHaveLength(0);

    // the schedule the loop armed at start still fires on its own
    clock.fireNext();
    expect(attempts).toBe(1);
    // and the next tick is armed from the loop, not from a request
    expect(clock.pending()).toBe(1);

    // the owner's retry is an EXTRA attempt on top of the schedule: it fires
    // now and leaves the armed tick alone (cancel + re-arm is the P2 bug)
    const answered = answerReclaimRetry(new Request(`http://localhost${RECLAIM_RETRY_PATH}`, { method: "POST" }), () =>
      retry.trigger(),
    );
    expect(attempts).toBe(2);
    expect(clock.cancelled).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    expect(await answered?.json()).toEqual({ ok: true, taken: false });
  });

  it("the client's rate never owns the schedule, however often it asks (#298)", () => {
    // The stronger pin, and the one that survives the mutations the routing test
    // above cannot see: here EVERY poll asks for an immediate attempt, which is
    // exactly the old behaviour (a request flipped the loop). Three mutations
    // die here:
    //   1. deleting the poll loop      -> attempts stays 0, not 200
    //   2. cancel-and-re-arm trigger()  -> `cancelled` is non-empty
    //   3. an attempt armed per request -> more than one pending tick
    const clock = armedTicks();
    let attempts = 0;
    const retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        return { ok: false };
      },
      onAcquired: () => {},
      backoffMs: [15_000],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    for (let poll = 0; poll < 200; poll += 1) retry.trigger();

    // every poll did ask, and every ask was answered as a failed attempt
    expect(attempts).toBe(200);
    // ...and the schedule is exactly where start() left it: one armed tick,
    // never cancelled, never re-armed at the cap by a request
    expect(clock.pending()).toBe(1);
    expect(clock.cancelled).toHaveLength(0);

    // the tick armed at start still fires on its own, from the loop's schedule
    clock.fireNext();
    expect(attempts).toBe(201);
    expect(clock.pending()).toBe(1);
  });
});
