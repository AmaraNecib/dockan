# Issue #113 — test audit evidence

Base `850d1f7`. Independently reviewed HEAD `05e8a4a`. The final commit adds only
a corrected test comment (`apps/web/src/lib/i18n.test.ts`, comment-only) and this
evidence file; the substantive tests are the ones the lenses saw at `05e8a4a`.

## Lenses

Three independent test-audit sub-agents (edge-case hunter, coverage analyst,
test-quality reviewer), each a fresh context with repo read access, run once on
`24a8e98` and confirmed once on `05e8a4a` after the fixes. The orchestrating
session ran the fanout and wrote this evidence from the children's reports.

## Findings and dispositions

### Round 1 (`24a8e98`)

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | Parity scan only saw `message: "CODE"` literals; it missed the two identifier-forwarded producers (`message: error.code` → `STOCK_NEGATIVE`, `message: phoneKey` → `CUSTOMER_PHONE_EXISTS`/`SUPPLIER_PHONE_EXISTS`), so those codes could still flatten to `errorGeneric` unseen. | **Fixed** (`24a6c4f`, union sources read; hardened `05e8a4a`, codes named). |
| 2 | Field-blamed focus is synchronous, before React commits the field's `aria-describedby`. | **Dismissed**, documented in `.scratch/implementation/113-design.md` (Risks): pre-existing reviewed pattern (`vault-gate.tsx:153-155`, `vault-settings.tsx:125`); React flushes the attribute before the assistive tech reads the focus announcement; changing the auth forms alone would diverge from the vault forms. |
| 3 | E2E field-blamed specs read `#login-error` but never asserted the paragraph is not a live region. | **Fixed** (`24a6c4f`; reordered `05e8a4a`). |
| 4 | The field-less role assertion was tautological with the `[role="alert"]` selector, and nothing pinned *exactly one* live region. | **Fixed** (`24a6c4f` count assertions; `05e8a4a` select by id). |
| 5 | Duplicated translatability assertions across `i18n.test.ts` describes; setup duplication in `App.test.tsx`; `not.toBe("")` subsumed by the Arabic-range check. | **Dismissed** as cosmetic; recorded here rather than churned. |

### Round 2 (`24a6c4f`)

| # | Finding | Disposition |
|---|---------|-------------|
| 6 | The union extractors require an inline union literal; a named-type refactor (`phoneKey: PartyPhoneKey`) drops the codes while the shape guard still passes. | **Fixed** (`05e8a4a`): a test now names `STOCK_NEGATIVE`, `CUSTOMER_PHONE_EXISTS`, `SUPPLIER_PHONE_EXISTS`, so the refactor fails loudly. |
| 7 | The e2e negated `not.toHaveAttribute` matcher can resolve while `#login-error` is still detached, passing vacuously. | **Fixed** (`05e8a4a`): the role check now runs after `toHaveText`, which waits for attachment. |
| 8 | Field-less credential/setup pins selected by `[role="alert"]` and then asserted `role === "alert"` (a restatement). | **Fixed** (`05e8a4a`): select `#login-error`/`#setup-error` by id, then assert the role. |
| 9 | No test pins field-less → field-blamed. | **Dismissed**: the role is a pure function of `field === null`; the forward transition test plus per-case pins cover the contract. |

### Round 3 confirmation (`05e8a4a`)

No blocker; all three fixes verified against the delta; the only note was a test
comment that referenced the removed shape guard, corrected in the final commit.

## Mutation proofs

Item 1 — the double announcement returns:

```bash
# apps/web/src/lib/auth-errors.tsx: role={field === null ? "alert" : undefined} -> role="alert"
cd apps/web && bun test src/App.test.tsx
# exit 1 — 26 pass / 8 fail; the 8 are exactly the field-blamed pins, the
# field-less pins stay green
```

Item 3 — a non-conforming key is added:

```bash
# apps/api/src/rpc/router.ts:91  message: "INVALID_RANGE" -> "not_a_server_key"
cd apps/web && bun test src/lib/i18n.test.ts
# exit 1 — "not_a_server_key is not a SCREAMING_SNAKE server key"; 16 pass / 1 fail
```

Item 3 — a conforming key with no resource entry:

```bash
# apps/api/src/rpc/router.ts:91  message: "NEW_UNTRANSLATED_KEY"
cd apps/web && bun test src/lib/i18n.test.ts
# exit 1 — "NEW_UNTRANSLATED_KEY fell back to errorGeneric"; 16 pass / 1 fail
```

Item 3 — a forwarded union becomes a named type:

```bash
# apps/api/src/rpc/router.ts:2143 phoneKey: "CUSTOMER_PHONE_EXISTS" | "SUPPLIER_PHONE_EXISTS"
#                                         -> phoneKey: PartyPhoneKey
cd apps/web && bun test src/lib/i18n.test.ts
# exit 1 — "names the identifier-forwarded refusals it reads from unions"; 1 fail
```

Item 2 — the move is behaviour-preserving (pre-#113 tests untouched):

```bash
git checkout origin/develop -- apps/web/src/App.test.tsx   # tests untouched
# scratch edit: auth-errors.tsx renders role="alert" unconditionally (no field
# prop); App.tsx call sites drop field={...}
cd apps/web && bun test src/App.test.tsx
# exit 0 — 34 pass / 0 fail
git checkout HEAD -- apps/web/src/App.test.tsx apps/web/src/lib/auth-errors.tsx apps/web/src/App.tsx
```

Every mutant was reverted; `git status` shows only the intended files.

## Gates (final HEAD)

| Command | Exit | Result |
|---------|------|--------|
| `bun run typecheck` | 0 | 4 tasks successful |
| `bun run lint` | 0 | oxlint clean |
| `bun run test` | 0 | web 1125 pass / 0 fail; api 934; desktop 68; e2e-support 22; root 74 |
| `DOKAN_PORT=4637 DOKAN_WEB_PORT=5483 bun run test:e2e tests/e2e/login.spec.ts` | 0 | 4 passed |

Sibling lanes `fix-115-onboarding` and `fix-227-bidi-marks` were active, so the
e2e run used an isolated pair (wisdom `2026-10-15-concurrent-lane-e2e-ports`).
`.dokan-port` was restored after each run.
