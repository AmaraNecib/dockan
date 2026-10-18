# #129 — Edge-case audit (test-audit) @ HEAD ee32c44

Scope read (whole diff vs a52084d): `packages/contracts/src/phone.ts`,
`apps/api/src/store/{drizzle-store.ts,port.ts}`, `apps/api/src/rpc/router.ts`,
`apps/web/src/components/parties/{party-forms.tsx,party-picker.tsx}`,
`apps/web/src/lib/i18n.ts`, and the changed tests
(`party-phone.test.ts`, `party-forms.test.tsx`, `party-picker.test.tsx`,
`drizzle-store.test.ts`, `router.test.ts`, `i18n.test.ts`,
`tests/e2e/{rpc-helpers.ts,rpc-helpers.spec.ts,phone-identity.spec.ts,receipts.spec.ts,customer-name-variants.spec.ts}`).

Audited the delta: `tests/e2e/rpc-helpers.spec.ts` test 1 now carries
`void refusal.catch(() => undefined)` at creation (new file lines 74–77).

Headline: **no red, no orange.** Every edge case below is either already
consistent between `isPartyPhoneText` and `normalizePartyPhone`, or a pinned
design consequence. They are gaps in *test coverage*, not latent bugs. Ratings:
red = would break, orange = subtle bug, yellow = cosmetic/coverage.

---

## The delta (rpc-helpers.spec.ts)

**D1 — `void refusal.catch(...)` handler semantics — no bug (verified).**
`refusal` is a `page.waitForResponse` promise. `.catch()` attaches a rejection
handler to `refusal` itself (the derived promise is voided), so it cannot raise
`unhandledRejection`; and because JS handlers do not mark a promise "consumed",
the later `await refusal` still throws. In the passing path `refusal` *resolves*
(the 500 fixture answers), so the handler is never invoked — the delta only
matters when a `fill`/`click` throws before `await refusal`, which is exactly
the second test's scenario. No double-consumption, no masked assertion.
Consistent with `actAndAck`'s `void output.catch(() => undefined)`
(`rpc-helpers.ts:52`).

**D2 — Route-fanout count — no bug.** Both the test's `refusal` and
`actAndAck`'s internal `waitForRpc` match the same falsified URL; both resolve
on the single 500 request, so `refused()` is 1 as asserted. No race.

## Predicate edges (packages/contracts/src/phone.ts, `isPartyPhoneText` ~line 99)

**E1 — lone `"0"` / short numerics are valid unique identities — YELLOW (pinned).**
`normalizePartyPhone("0") === "0"` and `isPartyPhoneText("0") === true`; a second
walk-in typed `0` collides `PHONE_EXISTS`. This is a direct consequence of the
deliberately numeric-not-mobile rule (pinned by the `"123"` case in
`party-phone.test.ts:88-95`), so it is a decision, not a defect. Worth an
explicit pin so the boundary is intentional:
```ts
it("accepts a bare digit-run that is not a mobile shape", () => {
  expect(isPartyPhoneText("0")).toBe(true);
  expect(normalizePartyPhone("0")).toBe("0");
});
```

**E2 — separator characters collapse into a different number — YELLOW (consistent).**
`"-5"` → `"5"`, `"12.34"` → `"1234"` because `-` `.` are in the separator
class. Predicate and canonicalizer agree (both call `cleanPhoneText`), so no
identity split. Untested; add:
```ts
expect(isPartyPhoneText("-5")).toBe(true);      // '-' is a separator
expect(normalizePartyPhone("12.34")).toBe("1234");
expect(isPartyPhoneText("12.34x")).toBe(false);
```

**E3 — Unicode whitespace (NBSP U+00A0, ideographic U+3000) — YELLOW (consistent).**
`cleanPhoneText` strips via `\s` and `normalizePartyPhone` trims via `trim()`;
both cover these code points, so no drift. Untested:
```ts
expect(isPartyPhoneText("0550\u00a0123123")).toBe(true);
expect(normalizePartyPhone("0550\u00a0123123")).toBe("+213550123123");
```

**E4 — internal newline/tab — YELLOW (consistent).** `"0550\n123123"` cleans to
`"0550123123"`. Uncovered but safe.

**E5 — whitespace-only *create* path (PartyForm) — YELLOW (coverage gap).**
`party-picker.test.tsx` pins whitespace-only as valid, and the store test pins
`phone: null` on update; but no test covers `PartyForm` create with a
whitespace-only phone yielding `{ name }` (no `phone`). The store-level
`normalizeValidatedPartyPhone("   ")` → `null` path is untested on *create*
(only `{ phone: null }` on update, `drizzle-store.test.ts:783`).

**E6 — very long numeric run / length boundary — YELLOW.** `isPartyPhoneText` is
linear and has no length cap (by design; the zod schema stays length-only), so
validity and the length rejection are two independent gates. No test exercises
the boundary; low risk, product-authentic.

**E7 — full-width plus U+FF0B (`"＋213..."`) — YELLOW.** Not stripped and not
ASCII `\+`, so `PARTY_PHONE_NUMERIC_RE` rejects. Reasonable; mirror of the
pinned full-width-digit rejection (`party-phone.test.ts:76-82`). No test.

**E8 — `"+"` with only separators (`"+ -"`) — YELLOW.** Cleans to `"+"`,
rejected; effectively covered by the `"+"` case. No new test needed.

## UI/store consistency edges

**E9 — legacy-junk rename gate (`party-forms.tsx` ~line 84) — no bug, well covered.**
`cleanPhone !== storedPhone && !isPartyPhoneText(phone)`: an *unchanged* legacy
`"abc"` is skipped; any *changed* non-numeric value (including `"abcd"` or an
empty clear) is re-checked. The `"abc"`→rename case is pinned
(`party-forms.test.tsx:233`). One uncovered sub-case: stored `"abc"`, operator
types `" abc "` → `cleanPhone === storedPhone` → no write, no check. Safe.

**E10 — picker Save-disabled vs submit re-check — no bug, covered.**
`phoneInvalid` gates the button and `submit` re-checks (`party-picker.tsx:113`,
`:155`); both tested (`party-picker.test.tsx:220`, `:236`, `:249`). Empty stays
valid.

**E11 — router `INVALID_PARTY_PHONE` alias — no bug.** `serverErrorKey` checks
`SERVER_ERROR_ALIASES` before the SCREAMING_SNAKE branch (`i18n.ts:1001`), so
the code resolves even though it has no resource entry; only one alias, no
shadowing. Tested (`i18n.test.ts:195`).

## Verdict
The delta is benign and correct. Remaining items are yellow coverage pins
(E1–E8); none changes a settled decision or masks a current failure. The
numeric-vs-mobile boundary (E1/E2) is the one most worth an explicit test so a
future edit cannot silently tighten or loosen it.
