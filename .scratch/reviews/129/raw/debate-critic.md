# Debate — harsh critic: implementation (apps/, packages/)

Scope: full reviewable diff `a52084d1...HEAD` limited to `apps/`, `packages/`.
Test quality is audited elsewhere; the 4-line `tests/e2e/rpc-helpers.spec.ts` delta is
checked at the end only for the record. Severity: 1 = nit, 10 = must-fix blocker.

Verified good (so the findings below are not noise):

- Only two party-phone write sites exist (`apps/api/src/store/drizzle-store.ts:1675,1678`),
  both reachable only through `createParty` → the rule has no bypass in the store.
  `router.ts:1072` (`createParty("supplier", { name })`) passes no phone. OK.
- The predicate and the fallback share `cleanPhoneText`, so predicate ↔ stored-fallback
  cannot drift. `normalizePartyPhone` behaviour is preserved: the only moved step is
  separator stripping, which `normalizeAlgerianPhone` (`phone.ts:16`) already performed
  on its input, and the old `fallback` stripped the identical class. Idempotent, no
  stored-identity change → no migration needed. Design's "no drift, no schema change" holds.
- `\d` is ASCII-only and both Arabic-Indic ranges fold first, so no non-ASCII digit can
  reach `PARTY_PHONE_NUMERIC_RE` (`phone.ts:64-65`). The full-width/Devanagari refusal is
  pinned, not accidental.

---

## D1 — Severity 7 — the store refuses *any* invalid phone sent, changed or not, and the docs claim otherwise

`apps/api/src/store/drizzle-store.ts:1684` (update path) + helper at `:1218-1227`:

```ts
const phone = patch.phone === undefined ? undefined : normalizeValidatedPartyPhone(patch.phone);
```

`normalizeValidatedPartyPhone` throws `INVALID_PHONE` on shape alone; it never compares the
incoming value with the stored one. Yet three places assert the store "refuses only a
*changed* phone":

- `.scratch/implementation/129-design.md`, web bullet: "the store refuses only a changed
  phone; the untouched value is never re-written";
- the store's own doc-comment, `drizzle-store.ts:1218-1222`;
- `party-forms.tsx:80-86` comment.

Consequence: a legacy row holding `"abc"` can no longer be renamed by *any client that
echoes the record back* (the shape a PATCH-style/offline or REST-ish caller naturally has):
`{ id, name: "new", phone: "abc" }` → `BAD_REQUEST INVALID_PARTY_PHONE`, and the name edit
is lost. Only the React form survives, because it happens to omit unchanged fields
(`party-forms.tsx:99`). "Legacy rows stay renameable" (design, Risk section) is therefore a
property of one UI, not of the store — the exact class of store/UI disagreement the design
claims to have removed. Fix is small: in `updateParty`, compare `normalizePartyPhone(patch.phone)`
(or the raw value) against the stored value before refusing, or document the rule as
"refuses any invalid *sent* phone" and stop claiming change-detection in the store.

## D2 — Severity 5 — the "exhaustive" switch is not exhaustive, and leaks a raw `PartyError` if a code is added

`apps/api/src/rpc/router.ts:2139-2152`:

```ts
if (err instanceof PartyError) {
  // exhaustive over the union: a new PartyError code must be handled here,
  // not silently mislabelled as a phone conflict
  switch (err.code) {
    case "INVALID_PHONE": throw new ORPCError("BAD_REQUEST", { message: "INVALID_PARTY_PHONE" });
    case "PHONE_EXISTS":  throw new ORPCError("CONFLICT", { message: phoneKey });
  }
}
```

