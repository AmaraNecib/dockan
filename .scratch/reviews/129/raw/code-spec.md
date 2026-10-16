# #129 spec-axis review — HEAD ee32c44 (base a52084d)

## (a) Missing / partial

1. **Partial — "the store refuses only a changed phone" holds only for the UI.**
   Design §Interfaces: "`updateParty` (only when `patch.phone !== undefined`) call it".
   Implemented literally: `drizzle-store.ts:1686` validates any *provided* phone, not
   only one that differs from the stored value. `party-forms.tsx:81-83` states
   "the store refuses only a changed phone and the untouched value is never
   re-written". A non-UI client round-tripping a legacy junk phone in a rename
   (`{id, name:"new", phone:"abc"}`) is refused `INVALID_PARTY_PHONE`, so the
   "legacy record can still be renamed" property is UI-only. Severity: low
   (comment/design drift; UI behaviour is correct).

2. No other missing feature. Every §Interfaces item is present and wired:
   `phone.ts:96` `isPartyPhoneText`; `port.ts:235` `INVALID_PHONE`;
   `drizzle-store.ts:1225,1672,1686`; `router.ts:2140-2151`
   `BAD_REQUEST`/`INVALID_PARTY_PHONE` for create+update, both roles;
   `i18n.ts:735` `partyPhoneInvalid` + `i18n.ts:982` alias; `party-forms.tsx:84`;
   `party-picker.tsx:115,155,345`. The Arabic-Indic accept-and-normalise decision
   is pinned: `party-phone.test.ts:31-36`, `drizzle-store.test.ts:788`,
   `router.test.ts:1623-1631`.

## (b) Scope creep (not asked for by #129)

- `tests/e2e/rpc-helpers.ts` (`readRpc`, `actAndAck<T>`, `rpcOutput` signature)
  plus its adoptions in `customer-name-variants.spec.ts:118-123` and
  `receipts.spec.ts:82-88` are #209/#189 test-infra work, absent from design
  §Planned tests. Already reviewed at da727f9 — noted, not re-litigated.
- **Delta at HEAD** (`rpc-helpers.spec.ts:74-77`, `void refusal.catch(...)`):
  test-only, no #129 requirement, but consistent with the helper contract and
  safe — `refusal` is a distinct promise from `actAndAck`'s own ack, and the
  later `await refusal` still fails loudly. It cannot mask a helper regression.

## (c) Implemented but wrong

- None found in #129 behaviour. Verified against `cleanPhoneText`: rejects `"+"`,
  `"++213550123123"`, `"12+34"`, `"12@34"`, `"هاتف"`; accepts `٠٥٥…`/`۰۵۶…`
  folded; separator-only clears. Routing `normalizePartyPhone` through
  `cleanPhoneText` is behaviour-preserving (`normalizeAlgerianPhone`,
  `phone.ts:11`, strips the same separator class itself).
- Note `router.ts:2140-2142` claims exhaustiveness ("a new PartyError code must
  be handled here") but there is no `never` check; a new code compiles and
  rethrows the raw `PartyError` (500). Comment overstates the guard.
- Note `isPartyPhoneText("123")` is true — the settled "numeric, not mobile"
  decision; not re-litigated.
