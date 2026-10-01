import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";

/**
 * Receipt printing e2e: the print button on the invoice screen produces a
 * receipt document with the store identity, invoice number, lines, totals,
 * paid/remaining and payment history.
 * A sale is recorded with a partial down payment, the remaining instalment
 * is settled on the invoice screen (paid invoice, 2 payment rows), then the
 * print button opens the print-only route whose receipt document carries the
 * store identity, invoice number, lines, totals, paid/remaining and both
 * payment rows.
 *
 * NOTE ON THE OS DIALOG: window.print() opens the system print dialog, which
 * is headless-hostile (no OS dialog in CI). The assertion therefore targets
 * the print route's document content — the exact page that would reach the
 * printer — and the dialog itself is exercised manually in the desktop
 * shell (WebView2 renders the same window.print() as a system dialog).
 */
test("invoice print button → receipt document with identity, totals and payments", async ({ page }) => {
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // 1. a known store identity so the receipt's header is asserted, not assumed
  const stamp = Date.now().toString();
  const storeName = `متجر-الإيصال-${stamp}`;
  await page.goto("/settings");
  await page.getByTestId("settings-name").fill(storeName);
  // loose Algerian input is normalized at the api boundary to canonical +213 form,
  // so the receipt header is asserted in its canonical spelling
  await page.getByTestId("settings-phone").fill("066 12 34 56 7");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toContainText("تم حفظ الإعدادات");

  // 2. category + item, then a sale with a partial down payment (500/900)
  const categoryName = `إيصال-تصنيف-${stamp}`;
  const itemName = `إيصال-منتج-${stamp}`;
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("900");
  await page.getByTestId("sale-quick-stock").fill("2");
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await page.getByTestId("sale-paid").fill("500");
  await expect(page.getByTestId("sale-total")).toContainText("900");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const number = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // 3. open the invoice detail, settle the remaining 400 → fully paid
  await page.getByRole("link", { name: "الفواتير" }).click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${number}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-remaining")).toContainText("400");
  await page.getByTestId("pmt-amount").fill("400");
  await page.getByTestId("pmt-submit").click();
  await expect(page.getByTestId("invoice-remaining")).toContainText("0");
  const history = page.getByTestId("pmt-history").locator("tbody tr");
  await expect(history).toHaveCount(2);

  // 4. the print button opens the print-only route
  await page.getByTestId("invoice-print").click();
  await expect(page.getByTestId("receipt-page")).toBeVisible();

  // 5. the receipt document carries everything the paper needs
  const receipt = page.getByTestId("receipt-view");
  await expect(receipt.getByTestId("receipt-store")).toContainText(storeName);
  await expect(receipt.getByTestId("receipt-phone")).toContainText("+213661234567");
  await expect(receipt.getByTestId("receipt-number")).toContainText(number);
  await expect(receipt.getByTestId("receipt-date")).not.toBeEmpty();
  // lines: one item, qty 1 @ 900 → line total 900
  await expect(receipt.getByTestId("receipt-line")).toHaveCount(1);
  await expect(receipt.getByTestId("receipt-line").first()).toContainText(itemName);
  await expect(receipt.getByTestId("receipt-line").first()).toContainText("900");
  // totals: subtotal, discount (none), final, paid, remaining (settled)
  await expect(receipt.getByTestId("receipt-subtotal")).toContainText("900");
  await expect(receipt.getByTestId("receipt-discount")).toContainText("0");
  await expect(receipt.getByTestId("receipt-total")).toContainText("900");
  await expect(receipt.getByTestId("receipt-paid")).toContainText("900");
  await expect(receipt.getByTestId("receipt-remaining")).toContainText("0");
  // both payments land in the receipt history, in recording order
  await expect(receipt.getByTestId("receipt-payment")).toHaveCount(2);
  await expect(receipt.getByTestId("receipt-payment").nth(0)).toContainText("500");
  await expect(receipt.getByTestId("receipt-payment").nth(1)).toContainText("400");

  // 6. the toolbar offers the way back (and stays off the paper via print-hidden)
  await expect(page.getByTestId("receipt-back")).toContainText("رجوع للفاتورة");
  await page.getByTestId("receipt-back").click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
});