There is no `default: assertNever(err.code)` and nothing in the function's control flow
forces a new union member to be added here. The comment promises the compiler enforces
handling; it does not. Today both cases throw so behaviour is fine, but the real failure
mode for a future code is *not* "mislabelled as a phone conflict" (the comment's premise) —
it is fallthrough to `throw err`, i.e. a bare `PartyError` crossing the RPC boundary as an
unnamed internal failure. The claim and the code disagree; either add the `assertNever`
default or cut the comment down to what the code does.

## D3 — Severity 4 — "one cleaning … cannot drift" is only half true; the separator class is still duplicated

`packages/contracts/src/phone.ts:73` and `phone.ts:16` both hard-code `/[\s.()-]/g`.
`cleanPhoneText` now pre-strips separators and `normalizeAlgerianPhone` strips them again —
the mobile branch keeps its *own* cleaning. So:

- if `normalizeAlgerianPhone`'s separator class is ever tightened/loosened, `normalizePartyPhone`
  silently changes *because of the pre-strip*, with no test or type to catch it — the coupling
  is implicit and unasserted (design Risk section lists the opposite risk only);
- the drift class the design says it eliminates (wisdom 2026-10-01) is eliminated for the
  predicate↔fallback pair, not for the mobile pair. A `PHONE_SEPARATOR_RE` constant used by
  both would make the claim true at zero cost.

## D4 — Severity 4 — a validation error is smuggled through the party-*identity-conflict* error type

`apps/api/src/store/port.ts:234-240` widens `PartyError` from `"PHONE_EXISTS"` to
`"PHONE_EXISTS" | "INVALID_PHONE"`, and `router.ts:2139` then cross-maps both to the same
`withPartyPhoneRefusals`/`phoneKey` machinery. "The identity already exists" (a conflict) and
"the text is not a phone" (an input-shape validation) are different failure classes with
different HTTP semantics; folding the second into a class documented as the identity-refusal
type is what forces D2's switch and leaves the catch block also mapping *any* unique violation
to the phone-exists key. A separate `PhoneTextError` (or a store-boundary schema refine)
would keep each refusal on its own path. Note: the `isUniqueViolation → phoneKey` fallback is
pre-existing and unchanged by this diff; only its co-location with the new case is new.

## D5 — Severity 4 — `SERVER_ERROR_ALIASES` is a new resolution mechanism for one string

`apps/web/src/lib/i18n.ts:979-984` + `:997-1002`. The alias map short-circuits
`serverErrorKey` *before* the existing `SERVER_ERROR_KEY` + `Object.hasOwn(resources.ar…)`
path, purely so that `INVALID_PARTY_PHONE` renders another key's copy. Adding a plain
`INVALID_PARTY_PHONE` entry to the Arabic resources and (if literal reuse is needed) pointing
it at the same string would have used the existing mechanism with zero new code and zero new
invariant ("every alias must be kept in sync with a resource key"). New indirection, one
call site, no test that the alias map has no dangling values — over-engineering.

## D6 — Severity 4 — the form's guard tests a *different string* than the store, and only when a value changed

`apps/web/src/components/parties/party-forms.tsx:84`:

```ts
if (cleanPhone !== storedPhone && !isPartyPhoneText(phone)) { … }
```

- The predicate runs on the raw input `phone`; the store runs it on `input.phone` and then
  normalises. Equivalent only because `cleanPhoneText` is idempotent — an unasserted
  assumption (see D3).
- `storedPhone` is `undefined` on create, so `cleanPhone !== storedPhone` is always true
  there; on edit the guard silently turns the rule off whenever the normalised value is
  equal. That "the phone is only checked if it changed" semantics is a UI-only notion the
  store does not share (D1) — three prose comments defend it, no test pins the *store*
  side of the contract (the store test only covers `phone: "abc"` with a different stored
  value).

## D7 — Severity 3 — lone `+` is refused although the predicate's own rationale says unset-able text is valid

`packages/contracts/src/phone.ts:99`: `isPartyPhoneText("+") === false`, while
`normalizePartyPhone("+")` is `null`. So `"."`, `" - "` and a lone bidi mark are *valid*
(they clear to unset) but `"+"` is an error the operator must retype — with copy that says
the number must be digits, for a value that means "no number". Either accept `+` as
clearing (`cleaned.replace(/^\+$/,"") === ""`) or drop the "any separator-only text is
valid because the phone is optional" wording; as written the rule is inconsistent with its
own justification. Ugly but low-blast-radius.

## D8 — Severity 3 — the refusal copy misdescribes the accepted set and never mentions the field is optional

`apps/web/src/lib/i18n.ts:735`: «رقم الهاتف يجب أن يكون أرقاماً فقط، مثل …».
The accepted set is `digits` **or** one leading `+` (an international number such as
`+33123456789` is legal per `phone.ts:64-65`), and the field is optional and clears to
unset — neither is said. An operator who typed a stray letter *while clearing* the field
(the D7 case) is told their number is malformed. The copy is at least isolated LTR via
`ltrIsolate`, and reuses `PHONE_EXAMPLE_LOCAL/INTL`, which is good.

## D9 — Severity 3 — the picker disables Save instead of explaining on submit, and duplicates the guard

`apps/web/src/components/parties/party-picker.tsx:113-117, 152-160, 345-349`. The
`phoneInvalid` flag both disables the primary button and renders a `role="alert"` paragraph
pinned to the *raw* `createPhone`. A permanently disabled Save with an alert below it is a
dead-end affordance (the form's submit-time error is the friendlier, already-existing
pattern); the double guard (`createDisabled ||` and the `if (phoneInvalid)` re-check) is
belt-and-braces for a single built-in panel. Low severity, but it is the third copy of the
same wiring the design says it consolidated.

## Notes (no action demanded, recorded for the record)

- **N1 (residual, settled):** the rule is numeric, not shape-based, so `"12"`/`"0"`/a
  32-digit run are legal unique identities — the same "never matches the real number"
  money-splitting class the issue targets, one step narrower. The design settles this
  deliberately (landlines/foreign numbers must stay storable); not re-litigated, but it is
  a residual risk with no lower bound/leading-zero sanity check, and `core.ts:904,914` caps
  only raw length (32).
- **N2 (delta, verified):** `tests/e2e/rpc-helpers.spec.ts:71-78` is exactly the claimed
  4-line addition (`void refusal.catch(() => undefined)` + a 3-line comment). It is
  behaviourally sound: the pre-attached handler suppresses the abandoned wait's rejection,
  and the later `await refusal` still observes the same rejection. It touches no
  implementation file.
- **N3:** guards re-ran clean at HEAD per the existing logs
  (`.scratch/reviews/129/ee32c44-guard1-{typecheck,test}.log`: 4/4 typecheck tasks,
  38 pass / 1 skip). I did not re-run the suite myself (tool budget); the implementation
  findings above are read-verified, D1 is the only one I would spend a test on.
- **N4:** `phoneToUsername` (`phone.ts:127`) `slice(1)` assumes a leading `+`; the new rule
  guarantees that for mobiles but not for a legal numeric non-mobile (`"33123456789"` →
  username `"3123456789"`). Pre-existing, not introduced here.

## Delta verdict

The only reviewable change since `da727f9` is the e2e test line (N2). It changes nothing in
`apps/` or `packages/`, so none of D1–D9 is affected; no settled or deferred item is
reopened by it.

## Verdict

Nothing here is an 8-10 blocker: the money-path invariant (no new non-numeric identity can
be written) holds, the store has no bypass, and the accepted/rejected boundary is pinned.
D1 is the one finding I would fix before merge — it is a documentation/behaviour contract
mismatch that strands legacy rows for any client that echoes a record, and its fix is a
3-line comparison in `updateParty`.
