# Test audit — #162 + #164 (customer half)

- Base: `54a754b`
- Reviewed HEAD: `4aa2c329efae94f3770a949d88e587832791b4b8`
- Fixes landed: `b698d3c26fc20d0962465f41bffb96bf0de19c1a`
- Tier: High-assurance

Three reviewer sub-agents ran in parallel: edge-case hunter, coverage analyst,
test-quality reviewer. This file records the findings and the fixes.

## Fixed

| Finding | Fix |
|---|---|
| `PaymentPanel` had no test that the percentage field renders / mirrors the remaining reference. | Added `invoice.test.tsx` "links the instalment amount to the invoice remaining (#162)". |
| `ReturnsPanel` custom split was migrated to the shared component but `returns-percentage`/`returns-reference` were never asserted. | Added `invoice-returns.test.tsx` "links the custom cash split to the return value (#162)". |
| Sale/purchase default + linkage + the edited-source rule were uncovered. | Added sale tests: default full/100%, percentage source rescales on cart edit, amount source re-derives the percentage, and a draft typed before the first line survives. |
| The settle loop's mid-loop failure path was never exercised. | Added `party-detail.test.tsx` "halts after a mid-loop failure so a second confirm cannot resend money". |
| The supplier case in `party-detail.test.tsx` could pass vacuously (the wait loop `break`s on timeout and only negative assertions follow). | Added an explicit `party-detail-name` assertion before the negatives. |
| `party-detail.test.tsx` unmounted roots outside `act`, printing React warnings and risking flake. | Wrapped unmount in `act`. |
| The e2e money assertion `toContainText("500")` would also match 1500/2500. | Tightened to `toHaveText(/^500\s*دج$/)`. |
| The shared router mock lacked `useNavigate`, so running `party-detail.test.tsx` beside the other page tests crashed the module. | Added `useNavigate` to `tests/router-mock.tsx`; party-detail now uses the shared mock. |
| The same-second ordering edge (random UUID tie-break). | Added a numeric invoice-number tie-break test. |
| The empty-cart draft wipe. | Added a sale test that a pre-line draft survives and links. |

## Deferred (minor, no correctness impact)

- Extract the shared `invoice()` fixture and the repeated `typeInto` native-setter
  helper into `src/tests/react-helpers`. Duplication across ~5 test files; a
  mechanical cleanup that would widen this diff.
- Support Arabic-Indic digits in the amount/percentage parsers. The whole app
  parses ASCII digits (`paymentAmountError` included); changing that is a
  cross-cutting decision, not part of this lane.
- A live inline message for an unusable *percentage* draft (the amount path now
  shows one). Cosmetic.

## Verdict

Coverage now matches the design's planned tests for the shared component, the
pure helpers, each consumer surface, and the #164 page/e2e flow. No shallow or
duplicate coverage remained after the fixes.
