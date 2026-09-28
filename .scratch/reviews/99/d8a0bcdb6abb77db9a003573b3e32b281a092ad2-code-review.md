# Code review — issue #99 (create an expense category from the expenses screen)

- **Base:** `0b4d5a16c793cb775288fd576cddc3dcc62b7d24` (`origin/develop`)
- **HEAD:** `d8a0bcdb6abb77db9a003573b3e32b281a092ad2`
- **Diff command:** `git diff 0b4d5a16c793cb775288fd576cddc3dcc62b7d24...HEAD`
- **Commits:** `5596a1a` feat, `2c71fbb` test, `d8a0bcd` fix
- **Tier:** Standard
- **Spec:** lane brief issue #99 + `.scratch/implementation/99-design.md`
- **Note:** the two review axes were run directly in this session (the
  sub-agent tool was not available in the turn); each axis is reported
  separately and not merged.

## Standards

Sources: `docs/engineering-workflow.md`, `AGENTS.md`, `CONTEXT.md`, the
repo's anti-slop oxlint config, and the Fowler smell baseline.

### Hard violations

None.

- `bun run lint` clean; `bun run typecheck` 3/3; `bun run test` 245 pass.
- All copy goes through `apps/web/src/lib/i18n.ts`; `expenses.tsx` carries no
  Arabic literal, so `apps/api/src/lib/locale-neutral.test.ts` stays green.
- No `apps/api` or `packages/contracts` change (constraint honoured).
- Named files only were staged; `.dokan-port` was restored byte-exact (`4317`).

### Judgement calls

1. **Record container `<form>` → `<div>`.** HTML forbids nested forms, so the
   record form became a `<div>` with an explicit `type="button"` save (the
   `sale.tsx` / `purchase.tsx` shape) and the quick-add is a real `<form>`.
   Consequence: Enter no longer submits the record fields. This is consistent
   with the other two record screens and is the deliberate trade for a native
   quick-add form; accepted.
2. **Two entry points into the quick-add** (`expense-category-add` toggle and
   the empty-state action). They now share `openCategoryForm`, so the success
   message clears on reopen; the duplication is gone.
3. **`expense-form` testid moved to a `<div>`.** No test or spec depended on it
   being a form element; verified by the green suite.

### Smell baseline

No finding. Names are honest (`categoryListEmpty`, `submitCategory`,
`openCategoryForm`); no Feature Envy, Data Clumps, Repeated Switches, Shotgun
Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man,
or Refused Bequest. The select's `items` + `SelectContent` repetition is the
Base UI API contract, not extractable duplication.

## Spec

### Missing or partial

None. Requirement-by-requirement:

- **Create from where it is needed, inline, following the existing precedent.**
  Done: demoted outline toggle + accent inline form + immediate selection,
  copied from the purchase quick-add.
- **Wire `expenseCategoriesCreate`.** Done; previously zero call sites.
- **Honest empty state.** Done: `EmptyState` teaches "لا توجد تصنيفات بعد /
  أنشئ أول تصنيف لتسجيل مصروف" and offers the first-create action; the save
  button is not rendered until a category exists.
- **Required, stated up front.** The api schema makes `categoryId` required, so
  it stays required: visible `*` + `sr-only` "مطلوب", and the placeholder is
  "اختر تصنيفاً…". The save-time message is now `expenseChooseCategory`
  ("اختر تصنيفاً من القائمة أو أنشئ تصنيفاً جديداً") — problem + recovery in
  Arabic, replacing the technical `CATEGORY_NOT_FOUND`.
- **UI-only.** No api/contracts change.
- **Existing history, history filters, report filters keep working.** Untouched;
  covered by the existing expense/report tests, all green.
- **Reuse components/tokens.** `Button`, `EmptyState`, Base UI `Select`,
  `accent`/`destructive`/green tokens.
- **Out of scope respected.** Items/stock/reports pages untouched; no expense
  feature beyond category creation.

### Scope creep

Two small additions inside the create flow: a `role="status"` success line and
a cancel button. Both are recovery/feedback for the new control, not new
features; accepted.

### Implemented-but-wrong

None found. One defect was found and fixed during this review: reopening the
quick-add after a success left the stale confirmation visible (`d8a0bcd`).

## Summary

- **Standards:** 0 hard violations; 3 judgement calls, 1 of which was fixed
  (`d8a0bcd`). Worst issue: the Enter-submit change, accepted as consistent with
  sale/purchase.
- **Spec:** 0 missing/partial, 0 out-of-scope, 0 implemented-but-wrong; one
  defect fixed. Worst issue: none outstanding.
