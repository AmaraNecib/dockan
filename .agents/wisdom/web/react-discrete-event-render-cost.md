# React flushes discrete events synchronously — filling N controlled inputs re-renders the table N times

**Date:** 2026-10-15 · **Ticket:** #193 · **Area:** apps/web tests (supplier-opening-balance)

## The failure looks like a timeout, not a render-cost problem (🟠 Major)

`SupplierOpeningBalancePage`'s 200-row batch-limit tests seeded 200 controlled
amount inputs by dispatching one real `input` DOM event per row. Each dispatch
is a React **discrete** event, and React flushes discrete events synchronously —
so the 201-row table re-rendered **once per fill** (200 full renders, each with a
Base UI `Select` per row). Measured ~15 s isolated; under ~3× CPU contention the
same test hit its 60 s budget and failed. It already carried a `60_000` override,
so this was *not* Bun's 5 s default.

Scaling probe (fills × 201 rows): 20 → 2.5 s, 50 → 5.0 s, 100 → 7.5 s, 200 →
16.5 s. Linear in fills = one render each.

**Always**: when a test fills many controlled inputs, count the renders, not the
events. A test that "just types 200 values" can be 200 renders.

## `unstable_batchedUpdates` does NOT help (🟡 Minor)

Wrapping the dispatch loop in `unstable_batchedUpdates` (inside or outside
`act`) still produced one render per event. React's discrete-event path flushes
synchronously by design. The only way to batch is to stop using DOM events.

## Fix: call the element's React change handler inside one `act` (💡 Design Principle)

```ts
// setNativeValue sets `.value` through happy-dom's native setter (assigning it
// directly does not notify React)
act(() => {
  for (const input of inputs) {
    setNativeValue(input, "1");
    const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"));
    const props = key === undefined ? undefined : (input as HTMLInputElement & Record<string, { onChange?: (e: { target: HTMLInputElement }) => void }>)[key];
    if (props?.onChange === undefined) {
      input.dispatchEvent(new Event("input", { bubbles: true })); // fallback: correct, slow
      continue;
    }
    props.onChange({ target: input }); // one render for all 200
  }
});
```

This runs the page's real `setRow` handler (the code under test) but batches the
200 state updates into **one** render (~0.1 s). Keep a DOM-event fallback for a
future React rename, and keep other tests in the file on the real event path so
wiring coverage is not lost. 200 renders → 1: the test dropped from ~15 s to
~1-2 s and stayed green while two heavy suites ran at once.

## A fixed timeout cannot be made safe here (🔴 Critical)

The fill loop is synchronous, so Bun cannot pre-empt it at the bound (the
reported duration balloons; the timeout fires only after the loop yields). A
fixed per-test bound is therefore a bet on the host's CPU share: the same test
measured 31 s and 96 s in two runs under identical synthetic load. **Reduce the
cost; do not raise the bound.** If a batch-limit test times out again, look for a
per-fill render before touching the number.
