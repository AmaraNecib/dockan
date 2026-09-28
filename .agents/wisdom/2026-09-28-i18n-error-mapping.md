# Wisdom: mapping server failures to user copy (i18n + better-auth)

Lessons from issue #100 (login/error copy, `apps/web` only).

## i18next `defaultValue` is returned literally — it is NOT translated (🟠 Major)

A bug report said `i18n.t(sentence, { defaultValue: "UNEXPECTED" })` rendered the
Arabic `حدث خطأ غير متوقع`. Probing the real instance showed it returns the raw
string `"UNEXPECTED"`; the Arabic only appeared when the caller hit `?? "UNEXPECTED"`
(the message was `undefined`). Both are wrong, but knowing which one you actually
have changes the fix and the test.

```ts
// real behaviour, bun + i18next v25
i18n.t("Invalid username or password", { defaultValue: "UNEXPECTED" }) // "UNEXPECTED"
i18n.t("UNEXPECTED")                                                   // "حدث خطأ غير متوقع"
```

**Always**: probe an i18n fallback with a throwaway script before trusting a
code-reading of it. Do not make a `defaultValue` a key you also expect to be
translated.

## Model "a key or an error object" as two typed entry points, not one union (🟡 Minor)

The obvious shape `tError(input: string | { code?; message?; status? })` needs a
run-time `typeof input === "string"` — which this repo's anti-slop plugin
(`no-runtime-typeof`) rejects outright, and `no-known-value-widening` rejects
`Record<string, Key>` and anonymous return-type annotations. Two functions keep
the types honest and lint green:

```ts
export function serverErrorKey(message: string | undefined): MessageKey;   // oRPC keys/sentences
export function authErrorKey(error: AuthErrorInput): MessageKey;           // better-auth objects
```

Use `new Map<string, MessageKey>([...])` for code tables (`.get()` returns
`| undefined`, no index-signature cast). Gate "is this a server key?" on
`/^[A-Z][A-Z0-9_]*$/`, not on `Object.hasOwn(resources, message)` — every UI
label is otherwise a valid "error key".

## better-auth error shapes the client actually sees (🟡 Minor)

- Error responses are `APIError.body` serialized: `{ code, message }`; the client
  adds `status` and `statusText`. `result.error.code` is therefore a stable
  discriminator (`INVALID_USERNAME_OR_PASSWORD`, `INVALID_USERNAME`, …).
- The rate limiter returns `429 { message: "Too many requests…" }` with **no
  code**, so the status is the only lockout signal.
- `rateLimit.enabled` defaults to `isProduction` (`create-context.mjs`), so e2e
  and dev runs never hit 429 and the packaged app does. A lockout mapping is
  therefore testable only at unit/component level.
- Zod messages carry no field name (`Too small: expected string to have >=4
  characters`), so a text fallback for a field cannot be anchored to the field.
  Prefer a client pre-check using the shared rule; keep the text match as a
  documented last resort.

## One in-flight guard per submit (🟡 Minor)

`disabled={busy}` on a submit button does not stop an implicit Enter submit; the
second handler runs before React commits `busy`. Keep a `busyRef` mirror and
early-return, and test it by dispatching two `submit` events in one `act` against
a delayed mock.
