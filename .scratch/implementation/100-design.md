# Issue #100 — Login failures say what went wrong (design)

Tier: **Standard**. Base: `origin/develop` @ `0b4d5a1`. Branch: `feat/100-auth-errors`.

## Problem

`tError` treats its input as an i18n **key**:

```ts
export function tError(message: string | undefined): string {
  return i18n.t(message as MessageKey, { defaultValue: "UNEXPECTED" });
}
```

What actually arrives is one of three shapes, and only the first is a key:

| Arrives | Where from | Today renders |
|---|---|---|
| a stable server key (`CATEGORY_EXISTS`) | oRPC error `message` | correct Arabic |
| an English sentence (`Invalid username or password`) | better-auth error `message` | literal `UNEXPECTED` (probed) |
| nothing (`undefined`) | non-Error throws, declined data | empty string |

Where the login screen reaches `UNEXPECTED` (the brief's report) is the
`?? "UNEXPECTED"` / `t("unexpected")` fallbacks plus the raw sentence path; the
owner sees either the raw token or `حدث خطأ غير متوقع`, both of which imply a
crash. A mistyped password or phone is not a crash.

The fix is web-side only: `apps/api` and `packages/contracts` are frozen for
this lane, so no error code, Zod message, or rule changes there.

## Failure cases found

Verified against better-auth 1.7.1 and the contract schemas.

**Login (`authClient.signIn.username`, `App.tsx`).** The endpoint throws
`APIError` with a stable `code`, surfaced by the client as
`result.error.code` (better-fetch `{ code?, message?, status?, statusText? }`):

| Case | Signal | Meaning |
|---|---|---|
| wrong phone or password, unknown phone | `code: INVALID_USERNAME_OR_PASSWORD`, 401 | credentials rejected |
| phone cannot be a username | `code: INVALID_USERNAME`, 422 | malformed phone |
| phone shorter/longer than the validator | `USERNAME_TOO_SHORT` / `USERNAME_TOO_LONG`, 422 | malformed phone |
| too many attempts in the window | HTTP 429, `{ message: "Too many requests…" }`, **no code** | temporary lockout |

A malformed phone currently never reaches better-auth as a phone error: the
form does `normalizeAlgerianPhone(username) ?? ""` and posts an empty username.
That must be caught before the request so the owner is told which field is
wrong.

**Setup / forgot-password (oRPC, `App.tsx`).** The contracts validate the phone
(`.refine(isValidAlgerianPhone, "expected an Algerian mobile…")`) and the
password (`z.string().min(4)`) **before** the handler, so an invalid phone or a
too-short password arrives as an English Zod message — another silent
`UNEXPECTED` today.

**`SETUP_ALREADY_DONE`.** The api throws this key when setup races or is
replayed; it has no translation, so it renders `UNEXPECTED`.

**Audit of the other `tError` call sites.** All feed oRPC `err.message`, which
is a stable key already present in `i18n.ts` (`CATEGORY_EXISTS`,
`PAYMENT_EXCEEDS_REMAINING`, `WRONG_BUILD_SECRET`, `RESET_LOCKED`, …), or a
non-`Error` throw. They keep working unchanged; they only gain the calm
fallback when a key is genuinely missing (e.g. a future api key, or the
`detail.data === undefined` branch in `receipt-print.tsx` / `return-print.tsx`
that renders an empty error box today).

## Keys to add / change (`apps/web/src/lib/i18n.ts`)

| Key | Copy (pace: name the problem, then the recovery) |
|---|---|
| `errorGeneric` (new) | تعذّر إكمال العملية. أعد المحاولة. |
| `AUTH_INVALID_CREDENTIALS` (new) | رقم الهاتف أو كلمة السر غير صحيحة. تحقّق منهما ثم أعد المحاولة. |
| `INVALID_PHONE_NUMBER` (change) | رقم الهاتف غير صالح. اكتبه بالصيغة الجزائرية مثل 0550123123 أو +213550123123. |
| `AUTH_TOO_MANY_ATTEMPTS` (new) | محاولات كثيرة خلال وقت قصير. انتظر دقيقة ثم أعد المحاولة. |
| `AUTH_PASSWORD_TOO_SHORT` (new) | كلمة السر قصيرة جداً. استعمل 4 أحرف على الأقل. |
| `SETUP_ALREADY_DONE` (new) | تم إعداد المتجر مسبقاً. سجّل الدخول برقم هاتفك وكلمة السر. |

`UNEXPECTED` / `unexpected` stay in the resource table (other code/tests may
name them) but `errorKeyFor` redirects them to `errorGeneric`, so no path can
render `حدث خطأ غير متوقع` again.

## Mapping

New public seam in `i18n.ts`:

```ts
type ErrorInput =
  | string
  | { code?: string; message?: string; status?: number }
  | undefined;

/** Resolve an error to the i18n key that names it. */
export function errorKeyFor(input: ErrorInput): MessageKey;

/** Arabic copy for a failure; never "unexpected". */
export function tError(input: ErrorInput): string; // i18n.t(errorKeyFor(input))
```

Precedence, most specific first:

1. **`code`** in a small code→key table (`INVALID_USERNAME_OR_PASSWORD`,
   `INVALID_USERNAME`, `USERNAME_TOO_SHORT`, `USERNAME_TOO_LONG`,
   `PASSWORD_TOO_SHORT`). Stable discriminator, so it wins.
2. **`status === 429`** → lockout. The rate-limit response carries no code, so
   status is the only stable signal.
3. **`message` that is a known resource key** → that key (oRPC path).
   `UNEXPECTED` / `unexpected` are redirected to `errorGeneric`.
4. **`message` matching a documented sentence** → key. Last resort, with the
   reason in the code: the phone refinement and better-auth rate-limit text are
   the only signals the web bundle gets, and the lane is not allowed to change
   the modules that emit them.
5. **anything else** → `errorGeneric`.

## Forms (`App.tsx`)

- **Phone**: pre-submit `normalizeAlgerianPhone` (the same shared rule the
  contracts use) on login, setup, and forgot-password. Invalid → phone key,
  focus the field. This is "how the failure is reached", not a rule change.
- **Password (setup / forgot)**: pre-submit `password.length < MIN_PASSWORD_LENGTH`
  (`4`, mirroring `packages/contracts/src/core.ts`). The inputs drop the native
  `minLength={4}` so the Arabic copy shows instead of a browser-locale bubble;
  `required` stays for the other fields.
- **Presentation**: the login and reset phone fields gain the existing
  `settingsPhoneHint` example (`0550123123` / `+213…`) as placeholder +
  `aria-describedby`, so the owner reaches the right shape before failing.
  **No `maxLength`**: `normalizeAlgerianPhone` strips `[\s.()-]`, so a valid
  grouped form like `00213 550 123 123` is 17 chars. Any bound short enough to
  stop a 12-digit typo also truncates a valid paste, which would change which
  inputs pass — a rule change, not a presentation one. The hint plus the
  specific message is the safe "prevent" here.
- **Announcement**: every auth error paragraph is `role="alert"` +
  `tabIndex={-1}`. Focus: malformed phone → phone field; short password →
  password field; credentials → the alert summary (either field could be the
  typo, so the summary names both); anything else → the alert summary.
- `aria-invalid` is set on the field the error points at.

## Planned tests

**Unit** `apps/web/src/lib/i18n.test.ts` (new):
- each known code/status → its own key, and the keys are pairwise distinct;
- unknown sentence / unknown code / `undefined` / `UNEXPECTED` → `errorGeneric`,
  and never `unexpected`;
- known oRPC keys still resolve; sentence fallbacks resolve.

**Component** `apps/web/src/App.test.tsx` (extend the existing auth-gate
harness): a rejected password renders `AUTH_INVALID_CREDENTIALS` (not
`unexpected`); a malformed phone renders `INVALID_PHONE_NUMBER`, focuses the
phone field, and does not call `signIn`.

**E2E** `tests/e2e/login.spec.ts`: submitting a wrong password shows the
credentials message and not the generic one; a malformed phone shows the phone
message. `auth-helpers.ts` gains `provisionOwner` so both specs are
order-independent (the shared e2e DB is provisioned by the first spec).

## Risks

- **better-auth client error shape.** The mapping depends on `error.code` and
  `error.status` being present. Mitigated by the sentence fallback and by
  asserting the real codes in the E2E run.
- **Locale-neutral guard.** All new copy stays in `i18n.ts`; `App.tsx` gains no
  Arabic literals. `bun run test` runs the guard.
- **Pre-submit checks.** Using the shared phone normalizer and a commented
  length constant keeps the accept/reject sets identical; the api still
  validates everything.
- **No `maxLength`.** Deliberate, argued above; the reviewer may disagree.
