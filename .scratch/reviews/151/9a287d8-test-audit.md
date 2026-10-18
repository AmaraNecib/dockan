# Issue 151 — Test audit (edge case, coverage, quality)

Head reviewed: `9a287d8` (merge-base `3c3abcf`). Three independent reviewer
children ran the edge-case-hunter, coverage-analyst, and quality-reviewer
lenses against `git diff 3c3abcf...d8355fd`; findings below are synthesized
against the final head and the fixes applied before commit.

## Fixed before commit

| Finding | Lens / risk | Fix |
|---|---|---|
| E2E asserted only the badge **count**, not the inversion it exists for. | Coverage — blocker | The e2e now asserts the correction row's index is **above** the future row's index, that the future row carries the badge, that the correction row is not badged, and that the badge text is not the raw i18n key. |
| Badge text could be a hardcoded literal and still pass. | Coverage 🟠 | The e2e asserts the badge is not the raw key; the unit copy test asserts by key (`t("historySupersededByCorrection")`). |
| No test for a `COST_CORRECTION` row with `unitCost: null`. | Edge 🟡 | Added unit test: a null-cost correction does not supersede (mirrors the api's `isCostCorrection`). |
| No test for a zero-delta row without the token (`opening`). | Edge 🟡 | Added unit test. |
| Empty ledger untested. | Edge 🟡 | Added `supersededByCorrection([]) === new Set()`. |
| E2E could flake if the purchase and the correction land in the same wall-clock second. | Quality — flake risk | The e2e waits past the second boundary before the UI cost edit; the strict tie is the documented, tested under-annotation. |

## Deferred / dismissed

- **Pagination (`🔴`)**: the predicate sees one page. A correction on a prior
  page cannot badge a superseded row on a later page. Fixing it needs `seq` on
  the contract (forbidden here). Documented as a Known limit in `151-design.md`;
  surfaced to the parent. Display-only under-annotation — no number changes.
- **Duplicate `rpc` helper (`🟡`)**: the new e2e helper re-implements the oRPC
  `{json}` envelope. The same local helper already exists in `pagination.spec.ts`
  and `supplier-adjustment.spec.ts`; extracting one shared `seedRpc` into
  `rpc-helpers.ts` is a worthwhile follow-up but not this ticket's scope.
- **No page-level render test**: `ItemHistoryPage` has no component-render test,
  so the JSX wiring is proven only end-to-end. There is no existing page-render
  harness; the e2e covers the real user path.
- **`rows.filter({ hasText: "01/01/2999" })` baked the display date format**:
  the assertion now reads `allInnerTexts()` and finds the row by date text; the
  date shape is already pinned by `dates.test.ts`.

## Quality grade

Unit tests: **B+** (behaviour-named, pure-function isolation, diverse edge
cases). E2E test: **B** after fixes (real inversion assertion, typed RPC seed).
Composite: **B+**. No shallow "does not crash" assertions; every case names the
rule it pins.
