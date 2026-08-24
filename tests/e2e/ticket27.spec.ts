import { expect, test } from "@playwright/test";

/**
 * Ticket 27 e2e flow: create an item, add stock manually through the ledger,
 * verify the raised stock in the items list, open the item history and check
 * the derived stock-after column, then confirm an oversell is rejected and
 * changes nothing. (Opening-row backfill behavior is covered by store tests.)
 */
test("add stock manually, item history shows movements with derived stock", async ({ page }) => {
  // 0. first-time setup + sign in
  await page.goto("/");
  await page.getByText("أنشئ كلمة السر بالرمز السري").click();
  await page.getByTestId("setup-secret").fill("e2e-secret-0123456789");
  await page.getByTestId("setup-phone").fill("0550123123");
  await page.getByTestId("setup-password").fill("pass-1234");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("setup-message")).toContainText("تم الإعداد");
  await page.getByTestId("login-submit").click();
  await expect(page.getByText("الرئيسية")).toBeVisible();

  // 1. create a category + an item (stock starts at 0)
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("بطاريات");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("بطاريات", { exact: true })).toBeVisible();

  await page.goto("/items");
  await page.getByLabel("الاسم").fill("مكواة 27");
  await page.getByLabel("سعر الشراء (دج)").fill("2000");
  await page.getByLabel("سعر البيع (دج)").fill("3500");
  // threshold 0 keeps this item off the shared low-stock dashboard so the
  // other spec files' assertions stay deterministic
  await page.getByLabel("حد التنبيه").fill("0");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByRole("row", { name: /مكواة 27/ })).toBeVisible();

  // 2. record a manual stock-in of 6 units at 2000 DZD
  const stockForm = page.getByTestId("stock-form");
  await stockForm.getByRole("combobox").selectOption({ label: "مكواة 27" });
  await page.getByTestId("stock-delta").fill("6");
  await stockForm.getByLabel("تكلفة الوحدة (دج)").fill("2000");
  await stockForm.getByRole("button", { name: "تسجيل" }).click();
  await expect(page.getByTestId("stock-done")).toContainText("تم تسجيل الحركة");

  // 3. the items list reflects the new stock (exact cell match, not substring)
  await expect(page.getByRole("row", { name: /مكواة 27/ }).getByTestId("stock-after-cell")).toHaveText("6");

  // 4. history: the manual movement with derived stock-after. A fresh item
  // has no ledger history before this, so exactly one row exists (the
  // synthetic "opening" backfill applies only to pre-ledger items).
  await page
    .getByRole("row", { name: /مكواة 27/ })
    .getByRole("link", { name: "السجل" })
    .click();
  await expect(page.getByTestId("history-table")).toBeVisible();
  const rows = page.getByTestId("history-table").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("+6");
  await expect(page.getByTestId("stock-after").last()).toHaveText("6");

  // 5. overselling is rejected by the api with a translated error…
  await page.goto("/items");
  await page.getByTestId("stock-form").getByRole("combobox").selectOption({ label: "مكواة 27" });
  await page.getByTestId("stock-delta").fill("-99");
  await page.getByTestId("stock-form").getByRole("button", { name: "تسجيل" }).click();
  await expect(page.getByTestId("stock-error")).toContainText("الكمية غير متوفرة في المخزون");
  // …and the rejected delta changed nothing
  await expect(page.getByRole("row", { name: /مكواة 27/ }).getByTestId("stock-after-cell")).toHaveText("6");
});
