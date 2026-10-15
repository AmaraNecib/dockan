> Reviewed implementation SHA: `0631081c1a30ac6e0df37b046f95064407985e9d`. Final evidence SHA: `719a14e4c5b085b72df43ce999df77d17b2318d6` (only `.agents/wisdom/` changed after the reviewed commit — no product code).

# Test-audit evidence — issue #129

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b`.
**Audited:** `7f0540a`; fixes applied and final at
`0631081c1a30ac6e0df37b046f95064407985e9d`.

Three agents (edge-case hunter, coverage analyst, quality reviewer) ran in
parallel over the changed test and source files.

## Edge-case hunter

| Risk | Finding | Disposition |
|------|---------|-------------|
| 🟠 | Legacy permissive fallback (`normalizePartyPhone("abc") === "abc"`) untested. | **Fixed.** Pinned in `party-phone.test.ts`. |
| 🟠 | Non-foldable numeric scripts (full-width, Devanagari) rejected, undocumented. | **Fixed.** Pinned as a decision with a comment. |
| 🟠 | Bidi mark embedded between digits works but untested. | **Fixed.** Leading and mid-string marks pinned. |
| 🟡 | Supplier *update* refusal untested. | **Fixed.** Added to the router test. |
| 🟡 | Invalid-phone and phone-owner alerts could co-render. | **Dismissed.** Only possible after a legacy junk phone canonicalises onto typed junk; harmless, and a re-review found no practical path. |
| 🟡 | Short-numeric boundary (`"0"`) undocumented. | **Fixed.** The numeric-not-mobile decision is pinned (`123`/`«١٢٣»`). |
| 🟡 | Picker sends raw phone, form sends normalised. | **Dismissed.** Both are normalised at the store; the router test covers the raw path. |

## Coverage analyst

Acceptance criteria each have a test: create/edit refusal, picker refusal, API
boundary, Arabic copy with no API display text, Arabic-Indic accept+normalise,
same-phone-same-identity, duplicate-warning unchanged, no schema change. Coverage
is layered across seams (predicate table, store, router, jsdom components, E2E)
and not repetitive.

| Risk | Gap | Disposition |
|------|-----|-------------|
| 🟠 | No assertion that a refused write adds no activity row. | **Dismissed.** The refusal throws inside the router's `withTransactionImmediate`, and the store test asserts the record was not created; the activity insert cannot commit. |
| 🟡 | Supplier update refusal untested. | **Fixed.** |
| 🟡 | Server refusal not driven through the web copy path. | **Dismissed.** The alias mapping is unit-tested; the picker inline check and the store boundary are both tested. |

## Quality reviewer

Grade A−. Names describe behaviour and carry `#129`; async handling matches the
suite's `act`/microtask pattern; `afterEach` isolation holds; assertions are
meaningful. Fixes applied:

- Component create-mode refusal test added (was edit-mode only).
- Picker empty/whitespace phone stays valid and creates.
- E2E cleanup moved into `test.afterEach` with a tracked-names array, so a
  mid-test failure still returns the shared DB.
- The reviewer's incidental must-fix (collapsed JSX) was fixed in the same
  commit.

No `.only`/`.skip`/`.todo`; no missing `await`.

## Final evidence

api `bun run test`: 888 pass, 0 fail (one unrelated concurrency test flaked once
and passed on rerun). web `bun run test`: 969 pass, 0 fail. `bun run test:e2e`:
58 pass, 0 fail.
