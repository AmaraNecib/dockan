import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * Purchase intake (/purchase). Category + two uniquely-named
 * items (shared-wiped-database rule) → build lines via the catalog picker and
 * the inline quick-add → save → invoice number card → stock reflected in the
 * items list. The deferred-linking proposal panel renders after save.
 */
test("purchase intake: picker lines, quick-add, save, and proposal panel", async ({ page }) => {
  const tQty = "الكمية";
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // 1. seed: a category + two uniquely-named items
  const stamp = Date.now().toString();
  const categoryName = `مستلزمات-${stamp}`;
  const filterName = `فلتر زيت-${stamp}`;
  const batteryName = `بطارية-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  const itemCategory = page.getByLabel("التصنيف");
  await chooseSelectOption(page, itemCategory, categoryName);

  await page.getByTestId("item-name").fill(batteryName);
  await page.getByLabel("سعر الشراء (دج)").fill("1200");
  await page.getByLabel("سعر البيع (دج)").fill("1900");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: new RegExp(batteryName) })).toBeVisible();

  // 2. purchase flow via the nav link
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();

  await page.getByTestId("purchase-supplier").fill(`مورد-${stamp}`);

  // line 1 through the catalog picker
  await page.getByTestId("purchase-open-picker").click();
  const pickerInput = page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…");
  await pickerInput.fill(batteryName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(batteryName) }).first().click();
  await expect(page.getByTestId("purchase-lines")).toContainText(batteryName);

  // line 2 through the inline quick-add (creates the item and lands it as a line)
  await page.getByTestId("purchase-toggle-quick").click();
  await page.getByTestId("quick-name").fill(filterName);
  await chooseSelectOption(page, page.getByTestId("purchase-quick-form").getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر البيع (دج)").fill("1400");
  await page.getByTestId("quick-qty").fill("3");
  await page.getByTestId("quick-cost").fill("900");
  await page.getByTestId("purchase-quick-form").getByRole("button", { name: "منتج جديد سريعاً" }).click();
  await expect(page.getByTestId("purchase-lines")).toContainText(filterName);

  // quantities: battery ×2 @1200, filter ×3 @900 → total 5100
  await page.getByTestId("purchase-lines").getByLabel(`${batteryName}: ${tQty}`).fill("2");

  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");

  // 3. the saved invoice shows the linking proposal (no uninvoiced pool yet)
  await expect(page.getByTestId("link-proposal")).toBeVisible();

  // 4. stock landed on the items list
  await page.goto("/items");
  await expect(page.getByRole("row", { name: new RegExp(batteryName) })).toContainText("2");
  await expect(page.getByRole("row", { name: new RegExp(filterName) })).toContainText("3");
});
