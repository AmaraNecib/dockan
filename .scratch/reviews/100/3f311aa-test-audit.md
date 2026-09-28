# Test audit — issue #100 (HEAD `3f311aa`)

Base: `0b4d5a1`. Reviewed HEAD: `3f311aa`. Tier: **Standard** (pinned by the lane
brief; the workflow table lists "auth login" under High-assurance, but the brief
overrides and mandates no debate).

Tests audited: `apps/web/src/lib/i18n.test.ts`, `apps/web/src/App.test.tsx`,
`tests/e2e/login.spec.ts`, `tests/e2e/auth-helpers.ts`.
Sources: `apps/web/src/lib/i18n.ts`, `apps/web/src/App.tsx`.

Gates at this HEAD: `bun run typecheck` clean, `bun run lint` clean,
`bun run test` 446 api / 256 web / 34 desktop pass, `bun run test:e2e` 27/27.
Audit re-ran the changed tests directly: 21 pass / 0 fail.

Three sub-agent passes ran over the lane (edge hunter, coverage analyst, test
quality reviewer). Actionable findings were fixed in the commits up to
`3f311aa`; the notes below are what remains.

## Edge-case hunter

| # | Finding | Risk | Disposition |
|---|---|---|---|
| 1 | Resource-key collision: any own resource key was accepted as a server error (`tError("password")` rendered the label) | subtle | **Fixed** — `serverErrorKey` now requires `/^[A-Z][A-Z0-9_]*$/`; test added |
| 2 | No in-flight guard: a double submit fired two requests (implicit Enter) | subtle | **Fixed** — `busyRef` guard in all three forms; double-submit test added |
| 3 | Password length boundary (3 vs exactly 4) unpinned | subtle | **Fixed** — 3 rejected / exactly 4 accepted tests; grouped `00213 550 123 123` proves no over-rejection |
| 4 | `SETUP_ALREADY_DONE` had no UI test | subtle | **Fixed** — setup catch test asserts the translated copy |
| 5 | Login `catch` branch (thrown/network failure) untested | subtle | **Fixed** — mock can reject; test asserts `errorGeneric`, not `unexpected`, and button re-enabled |
| 6 | Arabic-Indic digits (`٠٥٥٠١٢٣١٢٣`) rejected as invalid | cosmetic | **Accepted** — `normalizeAlgerianPhone` is the contract rule and the lane may not change it; the message now names the ASCII format. See deferred work in the report. |
| 7 | `SENTENCE_KEYS` password regex is not anchored to "password" (Zod emits no field name) | latent | **Accepted, documented** — only `core.ts:471/483` use `min(4)` today; the client pre-check makes this a bypass-only fallback. |
| 8 | Empty required fields still meet the browser's native bubble, not the Arabic copy | cosmetic | **Accepted** — `required` is unchanged by design; the brief forbids validation changes. |

## Coverage analyst

| Criterion | Coverage | Verdict |
|---|---|---|
| wrong password → specific Arabic message | unit mapping + component render/focus + e2e literal against the real stack | adequate, non-duplicative |
| malformed phone → specific Arabic message | unit (three better-auth codes + validator sentence), component (login + reset, no request fired), e2e literal + focus | strongest criterion |
| no knowable failure renders `حدث خطأ غير متوقع` | unit exhaustively pins `undefined` / unknown code / retired keys / stray UI key → `errorGeneric`; component asserts the form path; e2e asserts absence on both named failures | adequate |
| validation behaviour unchanged | diff touches no api/contracts; exactly-4 accepted + grouped prefixed phone accepted; malformed rejected before any request | adequate |
| announced + focus moves | `role="alert"` on every failure, nonce re-mount for repeats, field/summary focus asserted in component and e2e | adequate |

Residual notes (accepted):
- `unexpected` / `UNEXPECTED` remain in the resource table; no path renders
  them (`serverErrorKey` redirects both), kept so the retirement is explicit and
  the negative assertions stay meaningful.
- No e2e for the generic fallback or the 429 path (covered at unit/component
  level; the rate limiter is disabled outside production, so an e2e 429 would
  need to enable it).
- `AUTH_PASSWORD_TOO_SHORT` from the login better-auth code path is unit-tested,
  not component-tested; the setup/reset pre-submit paths are component-tested.
- `phoneExample` is asserted non-empty by the copy test, not asserted to render.

## Test quality reviewer

Grade: **A− / B+** across the files.

- Names are behaviour sentences tied to the requirement; assertions compare
  against the `i18n.t(...)` oracle and pin `not.toBe(i18n.t("unexpected"))`.
- Isolation: module-level knobs and call counters reset in `afterEach`; roots
  unmounted; `document.body` cleared. e2e is safe with `workers: 1`.
- Strong oracles beyond "doesn't crash": call counters prove the pre-submit
  checks short-circuit, `document.activeElement` proves focus, node identity
  proves the alert re-mounts for re-announcement, `aria-invalid` /
  `aria-describedby` prove the field blame.
- Deductions: `submitForm` uses a fixed 20 ms flush and the double-submit test
  80 ms (deterministic today, but condition polling would be stronger); the
  fill→submit→query block repeats across tests with no table helper; the matrix
  pins only `login-error` for `aria-describedby`, not `setup-error` /
  `forgot-error`.

No finding was left that changes behaviour; the two ring-fenced items
(Arabic-Indic digits, native `required` bubbles) are rule/goal decisions
recorded in the report, not test defects.
