# Defender — PR #107 / issue #100 (HEAD 0e8ade9)

## What this gets right (defences)

**1. The fallback is the actual defect, and it is retired.** `tError` used to return the literal `UNEXPECTED` on any key miss (`i18n.ts:415` still holds the copy). Now `serverErrorKey` ends in `errorGeneric` and `RETIRED_UNEXPECTED_KEYS` (`i18n.ts:542`) blocks even an explicit `"UNEXPECTED"` string. Conf 10.

**2. Code-first mapping is the right discriminator.** `AUTH_ERROR_KEYS` (`i18n.ts:516`) keys on better-auth's stable `code`; status 429 is used only where the limiter sends no code (`i18n.ts:574-583`). Text matching is explicitly the last resort, anchored per producer, and its justification is in-code (`i18n.ts:533`). Conf 9.

**3. Rules are mirrored, not changed.** `MIN_PASSWORD_LENGTH = 4` (`App.tsx:14`) mirrors `packages/contracts/src/core.ts:471,483`; `authFieldKey` (`App.tsx:68`) calls the shared `normalizeAlgerianPhone`. The test `setup: exactly four characters is accepted…` submits `00213 550 123 123` and asserts `firstTimeSetupCalls === 1`, proving no over-rejection — the reason `maxLength` was rightly refused. Conf 9.

**4. The pre-submit check is what issue #100 §4 asked for.** The spec says "the UI should prevent the input before submitting"; `report()` + `authErrorField` (`App.tsx:54`) turn that into an Arabic field-level message instead of a round trip. Conf 8.

**5. `busyRef` is not redundant with `disabled`.** `disabled` does not stop an implicit Enter submit; the guard at `App.tsx:214,316,391` closes that door, and the double-submit test asserts `signInCalls === 1`. Conf 8.

**6. `key={nonce}` remount is the standard live-region re-announce trick.** `nonceRef` (`App.tsx:27`) is documented as monotonic precisely so an identical repeat becomes a new node; the test asserts node identity differs. Conf 8.

**7. Share-not-duplicate.** `useAuthReporter` (`App.tsx:78`) + `AuthErrorAlert` (`App.tsx:93`) removed three copies of `useState<string|null>` and give all three forms identical a11y semantics (`aria-invalid`/`aria-describedby`/focus). Fewer places to drift, not more. Conf 8.

**8. SETUP_ALREADY_DONE → login notice is behaviour-preserving, not scope creep.** Previously the message told the owner to sign in while leaving him on the setup form; now `onDone(key)` lands him on the form that can do it, asserted by the test checking `login-submit` present and `setup-secret` gone. Conf 7.

## Gentleman's false alarms

- "Regex matching is fragile": it is unreachable for any coded error; the code path precedes it.
- "`phoneToUsername` is a behaviour change": it is a literal extract of the old `normalizeAlgerianPhone(x).slice(1)` (`packages/contracts/src/phone.ts:22`).
- "Focus stealing": focus only lands on the blamed field or the alert, only after a submit.
- "`loginNotice` is never cleared": the duplicate-announce risk needs a forgot-password round trip; cosmetic, not a defect.
- "Test-only props (`data-testid`)": consistent with the existing suite.

## Residual risk (FSSR)

E2E specs share one provisioned owner; `provisionOwner` (`tests/e2e/auth-helpers.ts`) makes ordering explicit rather than implicit — acceptable per `docs/engineering-workflow.md`.
