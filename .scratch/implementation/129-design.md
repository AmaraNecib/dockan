# #129 — Customers/suppliers: reject non-numeric phone identity text

**Tier:** High-assurance (a phone is a party identity key — ADR-0007; a bad one
merges or splits debts, i.e. money).
**Base:** `origin/develop` @ `21dbc13f13d1889646f4466e610decf5a077253b` (merge-base = HEAD).
**Branch:** `fix-129-numeric-phone`.
**Issue:** GitHub #129 — "Customers: reject non-numeric phone identity text".

## Problem

`normalizePartyPhone` (`packages/contracts/src/phone.ts`) is the shared identity
canonicalizer for a party phone. After folding Arabic-Indic digits, stripping
invisible bidi marks and the separators `\s.()-`, an Algerian mobile canonicalizes
to `+213…`; **anything else is kept verbatim** as a fallback so a shop landline
stays storable. That fallback also lets `"abc"`, `"12a34"` or `"هاتف"` become the
unique identity of a customer/supplier, and the picker and form send the raw text
straight through. A "phone" that is not a phone then never matches the real
number and can split or merge a debtor's balance.

## Decisions

### 1. Arabic-Indic digits are accepted and normalised to Western

`٠٥٥٠١٢٣١٢٣` (and Extended Arabic-Indic `۰۵۶…`) **is** accepted and folds to
`0550123123` → stored `+213550123123`. This is already what `normalizePartyPhone`
and `displayAlgerianPhone` do (issue #108): the shop owner's Arabic keyboard
produces these digits by default, so rejecting them would lock the owner out of
the primary input. Pinned by test: the Arabic-Indic spelling and the ASCII
spelling are one identity (the second collides `PHONE_EXISTS`).

This is **not** the same as "accept anything": Arabic-Indic text is numeric after
folding, whereas letters/symbols are not.

### 2. Reject text that is not numeric after the same cleaning

A present phone is valid only when, after folding Arabic-Indic/Extended digits,
stripping invisible bidi marks and the separators `\s.()-`, the remainder is
digits with at most one leading `+`. Otherwise it is rejected with clear Arabic
copy. Absent / empty / separator-only text stays valid (the phone is optional and
clears to unset, exactly as today).

- accepted: `0550123123`, `0550 12 34 56`, `+213550123123`, `00213550123123`,
  landline `023 55 12 34`, foreign `+33123456789`, `٠٥٥٠١٢٣١٢٣`.
- rejected: `abc`, `12a34`, `هاتف`, `12@34`, `+`, `++213550123123`, `12+34`.
- still clears to unset (valid): `""`, `"..."`, `" - "`, a lone bidi mark.

The rule is deliberately **not** the Algerian-mobile shape: `normalizePartyPhone`
keeps a landline and a foreign number storable by design, so requiring the mobile
regex would be scope creep and would reject a legitimate identity. The issue asks
for "digits, the same rule the rest of the app uses" — numeric, not mobile.

## Interfaces

### `packages/contracts/src/phone.ts` (new predicate, no new normaliser)

```ts
/**
 * Issue #129: a phone is a valid identity only when it is numeric after the SAME
 * cleaning normalizePartyPhone applies (fold Arabic-Indic digits, strip
 * invisible bidi marks, strip the separators \s.()-), optionally with one
 * leading +. Absent/empty/separator-only is valid (the phone is optional and
 * clears to unset). Arabic-Indic digits are ACCEPTED and normalised to Western.
 */
export function isPartyPhoneText(raw: string | null | undefined): boolean;
```

Both the predicate and `normalizePartyPhone` now call one private
`cleanPhoneText` (fold + strip invisible + strip separators), so the rule and
stored identity cannot drift — the failure class wisdom 2026-10-01 records. No
second normaliser is added. `normalizePartyPhone` keeps its permissive fallback
so legacy rows that already hold non-numeric text still match themselves and
`displayAlgerianPhone` still renders them verbatim — no schema change, no data
migration. `«١٢٣»` folds to the numeric `123` and is therefore accepted (the rule
is numeric, not the mobile shape); the test pins that decision.

### `apps/api/src/store/port.ts` + `drizzle-store.ts`

`PartyError` code union gains `"INVALID_PHONE"`. A small local helper
`normalizeValidatedPartyPhone` runs the predicate then normalizes; `createParty`
and `updateParty` (only when `patch.phone !== undefined`) call it. The store owns
the rule, consistent with ADR-0007's "the phone uniqueness check lives in the
store, not only in a schema constraint" — the RPC contract only bounds length.

### `apps/api/src/rpc/router.ts`

`withPartyPhoneConflict` → `withPartyPhoneRefusals`: maps
`PartyError("PHONE_EXISTS")` → `CONFLICT` + role key (unchanged) and
`PartyError("INVALID_PHONE")` → `BAD_REQUEST` + `"INVALID_PARTY_PHONE"` (stable
code, no display text). A zod refine was **not** added: oRPC collapses refine
messages to "Input validation failed", which would give the owner a generic
message instead of the clear one.

### `apps/web` i18n + forms

- `i18n.ts`: new UI key `partyPhoneInvalid` (Arabic, reusing
  `PHONE_EXAMPLE_LOCAL`/`PHONE_EXAMPLE_INTL` with `ltrIsolate`); a
  `SERVER_ERROR_ALIASES` map resolves the server code `INVALID_PARTY_PHONE` to
  that key, so a direct API rejection gets the same copy.
- `party-forms.tsx` (`PartyForm.submit`): reject a changed phone before mutate
  with `t("partyPhoneInvalid")`. Only a value the operator changed is checked, so
  a legacy record already holding junk text can still be renamed (the store
  refuses only a changed phone; the untouched value is never re-written).
- `party-picker.tsx` inline create panel: show the same copy and disable Save
  when the typed phone is not numeric.

## Planned tests

Unit (bun test):
- `apps/web/src/lib/party-phone.test.ts` — `isPartyPhoneText` accept/reject table,
  plus `normalizePartyPhone("٠٥٥…") === "+213…"` to pin the accept-and-normalise
  decision.
- `apps/api/src/store/drizzle-store.test.ts` — create/update reject non-numeric;
  name-only update and `phone: null` still work; Arabic-Indic create stores
  canonical and collides with ASCII.
- `apps/api/src/rpc/router.test.ts` — `INVALID_PARTY_PHONE` on create/update for
  both roles; Arabic-Indic create round-trips.
- `apps/web/.../party-forms.test.tsx`, `party-picker.test.tsx` — the copy shows
  and no mutation is sent; valid input still submits.
- `apps/web/src/lib/i18n.test.ts` — `serverErrorKey("INVALID_PARTY_PHONE")` is
  `partyPhoneInvalid` and the copy is Arabic.

Playwright E2E (`tests/e2e/phone-identity.spec.ts`):
- customers dialog: create with `abc` shows the Arabic refusal and adds no row;
  edit an existing party's phone to `abc` is refused; create with Arabic-Indic
  digits succeeds and displays the local Western form.
- sale picker inline create: a non-numeric phone is refused; a valid one creates
  and selects the party. Clean up the created records (delete at zero invoices).

## Risks

- **Over-rejecting a legitimate landline/foreign number.** Mitigated: the rule is
  numeric, not the mobile shape; explicit tests for `023551234` and `+33123456789`.
- **Unicode sneaking past `\d`.** The predicate mirrors the existing android-safe
  separator/invisible cleaning; `\d` is ASCII-only and every Arabic-Indic digit is
  folded first, so no non-ASCII digit reaches the test.
- **UI/store disagreement.** Both call the one predicate; the store stays
  authoritative, so a bypassing client is still refused.
- **Legacy non-numeric rows.** Not migrated (out of scope, no schema change); they
  keep matching themselves. Deleting/fixing them is a data task, not this rule.

## Out of scope

- Name storage (unchanged).
- The "same phone = same identity" rule and the duplicate-name warning (unchanged).
- Schema/migration changes.
