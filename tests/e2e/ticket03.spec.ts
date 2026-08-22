import { expect, test } from "@playwright/test";

/**
 * Ticket 03 e2e flow: create a category, create an item with the live profit
 * preview, save it, and see it listed as low stock on the dashboard.
 */
test("category, item with profit preview, low-stock dashboard", async ({ page }) => {
  // 1. Create a category
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("زيوت");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("زيوت", { exact: true })).toBeVisible();

  // 2. Create an item; the profit preview recomputes while typing
  await page.goto("/items");
  await page.getByLabel("الاسم").fill("بطارية");
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("350");
  await expect(page.getByTestId("profit-preview")).toHaveText("الربح لكل وحدة: 150 دج");

  await page.getByRole("button", { name: "حفظ" }).click();

  // 3. The item appears in the list with a low badge (stock 0 <= threshold 5)
  await expect(page.getByRole("row", { name: /بطارية/ })).toBeVisible();
  await expect(page.getByText("منخفض")).toBeVisible();

  // 4. The dashboard lists it under low stock
  await page.goto("/");
  await expect(page.getByText("بطارية")).toBeVisible();
  await expect(page.getByText("0 / 5")).toBeVisible();
});