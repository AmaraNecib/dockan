# Test-audit evidence — issue #129 (High-assurance)

**Base:** `a52084d1de0bda7fd3cb25ec5da5c778f04200ae`.
**Head SHA reviewed:** `ee32c44fda6dff90309535dbcabbbf412ade2609`.
**Mode:** three read-only agents (edge-case hunter, coverage analyst, quality reviewer) on
the full diff, with the one delta since the previously-reviewed `da727f9` (`tests/e2e/rpc-helpers.spec.ts:74-77`)
verified in depth. Raw findings: `.scratch/reviews/129/raw/audit-{edge,coverage,quality}.md`.
**Prior audit:** `superseded/da727f9-test-audit.md` (grade B). Carried items not re-graded.

## Delta verification (`tests/e2e/rpc-helpers.spec.ts:74-77`)

All three agents verified the 4-line addition independently and agree: **correct, minimal,
no regression.**

- `.catch()` attaches a handler to the armed `refusal` promise (the derived promise is
  voided), so an abandoned `waitForResponse` cannot surface `unhandledRejection` over the
  action's error.
- It does **not** swallow the assertion: attaching `.catch` does not change `refusal`'s
  state, so the later `await refusal` (`:84`) still rejects/awaits as before. In the happy
  path the 500 fixture *fulfils* `waitForResponse` (it resolves on any response), so the
  handler is dead in the passing path.
- The test's discriminating power is preserved: it relies on `actAndAck`'s own
  `void output.catch(...)` (`rpc-helpers.ts:49`); the `:87` filter still catches the pre-fix
  `customersCreate failed with HTTP 500`, and the spec-local wait's timeout text does not
  contain `customersCreate`.
- Consistent with the adjacent test's pattern; grade-neutral (positive robustness).

## Acceptance criteria — all tested

| AC (issue #129 + design) | Layers covering it |
|--------------------------|--------------------|
| Reject non-numeric phone at the boundary | `party-phone.test.ts` (contracts), `drizzle-store.test.ts:773` (store, authoritative), `router.test.ts:1622` (RPC `INVALID_PARTY_PHONE`), `party-forms.test.tsx`, `party-picker.test.tsx`, `phone-identity.spec.ts` (e2e, asserts server payloads) |
| Clear Arabic copy | `i18n.test.ts:194` (`serverErrorKey("INVALID_PARTY_PHONE")==="partyPhoneInvalid"`, Arabic + LTR-isolated examples), form/picker unit asserts `"أرقام"`, e2e asserts it on all three dialogs |
| Pin the Arabic-Indic accept-and-normalise decision | pinned at five layers: contracts (`٠٥٥…`→`+213…`, equals the ASCII identity), store (`PHONE_EXISTS` collision), RPC (canonical response), component, e2e (server `phone`) |

Diversity is strong (table-driven accept/reject/boundary; adversarial full-width `０５５０…`
and Devanagari `०१२३४५६७८९` refused; bidi head/middle; legacy read-key permissive vs write-rule
strict). The repeated Arabic-Indic accept at five layers is deliberate defense-in-depth, not
duplicate noise.

## Quality reviewer — grade B (unchanged)

Discriminating and self-verifying: exact `refused()` counts, `finally` `stop()`/`unroute`
cleanup, exact-message pins, server-payload assertions where the DOM can lie, behavioural test
names. Below A on the carried items: `SETTLE_MS = 50` / 100 ms / 300 ms timing heuristics, a
worker-wide `unhandledRejection` listener (mitigated by the message filter), duplicated
`readCustomers`/abort boilerplate, and the outstanding `readRpc`/envelope-guard coverage gaps.

## Edge-case hunter — no red / no orange

Only yellow coverage pins, each either consistent between `isPartyPhoneText` and
`normalizePartyPhone` (they share `cleanPhoneText`) or a pinned design consequence:

- E1 bare `"0"`/short numeric accepted as a valid identity (numeric-not-mobile decision) —
  worth one explicit pin so a future edit cannot silently tighten the rule.
- E2 separator collapse (`"-5"`→`"5"`, `"12.34"`→`"1234"`) — consistent, untested.
- E3/E4 Unicode whitespace (NBSP/ideographic) and internal newline/tab — consistent, untested.
- E5 whitespace-only `PhoneForm` *create* (store `normalizeValidatedPartyPhone("   ") → null`)
  — store-level create path untested (update `phone:null` is tested).
- E6 no length boundary test (schema caps raw length; out of rule scope).
- E7 full-width `＋` rejected (mirror of the pinned full-width-digit refusal).
- E9/E10/E11 legacy-rename gate, picker double guard, and router→i18n alias — verified, covered.

None of these masks a current failure or reopens a decision.

## Residual gaps (non-blocking, carried)

- `rpcOutput`'s envelope guard (`unexpected oRPC envelope`) and `readRpc` have no focused
  unit test in `rpc-helpers.spec.ts` (only exercised indirectly). Load-bearing for this spec's
  server reads, not an #129 criterion.
- Extended Arabic-Indic (`۰۵۶…`) pinned only at the contracts layer, not through store/RPC/e2e.
- Supplier-role *UI* edit parity remains untested (server path covered).
- An API-sourced `INVALID_PARTY_PHONE` render is pre-empted by the form pre-check in the UI.

## Decision

No "Fix it" items from the audit; the delta is sound. E1 is the most valuable cheap pin if a
future lane touches the predicate.

## Gates at this SHA

```
bun run typecheck                                            exit 0
bun run lint                                                 exit 0
bun run test        exit 0 (api 913 / web 1076 / scripts 38; 0 fail)
bun run test:e2e tests/e2e/rpc-helpers.spec.ts               exit 0 (4 passed)
bun run test:e2e    exit 0 (80 passed, 13.6m)
```
