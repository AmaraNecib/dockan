# Test-audit evidence — issue #129 (round 1 review-fix)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`).
**Reviewed/worktree SHA:** `3444d79220170a5be4d274987202158ffc1277e0`
(`test(#129): await every e2e effect and prove the picker selection`).
**Nature of delta:** test-only. `tests/e2e/phone-identity.spec.ts` changed;
no `apps/` or `packages/` source changed.

Three read-only agents (edge-case hunter, coverage analyst, quality reviewer)
ran in parallel over the new spec and the code it drives. The parent then walked
every assertion manually and proved the selection fix with a deliberate
mutation. The two Greptile findings are resolved; no further vacuous assertion
was found; the residual items are missing-breath coverage, not test defects.

## The two Greptile findings

| # | Finding | Fix | Proof |
|---|---------|-----|-------|
| 1 | `afterEach` checked `row.count()` before `customersList` resolved, so it could skip saved customers (leaking them into the shared DB) and did not await the last delete. | `readCustomers` returns the **ACKED** `customersList` payload via `actAndAck`; presence comes from `before.items`. Each deletion awaits `actAndAck("customersDelete", …)`. A fresh ACKED read asserts the names are gone. | Mirrors the proven `customer-name-variants.spec.ts:26-44`; reviewers confirmed all three conditions. |
| 2 | `toHaveValue(pickerName)` passed before the save because the earlier `fill()` already put that text in `sale-customer`. | The combobox query and the created record name are now deliberately different (`pickerQuery` vs `pickerName`); the input only reaches `pickerName` through `pick()`. | **Mutation proof:** changing `party-picker.tsx` `onSuccess` to skip `pick()` made the focused spec fail at `toHaveValue(pickerName)` (value stayed `هاتف-منتقي-1792076778282`); the revert passes. |

## Assertion walk — "what else could make this true?"

| # | Assertion | Could it pass if the feature were broken? |
|---|-----------|-------------------------------------------|
| 1 | create `party-form-error` contains «أرقام» | No other error path renders in this state (name non-empty, phone the only invalid field). |
| 2 | refused name absent from a fresh ACKED list | Server-backed reload; a write would appear. |
| 3 | `arabicRow` visible after `actAndAck(customersCreate)` | Row derives from the server list and did not exist before. |
| 4 | created record `phone === +213…` from ACKED payload | Verified raw: `listParties` selects `p.phone` and `toPartyListItem` returns `String(r.phone)` with no read-side normalization, so DOM `displayAlgerianPhone` folding cannot mask a raw write. |
| 5 | edit `party-form-error` contains «أرقام» | Same as 1; edit path only differs by stored value. |
| 6 | identity still `+213…` after the refused edit | Fresh ACKED read; a bad write would show «هاتف». |
| 7 | `sale-form` visible after nav | Navigation gate; stale render cannot mount it. |
| 8 | `sale-customer-invalid-phone` contains «أرقام» | Renders only when `phoneInvalid`; field just set to `12a34`. |
| 9 | `sale-customer-create-save` disabled | `createDisabled = pending ∨ name empty ∨ phoneOwner ∨ phoneInvalid`; only `phoneInvalid` is true here. |
| 10 | invalid alert gone and save enabled after a valid phone | Proves the validation cleared for the right reason. |
| 11 | `sale-customer-create-panel` count 0 | Panel was proven open (its testids were filled); closes with the pick. |
| 12 | `sale-customer` value `pickerName` | **Non-vacuous** — value before save was `pickerQuery`; only `pick()` assigns the record name. Mutant fails here. |
| 13 | picker record `phone === +213…` from ACKED payload | Same raw-read reasoning as 4. |
| 14 | `removePartyRow` row count 1 | Unique name, search-filtered, auto-retrying. |
| 15 | `customersDelete` ack | `expectRpcOk` rejects a non-2xx refusal. |
| 16 | row count 0 after the ack | Combined with 15 and 17. |
| 17 | `afterEach` fresh list carries none of the names | Fresh ACKED server read. |

## Edge-case hunter

| Risk | Finding | Disposition |
|------|---------|-------------|
| MEDIUM | Non-mobile numeric (landline `023551234`) acceptance untested in e2e. | **Deferred.** The predicate's deliberate permissiveness is pinned in `party-phone.test.ts`; e2e duplication adds breadth, not vacuity protection. |
| MEDIUM | Separator tolerance (`0550 12 34 56`) untested in e2e. | **Deferred.** Same unit-level pin. |
| MEDIUM | Extended Arabic-Indic / bidi-mark folding untested in e2e. | **Deferred.** Bidi marks and non-foldable scripts are pinned in the unit suite (prior test-audit). |
| MEDIUM | Refusal proven only by client copy; no browser POST to the server boundary. | **Deferred.** The authoritative refusal is covered by `router.test.ts:1604-1612` and `drizzle-store.test.ts`; the e2e point is the UI copy and the write-nothing read. |
| MEDIUM | `customersList` could normalise on read, making the canonical assertion vacuous. | **Verified not the case** (see assertion 4). |
| LOW | `refusedName` was not tracked in cleanup. | **Fixed.** Added to `cleanupNames`; a regression that writes it now fails and is cleaned. |
| LOW | Selection is proven by record name, not the id itself. | **Accepted.** `pick()` is the single function that assigns both id and name; the name-divergence mutation is the realistic failure mode and is proven. |
| LOW | Panel-hidden `toHaveCount(0)` could also be true if the menu hid. | **Accepted.** Assertion 12 carries the real signal. |
| LOW | `Date.now()` suffix collision with a leaked prior run. | **Accepted.** Wipe runs before the suite; probability negligible. |

## Coverage analyst

Each #129 criterion has a test: create refusal, edit refusal, picker refusal,
Arabic-Indic accept+normalise on create and picker, and picker selection lands.
Coverage is layered (predicate, store, router, jsdom components, e2e). Gaps are
breadth items:

- G1 server-boundary POST from the browser — deferred (unit/router coverage).
- G2 read-vs-write normalisation — **dismissed with evidence** (raw column read).
- G3 edit-path Arabic-Indic re-entry/normalisation — deferred (create + picker
  prove normalisation; edit proves refusal + identity preserved).
- G4 selection id — accepted (same reasoning as the LOW item above).
- G5 copy asserted by substring «أرقام» — accepted (only `partyPhoneInvalid`
  can render in these states).
- G6 `afterEach` login redirect on a pre-signIn failure — mitigated because
  `cleanupNames` is only populated after `signIn` succeeds.

## Quality reviewer

Grade **A−**. Both Greptile findings resolved; all writes gated by
`actAndAck`/`waitForRpc` armed before the click; reads server-backed; isolation
and cleanup correct; names and comments clear. No `.only`/`.skip`/`.todo`, no
missing `await`. The A− deductions are the deferred breadth gaps and the
name-vs-id residual above.

## Final checks at `3444d79`

- `bun run typecheck` — pass (3 packages).
- `bun run lint` — pass (0 errors).
- `bun run test` — api 888 pass / 0 fail; web 977 pass / 0 fail.
- `bun run test:e2e` (isolated ports `6317/6273/6399/6274`) — 56 passed,
  1 failed (unrelated `vault.spec.ts` first-run visibility), 1 did not run.
  `tests/e2e/phone-identity.spec.ts` passed inside the full run. Rerunning
  `vault.spec.ts` alone: 3 passed — the failure was contention under the full
  suite with three sibling lanes, not the change.
- Focused `phone-identity.spec.ts`: passed; with the selection-step mutation:
  failed (proof above).
