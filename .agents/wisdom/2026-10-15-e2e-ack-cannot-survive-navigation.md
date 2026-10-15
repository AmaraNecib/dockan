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
navigation). A read the page issues on mount has no safe ack there.

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
call. The helpers trust the oRPC `StandardRPCSerializer` envelope (`{ json }`)
and name the invariant in a `SAFETY` comment; they do **not** re-check the shape
at runtime, because this repo's oxlint forbids `typeof` narrowing and `zod` is
not importable from `tests/e2e`. If the serializer ever moves, the symptom is
`expected undefined to be …` at the assertion site — pin the protocol with a
focused helper test rather than a hand-rolled guard.

`body: "{}"` is only correct for a no-input procedure.
