import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { captureEvidence } from "./money-display-helpers";

// #254 evidence (#259): the money display is a VISUAL change, so this spec can
// record a video at real user pace when a lane asks for one. CI never sets
// E2E_VIDEO, so CI records nothing.
test.use({ video: process.env.E2E_VIDEO === "1" ? "on" : "off" });

/**
 * E2E flow: create a category, create an item with the live profit
 * preview, save it, and see it listed as low stock on the dashboard.
 */
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

  await page.getByRole("button", { name: "حفظ" }).click();

  // 3. The item appears in the list with a low badge (stock 0 <= threshold 5)
  await openItemsTab(page, "products");
  const batteryRow = page.getByRole("row", { name: new RegExp(`بطارية-${stamp}`) });
  await expect(batteryRow).toBeVisible();
  await expect(batteryRow).toContainText(`زيوت-${stamp}`); // category NAME, not a UUID
  await expect(batteryRow.getByText("منخفض")).toBeVisible();

  // 4. The dashboard lists it under low stock
  await page.goto("/");
  const dashItem = page.getByText(`بطارية-${stamp}`);
  await expect(dashItem).toBeVisible();
  await expect(dashItem.locator("..")).toContainText("0 / 5");
});