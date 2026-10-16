# Debate — CHARITABLE DEFENDER, issue #129 @ HEAD `ee32c44`

**Repo:** `D:/projects/mani-worktrees/fix-129-numeric-phone` (branch `fix-129-numeric-phone`).
**Base:** `a52084d1de0bda7fd3cb25ec5da5c778f04200ae`; **prior reviewed SHA:** `da727f9`.
**Delta under scrutiny:** 4 added lines in `tests/e2e/rpc-helpers.spec.ts` (only reviewable change since `da727f9`;
`git diff da727f9...HEAD -- apps packages tests` = that hunk alone).

Role: argue FOR the implementation. Every defense cites file:line and carries a confidence score (1–10).
Findings that survived into the prior debate are defended, not re-litigated, unless the delta changes them.

---

## D1 — Delta: handle the abandoned wait at creation (tests/e2e/rpc-helpers.spec.ts:74–77) — confidence 9/10

```ts
61: test("actAndAck reports the action error, not a refused RPC, with no unhandled rejection", …
73:   const refusal = page.waitForResponse(rpcUrl);
74:   // handle the abandoned wait at creation too (see the next test): a fill
75:   // or click that throws before `await refusal` must not surface the
76:   // wait's own rejection on top of the action's error
77:   void refusal.catch(() => undefined);
78:   await page.getByTestId("party-form-name").fill(customerName("action"));
…
81:   await refusal;
```

**Defense.** The inserted `void refusal.catch(() => undefined)` is the *minimal correct* fix for a real
ordering hazard, and it is the same shape the next test already uses. `page.waitForResponse` returns a
promise; until line 81 awaits it, the promise is unhandled. Lines 78–80 perform three awaited UI steps
(fill name, fill phone, click save). Any of those can reject — a flaky selector, a detached node. Without the
creation-time handler, that UI rejection *and* the still-pending `refusal` rejection race to the same
`process.on("unhandledRejection")` listener; the test's whole contract (its title, line 61) is to show the
**action's** error surfaces and nothing is reported unhandled. Attaching `.catch` at creation removes exactly
that masking window and nothing else.

**Correctness of `.catch`.** `.catch()` derives a *new* promise; it does not settle the original. So the
original `refusal` still rejects, and `await refusal` at line 81 still observes the refusal in the normal
path. There is no path where the handler swallows something the test depends on — confirmed by test 3
(`rpc-helpers.spec.ts:146`), which pins that a refused RPC the action does *not* outlive is still reported.

**Consistency.** This mirrors the next test's own abandoned-wait handling (`:118` region, test 2), so the
spec is now internally uniform: every armed wait gets a creation-time handler. That is the maintainable
pattern, not a one-off.

**Evidence it holds.** `.scratch/reviews/129/ee32c44-guard2-rpc-helpers.log` — all 4 tests pass: ok 1
(`:61:1`), ok 2, ok 3, ok 4. Lint (oxlint, exit 0) and typecheck (4/4 turbo tasks) also clean at `ee32c44`.

Residual risk (2/10 chance of mattering): the handler is process/Playwright-semantics pinning, so it can
become a no-op if Playwright ever auto-handles abandoned waits — but it stays harmless and correct.

---

## D2 — Delta is scope-disciplined and behaviour-preserving — confidence 9/10

`git diff da727f9...HEAD -- apps packages tests` is **only** the 4-line hunk. No production file moved, no
assertion changed, no test renamed. The change adds a defensive handler without weakening the "action error
wins" assertion (`expect(thrown?.message).toBe("ACTION_FAILED")`) or the unhandled-rejection filter. This is
exactly the bounded remediation a review delta should be — it closes the Greptile P2 without reopening the
settled design.

---

## D3 — One shared cleaning + predicate, no second normaliser (packages/contracts/src/phone.ts:64–73, 96–101) — confidence 8/10

`cleanPhoneText` (`:71-73`) is extracted once and used by both `isPartyPhoneText` (`:96-101`) and
`normalizePartyPhone` (`:123`). The rule and the stored identity therefore *cannot* drift — directly
addressing the recorded welding class "the separator-only and bidi-mark bugs recurred when cleaning drifted
between call sites." Using the same cleaning means the predicate validates exactly what the normaliser will
persist, so there is no "accepted but stored differently" gap. This is the right architectural instinct:
define the invariant at the identity boundary, near the canonicalizer, not scattered per call site.

---

## D4 — Store remains authoritative; legacy rows untouched (apps/api/src/store/drizzle-store.ts:1218–1225, 1672, 1684) — confidence 8/10

`normalizeValidatedPartyPhone` (`:1218`) throws `PartyError("INVALID_PHONE")` *before* normalising, and is
called from `createParty` (`:1672`) and from `updateParty` only when `patch.phone !== undefined` (`:1684`).
This is the correct authority placement per ADR-0007: a client that bypasses the web form is still refused,
and the RPC contract stays length-only. Critically, `normalizePartyPhone` itself stays permissive
(`phone.ts:117-128`), so **existing** non-numeric rows still match themselves and `displayAlgerianPhone`
still renders them — no migration, no schema change, no data rewrite. That is a deliberate, well-justified
compatibility decision, not an oversight.

---

## D5 — Router switch is exhaustive over the union; API ships stable codes, not text (apps/api/src/rpc/router.ts:2132–2154) — confidence 8/10

