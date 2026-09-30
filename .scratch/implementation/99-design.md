# Issue #99 — Create an expense category from the expenses screen

- **Issue:** #99, owner cannot create an expense category
- **Tier:** Standard (UI + tests)
- **Base:** `origin/develop` @ `0b4d5a16c793cb775288fd576cddc3dcc62b7d24`
- **Branch:** `feat/99-expense-categories`
- **Scope:** `apps/web` only. `apps/api` and `packages/contracts` are frozen
  (other lanes are landing there). No schema, no API, no store change.

## Problem

`expenseCategoriesCreate` is defined in `packages/contracts/src/app-contract.ts`
and implemented in the router, but the web app never calls it. On `/expenses`
the category field is a select over `expenseCategoriesList`; a fresh install
seeds categories, but the owner can never add his own (rent, electricity,
transport, tea for the shop). Submitting without a category fails at save with
`CATEGORY_NOT_FOUND` ("التصنيف غير موجود") — a technical sentence with no way
out.

The category is **required** by `expenseCreateInputSchema.categoryId` (a
non-optional `idSchema`). So the honest fix is not to make it optional; it is to
(a) say up front that it is required, (b) let the owner create one without
leaving the screen, and (c) make the empty-list case a teaching state rather
than a save-time error.

## Precedent

`apps/web/src/pages/purchase.tsx` already has the inline-create pattern while
recording: a demoted outline toggle (`purchase-toggle-quick`) with
`aria-expanded`, an inline `<form>` (`purchase-quick-form`) in an accent panel,
its own submit, and `onSuccess` placing the new entity straight into the draft.
`sale.tsx` does the same. This change copies that pattern rather than inventing
a dialog.

The one structural difference: `expenses.tsx` wraps the record fields in a
native `<form>`. HTML forbids nesting forms, so the record form and the
category quick-add form are **siblings**, never nested: the quick-add renders
below the record form (and alone, in the empty state) as its own `<form>` with
native Enter submit. An earlier draft replaced the record `<form>` with a
`<div>` and a `type="button"` save; that was reverted because it silently cost
the record form its Enter-to-submit, which the e2e now pins.

## Component interface — `apps/web/src/pages/expenses.tsx`

New state:

```ts
const [categoryFormOpen, setCategoryFormOpen] = useState(false);
const [newCategoryName, setNewCategoryName] = useState("");
const [categoryError, setCategoryError] = useState<string | null>(null);
const [categoryCreated, setCategoryCreated] = useState<string | null>(null);
```

New mutation:

```ts
const createCategory = useMutation(
  orpc.expenseCategoriesCreate.mutationOptions({
    onSuccess: (category) => {
      setCategoryId(category.id);        // immediately selectable + usable
      setCategoryCreated(category.name);
      setNewCategoryName("");
      setCategoryError(null);
      setCategoryFormOpen(false);
      void queryClient.invalidateQueries({ queryKey: orpc.expenseCategoriesList.queryKey() });
    },
    onError: (err) => setCategoryError(tError(err.message)),
  }),
);
```

Create submit (pure, testable through the DOM): empty name → Arabic inline
error, otherwise `createCategory.mutate({ name })`.

Rendered surface:

- The record card header keeps `expensesRecordTitle`.
- When `expenseCategoriesList` has resolved to **zero** items and the quick-add
  is closed, the card body is an `EmptyState` (`expense-category-empty`) whose
  single action opens the quick-add (`expense-category-empty-action`).
- Otherwise the record fields render. The category cell is a `<div>` with a
  `<span id="expense-category-label">` that carries a visible `*` plus an
  `sr-only` `مطلوب`, and a demoted ghost button `expense-category-add`
  (`aria-expanded`) that toggles the quick-add. The Base UI trigger gets
  `aria-labelledby="expense-category-label"`.
- The select's empty item is relabelled from `—` to `اختر تصنيفاً…` so the
  required, unselected state is honest before submit.
