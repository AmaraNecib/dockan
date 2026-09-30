# Defender — PR #110 / issue #99 (HEAD 6b22540)

## Defences (each with file:line + hunk)

**1. It wires the dead contract, nothing more.** `expenses.tsx:99` `const createCategory = useMutation(` + `:165` `submittedAttemptRef.current = categoryAttemptRef.current;` — `expenseCategoriesCreate` had *zero* web call sites; this is the minimal wiring. UI-only: diff touches `apps/web/src/**` + `tests/e2e`, no `apps/api`, no `packages/contracts`. Confidence 10.

**2. Precedent, not invention.** `expenses.tsx:270` `data-testid="expense-category-add"` (outline, `aria-expanded`) + `:191` `const categoryForm = (` in an `accent` panel with a `dialogClose` cancel — the exact shape of `purchase.tsx:183` `"purchase-toggle-quick" aria-expanded={quickOpen}` / `:199` `rounded bg-accent p-3`. Confidence 9.

**3. The dead end is removed, not reported.** `expenses.tsx:231` `{categoryListEmpty ? (` renders `EmptyState` (Tags icon, hint) and *no* record controls, so `expense-save` cannot exist to answer `CATEGORY_NOT_FOUND`; test `"never offers save before any category exists…"` asserts `expect(ui.query("expense-save")).toBeNull()`. This is stronger than issue wording #3 ("say so and offer"). Confidence 9.

**4. Required-ness stated up front (issue #4 met head-on).** `:256` `<span className="sr-only"> ({t("expenseRequired")})</span>` + visible `*` + `expenseCategoryPlaceholder: "اختر تصنيفاً…"` (i18n.ts:415). Confidence 9.

**5. Failure copy is Arabic problem+recovery.** `:178` `setError(t("expenseChooseCategory"));` replacing `t("CATEGORY_NOT_FOUND")`, resource = `"اختر تصنيفاً من القائمة أو أنشئ تصنيفاً جديداً"` (i18n.ts:424). All 11 new strings live in i18n.ts:413-424, so `locale-neutral.test.ts:55` (`"apps/web/src/pages/expenses.tsx"`) stays green. Confidence 10.

**6. The complexity is falsifiable, not speculative.** `:144-148` merge `createdCategory` into `categoryOptions` so a failed refetch cannot bounce the owner back to the empty state; `:109` `if (submittedAttemptRef.current === categoryAttemptRef.current)` so a late-settling cancelled create cannot wipe a newer draft. Both are exercised: `"keeps recording available when the create succeeds but the list refresh fails"` and `"keeps a reopened draft when a cancelled create settles late"`. Confidence 8.

**7. Enter-to-submit was restored with coverage.** `:249` `data-testid="expense-record-form"` re-wraps the controls as a sibling of the quick-add (no nesting), and `expense-reports.spec.ts:60` `await page.getByTestId("expense-amount").press("Enter");` now proves the native path in a browser. Confidence 9.

## False alarms

- *"Enter-submit lost"* — false at HEAD; re-fixed in 6b22540 with an E2E guard.
- *"nested `<form>`"* — false: the component test asserts `closest("form")?.dataset.testid` is `expense-record-form` for the amount and `expense-category-form` for the quick-add.
- *"`expense-form` testid is no longer a form"* — no consumer depended on element type; suite green.
- *"loading shows an empty select"* (`:148` gates on `data !== undefined`) — cosmetic only; save still names the recovery.
- *"`dialogClose` reused as cancel label"* — consistent with `sale.tsx:439`.
- *"local `@/lib/rpc` mock duplicates purchase.test.tsx"* — reuses the established seam.

Residual: no trailing newline at EOF, pre-existing at base (base also ends `});`).
