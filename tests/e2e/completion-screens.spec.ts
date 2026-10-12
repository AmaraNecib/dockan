import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";

/**
 * Completion screens (issue #159). After saving, the success card must open
 * the document that was just written by its saved id — never by searching for
 * the number. Covers the sale card («عرض الفاتورة» → that invoice) and the
 * return card («عرض الإيصال» → that return's voucher).
 */
test("completion card opens the saved sale and the saved return's voucher", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `إتمام-تصنيف-${stamp}`;
  const itemName = `إتمام-منتج-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // a stocked item, then a one-unit sale
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("900");
  await page.getByTestId("sale-quick-stock").fill("3");
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  await page.getByTestId("sale-save").click();

  // the completion card carries the saved number and opens THAT invoice
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  const saleNumber = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;
  await page.getByTestId("sale-open-invoice").click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-number")).toContainText(saleNumber);

  // a one-unit return: the card replaces the form and opens its voucher
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");
  await expect(page.getByTestId("returns-form")).toHaveCount(0);
  await page.getByTestId("returns-open-voucher").click();
  await expect(page.getByTestId("return-voucher-page")).toBeVisible();
  await expect(page.getByTestId("return-voucher-number")).toContainText("RTN-");
  await expect(page.getByTestId("return-voucher-invoice")).toContainText(saleNumber);
});
