# #204 — Test-audit evidence

Head reviewed: `e4d1e73`
Base: `8a7a7fa35de501efee15a802430193003926633d`
Method: three independent `reviewer` agents (edge-case hunter, coverage analyst,
test-quality reviewer) in one fan-out, then synthesized.

## Acceptance coverage (issue #204)

| Acceptance | Status | Test |
|---|---|---|
| Filled draft whose supplier vanishes is refused on save OR clearly surfaced | covered | `supplier-opening-draft.test.ts` (seam); `supplier-opening-balance.test.tsx` (notice + `requestSubmit` writes nothing, `mutationCalls === 0`); e2e `#204` |
| A test drives fill → refresh-remove → owner told / save blocked | covered | page test "tells the owner and blocks the save…"; e2e "a refresh that removes a filled row's supplier names the loss and blocks the save (#204)" |
| Assert on i18n keys, not hardcoded Arabic | covered | component tests assert via `i18n.t(...)`; Arabic in fixtures is supplier-name data |
| Empty rows may drop silently | covered | pure + page negative + e2e negative |

## Findings and disposition

| Finder | Finding | Disposition |
|---|---|---|
| edge / critic | removal during the submit's async resolve writes the removed row | **Fixed** (`removalBlocksSave()` live ref + `abandonAttempt`); regression test added |
| edge | removal with the confirm dialog open mutates the named set | **Fixed** (`abandonAttempt` closes it); test added |
| edge | no page test for two removals in one refresh | **Fixed**; test asserts two named rows and survivor-only write |
| edge / coverage | failed refetch / cache reset could flag every draft | **Fixed** (`presentSupplierIds === null` gate); negative test added |
| edge / quality | `name ?? ""` fallback unverified | **Fixed**; pure test pins `name: ""` |
| coverage | confirm-dialog save guard untested | **Fixed**; dialog-removal test asserts the dialog closes and save stays blocked |
| quality | `supplierOpeningRemovedBlocked` copy untested | **Fixed**; positive test asserts the form-error copy |
| quality | duplicated scenario setup between the two #204 page tests | **Fixed**; new tests keep the shared `render`/`settle`/`typeIntoRow` seams; no new bespoke helpers |
| coverage | E2E does not assert the notice copy | accepted: e2e asserts testids + supplier name + amount; the copy is pinned at unit level via `i18n.t` |
| edge | invalid orphan (`0`/`abc`) drops silently | **Deferred** per issue scope ("only a filled row is the concern"); documented in the design |
| edge | notice drops the direction; no re-entry hint | **Deferred** (non-blocking UX); documented |

## Quality grades (reviewer)

- `supplier-opening-draft.test.ts` #204 block: **A** — exact-shape `toEqual`, four
  negatives including the silent-drop negative.
- `supplier-opening-balance.test.tsx` #204 cases: **A− → A** after the added
  regression/negative tests and the blocked-copy assertion.
- `tests/e2e/supplier-adjustment.spec.ts` #204 cases: **B** — behavioural, uses the
  real refetch-on-focus path, proper negative; reviewed by inspection (Guard 2 runs
  the suite).

## Verdict

Every acceptance point has a driving test at pure, component, and e2e level; the
review-added tests close the resolve-window and dialog-staleness holes. Deferred
items are out of the issue's scope and documented.
