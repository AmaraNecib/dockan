import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { saveQuickAdd } from "./rpc-helpers";

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
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  // two units so two separate one-unit returns are possible on this invoice
  await page.getByTestId("sale-lines").locator("input").first().fill("2");
  await page.getByTestId("sale-save").click();

  // the completion card carries the saved number and opens THAT invoice
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  const saleNumber = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;
  await page.getByTestId("sale-open-invoice").click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-number")).toContainText(saleNumber);

  // first return: the card replaces the form and opens that return's voucher
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");
  await expect(page.getByTestId("returns-form")).toHaveCount(0);
  const firstReturn = (await page.getByTestId("returns-done-number").innerText()).match(/RET-\d+/)![0]!;
  await page.getByTestId("returns-open-voucher").click();
  await expect(page.getByTestId("return-voucher-page")).toBeVisible();
  await expect(page.getByTestId("return-voucher-number")).toContainText(firstReturn);
  await expect(page.getByTestId("return-voucher-invoice")).toContainText(saleNumber);

  // a second return on the same invoice: the card must open the SECOND one,
  // so a wrong-id lookup cannot pass (issue #169 finding 3)
  await page.getByTestId("return-voucher-back").click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");
  const secondReturn = (await page.getByTestId("returns-done-number").innerText()).match(/RET-\d+/)![0]!;
  expect(secondReturn).not.toBe(firstReturn);
  await page.getByTestId("returns-open-voucher").click();
  await expect(page.getByTestId("return-voucher-page")).toBeVisible();
  await expect(page.getByTestId("return-voucher-number")).toContainText(secondReturn);
});
