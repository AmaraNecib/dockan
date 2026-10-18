# Standards axis — PR #110 / issue #99 (HEAD 6b22540, base 0b4d5a1)

## Hard violations (documented standards)

1. **Stale review evidence shipped in the PR.** `docs/engineering-workflow.md`: *"Evidence filenames must contain the exact reviewed HEAD SHA; any later reviewable-file change makes evidence stale."* The PR adds `.scratch/reviews/99/d8a0bcdb6abb77db9a003573b3e32b281a092ad2-code-review.md` and `…-test-audit.md`, but HEAD is `6b22540ece195b5c88fe46ccdc246b1f6021856f` and the later commit `6b22540 fix(web): keep expense recording reachable after a failed refresh (#99)` touches reviewable files:
   `apps/web/src/pages/expenses.test.tsx | 104 +++-  apps/web/src/pages/expenses.tsx | 274 +++---  tests/e2e/expense-reports.spec.ts | 5 +-`
   The evidence therefore certifies a SHA that is no longer the code under review; the gate must be re-run at `6b22540` (or the evidence re-issued) before Guard Phase 2.

## Judgement calls / baseline smells

2. **Duplicated Code — quick-add form (expenses.tsx `@@ -119,61 +186,150 @@`).** `data-testid="expense-category-form"` reimplements `purchase.tsx:198` (`data-testid="purchase-quick-form"`) field-for-field (`autoComplete="off"`, same submit-button/cancel shape). `pr-99.md` states this is deliberate (*"mirroring the purchase quick-add precedent rather than inventing a pattern"*), so it is a consistency win, but it is now a second copy of the pattern to keep in sync.

3. **Mysterious Name — renamed container kept its old testid.** `@@ -16,6 +19,10 @@`/record block: `<form … data-testid="expense-form">` became
   `<div className="mt-4 grid gap-4 rounded border bg-card p-4" data-testid="expense-form">`
   while the real form inside is `data-testid="expense-record-form"`. A testid named *form* now labels a `div`; the comment in the payload explains *why* (`<div>` avoids illegal nested forms) but not the id. Rename to `expense-record` or similar.

4. **Duplicated Code / copy coupling — e2e literals.** `tests/e2e/expense-reports.spec.ts` hardcodes Arabic: `await expect(page.getByTestId("expense-category")).toContainText("اختر تصنيفاً…");` and
   `const categoryName = \`صيانة-${stamp}\`;`. The placeholder assertion duplicates an `i18n.ts` value, so any copy edit breaks the test. The brief's *"All copy through apps/web/src/lib/i18n.ts; no hardcoded Arabic"* is user-facing-copy scope, and the same file already asserts `"سحب المالك"`/`"كراء المحل"` — so precedent-following, not a violation. Prefer `getByTestId` uniqueness over copy text.

5. **Note — `submittedAttemptRef` / `categoryAttemptRef` (`@@ -53,6 +60,18 @@`).** Two refs guarding late-settling mutations is subtle state that only exists because the form can render twice; each carries a comment, so readable, but it is the kind of thing a later edit will silently break (the tests do cover it).

6. **Note — `tests/e2e/expense-reports.spec.ts` "\ No newline at end of file"** (pre-existing in the added hunk's tail). No `.editorconfig`/prettier config found, so tooling does not enforce it; cosmetic.

No Feature Envy, Shotgun Surgery, Divergent Change, Speculative Generality, Primitive Obsession (raw `categoryId: string` is pre-existing) or Refused Bequest found. i18n keys are added only in `apps/web/src/lib/i18n.ts`; no new raw palette class (`text-green-700` on the saved span is pre-existing); `docs/engineering-workflow.md` UI-only constraint (`apps/api`, `packages/contracts` untouched) holds.
