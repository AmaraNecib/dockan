# HARSH CRITIC — PR #107 / #100 @ 0e8ade9 (base 0b4d5a1)

**Correct (verified):** `phoneToUsername(normalizedPhone)` (App.tsx:328) matches the API validator `^213[5-7]\d{8}$` (auth.ts:29); `authFieldKey` reuses `normalizeAlgerianPhone` so no phone-rule drift (App.tsx:69); `busyRef` sync guard (App.tsx:316) does close the implicit-Enter hole `disabled` misses; the `tError` retirement set really does kill the old `UNEXPECTED` path (`i18n.ts:542,559`).

No blocker ≥8: nothing touches money, stock, or authz, and no crash path found.

```
score | file:line | what breaks and when | how to fix
```

6 | apps/web/src/lib/i18n.ts:523 (`["PASSWORD_TOO_SHORT", "AUTH_PASSWORD_TOO_SHORT"]`) + :192 (`"كلمة السر قصيرة جداً. استعمل 4 أحرف على الأقل"`) | better-auth emits that code under *its own* `minPasswordLength` (default 8), not the contract's 4; if it ever arrives the owner is told "use 4+" and loops on 4-char passwords forever. The 4 is also duplicated four ways (`App.tsx:14 MIN_PASSWORD_LENGTH = 4`, `core.ts:471,483`, and the message string). | Drop `PASSWORD_TOO_SHORT` from the map, or word the copy without a number; export the min from `packages/contracts` and import it in `App.tsx` + copy.

6 | tests/e2e/login.spec.ts:38,51 (`await expect(alert).not.toContainText("حدث خطأ غير متوقع")`) | unreachable after the exact `toHaveText` on the line above: an assertion that can never fail by itself — asserting nothing. | Delete, or assert the retired key explicitly via the i18n unit test (already covered there).

5 | apps/web/src/lib/i18n.test.ts:49 (`serverErrorKey("Password too short")`) | pins a sentence no producer emits; Zod/better-auth emit `Too small: expected string to have >=4 characters` — the author's own wisdom note says so. The test passes while `/password too short|.../` would miss the real string. | Fixture the real emitted sentence and assert the regex against it.

5 | apps/web/src/App.tsx:59 (`if (key === "AUTH_INVALID_CREDENTIALS" …) return "password"`) with :357 (`aria-invalid={authError.state?.field === "password"}`) | a *well-formed but unregistered* phone passes the pre-check at :317, gets the credentials error, and the UI marks the password invalid and focuses it — while the copy (i18n.ts:189) says "الهاتف أو كلمة السر". Screen-reader and sighted users are told the wrong field. | Return `null` for `AUTH_INVALID_CREDENTIALS` (focus the summary) or stop setting `aria-invalid` for it.

4 | apps/web/src/App.tsx:309-312 (deps `[notice, report]`) + :84 (`function report`) | `report` is a new closure each render, so the effect re-runs on *every* render and correctness rests entirely on `noticeShownRef`; any future unguarded report in that effect is an infinite render loop. `loginNotice` (:180) is never cleared, so login→forgot→login re-announces the stale setup notice. | `useCallback` the reporter; clear the notice once consumed.

4 | apps/web/src/lib/i18n.ts:549,558 (`/^[A-Z][A-Z0-9_]*$/` + `Object.hasOwn(resources.ar.translation, message)`) | every *future* `apps/api` key the web bundle doesn't know degrades to "تعذّر إكمال العملية" — the same "knowable failure rendered generic" defect #100 exists to remove, one deploy behind. | Add a test enumerating router messages, or keep a parity list.

4 | spec `.scratch/implementation/i-auth-errors.md` item 4 ("prevent the input before submitting") | not met: the tel field still swallows "12345" and only complains at submit (login.spec.ts:44). | `maxLength`/`pattern` or change-time validation on the phone field.

3 | apps/web/src/App.tsx:276, 434 (`required` now without `minLength={4}`) | native constraint validation and its inline message are gone; only the JS submit path guards. | Keep `minLength` alongside the JS check.

3 | apps/web/src/lib/i18n.ts:533-539 | auth-specific keys come from the *generic* `serverErrorKey`, still called by ~20 non-auth sites (sale.tsx:179, invoice.tsx:69, items.tsx:245…): any 429 or message containing "too many requests" now renders "محاولات كثيرة…". | Move sentence matching into `authErrorKey`.

2 | apps/web/src/App.tsx:272-357 | the alert is simultaneously `role="alert"` and the `aria-describedby` target of the field it focuses → the message is announced twice per failure. | Drop the described-by when the field is focused.

2 | tests/e2e/login.spec.ts:29-40 | pins the credentials message through the real better-auth path against a shared DB; if the e2e server ever runs `isProduction` (rateLimit on) the run yields AUTH_TOO_MANY_ATTEMPTS instead. | Assert an allowed key set, or isolate.

1 | apps/web/src/lib/i18n.ts:188 | phone example digits duplicated (placeholder vs the INVALID_PHONE_NUMBER sentence vs core.ts:473). | Single source.

1 | i18n.test.ts:57, App.test.tsx:219 | `i18n.t("unexpected")` has no key and returns the literal token, so `not.toBe(i18n.t("unexpected"))` compares against a token, not rendered copy. | Assert against `t("UNEXPECTED")`/`errorGeneric`.
