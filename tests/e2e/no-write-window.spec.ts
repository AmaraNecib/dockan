import { expect, test } from "@playwright/test";
import { sampleNoWrite } from "./no-write-window";

/**
 * Round 5: `expectNoWriteDuring` used to require its minimum sample count
 * before a fixed deadline, so a slow scheduler could fail a window that no
 * write ever touched. These tests drive the extracted sampler directly — no
 * page, no fixtures — so the timing policy is proven in isolation:
 *
 * 1. an on-schedule pass still observes the window;
 * 2. a slowed sampler PASSES (the old deadline would have failed it);
 * 3. the sample-count floor still binds when one gap overshoots the window;
 * 4. a real write inside the window still FAILS the sampler, slow gap or not.
 */

const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("the sampler observes the full window when sampling is on schedule", async () => {
  const result = await sampleNoWrite({
    windowMs: 300,
    check: () => undefined,
    wait: realWait,
  });
  expect(result.observedMs).toBeGreaterThanOrEqual(300);
  expect(result.samples).toBeGreaterThanOrEqual(2);
});

test("a slowed sampler passes instead of failing on the old deadline", async () => {
  // 100 ms of requested wait takes 500 ms: the old 600 ms deadline would stop
  // after two samples and then fail its three-sample minimum even though the
  // window is clean
  const result = await sampleNoWrite({
    windowMs: 600,
    check: () => undefined,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms * 5)),
  });
  expect(result.samples).toBeGreaterThanOrEqual(3);
  expect(result.observedMs).toBeGreaterThanOrEqual(600);
});

test("keeps sampling past the window when the sample count is still short", async () => {
  // one 700 ms gap overshoots the 600 ms window, so the window is already
  // satisfied at sample two; only the count floor can keep sampling to three
  const result = await sampleNoWrite({
    windowMs: 600,
    check: () => undefined,
    wait: () => new Promise((resolve) => setTimeout(resolve, 700)),
  });
  expect(result.samples).toBeGreaterThanOrEqual(3);
});

test("a real write inside the window still fails the sampler", async () => {
  let wrote = false;
  await expect(
    sampleNoWrite({
      windowMs: 1500,
      check: (observedMs) => {
        if (wrote) throw new Error(`write observed ${observedMs}ms into the window`);
      },
      // the write lands during the first gap; the next sample must catch it
      wait: () => {
        wrote = true;
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow(/write observed/);
});

test("a real write during a slow gap still fails the sampler", async () => {
  let wrote = false;
  await expect(
    sampleNoWrite({
      windowMs: 1500,
      check: (observedMs) => {
        if (wrote) throw new Error(`write observed ${observedMs}ms into the window`);
      },
      // the round-trip lands mid-gap, not at the instant the gap ends
      wait: async () => {
        await realWait(50);
        wrote = true;
        await realWait(50);
      },
    }),
  ).rejects.toThrow(/write observed/);
});
