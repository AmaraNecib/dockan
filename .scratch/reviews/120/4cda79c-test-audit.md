# Issue #120 — Final test-audit evidence (round 2)

- **Audited HEAD:** `46a6a8fd5b95b075648ef2ce8cda02bfe3c43f79`
- **Fix commit: 60573aff. Evidence HEAD (this file): 4cda79c33a302ad0fc3b7ba45d990746e7029249**
- **Base:** `8579fcf8f5d2197ec74d7fc01331530aef917957`
- **Round 1:** `.scratch/reviews/120/a4647f5-test-audit.md`
- **Method:** three parallel read-only sub-agents (edge hunter, coverage
  analyst, quality reviewer) over the final test files + source.

## Verdicts

- **Coverage analyst:** "None [blockers]. All three issue-mandated tests are
  present and strong: identity/uniqueness, delete rule, and the
  picker→invoice→debts Playwright flow." 31 acceptance criteria mapped; the
  earlier resolutions all re-verified on the final HEAD.
- **Quality reviewer:** grade **B** — behaviour-first names, right seams, real
  negative assertions and deliberate isolation; held back by duplicated web
  harness scaffolding, timing-sensitive picker mounts, substring money
  assertions, and the API mega-tests (standing follow-up).
- **Edge hunter:** no new correctness blocker after the round-1 fixes; the one
  substantive new bug (bidi marks in names) is recorded below.

## Findings and resolution

| Source | Finding | Decision |
|--------|---------|----------|
| Edge E1 / Critic N1 | Bidi/zero-width marks not stripped from **names** (`normalizeTextKey`), so the backfill and the duplicate-name warning could split one debtor | **Fixed at 60573af** (see the debate evidence for detail) |
| Edge E2 / Critic N15 | Alef/ya variants («علي»/«على») are not folded; the ADR's example still splits | **Deferred**: global fold changes catalog matching; picker-only fold is a follow-up candidate |
| Edge E3 | High-end aggregate overflow still failed `dinarsSchema.max` | **Fixed at 60573af** (clamp to `MAX_SAFE_INTEGER` + test) |
| Coverage G1 (Med) | Purchase picker's `counterpartyId` wiring had no unit test (asymmetric with sale) | **Fixed at 60573af**: purchase-page test picks a supplier through the real picker + quick-add and asserts `lastPurchaseInput.counterpartyId`/`counterpartyName` |
| Coverage G2 (Med) | Detail-page delete success path untested | **Fixed at 60573af**: detail test confirms delete and the navigate-back call |
| Coverage G3 (Med) | List edit dialog untested | **Fixed at 60573af**: row edit → save asserts the update payload |
| Coverage G4 (Med-low) | No regression guard for the «الطرف» retirement | **Fixed at 60573af**: i18n test asserts the role pair and the absence of «الطرف» |
| Coverage G5 (Low) | No key-completeness test for the new i18n block | **Deferred**: e2e + component tests render the keys in real flows; a completeness sweep is tooling work |
| Coverage G6 (Low) | Picker ARIA attrs (haspopup/controls/activedescendant) untested | **Partially covered**: keyboard ArrowDown/Enter/Escape is tested; attribute-level assertions deferred (low value vs the a11y review) |
| Coverage G7 (Low) | Route wiring only covered by e2e | **Deferred**: e2e exercises all four routes; a router smoke test is a nice-to-have |
| Coverage G8 (Low) | `partyInvoiceKind` + update refine have no direct test | **Deferred**: both are exercised indirectly (store detail/list + router update) |
| Coverage G9 (Low) | Supplier-side backfill reuse untested | **Deferred**: the customer-side reuse test covers the shared code path; the role map is derived from one constant now |
| Quality | Duplicated web test scaffolding (`mount`, `click`, `setElementValue`, mocks) across three files | **Deferred (recorded)**: extraction is a test-infra refactor; the files are new and self-contained |
| Quality | Picker tests use one fixed tick instead of `waitFor` | **Deferred (recorded)**: deterministic locally and in CI so far; the sibling page tests show the pattern to adopt |
| Quality | `toContain` on formatted money / substring copy assertions | **Deferred (recorded)**: the `Amount` component renders raw digits today; exact-value assertions would churn with the #119 formatter |
| Quality | `navigation.test.tsx` exact-length/order assertions are change-detectors | **Deferred**: pre-existing test contract; updating it for two nav items was deliberate and visible |
| Quality | API mega-tests (store/router) co-locate several rules per `it` | **Deferred (standing)**: splitting risks shared-DB fixture churn; failure localisation is the trade |

## Post-fix gates at 60573af

- `bun run typecheck` — 3/3 pass
- `bun run lint` — 0 errors
- `bun run test` — 430 web tests + API suites pass
- `bun run test:e2e` — 38/38 pass
