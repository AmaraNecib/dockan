# PR #110 / issue #99 — adversarial review synthesis

Reviewed head `6b22540`, merge-base `0b4d5a1`. Four independent fresh-context
reviewers (`standards.md`, `spec.md`, `critic.md`, `defender.md`).

Red evidence: with only the new tests applied and the pre-fix `expenses.tsx`
restored, 11 of them fail; all 21 pass with the fix.

| # | Finding | Score | Decision |
|---|---|---|---|
| 1 | A late response from a cancelled attempt still selected its category and took the screen over | 6 | **Fixed** — the option and confirmation are unconditional (the category exists), but selecting it and closing the form are gated on the attempt still being on screen |
| 2 | A failed list request left `data === undefined`, so the record form rendered with a save that could only answer CATEGORY_NOT_FOUND | 5 | **Fixed** — a retry row when the list never loaded; a load line while it is still pending |
| 3 | A stale *failure* had no attempt guard and painted the abandoned error into the new draft | 4 | **Fixed** — the same attempt check on the error path |
| 4 | A single `submittedAttemptRef` slot inverted the guard with two in-flight submits | 4 | **Fixed** — the attempt token is captured per submit, not in one shared ref |
| 5 | The grace category was wired into the record select but not the history filter chips | 4 | **Fixed** — both read `categoryOptions` |
| 6 | The late-response test never asserted the select or the notice | 4 | **Fixed** — it now asserts the selection did not move |
| 7 | With no categories the record fields were unmounted, so the first-use order regressed | 2 | **Fixed** — they stay mounted and disabled; only save is withheld |
| 8 | `aria-expanded` with no `aria-controls`; `htmlFor` pointed at a trigger button | 2 | **Fixed** — `aria-controls` added, the label became `aria-labelledby` |
| 9 | `autoFocus` stole the caret from the amount field | 2 | **Fixed** — focus is taken only on the empty-state path |
| 10 | Cancel reused `dialogClose` ("إغلاق") and was not disabled while pending | 2 | **Fixed** — its own copy, disabled while the create is in flight |
| 11 | The `*` required marker was on the category only, though amount is required too | 1 | **Fixed** |
| 12 | The design doc described the reverted `<div>` record container | spec | **Fixed** — doc updated to the shipped sibling-form structure |
| 13 | The quick-add form duplicates `purchase.tsx`'s pattern | judgement | **Kept** — deliberate precedent-following, documented |
| 14 | `expense-form` testid labelled a `div` | judgement | **Fixed** — renamed `expense-record` |
| 15 | Two refs guarding late mutations are subtle | note | **Reduced** — one ref plus a per-submit token |
| 16 | e2e hardcodes the placeholder copy | note | **Kept** — precedent exists in the same file; testid uniqueness is preferred but not required |
| 17 | `openCategoryForm` cleared the grace entry, so a failed refetch could hide the option again | spec note | **Fixed** — the grace entry is dropped only when the list itself confirms it |
| 18 | Evidence filenames must name the reviewed HEAD | standards | **Fixed** — evidence regenerated at the new head |
