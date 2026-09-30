# Standards axis — PR #107 (feat/100-auth-errors), HEAD 0e8ade9, base 0b4d5a1

## Correct (verified)

- Cast discipline holds the repo lint standard `anti-slop/require-safety-comment-for-type-assertion`
  (`oxlint.config.ts`): `apps/web/src/lib/i18n.ts:558-561`
  `if (RETIRED_UNEXPECTED_KEYS.has(message)) return "errorGeneric";` /
  `// SAFETY: Object.hasOwn above established that this string is a resource key` /
  `return message as MessageKey;`
- Typed entry points instead of a runtime `typeof` union satisfy `anti-slop/no-runtime-typeof`:
  `i18n.ts:505` `export type AuthErrorInput = {` … `authErrorKey(error: AuthErrorInput)`.
- Copy standard from `i-auth-errors.md` ("All copy through `apps/web/src/lib/i18n.ts` — no hardcoded
  Arabic, no English literals in the UI") is met in the UI: `App.tsx:185`
  `return <LoginPage onForgotPassword={() => setView("forgot")} notice={loginNotice} />;` renders via
  `t(key)`; Arabic lives only in resources (`i18n.ts:185-193`).

## Hard violations (documented standard)

1. **Stale gate evidence** — `docs/engineering-workflow.md`: "Evidence filenames must contain the
   exact reviewed HEAD SHA; any later reviewable-file change makes evidence stale." The diff commits
   `.scratch/reviews/100/0646f81-code-review.md` and `.../0646f81-test-audit.md`, but HEAD is
   `0e8ade9` and `git show --stat 0e8ade9` shows `apps/web/src/App.tsx | 52 +++++++++---` and
   `apps/web/src/App.test.tsx | 31 ++++++++++` after it. The committed evidence does not cover the
   reviewed HEAD.
2. **RTL isolation** — `.github/copilot-instructions.md` (Typography): "LTR isolation for DZD
   amounts, dates, times, **phone numbers**, barcodes, invoice numbers, error codes."
   `i18n.ts:190` `INVALID_PHONE_NUMBER: "رقم الهاتف غير صالح. اكتبه بالصيغة الجزائرية مثل 0550123123 أو +213550123123.",`
   embeds raw ASCII phone runs in an RTL sentence with no isolation (`\u2066…\u2069` / `<bdi>`); the
   leading `+` is a neutral run, so the `+213…` variant can render with the sign displaced. Rendered
   by `App.tsx:93` `AuthErrorAlert` inside a `dir`-less `<p role="alert">`.

## Judgement calls (Fowler baseline; no documented rule)

- **Duplicated Code** — the phone example is a literal in four places: `i18n.ts:188`
  `phoneExample: "0550123123",`, `i18n.ts:190` (inline), `tests/e2e/auth-helpers.ts` `PHONE`, and
  `tests/e2e/login.spec.ts:51` `await expect(alert).toHaveText("...مثل 0550123123 أو +213550123123.");`.
  `{{phoneExample}}` interpolation already exists in this file.
- **Duplicated Code / rule mirroring** — `App.tsx:14` `const MIN_PASSWORD_LENGTH = 4;` duplicates the
  contracts `min(4)` the spec says must not change; the comment at `App.tsx:13` concedes the mirror.
- **Divergent Change** — five page-independent helpers now sit in the page file:
  `App.tsx:21` `function useAuthError()`, `:54` `function authErrorField(`, `:68` `function authFieldKey(`,
  `:78` `function useAuthReporter(`, `:93` `function AuthErrorAlert(`. `apps/web/src/lib/` is the
  existing seam for `i18n.ts` / `auth-client.ts` / `rpc.ts`.
- **Duplicated Code** — the submit guard is triplicated: `App.tsx:206` `const busyRef = useRef(false);`
  + `:217` `const fieldKey = authFieldKey(phone, password);`, again at `:301`, again at `:384`/`:392`.
- **Repeated Switches** — `App.tsx:54` `function authErrorField(key: MessageKey)` is a second key→field
  table that must stay in sync with `i18n.ts:516` `const AUTH_ERROR_KEYS = new Map<string, MessageKey>([`.
- **Mysterious Name** — `i18n.ts:185` `errorGeneric: "تعذّر إكمال العملية. أعد المحاولة.",` breaks the
  SCREAMING_SNAKE convention of every neighbouring error key, and `i18n.ts:542`
  `const RETIRED_UNEXPECTED_KEYS = new Set(["UNEXPECTED", "unexpected"]);` keeps naming a key the code
  no longer emits (retained `unexpected` resource is now referenced only by tests).
- **Middle Man** — `i18n.ts:586` `export function tError(message: string | undefined): string {`
  is now a one-line delegate to `serverErrorKey`; kept only as a compatibility shim (justified).
