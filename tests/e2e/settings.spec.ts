import { expect, test } from "@playwright/test";
import { openSystemNav, signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";

/**
 * Settings screen (store identity). Owner edits the store
 * name + phone on /settings; the values persist (DB-backed, proven by a page
 * reload); a saved invoice displays them in its header (the only invoicing
 * view today is the purchase saved-card; sale checkout is covered by the
 * sale-checkout spec).
 * Unique names per the parallel-specs shared-DB rule (wisdom 2026-08-24).
 */
test("settings edit → save → invoice header reflects the store identity", async ({ page }) => {
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // 1. edit the store identity and save
  const stamp = Date.now().toString();
  const storeName = `متجر التجربة-${stamp}`;
  await openSystemNav(page);
  await page.getByRole("link", { name: "الإعدادات" }).click();
  await expect(page.getByRole("heading", { name: "إعدادات المتجر" })).toBeVisible();

  await page.getByTestId("settings-name").fill(storeName);
  await page.getByTestId("settings-phone").fill("066 12 34 56 7");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toContainText("تم حفظ الإعدادات");

  // 2. persistence across restarts: a fresh page load still shows the values
  await page.reload();
  await expect(page.getByTestId("settings-name")).toHaveValue(storeName);
  await expect(page.getByTestId("settings-phone")).toHaveValue("+213661234567");

  // 3. the invoice header shows the edited identity (canonical phone form)
  const categoryName = `مستلزمات-إعدادات-${stamp}`;
  const itemName = `فلتر-إعدادات-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-toggle-quick").click();
  await page.getByTestId("quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByTestId("purchase-quick-form").getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر البيع (دج)").fill("900");
  await page.getByTestId("quick-qty").fill("2");
  await page.getByTestId("quick-cost").fill("600");
  await page.getByTestId("purchase-quick-form").getByRole("button", { name: "منتج جديد سريعاً" }).click();
  await expect(page.getByTestId("purchase-lines")).toContainText(itemName);

  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");

  // the saved invoice card prints name + normalized phone
  const header = page.getByTestId("invoice-header");
  await expect(header).toBeVisible();
  await expect(header).toContainText(storeName);
  await expect(header).toContainText("+213661234567");
});