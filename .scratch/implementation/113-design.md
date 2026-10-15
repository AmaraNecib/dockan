# Issue #113 — auth-error follow-ups (design)

Tier: **Standard** (UI + i18n + tests; no auth logic, no money, no schema).
Base: `origin/develop` @ `a52084d`. Branch: `fix-113-auth-errors`.

## Problem

Deferred findings from the adversarial review of #107 (`0e8ade9`), on top of the
#109 work that moved every auth form off the browser bubble:

1. **Double announcement.** `AuthErrorAlert` always carries `role="alert"`, and
   a blamed field also points at the same paragraph with `aria-describedby`.
   A screen reader announces the message on insertion (live region) and again
   when focus lands on the field (description).
2. **App.tsx helper sprawl (Divergent Change).** Five page-independent auth
   helpers live in `App.tsx`, which also owns the auth gate. The file changes
   for two reasons.
3. **`SERVER_ERROR_KEY` drops translatable keys.** `serverErrorKey` only
   resolves a message when it is both SCREAMING_SNAKE *and* a resource key. A
   producer that ships a non-conforming key with a resource entry gets
   `errorGeneric`. Latent today, but nothing stops it (and one real router
   refusal, `PREFERENCE_NOT_WRITABLE`, already has no resource key and is
   silently flattened).
4. **The login e2e couples to the rate limiter.** It pins the credentials copy
   through the real better-auth path against a shared database. If the e2e
   server ever enables rate limiting the same attempt yields
   `AUTH_TOO_MANY_ATTEMPTS`, so a correct server makes the test red.

## Fix

### 1. One announcement per failure (`AuthErrorAlert`)

The alert becomes a live region **only when it blames no field**. When it
blames a field, the field's `aria-describedby` carries the copy and focus moves
to that field, so no insertion announcement is needed (and none is made).
The component gains a `field: AuthErrorField` prop; `role` is `"alert"` for
`field === null` and omitted otherwise. Four-plus `[role="alert"]` queries in
`App.test.tsx` and two in `tests/e2e/login.spec.ts` move to the stable id
(`#login-error` / `#setup-error`) for field-blamed failures, plus a negative
assertion that the field error is *not* a live region.

Contract: field-less failures (credentials, lockout, unknown, setup conflicts)
keep `role="alert"` and alert focus; field failures are announced via the
field. The id is unchanged, so `aria-describedby` stays valid.

### 2. Extract the helpers to `apps/web/src/lib/auth-errors.tsx`

Move the five named helpers plus their private dependencies:

- `useAuthError`, `authErrorField`, `authFieldKey`, `useAuthReporter`,
  `AuthErrorAlert` (the five in the issue),
- `authTarget` (private to `useAuthReporter`),
- the `AuthErrorField` type (public: `AuthErrorAlert` prop and `App.tsx` form
  state use it).

`setupNameKey` and `PHONE_MAX_LENGTH` stay in `App.tsx`: they are form-submit
and input-presentation constants, not error presentation, and moving them is
churn the issue did not ask for. `App.tsx` keeps only the gate, the two legacy
forms, and their submit logic.

### 3. Parity test: every router refusal is translatable

`serverErrorKey` falls back to `errorGeneric` silently, so a missing key is
invisible. Add a source-scanning parity test in `i18n.test.ts` (same style as
`cell-ltr.test.ts`) that reads `apps/api/src/rpc/router.ts`, extracts every
`ORPCError` `message:` value, and asserts for each:

- it matches the SCREAMING_SNAKE contract `serverErrorKey` gates on (a new
  non-conforming producer fails here instead of rendering generic);
- `serverErrorKey(code) === code` (never `errorGeneric`);
- `tError(code)` is real, non-empty Arabic distinct from the raw code.

A "the scan is not empty" assertion guards against a broken path/regex passing
every loop vacuously. The scan finds `PREFERENCE_NOT_WRITABLE`; add its Arabic
copy so the whole router family resolves.

### 4. The login e2e asserts an allowed key set

The wrong-password spec accepts either `AUTH_INVALID_CREDENTIALS` (rate limiting
off, today) or `AUTH_TOO_MANY_ATTEMPTS` (limiter on), and still rejects the
generic copy. The field-blamed specs move from `getByRole("alert")` to the
stable `#login-error` id.

## Interfaces

`apps/web/src/lib/auth-errors.tsx` (new):
- `export type AuthErrorField`
- `export function useAuthError()`
- `export function authErrorField(key: MessageKey): AuthErrorField`
- `export function authFieldKey(phone: string, password: string): MessageKey | null`
- `export function useAuthReporter(phoneRef, passwordRef, ownerNameRef?, storeNameRef?)`
- `export function AuthErrorAlert({ id, message, errorRef, field })` — new
  `field` prop drives the `role`.

`apps/web/src/lib/i18n.ts`: new resource key `PREFERENCE_NOT_WRITABLE`.

## Planned tests

Component (`bun run test`):
- field-blamed failure: copy is on `#login-error` / `#setup-error`, the field
  is focused and `aria-invalid`/`aria-describedby`, and the paragraph has **no**
  `role="alert"`;
- field-less failure: `role="alert"`, alert focused (existing tests unchanged);
- the new parity test over the router source, including the non-empty guard;
- existing `i18n` tests keep green.

E2E (Playwright, `tests/e2e/login.spec.ts`):
- wrong password: allowed key set `{credentials, too-many-attempts}`, never the
  generic copy;
- malformed phone / empty fields: copy read from `#login-error`, phone focused.

## Risks

- **Cross-app source scan.** The web test reads `apps/api/src/rpc/router.ts`.
  Precedent: `cell-ltr.test.ts` and `a11y-contrast.test.ts` already scan source.
  A moved file fails the non-empty guard loudly rather than passing vacuously.
- **A11y semantics.** Dropping `role="alert"` for field failures relies on the
  description being announced when focus moves to the field (the #100/#109
  contract). Focus already lands on the blamed field; the alert id and copy are
  unchanged. The non-live region is the point of the issue.
- **Repeated field failure.** A second identical field failure re-mounts the
  paragraph but is not re-announced as a live region; the field keeps focus and
  its description. Accepted: the issue trades the double announcement for the
  field description, and only field-less failures must re-announce.
