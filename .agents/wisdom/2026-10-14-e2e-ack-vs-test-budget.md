# Wisdom — 2026-10-14 · Playwright: an ack wait against the test budget, and how to keep it attributable (#191)

Follow-up to `2026-08-24…/2026-10-14-e2e-await-server-ack.md` (#179). The ack
pattern is still right, but #191 shows the failure mode it leaves behind.

## A `page.waitForResponse` timeout says nothing about whether a request was sent
`Error: page.waitForResponse: Test timeout of 30000ms exceeded` is emitted by
whichever wait is outstanding when the *test* budget dies
(`playwright.config.ts` `timeout: 30_000`). It does **not** mean "no POST was ever
sent", and the `waitForResponse` helper sits on a shared line
(`rpc-helpers.ts:16`), so the stack never names the procedure under test. Do not
read a mechanism out of this error; instrument before concluding.

**Always**: when a write's ack times out, treat it as "unknown", and get the app
state before theorising — a temporary instrumented copy of the spec that dumps the
DOM at the moment the last precondition passes (plus `/api/rpc` request/response
timestamps) answers in one run what static reading cannot.

## Ack waits need the app's own state asserted around them
`submit()` refuses client-side and records the refusal synchronously in the click
handler, sending nothing. With an ack armed, that refusal is invisible and burns the
whole budget. Asserting the surfaced state right after the click turns it back into a
named ≤5s failure:

```ts
await actAndAck(page, "invoicesCreate", async () => {
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-error")).toHaveCount(0);  // synchronous refusal
});
await expect(page.getByTestId("sale-save")).toBeEnabled();      // disabled gate
```

**Always**: for every ack, also assert (a) the app is not showing an error and (b)
the control the spec clicks is enabled, both before and immediately after the click.
The pre-click checks catch a stale gate; the in-action check catches a refusal.

## An ack whose value is discarded proves nothing
`await rpcOutput<{ id: string }>(await actAndAck(…))` reads the envelope and throws
the payload away; `rpcOutput` is a bare cast, so it validates nothing. Bind it and
assert it against the UI (`name="quantity-<id>"`), or drop the wrapper.

**Always**: an ack should be consumed. If the design says "server-confirmed id",
assert something with that id.

## Check which procedure the form actually calls
`apps/web/src/pages/sale.tsx` routes the quick-add on the resolved opening stock:
a filled stock quantity takes `itemsCreateWithStock`, a blank one takes `itemsCreate`
(same shape in purchase intake). The #191 brief said to ack `itemsCreate`; arming
that would have hung the full budget by construction. **Always**: before acking, read
the branch — `rg -n "mutate\(" apps/web/src/pages/<page>.tsx` and match the procedure
to the *spec's own inputs*.

## `--repeat-each > 1 --workers=2` is not a load test for specs that write global state
Ten parallel copies of `receipts.spec.ts` overwrite the one store identity
(`settings-name`), so a receipt can render another copy's name and fail at the assert
for that name. `playwright.config.ts` pins `workers: 1` for exactly this shared-DB
reason, and it is a test-isolation artifact, not the bug under investigation.

**Always**: prove concurrency claims with repeated *sequential* runs (fresh DB each
time) or with specs that do not share global rows; report a `--repeat-each` failure
for what it is rather than as evidence.

## CPU throttling cannot emulate "CI was slower"
`Emulation.setCPUThrottlingRate` 6–10 on the pre-fix spec fails at an earlier 5s
`expect().toBeVisible()`, not at the ack — uniform client slowdown is simply a
different profile. A budget overrun needs several seconds of *action-level* delay
(clicks, `goto`, `evaluate` — bounded by the test timeout, not by the 5s expect cap)
summed past 30s. Measure the phase marks (`signed-in=…ms pre-save=…ms`) and compare
the whole suite wall time before blaming the runner.

## Don't claim a mechanism your measurements don't show
0-of-120 runs observing a state is not proof the state is unreachable, and a static
ordering argument is only as good as the library version read. The commit body here
was rewritten to state the uncertainty instead of asserting a swallowed click; the
debate critic caught the overclaim. **Always**: separate "what I measured" from "what
I infer", and put the inference in the design doc/report, not in the commit message
as fact.
