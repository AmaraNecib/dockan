import { expect, test } from "@playwright/test";
import { openSystemNav, signIn } from "./auth-helpers";

/**
 * Later payments on an invoice, in instalments.
 * A sale is recorded with zero paid via /sale quick-add-with-stock; the
 * invoice is then opened from /invoices where two instalments are recorded,
 * the overpay boundary is refused with the exact Arabic message, the history
 * grows in order, remaining reaches zero and the form locks. The activity
 * log shows the PAYMENT_RECORDED entries with the invoice number.
 */
test("invoice payments: instalments, overpay refusal, history, and audit", async ({ page }) => {
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `دفعات-تصنيف-${stamp}`;
  const itemName = `دفعات-منتج-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // 1. create a SALE invoice with zero paid: 1 unit @ 900 → total 900
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
  await expect(page.getByTestId("sale-total")).toContainText("900");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const number = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // count real invoicesPay wire calls so the overpay step can prove nothing
  // reached the server (the client boundary must block it before sending)
  let payRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/rpc/invoicesPay")) payRequests += 1;
  });

  // 2. the invoice is listed with its full remaining amount
  await page.getByRole("link", { name: "الفواتير" }).click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await expect(page.getByTestId(`invoice-remaining-${number}`)).toContainText("900");
  await page.getByTestId(`invoice-open-${number}`).click();

  // 3. invoice screen: header totals + empty history
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-number")).toContainText(number);
  await expect(page.getByTestId("invoice-remaining")).toContainText("900");
  await expect(page.getByTestId("pmt-empty")).toBeVisible();

  // 4. first instalment: 300 → remaining 600, one history row
  await page.getByTestId("pmt-amount").fill("300");
  await page.getByTestId("pmt-submit").click();
  await expect(page.getByTestId("pmt-done")).toBeVisible();
  await expect(page.getByTestId("invoice-remaining")).toContainText("600");
  const history = page.getByTestId("pmt-history").locator("tbody tr");
  await expect(history).toHaveCount(1);
  await expect(history.first()).toContainText("300");

  // 5. overpay +1 beyond the remaining is refused with the exact message and
  //    writes nothing (history stays at one row, remaining unchanged) — and
  //    the client boundary blocks it BEFORE any request reaches the server
  const payRequestsAfterFirst = payRequests;
  await page.getByTestId("pmt-amount").fill("601");
  await page.getByTestId("pmt-submit").click();
  await expect(page.getByTestId("pmt-error")).toContainText("المبلغ يتجاوز المتبقي");
  await expect(page.getByTestId("invoice-remaining")).toContainText("600");
  await expect(history).toHaveCount(1);
  expect(payRequests).toBe(payRequestsAfterFirst);

  // 6. settling instalment: 600 → remaining 0, history in recording order
  await page.getByTestId("pmt-amount").fill("600");
  await page.getByTestId("pmt-submit").click();
  await expect(page.getByTestId("invoice-remaining")).toContainText("0");
  await expect(page.getByTestId("pmt-unavailable")).toBeVisible();
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText("300");
  await expect(history.nth(1)).toContainText("600");
  await expect(page.getByTestId("pmt-amount")).toBeDisabled();
  expect(payRequests).toBe(payRequestsAfterFirst + 1);

  // 7. both instalments landed in the activity log as PAYMENT_RECORDED
  await openSystemNav(page);
  await page.getByRole("link", { name: "سجل النشاط" }).click();
  // skip the SALE_CREATED entry (its summary also carries the invoice number)
  const auditRows = page
    .getByTestId("activity-table")
    .locator("tbody tr")
    .filter({ hasText: number })
    .filter({ hasText: "تسجيل دفعة" });
  await expect(auditRows).toHaveCount(2);
  await expect(auditRows.first()).toContainText("تسجيل دفعة");
});
