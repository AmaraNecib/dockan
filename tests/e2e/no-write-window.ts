/**
 * The sampling policy behind a "no write happened during a real window"
 * assertion (issue 184). It lives outside the spec so a test can drive it with
 * a deliberately slow wait and with a write that must be caught.
 */

export interface NoWriteSample {
  /** how many times `check` ran */
  samples: number;
  /** the observed span from the first sample to the last, in real ms */
  observedMs: number;
}

/** How long between samples; a window needs at least one sample per two gaps. */
const SAMPLE_MS = 100;

/**
 * Call `check` until BOTH the observed window and the minimum sample count
 * hold, then return. The loop deliberately has no wall-clock deadline: a slow
 * scheduler must extend the sampling, not fail the assertion. `check` may
 * throw (a real write was observed) and that propagates.
 *
 * The window is measured from the FIRST sample on a monotonic clock, so a long
 * pause before the first sample cannot be banked as observed time and a clock
 * adjustment cannot cut the window short; only time that actually carried a
 * sample counts. `wait` is injected so a test can make sampling slow. The
 * sampler yields before every sample so a pending request handler can set the
 * write flag before the sample reads it — a `wait` that never yields must not
 * turn into a false pass.
 */
export async function sampleNoWrite(opts: {
  windowMs: number;
  check: (observedMs: number) => void;
  wait: (ms: number) => Promise<void>;
}): Promise<NoWriteSample> {
  const minSamples = Math.max(1, Math.ceil(opts.windowMs / (SAMPLE_MS * 2)));
  let windowStart: number | undefined;
  let samples = 0;
  let observedMs = 0;
  for (;;) {
    if (windowStart === undefined) windowStart = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    observedMs = performance.now() - windowStart;
    opts.check(observedMs);
    samples += 1;
    if (observedMs >= opts.windowMs && samples >= minSamples) break;
    await opts.wait(SAMPLE_MS);
  }
  return { samples, observedMs };
}
