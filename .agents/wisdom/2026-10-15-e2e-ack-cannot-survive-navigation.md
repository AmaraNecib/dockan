# An e2e ack cannot survive a navigation it was armed around (#209)

**Date:** 2026-10-15 · **Issue:** #129 (PR #209 review-fix round 2) ·
**Area:** tests/e2e

The round-1 fix added an ack-based cleanup that armed `actAndAck` around
`page.goto("/customers")`. CI then failed inside that cleanup:

```
response.json: Protocol error (Network.getResponseBody):
No resource with given identifier found
Response body is not available for a response that was navigated away from.
```

## Two distinct races, two shapes

`page.waitForResponse` resolves when the headers land, but the body is fetched
later over the protocol. `actAndAck`'s action was a full-document `goto`:

1. **Arm-around-navigation.** The first `customersList` response after arming was
   issued by the document being *replaced* (the create invalidated the query
   before the `goto` committed). The commit discarded its body, so the later
   `.json()` threw.
2. **Eager read is not enough.** Chaining `.json()` onto the armed promise starts
   the read at header time, but the protocol round-trip still races the document
   swap. Proven: with the eager read, `phone-identity.spec.ts` failed the same
   way.

**Always**: never arm an ack around a `page.goto` (or any full-document
navigation). A read the page issues on mount has no safe ack there. The helper
cannot detect a navigating action, so this stays a review rule; `readRpc` is the
shape that makes it moot.

**Always**: use two shapes deliberately.
- Action that stays on the page → `actAndAck`, with the body read eagerly
  (`.then` on the armed promise, not on an awaited `Response`) so a *later*
  navigation cannot discard it.
- Read the page issues *around* a navigation → navigate first, then read it
  directly. `readRpc` does a fresh `page.evaluate(fetch("/api/rpc/<procedure>",
  POST, "{}", credentials: "include"))` and unwraps `{ json }`. It has no
  Playwright `Response` for a navigation to lose. Mirror the app client's
  `x-vault-session` header (`dokan.vault.session`) if a vault-mode spec uses it.

## Assert the envelope, not just `ok()`

`response.json()` is untyped and `ok()` only proves the server accepted the
call. Both helpers also check that the body carries a `json` field and throw
`<procedure>: unexpected oRPC envelope` otherwise. That check uses
`Object.prototype.hasOwnProperty.call`, not `typeof`: this repo's oxlint forbids
runtime `typeof` narrowing and `zod` is not importable from `tests/e2e`, so a
schema parse is not available at this boundary. Without the check, a serializer
drift surfaces far away — `expected undefined to be …` for `readEnvelope`, and
`Cannot read properties of undefined` for `readRpc`.

`body: "{}"` is only correct for a no-input procedure.

## A promise armed before the action needs its handler before the action

Round 3 of the same review found the second half of this hazard. `actAndAck`
arms the ack, then runs the action, then returns the read. The read is created in
the same tick, but its only handler used to be attached when the action settled —
so a server refusal that arrived **while the action was still running** rejected
`output` with no handler. Node reported it as an unhandled rejection, a second
failure that buried the action's own error.

**Always**: attach the handler at creation. `void output.catch(() => undefined)`
right after arming, and keep the ORIGINAL promise — `.catch` derives a new one,
so `return output` still rejects an awaited call with the refusal. Do not attach
the handler inside the action's `catch`: that is after the window it exists to
close.

Walk for any other promise created before its handler (round-3): `waitForRpc`'s
`page.waitForResponse` promise has its `.then` attached synchronously inside
`readEnvelope`, so it is never handler-less; `readRpc` awaits `page.evaluate`
immediately and its inner `fetch`/`json()` are sequential awaits. `output` was the
only gap. The derived promise from `void output.catch(...)` cannot reject (its
callback returns `undefined`), so it is not a new gap.

Test shape that discriminates: route the procedure to a 5xx, have the action
`await` the refusal and stay in flight a turn, then throw a distinct action
error. Assert the action error surfaces and that the armed read's rejection is not
in the process `unhandledRejection` list. Scope that list assertion to the
procedure name: `workers: 1` gives every spec file the same process, so an
unrelated late rejection must not fail the test for the wrong reason. A second
test where the action completes normally must still see the refusal — that is what
stops a "swallow everything" fix from passing.
