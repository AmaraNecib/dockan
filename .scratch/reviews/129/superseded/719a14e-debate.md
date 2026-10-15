> Reviewed implementation SHA: `0631081c1a30ac6e0df37b046f95064407985e9d`. Final evidence SHA: `719a14e4c5b085b72df43ce999df77d17b2318d6` (only `.agents/wisdom/` changed after the reviewed commit — no product code).

# Debate evidence — issue #129 (High-assurance)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`, merge-base).
**Reviewed:** `7f0540a` (first implementation commit).
**Final:** `0631081c1a30ac6e0df37b046f95064407985e9d` (fixes applied, re-verified).

Critic and defender ran in parallel against `git diff 21dbc13...7f0540a`; a
focused verifier re-read `7f0540a..0631081` to confirm resolutions.

## Critic findings and dispositions

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| F1 | 6 | `party-forms.tsx` validated the phone before the changed-field check, so a legacy record holding junk (`"abc"`) could no longer be renamed. | **Fixed.** Validation is now gated on `cleanPhone !== storedPhone`; name-only edits of a legacy record skip it and are covered by a new component test. |
| F2 | 5 | The issue's `«١٢٣»` example folds to numeric `123` and is accepted. | **Dismissed as designed.** The brief asks to decide Arabic-Indic accept+normalise vs reject. Accepting is right for this Arabic-keyboard shop (issue #108); the rule is numeric, not the Algerian-mobile shape, so landlines/foreign numbers stay storable. Decision pinned by test (`normalizePartyPhone("١٢٣") === "123"`). A minimum-plausibility floor is out of scope and risks rejecting legitimate short numbers. |
| F3 | 4 | Separator/invisible cleaning was copy-pasted between `isPartyPhoneText` and `normalizePartyPhone` (drift risk in identity-critical code). | **Fixed.** One private `cleanPhoneText` now feeds both. |
| F4 | 2 | Collapsed JSX line in `party-picker.tsx`. | **Fixed.** Reflowed. |
| F5 | 3 | `isPartyPhoneText` doc claimed the contract schema uses it. | **Fixed.** Doc now says the contract stays length-only and why (oRPC collapses refine messages). |
| F6 | 2 | `withPartyPhoneRefusals` fall-through mapped any future `PartyError` code to `PHONE_EXISTS`. | **Fixed.** Explicit `switch` over the union; unknown codes re-throw. |

## Defender points accepted

- One canonicalizer plus a predicate, no second normaliser (`phone.ts`).
- Store is authoritative, matching ADR-0007's store-owned uniqueness precedent.
- Stable `INVALID_PARTY_PHONE` code; Arabic copy lives only in i18n and serves
  both the inline and server paths via `SERVER_ERROR_ALIASES`.
- Arabic-Indic accept-and-normalise is the correct product call for this shop.
- Numeric-not-mobile preserves the documented permissiveness.
- No schema change, no migration; legacy rows still match themselves.
- Component + E2E evidence matches every claim, including cleanup.

## Verifier (at `7f0540a..0631081`)

F1–F6 all RESOLVED, with the fixes asserted by tests and no new findings. Focused
run: 43 pass, 0 fail. Full suite later: api 888 pass / web 969 pass; e2e 58 pass.
