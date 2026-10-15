# Code-review evidence — issue #129 (PR #209 rebase)

**Repo:** dockan. **Base:** `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (`origin/develop`,
after #199, #206/#216, #218/#220, #213/#221, #204/#219).

**Reviewed code SHA:** `a24ede713586897798cc35491e7ba91d57b55ea3` (rebased HEAD).
**Final SHA:** `da727f98bd0cb5cf97c66aaa8b60c743064b23be` — differs from the reviewed
SHA only by the comment correction recorded below.

The rebase resolved the `fc39625` (#196) collision by keeping both sides: #196's
`QuickAddProcedure` / `QuickAddSave` / `saveQuickAdd` / `rpcOutput` and #209's
`readEnvelope` / `readRpc` all survive in `tests/e2e/rpc-helpers.ts`. The fresh
delta since the previous evidence (`2db1b35`, 3 tests) is `04b21e5` (4th spec
test + creation-time `void refusal.catch`) and `a24ede7` (export `readEnvelope`;
`rpcOutput` owns the `ok()`/envelope checks). Product code (`apps/`, `packages/`)
is unchanged since `0631081`.

Two read-only review agents (Standards, Spec) ran on the rebased tree; the parent
applied the one comment fix.

## Standards

**Verdict: PASS.** The only blocker either agent raised was the stale evidence
this file regenerates.

- `readEnvelope` (`tests/e2e/rpc-helpers.ts:33-35`) is a real wrapper, not a
  Middle Man: the `.then` on the *armed* promise is the eager-read behaviour.
  `rpcOutput` (`:118-131`) carries the `ok()` gate and the `json` envelope guard;
  `actAndAck`'s creation-time `void output.catch(() => undefined)` (`:55`)
  matches `.agents/wisdom/2026-10-15-e2e-ack-cannot-survive-navigation.md` and
  keeps the awaited rejection (`.catch` derives a new promise).
- The `SAFETY:` comment on the `(body as { json: T })` cast in `rpcOutput` and
  `readRpc` satisfies the anti-slop contract (tooling-enforced).
- `receipts.spec.ts:82` returns `actAndAck<{ invoiceNumber: string }>` directly —
  the shared #196/#209 seam — and drops the redundant `rpcOutput(await …)`
  nesting and import.

Judgement calls (non-blocking, recorded):

- **Duplicated envelope guard** at `rpc-helpers.ts:135` and `:181`; a shared
  `unwrapEnvelope(body, procedure)` would be one source of truth.
- **Inconsistent failure idiom**: `rpcOutput` uses `expect(...).toBe(true)` +
  `throw`; `readRpc` uses a bare `throw` for the same two conditions.
- **Speculative surface**: `readEnvelope` is exported but has no caller outside
  `actAndAck`, and `rpcOutput`'s `procedure = "rpc"` default is unexercised. The
  export is deliberate per `a24ede7`'s message (the pair is a public helper API).
- **Names**: `refuseCustomersCreate` returns `refused` (a counter accessor) while
  `const refusal` names a promise.
- **Carried from round 2**: `readCustomers` is duplicated across
  `customer-name-variants.spec.ts` and `phone-identity.spec.ts`.

## Spec

Requirement mapping (issue #129 + PR #209):

| Requirement | Verdict |
|-------------|---------|
| Numeric-only rule (Arabic-Indic accepted) in the picker | Met — `party-picker.tsx` gates Save, shows `partyPhoneInvalid`, refuses in `submit` |
| Same rule in the customer/supplier edit forms | Met — `PartyForm.submit` refuses a changed phone; store authoritative via `INVALID_PHONE` → `BAD_REQUEST INVALID_PARTY_PHONE` → `i18n.ts` `SERVER_ERROR_ALIASES` |
| Arabic-Indic normalisation | Met — `cleanPhoneText` folds before the test; pinned at unit/store/router/form/picker/e2e layers |
| Round-3 clause: attach the handler immediately, keep the original promise | Met — `rpc-helpers.ts:60-69`, pinned by the 4 spec tests |
| `receipts.spec.ts` uses #196's `saveQuickAdd` for the quick-add save | Met — `receipts.spec.ts:53-70` |

Notes (not defects):

- The shipped rule is deliberately **numeric**, not the Algerian-mobile shape
  login/onboarding use, so `023551234`, `+33123456789` and `«١٢٣»` → `123` are
  accepted. The design defends this and tests pin it; a reviewer expecting "the
  same rule the rest of the app uses" may read it as a deviation.
- Scope: the branch carries e2e infrastructure for #179/#191/#209 (`readRpc`,
  `readEnvelope`, `saveQuickAdd`, `rpc-helpers.spec.ts`) beyond #129's picker/form
  ask, justified as review-driven hardening.

No product-code defect found.

## Comment correction (delta between reviewed and final SHA)

`04b21e5` inserted a new test 2, so test 1's comment ("test 2 pins the message
text this filter matches on") pointed at the wrong test. `da727f9` names the
behaviour instead: "the refused-RPC test below pins the exact message text this
filter matches on" (that test asserts `customersCreate failed with HTTP 500`, the
text test 1's `includes("customersCreate")` filter matches). Behaviour unchanged.

## Gates (final SHA `da727f9`)

```
bun run typecheck                                            exit 0
bun run lint                                                 exit 0
bun run skills:check                                         exit 0
bun run test        exit 0 (api 913 pass / web 1076 pass / scripts 38 pass; 0 fail)
bun run test:e2e tests/e2e/rpc-helpers.spec.ts               exit 0 (4 passed)
bun run test:e2e    exit 0 (80 passed, 7.9m)
  ports: DOKAN_PORT=4700 DOKAN_WEB_PORT=5700
         DOKAN_VAULT_PORT=4701 DOKAN_VAULT_WEB_PORT=5701
```
