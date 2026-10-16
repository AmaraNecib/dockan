# Coverage audit — #129 numeric phone identity (HEAD ee32c44)

Scope: whole diff `a52084d...HEAD` (apps/packages/tests), with the 4-line delta
in `tests/e2e/rpc-helpers.spec.ts` verified specifically. Role: coverage analyst.

## Acceptance criteria (from issue #129 + design doc)

- AC1 — Reject non-numeric phone identity text at the party boundary.
- AC2 — Clear Arabic copy for the refusal.
- AC3 — Decide and **pin with a test** whether Arabic-Indic digits are accepted
  and normalised to Western.

## Coverage matrix

| AC | Layer | Test (file — case) | Verdict |
|----|-------|--------------------|---------|
| AC1 | contracts rule | `apps/web/src/lib/party-phone.test.ts` — accept/reject tables, boundary (null/empty/separator/bidi), mixed run, non-folded scripts | covered |
| AC1 | store (authoritative) | `apps/api/src/store/drizzle-store.test.ts:773` (`rejects non-numeric phone text as an identity`) — create+supplier reject, update reject, name-only edit works, `phone:null` clears | covered |
| AC1 | RPC boundary | `apps/api/src/rpc/router.test.ts:1622` — `INVALID_PARTY_PHONE` BAD_REQUEST on create/update, both roles; stored value untouched | covered |
| AC1 | web form | `party-forms.test.tsx` (`refuses a non-numeric phone…`, `…when creating`) — no mutation sent, error copy | covered |
| AC1 | web picker | `party-picker.test.tsx` (`refuses a non-numeric phone…`) — Save disabled, no create | covered |
| AC1 | e2e | `tests/e2e/phone-identity.spec.ts` — create dialog refused + writes nothing (server read); edit refused keeps identity; picker refused | covered |
| AC2 | i18n unit | `apps/web/src/lib/i18n.test.ts:194` — `serverErrorKey("INVALID_PARTY_PHONE")==="partyPhoneInvalid"`, Arabic + isolated `PHONE_EXAMPLE_LOCAL/INTL` | covered |
| AC2 | UI assertion | form/picker unit assert `درق... "أرقام"`; e2e asserts `toContainText("أرقام")` on all three dialogs | covered |
| AC3 | contracts pin | `party-phone.test.ts` — `isPartyPhoneText("٠٥٥٠١٢٣١٢٣")===true`, `normalizePartyPhone("٠٥٥٠١٢٣١٢٣")==="+213550123123"`, equals ASCII spelling; Extended ۰۵۶ accepted | covered |
| AC3 | store pin | `drizzle-store.test.ts` — Arabic-Indic create → `+213550987654`, then ASCII create collides `PHONE_EXISTS` (one identity) | covered |
| AC3 | RPC pin | `router.test.ts` — Arabic-Indic create returns canonical `+213665667777` | covered |
| AC3 | e2e pin | `phone-identity.spec.ts` — created row's server `phone` is `+213<local>`; picker too | covered |

Every AC has at least one test; AC1/AC3 are pinned at multiple layers.

## Test diversity (not one pattern)

- Table-driven accept (mobile/landline/foreign/short numeric) vs. reject
  (letters/mixed/symbols/`+` placement) vs. boundary (unset/separator-only/bidi).
- Property-style adversarial cases: full-width `０５５０…` and Devanagari
  `०१२३४५६७८९` explicitly refused; bidi mark at head and middle; mixed
  Arabic+Western run.
- Legacy-safety: `normalizePartyPhone("abc")==="abc"` (read key permissive)
  paired with `isPartyPhoneText("abc")===false` (write rule strict).
- Layered black-box: unit → store → RPC → component → Playwright e2e, with e2e
  asserting server payloads (`readRpc`) rather than DOM text.

Good diversity; no single-template repetition.

## Duplicate coverage

The Arabic-Indic accept-and-normalise decision is asserted at five layers
(contracts/store/router/form/picker/e2e). This is deliberate defense-in-depth
across the boundary, not accidental duplication — each layer can regress
independently. No redundant test within a single layer. Not a finding.

## Missing / weak

- **Note** — `rpcOutput`'s new envelope guard (`unexpected oRPC envelope`) and
  `readRpc` have no direct unit test in `tests/e2e/rpc-helpers.spec.ts` (that
  spec exercises only `actAndAck` paths). Not an #129 criterion, but the helpers
  are load-bearing for this spec's server reads.
- **Note** — Extended Arabic-Indic (`۰۵۶`) is pinned only at the contracts unit
  layer, not through store/RPC/e2e. Cheap, low risk.
- **Note** — the delta's defensive `catch` in test 1 has no dedicated case that
  forces the early-throw branch (test 2 covers the analogous path). Acceptable.

## Delta verification (ee32c44, 4 lines)

`tests/e2e/rpc-helpers.spec.ts:74-77` adds
`void refusal.catch(() => undefined)` immediately after arming
`page.waitForResponse(rpcUrl)` in test 1.

- Correct: same idiom test 2 already uses; registers a rejection handler on the
  armed promise at creation, so a `fill`/`click` that throws before
  `await refusal` cannot surface the wait's own rejection over the action error.
- Does not swallow the reported failure: attaching `catch` does not change
  `refusal`'s state, so `await refusal` inside the action still rejects/awaits
  as before; assertions (`thrown?.message==="ACTION_FAILED"`, `refused()===1`)
  unchanged. Purely additive; no regression to previously-reviewed content.

## Verdict

No blocker. AC1/AC2/AC3 all tested, with strong diversity and clean layered
coverage; the delta is a correct, low-risk hardening consistent with the
adjacent test. Residual gaps are helper-level (rpcOutput/readRpc) and an
Extended-Arabic e2e breadth nit — none blocks #129.
