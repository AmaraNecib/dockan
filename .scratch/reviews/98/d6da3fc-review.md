# PR #105 / issue #98 — adversarial review synthesis

Reviewed head `d6da3fc`, merge-base `0b4d5a1`. Four independent fresh-context
reviewers: Standards axis, Spec axis, harsh Critic, charitable Defender
(`.scratch/reviews/98/{standards,spec,critic,defender}.md`).

No critic finding scored 8-10. Three of the four reviewers independently
reported the same hard defect (the leaked capture listener); that is the only
one the Standards and Spec axes called a blocker.

| # | Finding | Score | Decision |
|---|---|---|---|
| 1 | `use-barcode-scanner.ts` — capture listener registered with `true`, removed without it, so it never detaches | blocker (3 axes) | **Fixed** — matching `true` in `removeEventListener`; test unmounts and asserts no further commits and no swallowed Enter |
| 2 | Blank inline cost silently wrote 0 while create rejects blank | 6 | **Fixed** — edit rejects a blank cost like create does |
| 3 | Blank threshold wrote 0 while create's blank default is 5 | 5 | **Fixed** — blank means "leave it alone"; the field is omitted from the patch |
| 4 | `beginEdit` replaced a dirty draft with no warning | 5 | **Fixed** — a dirty draft disables the other rows' edit controls |
| 5 | `baseline` never refreshed, so the draft showed pre-refetch prices | 3 | **Fixed** — the baseline and untouched fields follow a refetch |
| 6 | Unit cost validated then discarded for a negative delta | 3 | **Fixed** — the field is disabled for a removal, with a hint |
| 7 | Pollution guard keyed on `data-testid` prefix | 3 | **Fixed** — structural `data-editing` row hook; focus moved to a ref |
| 8 | `Number()` accepted `1e3` / `0x10` | 3 | **Fixed** — shared `parseWholeNumber` / `parseSignedWholeNumber` |
| 9 | Quantity error rendered the field label as the message | 2 | **Fixed** — `stockQuantityInvalid` copy |
| 10 | `invalidateItems` skipped the catalog search | 2 | **Fixed** — invalidation is app-wide now, matching the expenses page precedent |
| 11 | No-op save closed the row with no feedback | 2 | **Fixed** — `items-edit-unchanged` status line |
| 12 | `Object.keys(patch).length === 1` as the change test | 1 | **Fixed** — explicit `changed` flag |
| 13 | Money validation duplicated between create and edit | judgement | **Partly fixed** — both now share the parsers; the message split stays (create requires > 0, edit allows 0) |
| 14 | `ItemListItem.categoryId` may be nullable, blocking edits | spec note | **Dismissed** — `itemSchema.categoryId: idSchema` is non-nullable (`packages/contracts/src/core.ts:110`) |
| 15 | Evidence filenames must name the reviewed HEAD | standards blocker | **Fixed** — evidence regenerated at the new head |
| 16 | Scan hook's capture-phase change is scope creep beyond the brief | spec note | **Kept** — it is what makes the inline editor safe; the leak above was its defect, now fixed |
| 17 | Table header relabel `dashboardItemsCount` → `itemsStock` | spec note | **Kept** — the threshold column needs the honest header |

## Also fixed here (found by running the gates, not by the reviewers)

`tests/e2e/expense-reports.spec.ts` asserted `not.toContainText("777")` against
a history whose note column carries `Date.now()` — any three digits can appear
by chance, so the spec failed intermittently. It now asserts on that row's own
unique note and on the row count.

## Dismissed as false alarms (Defender upheld)

- Partial patches breaking the contract: `itemUpdateInputSchema` already
  accepts partials.
- Blank opening stock defaulting to 0: the issue's explicit steer.
- Two focus-restoring effects being redundant: they fire on disjoint
  transitions.
