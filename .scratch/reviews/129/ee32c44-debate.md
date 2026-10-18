# Debate evidence — issue #129 (High-assurance)

**Base:** `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (`origin/develop`; merge-base = HEAD's base).
**Head SHA reviewed:** `ee32c44fda6dff90309535dbcabbbf412ade2609`.
**Mode:** two read-only sub-agents (harsh Critic + Charitable Defender) on the full
diff `a52084d1...HEAD -- apps packages tests`, plus the design doc.
**Prior debate:** `superseded/da727f9-debate.md` (and earlier). Not re-litigated except
where the new critic raised something new.

## The delta under review

The only reviewable change since the previously-reviewed `da727f9` is a 4-line,
test-only addition in `tests/e2e/rpc-helpers.spec.ts:74-77`:

```ts
const refusal = page.waitForResponse(rpcUrl);   // :73
// handle the abandoned wait at creation too (see the next test): a fill
// or click that throws before `await refusal` must not surface the
// wait's own rejection on top of the action's error
void refusal.catch(() => undefined);            // :77
```

Both agents independently verified this is exactly the diff
(`git diff da727f9...HEAD -- apps packages tests` = that hunk alone).

## Critic findings and adjudication

The Critic was asked to be ruthless on the **implementation** code (`apps/`, `packages/`).
It found **no 8–10 blocker**: the money-path invariant holds (no new non-numeric identity
can be written), the store has no bypass, and the accepted/rejected boundary is pinned.
The findings below are the residue; D1/D2 are **pre-existing** (present at every prior
round on unchanged code), not introduced by this delta.

| # | Sev | Location | Finding | Disposition |
|---|-----|----------|---------|-------------|
| D1 | 7 | `drizzle-store.ts:1684`, `:1218`; design web bullet; `party-forms.tsx:80-86` | `updateParty` validates **any provided** phone, not only one that differs from the stored value; three comments say "the store refuses only a changed phone", so the "legacy junk row stays renameable" property is UI-only. | **Dismissed as a behaviour defect; wording corrected.** `PartyUpdate` is a patch and the only client omits unchanged fields (`party-forms.tsx:96`), so no shipped path re-writes a legacy value; the store refusing a phone it is explicitly asked to write is the #129 boundary rule working, and is *safer* than re-persisting junk on an echo. Design wording tightened below. No code change. |
| D2 | 5 | `router.ts:2139-2152` | Switch over `PartyError.code` claims exhaustiveness ("must be handled here") but has no `assertNever`; a future code compiles and rethrows the raw error (as a 500), not a "mislabelled phone conflict". | **Dismissed as a runtime defect; comment overstates the guard.** Both current codes throw, so no defect today. Recorded as a follow-up wording/`assertNever` candidate (parent decides). No code change in this lane. |
| D3 | 4 | `phone.ts:73` vs `:16` | The separator class `/[\s.()-]/g` is still duplicated between `cleanPhoneText` and `normalizeAlgerianPhone`; "one cleaning cannot drift" is only true for the predicate↔fallback pair. | Deferred (carried). A `PHONE_SEPARATOR_RE` constant is the cheap follow-up; not introduced by this delta. |
| D4 | 4 | `port.ts:234-240`, `router.ts` | `PartyError` mixes "identity exists" (conflict) with "text is not a phone" (validation). | Deferred (carried design choice; the previous rounds accepted the co-located type). |
| D5 | 4 | `i18n.ts:979-984` | `SERVER_ERROR_ALIASES` is a new one-entry map where a resource key would do. | Dismissed — deliberate alias seam documented in the design; a plain key would not reuse `partyPhoneInvalid`'s literal. |
| D6 | 4 | `party-forms.tsx:84` | The form guard tests the raw input only when the value changed. | Dismissed — intended: an untouched legacy value must not block a rename. |
| D7 | 3 | `phone.ts:99` | Lone `"+"` is refused although separator-only text clears. | Dismissed — the design explicitly lists `"+"` as rejected (a sign is not a separator); the rationale's "separator-only" set is `""`/`"..."`/`" - "`/bidi, not `"+"`. |
| D8 | 3 | `i18n.ts:735` | Copy says "digits only" though one leading `+` is accepted. | Dismissed — the copy embeds `PHONE_EXAMPLE_INTL`, so the accepted international form is shown; low value to reword. |
| D9 | 3 | `party-picker.tsx:113-117,155,345` | Save is disabled and a duplicate guard re-checks on submit. | Dismissed — clearing the field re-enables; the alert explains the refusal (AC2). The double guard mirrors the existing `phoneOwner` pattern. |
| N1 | — | `phone.ts` | Numeric-not-mobile rule means `"0"`/`"12"` are legal identities (residual of the deliberate decision). | Recorded, settled by design; edge-audit recommends one explicit pin (below). |
| N2 | — | `tests/e2e/rpc-helpers.spec.ts:71-78` | Delta is exactly the 4 lines and is sound. | No action. |
| N4 | — | `phone.ts:127` | `phoneToUsername` `slice(1)` assumes a leading `+`; a legal numeric non-mobile omits it. | Pre-existing, out of scope; recorded. |

## Defender position

The Defender argued (confidence 8–9/10) that the delta is the minimal correct fix — the
same creation-time handler pattern the adjacent test already uses, `.catch` derives a new
promise so the original still rejects and `await refusal` still observes it — and that the
settled design (shared `cleanPhoneText`, store authority with a permissive legacy read path,
stable RPC codes with UI-localised copy, Arabic-Indic accept-and-normalise) is coherent and
money-safe. It rated the delta 9/10.

The Critic's D1 is where the two disagree: the Defender reads the store as authoritative for
any written phone (correct), the Critic reads the comments as claiming change-detection.
Adjudication above sides with the Defender on behaviour and corrects the prose.

## Decision

- **No blocker, no major defect requiring a code change in this lane.**
- D1: design wording corrected; no code change.
- D2: recorded as a follow-up wording/`assertNever` candidate (see report deferred items).
- Everything else is pre-existing, already-deferred, or a dismissed design choice.
- The reviewed delta is sound and does not reopen any settled decision.

## Gates at this SHA

```
bun run typecheck                                            exit 0
bun run lint                                                 exit 0
bun run skills:check                                         exit 0
bun run test        exit 0 (api 913 / web 1076 / scripts 38; 0 fail)
bun run test:e2e tests/e2e/rpc-helpers.spec.ts               exit 0 (4 passed)
bun run test:e2e    exit 0 (80 passed, 13.6m)
  ports: DOKAN_PORT=4700 DOKAN_WEB_PORT=5700
         DOKAN_VAULT_PORT=4701 DOKAN_VAULT_WEB_PORT=5701
```
