import { expect, test } from "@playwright/test";
import { openSystemNav, signIn } from "./auth-helpers";

/**
 * Returns & refunds e2e: a sale is recorded, the customer returns the unit on
 * the invoice screen (cash refund), the stock comes straight back into the
 * item history marked as a return, the on-demand return voucher renders the
 * store identity / return + invoice numbers / line / refund total, and the
 * owner reviews and accepts the return from the /returns screen (the pending
 * mark is consumed).
 */
test("sale → cash return → stock back (marked) + voucher route + review accept", async ({ page }) => {
  // 0. sign in
  await signIn(page);

  // 1. a known store identity so the voucher's header is asserted, not assumed
  const stamp = Date.now().toString();
  const storeName = `متجر-المرجوع-${stamp}`;
  await page.goto("/settings");
  await page.getByTestId("settings-name").fill(storeName);
  await page.getByTestId("settings-phone").fill("066 12 34 56 7");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toContainText("تم حفظ الإعدادات");

  // 2. category + item with stock, then a full cash sale
  const categoryName = `مرجوع-تصنيف-${stamp}`;
  const itemName = `مرجوع-منتج-${stamp}`;
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-stock-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await page.getByLabel("التصنيف").selectOption({ label: categoryName });
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("900");
  await page.getByTestId("sale-quick-stock").fill("2");
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  expect(await page.getByTestId("sale-total").textContent()).toContain("900"); // 1 × 900
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const saleNumber = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // 3. open the invoice and record a 1-unit cash return; the sale was recorded
  // without a down payment, so the all-cash settlement triggers the soft
  // collected-money warning (owner decides — the api never blocks)
  await page.getByRole("link", { name: "الفواتير" }).click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${saleNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  const returnsPanel = page.getByTestId("returns-panel");
  await expect(returnsPanel).toBeVisible();
  await expect(page.locator('[data-testid^="returns-qty-"]')).toBeVisible();
  await expect(returnsPanel).toContainText("المتبقي: 1");
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  // the return value (900) vs collected-so-far (0) and the soft warning
  await expect(page.getByTestId("returns-value")).toContainText("900");
  await expect(page.getByTestId("returns-collected")).toContainText("0");
  await expect(page.getByTestId("returns-cash-warning")).toBeVisible();
  // an all-debt split would be capped by the 900 debt — keep the default
  // all-cash settlement (owner's choice) and record the return
  await page.getByTestId("returns-reason").fill("الزبون بدل رأيه");
  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");

  // 4. the return lands in the panel history with a return number
  const historyRow = page.getByTestId("returns-row");
  await expect(historyRow).toBeVisible();
  const returnNumber = (await historyRow.innerText()).match(/RTN-\d+/)![0]!;
  await expect(historyRow).toContainText("900 دج");
  await expect(historyRow).toContainText("قيد المراجعة");

  // 5. the on-demand voucher renders store identity + return/invoice numbers + line + total
  await page.locator(`[data-testid="return-print-${returnNumber}"]`).click();
  await expect(page.getByTestId("return-voucher-page")).toBeVisible();
  const voucher = page.getByTestId("return-voucher-view");
  await expect(voucher.getByTestId("return-voucher-store")).toContainText(storeName);
  await expect(voucher.getByTestId("return-voucher-phone")).toContainText("+213661234567");
  await expect(voucher.getByTestId("return-voucher-number")).toContainText(returnNumber);
  await expect(voucher.getByTestId("return-voucher-invoice")).toContainText(saleNumber);
  await expect(voucher.getByTestId("return-voucher-line")).toContainText(itemName);
  await expect(voucher.getByTestId("return-voucher-line")).toContainText("900");
  await expect(voucher.getByTestId("return-voucher-total")).toContainText("900");
  await expect(voucher.getByTestId("return-voucher-cash")).toContainText("900");
  await expect(voucher.getByTestId("return-voucher-debt")).toContainText("0");
  await expect(voucher.getByTestId("return-voucher-status")).toContainText("قيد المراجعة");
  await page.getByTestId("return-voucher-back").click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();

  // 6. stock is back in the item history, visibly marked as a return
  await openSystemNav(page);
  await page.getByRole("link", { name: "المنتجات" }).click();
  const itemRow = page.getByRole("row", { name: new RegExp(itemName) });
  await expect(itemRow.getByTestId("stock-after-cell")).toContainText("2");
  await itemRow.getByRole("link", { name: "السجل" }).click();
  await expect(page.getByTestId("history-table")).toBeVisible();
  const movementRows = page.getByTestId("history-table").locator("tbody tr");
  // opening +2, sale −1, return +1: the last movement carries the visible
  // return marker and the stock is back at 2
  await expect(movementRows).toHaveCount(3);
  await expect(movementRows.nth(2)).toContainText("مرجوع");
  await expect(movementRows.nth(2)).toContainText("+1");
  await expect(movementRows.nth(2)).toContainText("2"); // stock after the return

  // 7. the owner reviews on /returns and accepts — the pending mark is consumed
  await page.getByRole("link", { name: "المرتجعات" }).click();
  await expect(page.getByTestId("returns-page")).toBeVisible();
  await expect(page.getByTestId(`returns-review-${returnNumber}`)).toBeVisible();
  await page.getByTestId(`returns-accept-${returnNumber}`).click();
  await expect(page.getByTestId("returns-status-ACCEPTED")).toContainText("مقبول");
  await expect(page.getByTestId(`returns-actions-${returnNumber}`)).toHaveCount(0);
});