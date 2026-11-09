import { expect, test } from "@playwright/test";
import type { ItemCreate } from "../../packages/contracts/src/core";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { captureEvidence } from "./money-display-helpers";
import { actAndAck, callRpc } from "./rpc-helpers";

// #254 evidence (#259): the money display is a VISUAL change, so this spec can
// record a video at real user pace when a lane asks for one. CI never sets
// E2E_VIDEO, so CI records nothing.
test.use({ video: process.env.E2E_VIDEO === "1" ? "on" : "off" });

/**
 * E2E flow: create a category, create an item with the live profit
 * preview, save it, and see it listed as low stock on the dashboard.
 */
test("the last table row category editor opens its menu outside the scroll container", async ({ page }) => {
  const stamp = Date.now();
  const itemName = `😀 PR460-last-row-${stamp}`;
  const categoryName = `PR460-category-${stamp}`;
  await signIn(page);
  const baseCategory = await callRpc<{ id: string }, { name: string }>(page, "categoriesCreate", {
    name: `PR460-base-${stamp}`,
  });
  await callRpc<{ id: string }, { name: string }>(page, "categoriesCreate", { name: categoryName });
  const seededItem = await callRpc<{ id: string }, ItemCreate>(page, "itemsCreate", {
    name: itemName,
    categoryId: baseCategory.id,
    costPrice: 100,
    sellingPrice: 150,
    lowStockThreshold: 0,
  });
  await page.goto("/items");
  await openItemsTab(page, "products");

  const table = page.getByRole("table");
  const lastRow = table.getByRole("row").last();
  const seededRow = table.getByRole("row").filter({ hasText: itemName });
  await expect(lastRow).toContainText(itemName);
  await lastRow.getByTestId(`edit-item-${seededItem.id}`).click();
  const editor = lastRow.getByTestId("edit-category");
  await editor.click();
  const menu = page.getByTestId("edit-category-menu");
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((element) => element.closest(".overflow-x-auto") === null)).toBe(true);
  await editor.fill(categoryName);
  const option = menu.getByRole("option", { name: categoryName, exact: true });
  await expect(option).toBeVisible();
  await option.click();
  await actAndAck(page, "itemsUpdate", () => lastRow.getByTestId("edit-save").click());
  await expect(lastRow).toContainText(categoryName);

  await lastRow.getByTestId(`edit-item-${seededItem.id}`).click();
  const reopenedEditor = lastRow.getByTestId("edit-category");
  await reopenedEditor.click();
  const reopenedMenu = page.getByTestId("edit-category-menu");
  await expect(reopenedMenu).toBeVisible();
  await reopenedEditor.fill(`PR460-base-${stamp}`);
  await reopenedMenu.getByRole("option", { name: `PR460-base-${stamp}`, exact: true }).click();
  await actAndAck(page, "itemsUpdate", () => lastRow.getByTestId("edit-save").click());
  await page.reload();
  await openItemsTab(page, "products");
  await expect(seededRow).toBeVisible();
  await expect(seededRow).toContainText(`PR460-base-${stamp}`);
});

test("category, item with profit preview, low-stock dashboard", async ({ page }) => {
  const stamp = Date.now();
  // 0. sign in (the session guard is part of the seam)
  await signIn(page);

  // 1. Create a category
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(`زيوت-${stamp}`);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(`زيوت-${stamp}`, { exact: true })).toBeVisible();

  // 2. Create an item; the profit preview recomputes while typing
  await page.goto("/items");
  await openItemsTab(page, "add");
  await page.getByLabel("الاسم", { exact: true }).fill(`بطارية-${stamp}`);
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("350");
  // tie the item to the category created above so the table shows its NAME; the
  // dropdown options arrive via an async categories query, so wait for the
  // option before selecting (prevents a race with the fetch)
  const categorySelect = page.getByLabel("التصنيف");
  await chooseSelectOption(page, categorySelect, `زيوت-${stamp}`);
  await expect(page.getByTestId("profit-preview")).toHaveText("الربح لكل وحدة: 150 دج");
  // #254 round 3 — the sentence carries the amount through the money primitive,
  // so a five-figure profit is grouped and the currency is the primitive's run,
  // not a literal the catalog owns
  await page.getByLabel("سعر البيع (دج)").fill("12700");
  const preview = page.getByTestId("profit-preview");
  await captureEvidence(page, "money-profit-preview");
  await expect(preview.getByTestId("money-figures")).toHaveText("12,500");
  await expect(preview.getByTestId("money-currency")).toHaveText("دج");
  await page.getByLabel("سعر البيع (دج)").fill("350");

  // Acknowledge the item write before switching tabs; the response helper checks
  // HTTP success and the oRPC success envelope.
  await actAndAck(page, "itemsCreate", () => page.getByRole("button", { name: "حفظ" }).click());

  // 3. The item appears with out-of-stock text because its quantity is zero.
  await openItemsTab(page, "products");
  const batteryRow = page.getByRole("row", { name: new RegExp(`بطارية-${stamp}`) });
  await expect(batteryRow).toBeVisible();
  await expect(batteryRow).toContainText(`زيوت-${stamp}`); // category NAME, not a UUID
  await expect(batteryRow.locator('[data-stock-status="out-of-stock"]')).toHaveText("نفد المخزون");

  // 4. The dashboard lists it under low stock
  await page.goto("/");
  const dashboardRow = page
    .getByTestId("dashboard-low-stock-list")
    .getByRole("listitem")
    .filter({ hasText: `بطارية-${stamp}` });
  await expect(dashboardRow).toBeVisible();
  await expect(dashboardRow).toContainText("نفد المخزون");
  await expect(dashboardRow).toContainText("المخزون الحالي: 0");
  await expect(dashboardRow).toContainText("حد التنبيه: 5");
});
