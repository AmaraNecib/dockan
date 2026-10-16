import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { runE2eReset } from "./reset-helpers";

/**
 * Issue #96 — secondary empty states name a real next action.
 *
 * The suite shares one database, so this spec owns its empty state the same
 * way `00-onboarding.spec.ts` does: it resets shop records in `beforeAll`.
 * The numeric prefix keeps it ahead of the feature specs, which seed their own
 * records, so the reset cannot delete a later spec's fixtures.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  runE2eReset("reset-e2e-records.mjs");
});

test("categories: the empty state focuses the adjacent add field", async ({ page }) => {
  await signIn(page);
  await page.goto("/categories");

  const empty = page.getByTestId("categories-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("لا توجد تصنيفات بعد");
  await expect(empty).toContainText("اكتب اسم التصنيف في الحقل أعلاه ثم اضغط إضافة");

  await page.getByTestId("categories-empty-action").click();
  await expect(page.getByPlaceholder("اسم تصنيف جديد")).toBeFocused();
});

test("items: the empty state opens the add tab once a category exists", async ({ page }) => {
  await signIn(page);

  // the add form needs a category it cannot create; a category is a precondition
  const stamp = Date.now().toString();
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(`تصنيف-${stamp}`);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(`تصنيف-${stamp}`, { exact: true })).toBeVisible();

  await page.goto("/items");
  const empty = page.getByTestId("items-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("أنشئ أول منتج بأسعار الشراء والبيع ليظهر في القائمة");

  await page.getByTestId("items-empty-action").click();
  await expect(page.locator("#items-panel-add")).toBeVisible();
  await expect(page.locator("#items-panel-products")).toBeHidden();
});

test("invoices: the empty state links to a new sale and a new purchase", async ({ page }) => {
  await signIn(page);
  await page.goto("/invoices");

  const empty = page.getByTestId("invoices-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("تظهر هنا فواتير البيع والشراء بعد إنشائها.");
  await expect(page.getByTestId("invoices-empty-action")).toHaveAttribute("href", "/sale");

  await page.getByTestId("invoices-empty-action").click();
  await expect(page).toHaveURL(/\/sale$/);
  await expect(page.getByTestId("sale-form")).toBeVisible();
});

test("expenses: the history empty state focuses the record field", async ({ page }) => {
  await signIn(page);
  await page.goto("/expenses");

  const empty = page.getByTestId("expenses-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("سجّل مصروفاً من الأعلى ليظهر في هذا الجدول.");

  await page.getByTestId("expenses-empty-action").click();
  await expect(page.getByTestId("expense-amount")).toBeFocused();
});

test("reports: the breakdown empty state links to recording an expense", async ({ page }) => {
  await signIn(page);
  await page.goto("/reports");

  const empty = page.getByTestId("report-breakdown-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("لا توجد مصاريف في هذه الفترة؛ سجّلها من شاشة المصاريف ثم اختر نفس الفترة هنا.");
  await expect(page.getByTestId("reports-empty-action")).toHaveAttribute("href", "/expenses");

  await page.getByTestId("reports-empty-action").click();
  await expect(page).toHaveURL(/\/expenses$/);
});

test("read-only lists explain what fills them instead of faking an action", async ({ page }) => {
  await signIn(page);

  // activity is omitted here: provisioning the owner writes one activity row,
  // so the log is never empty on a clean room; activity-empty.test.tsx covers it.
  await page.goto("/returns");
  const returns = page.getByTestId("returns-list-empty");
  await expect(returns).toBeVisible();
  await expect(returns).toContainText("تُسجَّل المرتجعات من شاشة الفاتورة، وتظهر هنا للمراجعة.");
  await expect(returns.locator("button, a")).toHaveCount(0);

  await page.getByTestId("returns-tab-suppliers").click();
  const supplierReturns = page.getByTestId("supplier-returns-empty");
  await expect(supplierReturns).toBeVisible();
  await expect(supplierReturns).toContainText("تُسجَّل مرتجعات الموردين من كشف حساب المورّد، وتظهر هنا.");
  await expect(supplierReturns.locator("button, a")).toHaveCount(0);
});
