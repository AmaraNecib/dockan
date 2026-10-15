# #204 — Test-audit evidence

Head reviewed: `aae4a7f` (code identical to `e4d1e73`; delta is `.agents/wisdom/`
only). Full findings retained in `superseded/e4d1e73-test-audit.md`.
Base: `8a7a7fa35de501efee15a802430193003926633d`
Method: edge-case hunter, coverage analyst, test-quality reviewer (independent).

## Acceptance coverage (issue #204)

| Acceptance | Status | Test |
|---|---|---|
| Filled draft whose supplier vanishes refused on save OR clearly surfaced | covered | pure seam; component notice + `requestSubmit` writes nothing (`mutationCalls === 0`); e2e `#204` |
| Test drives fill → refresh-remove → owner told / save blocked | covered | component "tells the owner and blocks the save…"; e2e "a refresh that removes a filled row's supplier names the loss and blocks the save (#204)" |
| Assert on i18n keys, not hardcoded Arabic | covered | `i18n.t(...)` in pure/component tests |
| Empty rows may drop silently | covered | pure + component negative + e2e negative |

## Findings and disposition

| Finding | Disposition |
|---|---|
| Removal during the submit's async resolve writes the removed row | **Fixed** (live ref + `abandonAttempt`); regression test with the resolver held open |
| Removal with the confirm dialog open mutates the named set | **Fixed** (`abandonAttempt` closes it); test added |
| No page test for two removals in one refresh | **Fixed**; test asserts two named rows and survivor-only write |
| Failed refetch / cache reset could flag every draft | **Fixed** (`presentSupplierIds === null` gate); negative test added |
| `name ?? ""` fallback unverified | **Fixed**; pure test pins `name: ""` |
| Confirm-dialog save guard untested | **Fixed**; dialog-removal test |
| `supplierOpeningRemovedBlocked` copy untested | **Fixed**; positive test asserts the form-error copy |
| E2E does not assert the notice copy | accepted; copy pinned at unit level via `i18n.t` |
| Invalid orphan (`0`/`abc`) drops silently | **Deferred** per issue scope; documented |
| Notice drops direction; no re-entry hint | **Deferred** (non-blocking UX); documented |

## Quality grades

- `supplier-opening-draft.test.ts` #204: **A** — exact-shape assertions, four negatives
  including the silent-drop negative.
- `supplier-opening-balance.test.tsx` #204: **A** after the added resolve-window,
  dialog, multi-removal, failed-refetch and blocked-copy tests.
- `tests/e2e/supplier-adjustment.spec.ts` #204: **B** — real refetch-on-focus path,
  proper negative; executed green in Guard 2 (75/75).

## Verdict

Every acceptance point has a driving test at pure, component and e2e level. The
review-added tests close the resolve-window and dialog-staleness holes; deferred
items are out of the issue's scope and documented.