- The quick-add is a sibling `<form data-testid="expense-category-form">` in an
  accent panel: name input (`expense-category-name`, autofocused), submit
  (`expense-category-create`), cancel (`expense-category-cancel`), and an error
  `<p role="alert" data-testid="expense-category-error">` tied to the input via
  `aria-describedby`.
- A successful create shows `expense-category-created` (`role="status"`).
- The record submit path replaces `t("CATEGORY_NOT_FOUND")` with a new key
  `expenseChooseCategory`: the problem **and** the recovery, in Arabic.

No new public helper exports are needed; the interaction is exercised through
the rendered DOM (component tests) and Playwright.

## i18n keys (all new copy in `apps/web/src/lib/i18n.ts`)

| key | Arabic |
| --- | --- |
| `expenseRequired` | مطلوب |
| `expenseCategoryPlaceholder` | اختر تصنيفاً… |
| `expenseCategoryAdd` | تصنيف جديد |
| `expenseCategoryName` | اسم التصنيف |
| `expenseCategoryCreate` | إضافة |
| `expenseCategoryCreated` | تمت إضافة التصنيف {{name}} |
| `expenseCategoryEmpty` | لا توجد تصنيفات بعد |
| `expenseCategoryEmptyHint` | أنشئ أول تصنيف لتسجيل مصروف |
| `expenseCategoryCreateFirst` | إنشاء تصنيف |
| `expenseCategoryNameRequired` | أدخل اسم التصنيف |
| `expenseChooseCategory` | اختر تصنيفاً من القائمة أو أنشئ تصنيفاً جديداً |

`EXPENSE_CATEGORY_EXISTS` already exists ("هذا التصنيف موجود مسبقاً") and covers
the duplicate path.

## Dependencies

None new. Uses the existing `expenseCategoriesCreate` contract, TanStack Query,
Base UI `Select`, the local `Button`/`EmptyState`, and `tError`.

## Planned tests

### Component — `apps/web/src/pages/expenses.test.tsx` (new, `bun test`)

`@/lib/rpc` is mocked (same shape as `purchase.test.tsx`), with mutable category
and expense fixtures.

1. Empty category list → `expense-category-empty` with its action; clicking it
   opens the quick-add; a name submit calls `expenseCategoriesCreate` and the
   new category becomes the selected value.
2. With categories present → `expense-category-add` toggles the quick-add; a
   name submit creates the category and selects it immediately.
3. After creating, recording an expense sends the new category id to
   `expensesCreate`.
4. Submitting the record with no category shows `expenseChooseCategory` (the
   Arabic problem + recovery) and never calls `expensesCreate`.
5. Duplicate create rejects with `EXPENSE_CATEGORY_EXISTS` → the Arabic
   `expense-category-error` is shown, the quick-add stays open, and no category
   is selected.

### E2E — `tests/e2e/expense-reports.spec.ts` (new test in the existing spec)

`DOKAN_PORT=4817 DOKAN_WEB_PORT=5673 bun run test:e2e` (concurrency stays
capped). Flow: sign in → `/expenses` → open the quick-add → create a uniquely
named category → the select shows it and is usable → fill an amount → save →
the history row carries the new category name and amount. Also assert the
required field is named before submit and that no technical error appears.

## Risks

- **Nested-form trap.** Converting the record container to a `<div>` is the
  mitigation; the record submit is an explicit button like sale/purchase. E2E
  and component tests click the button, so Enter-submit loss is not a regression
  for any existing spec.
- **Stale label after create.** `setCategoryId` runs before the list refetch
  resolves, so the trigger could briefly show a raw id. The refetch is the same
  tick in tests; the E2E waits for the visible name. `invalidateQueries` keeps
  the list honest.
- **Select association.** The old wrapper `<label>` becomes a `<span id>` +
  `aria-labelledby`; the a11y check must confirm the accessible name.
- **Locale-neutral guard.** `expenses.tsx` is on the `locale-neutral.test.ts`
  list; every new string goes through `t()`.
- **History/report filters.** Untouched; the change only adds controls inside
  the record card.
- **Out of scope:** items, stock, reports pages, owner-withdrawal flag on
  create, edit/delete of categories.
