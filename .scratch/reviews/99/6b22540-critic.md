# Critic review — PR #110 / issue #99 (HEAD 6b22540, merge-base 0b4d5a1)

Harsh pass. Diff: `apps/web/src/pages/expenses.tsx`, `apps/web/src/lib/i18n.ts`, `apps/web/src/pages/expenses.test.tsx`, `tests/e2e/expense-reports.spec.ts`, `.scratch/*`.

## Findings (score | file:line | what breaks | fix)

**6 | apps/web/src/pages/expenses.tsx:101-113 | a late response from a cancelled attempt still hijacks the screen.** Only the *draft* is guarded:
```ts
setCategoryId(category.id);
setCreatedCategory(category);
...
if (submittedAttemptRef.current === categoryAttemptRef.current) {
```
When "كراء" settles after the owner cancelled, reopened and typed "كهرباء", the page flips from the empty state to the record form, selects "كراء" as the category to record against, and shows `expense-category-created` / "تمت إضافة التصنيف كراء" (line 325-329) under the "كهرباء" draft. The guard's stated purpose ("must not steal the name", :106-108) is half-implemented. Fix: move `setCategoryId`/`setCreatedCategory` inside the same attempt check.

**5 | apps/web/src/pages/expenses.tsx:148 | the teaching state vanishes whenever the list request fails.**
```ts
const categoryListEmpty = categories.data !== undefined && categoryOptions.length === 0;
```
A failed/loading `expenseCategoriesList` leaves `data === undefined`, so `categoryListEmpty` is false: the record form renders with a select whose only option is "اختر تصنيفاً…" (:290) and a save button whose only answer is `expenseChooseCategory` (:178) — exactly the dead end the issue asks to remove. `categories.isError` is never read anywhere on the page. Fix: drive the branch off `isSuccess`/`isError` too, and surface a load-failure row with retry.

**4 | apps/web/src/pages/expenses.tsx:116 | stale *failure* has no attempt guard.** `onError: (err) => setCategoryError(tError(err.message))` fires unconditionally, so an abandoned attempt that fails after cancel+reopen paints "هذا التصنيف موجود مسبقاً" inside the new draft — the mirror of the bug the onSuccess guard was added for. Fix: apply the same `submittedAttemptRef` check in `onError`.

**4 | apps/web/src/pages/expenses.tsx:165 | two in-flight submits invert the guard.** `submittedAttemptRef.current = categoryAttemptRef.current` is a single slot: submit A, cancel, reopen, submit B → A's response now equals the current attempt and wipes B's draft, closes the form and clears the error. Fix: capture the attempt token in the mutation variables and compare that.

**4 | apps/web/src/pages/expenses.tsx:144-147 vs :415 | created category is half-wired.** `categoryOptions` (with the grace entry) feeds only the record select; the history filter chips still map `categories.data?.items.map(...)`. If the post-create refetch fails, the new category is recordable but permanently invisible/unfilterable until another refetch succeeds — the exact state the `createdCategory` state exists to handle. Fix: use `categoryOptions` in both, or seed the query cache on success.

**4 | apps/web/src/pages/expenses.test.tsx:285-309 | test passes against the broken behaviour.** It asserts only `expense-category-form !== null` and `value === "كهرباء"`; it never asserts `selectValue()`/`expense-category-created`, so finding #1 and the silent branch flip (empty state → full record form, `expense-category-empty` gone) go undetected. Add those assertions.

**2 | apps/web/src/pages/expenses.tsx:230-246 | first-use data-entry order regressed.** With zero categories the amount/note/date inputs are unmounted entirely (`expense-amount` is even asserted null at test :280); the owner must create a category before typing anything. Fix: keep the record fields mounted but disabled.

**2 | apps/web/src/pages/expenses.tsx:262 | `aria-expanded` with no `aria-controls`;** the revealed form has no id, and `htmlFor="expense-category"` (:253) points at a base-ui trigger button.

**2 | apps/web/src/pages/expenses.tsx:199 | `autoFocus` steals the caret** from the amount field whenever the inline create opens mid-entry.

**2 | apps/web/src/pages/expenses.tsx:211 | cancel reuses `t("dialogClose")` ("إغلاق") against "إضافة"** — register mismatch; cancel is also not `disabled` while `createCategory.isPending`, unlike the submit at :208.

**1 | apps/web/src/pages/expenses.tsx:63 (also :22-23) | the comment's justification is false.** `purchase.tsx:44,96-97,210-226` has only a quick category *select* (`itemsChooseCategory`), no inline create; the precedent is `sale.tsx`. A pointer other lanes will trust.

**1 | tests/e2e/expense-reports.spec.ts:175-206 | `Date.now()` category names, no cleanup,** so a persistent DB accumulates categories and a cross-run name collision (exact-match uniqueness at `router.ts:1310`) fails the test. Also `\ No newline at end of file`.

**1 | apps/web/src/pages/expenses.tsx:255 vs :300-311 | the `*` required marker is applied to the category only,** though `amount` is equally required (`expenseInvalidAmount`, :173).

What is right: `expenseChooseCategory` replaces the raw `CATEGORY_NOT_FOUND` key (:178), the `createdCategory` grace entry is a genuine correctness win, `Set<ExpenseCategory>` typing is clean, and the Enter-to-submit e2e change is honest about the new nesting (`expense-category-form` stays outside the record form).
