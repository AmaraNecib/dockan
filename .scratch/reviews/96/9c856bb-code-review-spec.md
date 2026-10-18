## Spec review — issue #96, `git diff 071a1c4...HEAD` (2 commits)

### Correct
- "Two commits, one per group, so a reviewer can judge Group A and Group B separately" — satisfied: `3508208` is Group A copy-only, `9c856bb` Group B focus/nav.
- "The read-only group is judged individually" — satisfied. Every Group A state passes `title`+`hint` only, no `action`, with a per-screen key (`i18n.ts` activityEmptyHint:55, diagnosticsEmptyHint:113, historyEmptyHint:235, pmtEmpty*/pmtEmptySettledHint:512-515, returnsEmptyHint:557, supplierReturnsEmptyHint:900, party*:813-817, supplierAccountEmptyHint:856).
- "No invented actions" — invoice payments/returns gate the action on usability (`invoice.tsx:181-205` `remaining === 0 || savedPayment !== null ? undefined`; `:578-596` `hasReturnableLine` via `remainingReturnableFor`).

### Missing / partial
1. Issue Group A names "invoice lines"; `decisions.md` reinterprets it ("'Invoice lines' is judged as the two invoice-detail histories"). The product-line table (`invoice.tsx:896`) has no empty branch at all. A documented substitution, but the named list never got its own judgement.

### Scope creep
2. `expenses.tsx:570-574` adds a new `history.isError` alert branch. The issue asks for "either a genuinely useful next action, or copy that explains what will appear"; this changes failure-state behaviour ("a failed history read now shows the error instead of 'empty'", commit `9c856bb`).

### Wrong / weak
3. `categories.tsx:66-71` action `categoriesEmptyAction` = «اكتب اسم التصنيف» whose only effect is `nameRef.current?.focus()` on the field directly above, while hint `i18n.ts:163` already says "write the name above then press Add". The button restates the hint without advancing the task — weakest action in the diff.
4. `invoices.tsx:113-117` selects `invoicesEmptyFilteredHint` ("لا توجد فواتير مطابقة للتصفية الحالية") whenever a filter is set, even when the shop has zero invoices; the action then clears filters and lands on the same empty list. Copy untrue in that case.
5. Brief: "Use it; do not hand-roll markup" — `purchase.tsx:435` keeps a bare `<p>` (justified in `decisions.md` by the panel's own `h3`). Minor deviation.

### Note
- `items.tsx:796` sends the no-category case to `/categories` because the add form "cannot be completed" without one, but the form renders an empty placeholder category option (`items.tsx:499-507`). Verify the field is required; otherwise the action moves the user away from a completable task.
