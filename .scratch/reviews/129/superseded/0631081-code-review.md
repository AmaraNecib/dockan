# Code-review evidence — issue #129 (Standards + Spec)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b`.
**Reviewed:** `7f0540a`; final `0631081c1a30ac6e0df37b046f95064407985e9d`.

Two axes ran in parallel over `git diff 21dbc13...7f0540a`.

## Standards

Documented standards: `docs/engineering-workflow.md`, `docs/development-workflow.md`
(Definition of Done), `AGENTS.md`, `oxlint.config.ts`. No `CONTRIBUTING`/`CODING_STANDARDS`.

**No hard violations.** DoD met: unit + Playwright coverage, Arabic copy via the
i18n key `partyPhoneInvalid`, stable server code `INVALID_PARTY_PHONE`, no display
text from the API, no generated artifacts committed, design doc at the
`.scratch/implementation/<id>-design.md` convention.

Baseline-smell judgement calls:

| Smell | Finding | Disposition |
|-------|---------|-------------|
| Readability | Collapsed JSX line in `party-picker.tsx`. | **Fixed** (reflowed). |
| Lying comment | `isPartyPhoneText` doc claimed the contract schema uses it. | **Fixed** (doc corrected). |
| Duplicated Code | The new invalid-phone alert and the phone-owner alert share markup and could theoretically co-render. | **Dismissed.** Two independent alerts; extraction would be speculative for two sites, and the co-render path needs a legacy junk phone to canonicalise onto typed junk. |

No Speculative Generality, Feature Envy, Shotgun Surgery, or Divergent Change in
the hunks.

## Spec

Issue #129 requirements, each verified:

| Requirement | Verdict |
|-------------|---------|
| Reject non-numeric phone text at the boundary | Met — store + router + form + picker. |
| Validate phone input as digits | Met — numeric rule; deliberately not the mobile shape (documented). |
| Reject/normalise in picker and edit forms | Met — inline Arabic refusal in both. |
| Clear Arabic copy, i18n, no display text from API | Met — `partyPhoneInvalid`, `INVALID_PARTY_PHONE` alias. |
| Decide Arabic-Indic accept+normalise vs reject, pin with a test | Met — accepted and normalised; pinned at predicate, store, router, form, picker, E2E. |
| Do not change name storage | Met — no name code touched. |
| Preserve same-phone-same-identity and the duplicate warning | Met — `normalizePartyPhone` semantics preserved; existing tests green. |
| No schema change | Met — no DDL/migration. |

Findings:

1. **Legacy junk-phone record un-renameable (Medium) — Fixed.** The form now
   validates only a changed phone; a component test covers the name-only edit.
2. **Supplier surface not exercised end-to-end (Low) — Partially addressed.**
   Supplier create/update are covered at store and router level and share the
   one role-parameterised path; the E2E drives the customer path. Accepted as
   sufficient for the shared code path.
3. **"Digits, the same rule the rest of the app uses" deviates from
   `isValidAlgerianPhone` (Low) — Justified.** ADR-0007 and `normalizePartyPhone`
   deliberately keep a landline/foreign number storable; the rule rejects only
   non-numeric text. Documented in the design.
4. **`SERVER_ERROR_ALIASES` is more machinery than the spec asked (Low) —
   Dismissed.** It keeps one Arabic sentence for both the inline and the server
   path, which is the i18n discipline this repo already uses.
5. **Numeric-only accepts implausible identities like `"1"` (Low) — Dismissed.**
   The spec says "digits"; a length floor is a separate product decision and
   risks rejecting legitimate short numbers. The decision is pinned.

## Summary

Standards: 3 judgement calls, 2 fixed, 1 dismissed; no hard violations.
Spec: 5 findings, 1 fixed (the only correctness issue), 1 partially addressed, 3
justified/dismissed. Worst within Spec was the legacy-rename regression — fixed
and tested.
