# A bounded observation window needs observed time AND a count floor — never a wall-clock deadline

**Date:** 2026-10-15 · **Ticket:** 184 (PR #190, review round 5) · **Area:** tests/e2e/no-write-window.ts, tests/e2e/supplier-adjustment.spec.ts

`expectNoWriteDuring` proved "no opening-balance write during a 1.5 s window"
by sampling every 100 ms under a fixed `deadline = Date.now() + 1500` and then
requiring at least 8 samples. Under CI load the deadline could arrive before
the samples did, so a clean window FAILED. The assertion was measuring the
scheduler, not the write.

The fix, and the general rule:

1. **Keep sampling until both conditions hold**, not "sample until time runs
   out, then check the count": `observedMs >= windowMs && samples >= minSamples`.
   Slowness then extends the sampling instead of failing it.
2. **Measure the window in observed time.** Start the clock at the FIRST
   sample, so a long pause before sampling begins is not banked as a window
   nobody watched. Use `performance.now()` (monotonic), not `Date.now()`.
3. **Yield before each sample** so a pending request handler can set the write
   flag before the sample reads it; a non-yielding injected `wait` must not
   become a false pass.
4. **Pair the fix with a control that fails on a real write.** Otherwise the
   helper can be made unconditionally green and still pass the suite. Prove all
   three: on-schedule pass, slowed-sampler pass, real-write fail. A temporary
   revert of the fix (old deadline) is the sharpest evidence that the delayed
   test discriminates.
