# Issue #113 — auth-error follow-ups (design)

Tier: **Standard**. Justification: UI copy, one ARIA role contract, a pure module
move and tests — no auth logic, no money math, no schema bump, so none of the
five High-assurance failure modes is reachable.
Base: `origin/develop` @ `850d1f7`. Branch: `fix-113-auth-a11y-mapping`.

## Provenance: the abandoned branch

`fix-113-auth-errors` (`203f5f6`) already contained a sound implementation of
items 1–3, based on an old `develop` (`a52084d`) with no review evidence. This
lane **cherry-picked it** (`6fd2f47`, `-x`) and brought it up to date:

- the parity test's `serverErrorKey(code) === code` assertion is wrong now:
  `INVALID_PARTY_PHONE` was added to `SERVER_ERROR_ALIASES` after `a52084d` and
  legitimately resolves to `partyPhoneInvalid`. The check is now
  `serverErrorKey(code) !== "errorGeneric"` (still fails on a missing/non-conforming key).
- the item-1 pins were incomplete: several field-blamed tests selected
  `#login-error` but never asserted `role` is absent, so they would pass against
  the double-announcement mutant. Every field-blamed case now asserts
  `role` is `null`, and the field-less credentials case asserts
  `role === "alert"`.
- the design doc (this file) is rewritten for the current base; the abandoned
  one named `a52084d` / `fix-113-auth-errors`.

Nothing in the abandoned code was found unsound; the gaps were staleness and
pin strength, both fixed here.

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
   `errorGeneric`. Latent today — no producer emits such a key — but nothing
   stops one (one real router refusal, `PREFERENCE_NOT_WRITABLE`, already had
   no resource key and was silently flattened).
4. **The login e2e couples to the rate limiter.** It pins the credentials copy
   through the real better-auth path against a shared database. If the e2e
   server ever enables rate limiting the same attempt yields
   `AUTH_TOO_MANY_ATTEMPTS`, so a correct server makes the test red.

## Fix

### 1. One announcement per failure (`AuthErrorAlert`)

The alert becomes a live region **only when it blames no field**. When it
blames a field, the field's `aria-describedby` carries the copy and focus moves
to that field, so no insertion announcement is made. The component gains a
`field: AuthErrorField` prop; `role` is `"alert"` for `field === null` and
omitted otherwise. The id is unchanged, so `aria-describedby` stays valid.

The accessibility skill's stock pattern puts `aria-live` on the field wrapper
*and* `role="alert"` on the paragraph (`.agents/skills/accessibility/references/A11Y-PATTERNS.md`,
"Error handling"). That is exactly the double announcement this issue removes;
the project contract is one path per case, with the field's description as the
field-blamed path. Recorded here because it is a deliberate divergence from the
skill's example.

Pins (issue requirement: assert one path per case, not an attribute):

- **field-blamed** (phone, short password, owner/store name): paragraph is read
  by id `#login-error` / `#setup-error`, the blamed field is focused with
  `aria-invalid`/`aria-describedby`, and the paragraph's `role` is `null`;
- **field-less** (credentials, lockout, unknown, transport, setup conflict):
  the paragraph is found by `[role="alert"]`, has `role === "alert"`, and takes
  focus.

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

Pure-move proof: the cherry-pick landed the move and the item-1 role change in
one commit, so "tests untouched" cannot prove the move alone. Instead the move
is proven mechanically — the body of every moved function in
`auth-errors.tsx` is byte-identical to the hunk removed from `App.tsx`; the
only deltas are `export`, the import list, and the item-1 `field`/`role`
addition to `AuthErrorAlert`. `git show 6fd2f47 -- apps/web/src/App.tsx
apps/web/src/lib/auth-errors.tsx` is that diff.

### 3. Parity test: every router refusal is translatable

`serverErrorKey` falls back to `errorGeneric` silently, so a missing key is
invisible. A source-scanning parity test in `i18n.test.ts` (same style as
`cell-ltr.test.ts`) reads `apps/api/src/rpc/router.ts`, extracts every
`message: "…"` value (46 today; the adjustment refusal table at lines 180–186
also funnels into `ORPCError`), and asserts for each:

- it matches the SCREAMING_SNAKE contract `serverErrorKey` gates on — this is
  the item-3 pin: a future non-conforming producer fails here instead of
  rendering generic;
- `serverErrorKey(code)` is **not** `errorGeneric` (a documented alias such as
  `INVALID_PARTY_PHONE` → `partyPhoneInvalid` is allowed);
- `tError(code)` is real, non-empty Arabic distinct from the raw code.

A non-empty scan assertion (`> 40`) guards against a broken path/regex passing
every loop vacuously. The scan finds `PREFERENCE_NOT_WRITABLE`; its Arabic copy
ships. **The regex is not changed** — the issue calls the change optional and
speculative.

### 4. The login e2e asserts an allowed key set

Chosen: **allowed key set**, not account isolation. The wrong-password spec
accepts either the credentials copy (rate limiting off, today) or the lockout
copy (limiter on), and rejects the generic copy. Account isolation would need a
second provisioned owner plus DB cleanup and still shares the limiter's window;
the copy set is the smaller, honest assertion. Field-blamed specs read the
stable `#login-error` id. The rate limiter's real configuration is not touched.

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

Component (`bun test` in `apps/web`):
- field-blamed failure: copy is on `#login-error` / `#setup-error`, the field
  is focused and `aria-invalid`/`aria-describedby`, and the paragraph has **no**
  `role`;
- field-less failure: `role="alert"`, alert focused;
- the parity test over the router source, including the non-empty guard;
- existing `i18n` tests keep green.

E2E (Playwright, `tests/e2e/login.spec.ts`):
- wrong password: allowed key set `{credentials, too-many-attempts}`, never the
  generic copy;
- malformed phone / empty fields: copy read from `#login-error`, field focused.

## Mutation proofs (item 1 and item 3)

- **Item 1:** revert `AuthErrorAlert` to `role="alert"` unconditionally. The
  field-blamed pins (`role` is `null`) must fail; the field-less pins must stay
  green.
- **Item 3:** add a non-conforming producer (`message: "not_a_server_key"`) to
  `apps/api/src/rpc/router.ts`. The parity test must fail on
  `is not a SCREAMING_SNAKE server key`; reverting restores green.

Commands, exit codes and observed failures go in
`.scratch/reviews/113/<sha>-test-audit.md`, not here.

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
