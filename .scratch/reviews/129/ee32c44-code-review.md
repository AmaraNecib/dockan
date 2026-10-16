# Code-review evidence — issue #129 (High-assurance)

**Repo:** dockan. **Base:** `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (`origin/develop`,
after #199, #206/#216, #218/#220, #213/#221, #204/#219).

**Head SHA reviewed:** `ee32c44fda6dff90309535dbcabbbf412ade2609`.
**Mode:** two read-only sub-agents, Standards (axis 1) and Spec (axis 2), on the full diff
`a52084d1...HEAD`, with the delta spot-checked. Raw findings:
`.scratch/reviews/129/raw/code-{standards,spec}.md`.

## Delta since the prior review (`da727f9`)

`git diff da727f9...HEAD -- apps packages tests` is exactly the 4-line test-only hunk in
`tests/e2e/rpc-helpers.spec.ts:74-77` (`void refusal.catch(() => undefined)` at creation).
No product file changed. Every arm of the delta was verified: the original imminent
rejection is still observed by the later `await refusal`; assertions and the unhandled
filter are unchanged.

## Standards (axis 1) — PASS

**No hard documented-standard violations** against `AGENTS.md`,
`docs/engineering-workflow.md`, `.agents/skills/unslop/SKILL.md` or `CONTEXT.md`.
Source-only policy holds (tracked source/test + ignored `.scratch/` evidence; no staged
artifacts; evidence filenames carry the SHA).

Baseline smells, all judgement calls, none blocking, all consistent with surrounding code:

- **Duplicated Code** — the envelope guard and `SAFETY:` comment appear twice,
  `rpc-helpers.ts:135` and `:181`; extractable if the file is touched again (two call sites
  is below the usual threshold).
- **Middle Man (mild)** — `readEnvelope` (`rpc-helpers.ts:33`) wraps `rpcOutput` in `.then`;
  it earns its name (eager-read behaviour) and documents why.
- **Duplicated condition** — `party === undefined || party === null` at
  `party-forms.tsx:78,90`; pre-existing pattern in the file.
- **Speculative Generality (mild)** — `SERVER_ERROR_ALIASES` (`i18n.ts:984`) holds one entry;
  the design justifies the map as the alias seam.
- **Duplicated guard (mild)** — `party-picker.tsx:155` re-checks `phoneInvalid` though
  `createDisabled` already blocks Save; mirrors the existing `phoneOwner` guard.

Style: new docblocks use em dashes; the repo baseline does so pervasively, so repo standard
overrides the unslop preference — not flagged.

## Spec (axis 2) — PASS (one low-severity wording drift)

| Requirement | Verdict |
|-------------|---------|
| Numeric-only rule (Arabic-Indic accepted + normalised) at the picker | Met — `party-picker.tsx` gates Save, shows `partyPhoneInvalid`, refuses in `submit` |
| Same rule in the customer/supplier edit forms | Met — `PartyForm.submit` refuses a changed phone; store authoritative via `INVALID_PHONE` → `BAD_REQUEST INVALID_PARTY_PHONE` → `i18n.ts` `SERVER_ERROR_ALIASES` |
| Arabic-Indic accept-and-normalise pinned by a test | Met — pinned at contracts/store/RPC/form/picker/e2e layers |
| Clear Arabic copy, no display text from the API | Met — `partyPhoneInvalid` copy in the UI; API ships stable codes only |
| Reject `"abc"`/`"هاتف"`/`"12@34"`/`"+"`/`"++…"`; separator-only clears | Met — verified against `cleanPhoneText` |
| Preserve "same phone = same identity"; no name-storage change; no schema change | Met — no migration, permissive read path retained |

- **(a) Partial / low severity:** the design and a form comment say "the store refuses only a
  changed phone"; `drizzle-store.ts:1686` validates any *provided* phone. The "legacy junk row
  can still be renamed" property is therefore UI-dependent (`party-forms.tsx:81-83`). This is
  **comment/design wording drift, not an app defect**: `PartyUpdate` is a patch and the only
  client omits unchanged fields, so no shipped path re-writes a legacy value, and refusing an
  explicitly-written invalid phone is the #129 boundary rule. Design wording corrected; no code
  change. (Same as debate D1.)
- **(b) Scope creep (noted, not re-litigated):** `tests/e2e/rpc-helpers.ts` (`readRpc`,
  `actAndAck<T>`, `rpcOutput`) plus its adoptions in `customer-name-variants.spec.ts` and
  `receipts.spec.ts` are #209/#189 test-infra, settled at `da727f9`. The HEAD delta is
  test-only and safe.
- **(c) Nothing in the #129 behaviour is wrong.** Note only: `router.ts:2140-2142` claims the
  switch is exhaustive with no `never` guard; a future `PartyError` code would compile and
  rethrow raw (500). No runtime defect today (same as debate D2).

## Verdict

Both axes PASS. No product-code defect found. The only action taken was tightening the design
wording for the D1 contract drift; D2 is a recorded follow-up candidate. No fix required.

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
