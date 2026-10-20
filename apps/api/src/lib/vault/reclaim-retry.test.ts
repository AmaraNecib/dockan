import { describe, expect, it } from "bun:test";

import { DEFAULT_RECLAIM_BACKOFF_MS, ReclaimRetry, type ReclaimTimerHandle } from "./reclaim-retry";

/**
 * A synchronous timer seam: it records every requested delay and lets a test
 * fire the next tick without waiting for it. A passing file here means the
 * backoff is covered without sleeping for its duration (#277).
 */
function fakeScheduler() {
  const delays: number[] = [];
  const cancelled: ReclaimTimerHandle[] = [];
  let queue: { fn: () => void; handle: ReclaimTimerHandle }[] = [];
  let nextHandle = 1;
  return {
    delays,
    cancelled,
    schedule(fn: () => void, ms: number): ReclaimTimerHandle {
      delays.push(ms);
      const handle: ReclaimTimerHandle = { native: nextHandle++ };
      queue.push({ fn, handle });
      return handle;
    },
    cancel(handle: ReclaimTimerHandle): void {
      cancelled.push(handle);
      queue = queue.filter((entry) => entry.handle !== handle);
    },
    fireNext(): void {
      const entry = queue.shift();
      entry?.fn();
    },
    pending(): number {
      return queue.length;
    },
  };
}

