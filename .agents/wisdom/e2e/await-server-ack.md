# Wisdom — 2026-10-14 · Playwright: ack the write before asserting the render (#179)

## A 5 s `expect` on a fresh write is a wall-clock bet the suite keeps losing
`receipts.spec.ts` clicked Save and polled `sale-saved-number` inside Playwright's
default 5 s window. On CI the `invoicesCreate` round-trip outlived the poll and
the spec failed with "element(s) not found" even though the write landed
(`gh run 38395248682`). The fix is not a bigger timeout: arm
`page.waitForResponse` for the procedure *before* the click, assert the response
is ok, and take the asserted value from the response body — server-acknowledged
state, not a guessed render delay.

## The same rule covers the app's own search reads
`arabic-search.spec.ts` seeded six items and searched without waiting for any
create. The catalog query correctly returned zero matches for a row that was not
committed yet, so the UI flickered "previous results → «لا توجد نتائج مطابقة»".
It looked like a query/re-render race in `CatalogSearch`; it was the spec racing
its own `itemsCreate` calls. There was **no app race**. Ack every write the spec
depends on before searching.

## Prove causality with a controlled server delay, not a longer local loop
A throwaway spec copy plus `page.route("**/api/rpc/<procedure>", …)` holding the
first request 10 s makes the flake deterministic: the un-acked spec fails with
the exact reported symptom (`Timeout: 5000ms`, empty state) and the ack-based
spec passes. This is the only cheap way to show a fix is causal rather than a
longer wait; reruns on a fast local box never trigger it.

## Details worth remembering
- oRPC's fetch link POSTs to `/api/rpc/<procedure>` and answers `{ json: <output> }`
  (StandardRPCSerializer). Match `method === "POST"` and the exact `pathname`;
  parse the envelope and assert `ok()` so a refusal fails loudly.
- Arm-then-act must be one call (`actAndAck`) or the wait can be set up after the
  request. Swallow the armed wait if the action itself throws, or teardown
  surfaces it as an unhandled rejection over the real failure.
- Assert the spec's own row, not the aggregate list: the shared catalog is capped
  at `DEFAULT_CATALOG_LIMIT = 20`, and other specs' data shares the DB.
- `parties-search` is **client-side** (`filterParties` over `customersList`), so
  there is no RPC to ack — don't wire a wait that will never fire.
