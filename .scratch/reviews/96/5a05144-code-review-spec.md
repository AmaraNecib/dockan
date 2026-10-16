## Spec review — issue #96, `git diff 071a1c4...HEAD` (3 commits); round-1 findings re-checked at 5a05144

### Correct (round-1 items closed)
- R1-3 partially: `categoriesEmptyAction` now names the step — `i18n.ts:164` = "أضف تصنيفاً" ("add a category"), not the mechanic.
- R1-note (items, failed category read): commit message + `items.tsx:798-812` (`categoriesUnavailable = categories.isError`) now omit the action; pinned by `items.test.tsx:433`. Acceptable: brief's "every button … must lead somewhere that helps".
- Evidence bar met: `decisions.md` table, 16 before/after screenshots, `tests/e2e/01-empty-states.spec.ts`, i18n key-completeness spec. "Two commits, one per group" still holds.

### Missing / partial (still open from round 1)
1. Issue: "**Read-only lists with no honest action.** … returns, purchase link-proposals, **invoice lines**." Still no empty branch on the product-line table (`invoice.tsx:896`); `decisions.md` §Judgement notes substitutes "judged as the two invoice-detail histories". A documented substitution, not an implementation — unchanged since round 1.

### Scope creep (unchanged, not dispositioned)
2. `expenses.tsx:569-573` `history.isError` alert: the issue asks only for "a genuinely useful next action, or copy that explains what will appear there and why it is empty". A failed-read branch changes failure behaviour; round-1 flagged it and 5a05144 neither reverted nor mentioned it.

### Wrong / weak (unchanged, only partially touched)
3. `categories.tsx:66-71`: action still only `nameRef.current?.focus()` on the field directly above; label improved, behaviour not. Hint (`i18n.ts:163`) already gives the same instruction — still the weakest action in the diff.
4. `invoices.tsx:114`: `kind === "" && status === "" ? "invoicesEmptyHint" : "invoicesEmptyFilteredHint"`. With a filter set and **zero** invoices in the shop, the copy is "لا توجد فواتير مطابقة للتصفية الحالية" (`i18n.ts:492`) — untrue; the clear-filters action lands on the same empty list. The new test (`invoices.test.tsx:222-229`) covers the clearing mechanics, not this case.
5. Brief: "Use it; do not hand-roll markup" — `purchase.tsx:435` still a bare `<p>`; justification (panel `h3`) is reasonable and now pinned (`purchase.test.tsx:259-271`). Minor deviation.

### Note
- `items.tsx:809-812`: while the category read is pending the add action renders, then vanishes on error (test waits for that). Offered-then-withdrawn control; consider gating on `!categories.isPending`.
- Round-1 note (empty categories → `/categories`) unresolved: I could not confirm the create schema requires `categoryId`, so "the form cannot be completed" remains unverified.