describe("vault reclaim retry (#277)", () => {
  it("advances a bounded backoff and repeats the cap", () => {
    const clock = fakeScheduler();
    const retry = new ReclaimRetry({
      attempt: () => ({ ok: false }),
      onAcquired: () => {},
      backoffMs: [10, 20, 30],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    expect(clock.delays).toEqual([10]);
    // each failed tick waits the next interval; the last one repeats forever
    for (let tick = 0; tick < 4; tick += 1) clock.fireNext();
    expect(clock.delays).toEqual([10, 20, 30, 30, 30]);
    expect(retry.taken).toBe(false);
  });

  it("ships a first wait and a cap that cannot spin the CPU", () => {
    // The SHIPPED schedule, not the shape of an injected one: a constant
    // [250, 250, 250] satisfies every shape-only rule while spinning the CPU
    // on every tick. The values below are the shipped ones.
    const schedule: readonly number[] = DEFAULT_RECLAIM_BACKOFF_MS;
    expect(schedule[0]).toBe(250);
    expect(schedule.at(-1)).toBe(15_000);
    // the growth rule: every wait doubles, and the last one is the cap that
    // repeats forever
    for (let index = 0; index < schedule.length - 1; index += 1) {
      expect(schedule[index + 1]).toBe(Math.min(schedule[index]! * 2, 15_000));
    }
    expect([...schedule]).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 15_000]);
  });

  it("start is idempotent: a second start does not double the attempt rate", () => {
    const clock = fakeScheduler();
    let attempts = 0;
    const retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        return { ok: false };
      },
      onAcquired: () => {},
      backoffMs: [10, 20],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    retry.start();
    retry.start();

    // one tick is on the schedule, not three: three starts, three timers, and
    // the folder would be reclaimed three times per backoff window
    expect(clock.delays).toEqual([10]);
    expect(clock.pending()).toBe(1);

    // and one tick means one attempt
    clock.fireNext();
    expect(attempts).toBe(1);

    // a start after a tick is guarded the same way
    retry.start();
    expect(clock.delays).toEqual([10, 20]);
    expect(clock.pending()).toBe(1);
  });

  it("reports no acquisition when the loop is stopped while an attempt runs", () => {
    const clock = fakeScheduler();
    let acquired = 0;
    let attempts = 0;
    let retry: ReclaimRetry;
    retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        // the shutdown stops the loop while this attempt is still running
        retry.stop();
        return { ok: true };
      },
      onAcquired: () => {
        acquired += 1;
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    clock.fireNext();
    expect(attempts).toBe(1);
    // the attempt took the folder, but the loop was stopped: nothing is
    // reported, so the caller never publishes a port record for a listener
    // that is already closing
    expect(acquired).toBe(0);
    expect(retry.taken).toBe(false);
    // and the loop does not re-arm itself after a stop
    expect(clock.pending()).toBe(0);
  });

  it("keeps the loop alive when an attempt breaks its contract and throws", () => {
    const clock = fakeScheduler();
    let attempts = 0;
    const retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        throw new Error("the attempt threw instead of reporting a refusal");
      },
      onAcquired: () => {},
      backoffMs: [10, 20],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    // the scheduled tick must not let the exception escape into the timer
    retry.start();
    expect(() => clock.fireNext()).not.toThrow();
    expect(attempts).toBe(1);
    expect(retry.taken).toBe(false);
    // and the cadence continues: the next tick is still on the schedule
    expect(clock.delays).toEqual([10, 20]);

    // a deliberate retry is guarded the same way
    expect(() => retry.trigger()).not.toThrow();
    expect(retry.taken).toBe(false);
  });

  it("re-checks immediately on trigger without disarming the schedule", () => {
    const clock = fakeScheduler();
    let attempts = 0;
    const retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        return attempts >= 2 ? { ok: true } : { ok: false };
      },
      onAcquired: () => {},
      backoffMs: [10, 20],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    expect(attempts).toBe(0);
    // the screen's retry does not wait for the 10ms tick
    expect(retry.trigger()).toBe(false);
    expect(attempts).toBe(1);
    // ...and the armed tick survives it, so the schedule keeps its own cadence
    expect(clock.cancelled).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    // the next deliberate retry takes the folder, and taking it cancels the
    // tick nothing needs any more
    expect(retry.trigger()).toBe(true);
    expect(retry.taken).toBe(true);
    expect(clock.cancelled).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("a deliberate retry leaves the automatic schedule armed", () => {
    const clock = fakeScheduler();
    let attempts = 0;
    const retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        return { ok: false };
      },
      onAcquired: () => {},
      backoffMs: [10, 20],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    expect(clock.pending()).toBe(1);
    // the owner's retry asks the folder again right away...
    expect(retry.trigger()).toBe(false);
    expect(attempts).toBe(1);
    // ...and leaves the tick the schedule already armed alone. A trigger that
    // cancelled and re-armed would let a client polling faster than the cap
    // hold the automatic tick off forever: the retry rate would be the
    // client's rate, not the backoff's (greptile P2 on #298).
    expect(clock.cancelled).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    clock.fireNext();
    expect(attempts).toBe(2);
  });

  it("runs onAcquired exactly once and never attempts again", () => {
    const clock = fakeScheduler();
    let acquired = 0;
    let attempts = 0;
    const retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        return { ok: true };
      },
      onAcquired: () => {
        acquired += 1;
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    clock.fireNext();
    expect(acquired).toBe(1);
    // no tick was rescheduled after success, and a later trigger is a no-op
    clock.fireNext();
    expect(retry.trigger()).toBe(true);
    expect(attempts).toBe(1);
    expect(acquired).toBe(1);
  });

  it("never re-enters an attempt that is already in flight", () => {
    const clock = fakeScheduler();
    let attempts = 0;
    let nested: boolean | undefined;
    let retry: ReclaimRetry;
    retry = new ReclaimRetry({
      attempt: () => {
        attempts += 1;
        // a request that lands mid-attempt finds the guard and does not race
        nested = retry.trigger();
        return { ok: false };
      },
      onAcquired: () => {},
      backoffMs: [10],
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    clock.fireNext();
    expect(attempts).toBe(1);
    expect(nested).toBe(false);
  });

  it("stop cancels the pending tick", () => {
    const clock = fakeScheduler();
    const retry = new ReclaimRetry({
      attempt: () => ({ ok: false }),
      onAcquired: () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    retry.start();
    retry.stop();
    expect(clock.cancelled).toHaveLength(1);
    expect(clock.pending()).toBe(0);
    // a stopped loop does not re-arm, even on a deliberate trigger
    expect(retry.trigger()).toBe(false);
    expect(clock.pending()).toBe(0);
  });
});