`withPartyPhoneRefusals` now switches on `err.code` over `"INVALID_PHONE" | "PHONE_EXISTS"` with no
`default`, and the union is closed in `port.ts:234`. A future `PartyError` code is a compile error until
handled here, so it can never be silently mislabelled as a phone conflict. `INVALID_PHONE → BAD_REQUEST +
"INVALID_PARTY_PHONE"` keeps display text out of the API (localisation stays in the UI) while giving the
client a stable, translatable key. This is the correct layering.

---

## D6 — Server alias gives the direct-API path the same copy (apps/web/src/lib/i18n.ts:979–984, 1000–1002) — confidence 8/10

`SERVER_ERROR_ALIASES` maps `INVALID_PARTY_PHONE → partyPhoneInvalid`. Inline UI validation and a
server-issued refusal therefore render the *same Arabic sentence*; the owner never sees a generic
"validation failed". This resolves the oRPC-refine limitation the design calls out (oRPC collapses refine
messages to a generic string), which is why the rule lives in the store and is aliased back — a coherent
end-to-end story.

---

## D7 — Forms validate only a *changed* phone, so legacy junk stays renameable (apps/web/src/components/parties/party-forms.tsx:78–86, 96) — confidence 9/10

The guard is `if (cleanPhone !== storedPhone && !isPartyPhoneText(phone))`. Checking `cleanPhone !==
storedPhone` first means an untouched legacy value is never re-validated, so a record already holding junk
text can still be renamed — matching the store, which refuses only a changed phone. `storedPhone` is
computed once (`:78`) and reused for the patch diff at `:96`, removing the previous duplicated
`normalizePartyPhone(party.phone)` call. This is careful, correct edge-case handling of exactly the case a
naive implementation would break.

---

## D8 — Picker refuses inline and disables Save (apps/web/src/components/parties/party-picker.tsx:113–116, 155–158, 345–349) — confidence 8/10

`phoneInvalid = !isPartyPhoneText(createPhone)` drives both `createDisabled` (`:115`) and an inline
`role="alert"` with `data-testid=…-invalid-phone` (`:345-349`), plus a defensive `setCreateError` in
`submit` (`:155`). Empty remains valid (`isPartyPhoneText("") === true`), so the optional-phone flow is
preserved. The three-layer refusal (disable, inline copy, submit guard) is the user-facing half of the
identity rule and duplicates the store rule through the *same* shared predicate — agreement is structural,
not incidental.

---

## D9 — Digital-decision is justified and pinned (design §1; packages/contracts/src/phone.ts:96–101) — confidence 9/10

Accepting and normalising Arabic-Indic digits is the right call: the shop owner's Arabic keyboard produces
`٠٥٥…` by default (issue #108), so rejecting it would lock the owner out of the primary input. The rule is
"numeric after folding," not "Algerian mobile," so landlines (`023551234`) and foreign numbers
(`+33123456789`) stay storable — the scope matches the issue's "digits, same rule the rest of the app uses."
Pinned by the unit table and by the Arabic-Indic-vs-ASCII collision test, so the decision is frozen.

---

## D10 — Test coverage spans the contract quadrants (tests/e2e/rpc-helpers.spec.ts, phone-identity.spec.ts; unit suites) — confidence 8/10

The e2e helper spec covers: action error wins + no unhandled (test 1, `:61`), abandoned wait absorbed (test
2), refusal surfaced when action completes (test 3, `:146`), action throws before RPC (test 4, `:165`). It is
a clean quadrant decomposition of the arm/act/refuse contract. Combined with the store/router/unit tables and
`phone-identity.spec.ts`, the change is well-covered. The self-verifying `refused()` counter (`:43-51`)
prevents a stale URL from silently letting a real write into the shared DB — a genuinely good fixture.

---

## Summary

| # | Defense | file:line | Confidence |
|---|---------|-----------|-----------|
| D1 | Delta handler at creation is the minimal correct fix | rpc-helpers.spec.ts:74–77 | 9/10 |
| D2 | Delta is bounded and behaviour-preserving | da727f9...HEAD diff | 9/10 |
| D3 | One shared cleaning + predicate, no drift | phone.ts:64–73,96–101 | 8/10 |
| D4 | Store-authoritative; legacy rows untouched | drizzle-store.ts:1218–1225 | 8/10 |
| D5 | Exhaustive switch; stable codes, no display text | router.ts:2132–2154 | 8/10 |
| D6 | Server alias renders the same copy | i18n.ts:979–984 | 8/10 |
| D7 | Only a changed phone is validated | party-forms.tsx:78–86 | 9/10 |
| D8 | Picker refuses + disables inline | party-picker.tsx:113–116,345–349 | 8/10 |
| D9 | Arabic-Indic accept decision justified + pinned | phone.ts:96–101 | 9/10 |
| D10 | Tests span the arm/act/refuse quadrants | rpc-helpers.spec.ts:61–176 | 8/10 |

**Blocker: none.** The delta is a net improvement: it removes a real (if narrow) failure-masking window and
aligns test 1 with test 2's already-blessed pattern, without touching any settled behaviour. Confidence the
delta is correct and safe to merge: **9/10**.

**Residual risks (carried, not introduced by the delta):** the e2e helper's timing-based `SETTLE_MS` sleeps
(`:17`) remain load-sensitive; `readRpc` is a deliberate parallel client that can drift from
`apps/web/src/lib/rpc.ts`. Neither is changed by this delta.
