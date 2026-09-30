import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { expectSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * E2E smoke: real flows (category + item creation) land entries in
 * the activity log screen, newest first, in Arabic.
 * Unique names per the parallel-specs shared-DB rule (wisdom 2026-08-24).
 */
test("activity log lists real-flow entries newest first", async ({ page }) => {
  // sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // real flow: create a category then an item
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("سجل-تصنيف-12");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("سجل-تصنيف-12", { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await expectSelectOption(page, page.getByLabel("التصنيف"), "سجل-تصنيف-12");
  await page.getByLabel("الاسم", { exact: true }).fill("سجل-منتج-12");
  await page.getByLabel("سعر الشراء (دج)").fill("300");
  await page.getByLabel("سعر البيع (دج)").fill("500");
  await page.getByRole("button", { name: "حفظ" }).click();
  await openItemsTab(page, "products");
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
