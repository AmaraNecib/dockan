import { expect, test } from "@playwright/test";

/**
 * Ticket 03 e2e flow: create a category, create an item with the live profit
 * preview, save it, and see it listed as low stock on the dashboard.
 */
test("category, item with profit preview, low-stock dashboard", async ({ page }) => {
  // 0. first-time setup + sign in (the session guard is part of the seam)
  await page.goto("/");
  await page.getByText("أنشئ كلمة السر بالرمز السري").click();
  await page.getByTestId("setup-secret").fill("e2e-secret-0123456789");
  await page.getByTestId("setup-phone").fill("0550123123");
  await page.getByTestId("setup-password").fill("pass-1234");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("setup-message")).toContainText("تم الإعداد");
  await page.getByTestId("login-submit").click();
  await expect(page.getByText("الرئيسية")).toBeVisible();

  // 1. Create a category
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("زيوت");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("زيوت", { exact: true })).toBeVisible();

  // 2. Create an item; the profit preview recomputes while typing
  await page.goto("/items");
  await page.getByLabel("الاسم", { exact: true }).fill("بطارية");
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("350");
  await expect(page.getByTestId("profit-preview")).toHaveText("الربح لكل وحدة: 150 دج");

  await page.getByRole("button", { name: "حفظ" }).click();

  // 3. The item appears in the list with a low badge (stock 0 <= threshold 5)
  const batteryRow = page.getByRole("row", { name: /بطارية/ });
  await expect(batteryRow).toBeVisible();
  await expect(batteryRow.getByText("منخفض")).toBeVisible();

  // 4. The dashboard lists it under low stock
  await page.goto("/");
  await expect(page.getByText("بطارية")).toBeVisible();
  await expect(page.getByText("0 / 5")).toBeVisible();
});