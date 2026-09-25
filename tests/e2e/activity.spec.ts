import { expect, test } from "@playwright/test";
import { expectSelectOption } from "./select-helpers";

/**
 * E2E smoke: real flows (category + item creation) land entries in
 * the activity log screen, newest first, in Arabic.
 * Unique names per the parallel-specs shared-DB rule (wisdom 2026-08-24).
 */
test("activity log lists real-flow entries newest first", async ({ page }) => {
  // first-time setup + sign in (idempotent across the shared e2e database)
  await page.goto("/");
  await page.getByText("أنشئ كلمة السر بالرمز السري").click();
  await page.getByTestId("setup-secret").fill("e2e-secret-0123456789");
  await page.getByTestId("setup-phone").fill("0550123123");
  await page.getByTestId("setup-password").fill("pass-1234");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("setup-message")).toContainText("تم الإعداد");
  await page.getByTestId("login-submit").click();
  await expect(page.getByText("الرئيسية")).toBeVisible();

  // real flow: create a category then an item
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("سجل-تصنيف-12");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("سجل-تصنيف-12", { exact: true })).toBeVisible();

  await page.goto("/items");
  await expectSelectOption(page, page.getByLabel("التصنيف"), "سجل-تصنيف-12");
  await page.getByLabel("الاسم", { exact: true }).fill("سجل-منتج-12");
  await page.getByLabel("سعر الشراء (دج)").fill("300");
  await page.getByLabel("سعر البيع (دج)").fill("500");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByRole("row", { name: /سجل-منتج-12/ })).toBeVisible();

  // the log shows both events, newest (the item) first
  await page.goto("/activity");
  const rows = page.getByTestId("activity-table").locator("tbody tr");
  await expect(rows.first()).toContainText("إنشاء منتج");
  await expect(rows.first()).toContainText("سجل-منتج-12");
  // the item creation carries its related item id as a ref
  await expect(rows.first().getByTestId("activity-ref")).not.toHaveText("—");
  await expect(rows.nth(1)).toContainText("إنشاء تصنيف");
});
