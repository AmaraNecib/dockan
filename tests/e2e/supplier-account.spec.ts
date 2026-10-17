import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * Supplier account (issue 161): a signed ledger per supplier.
 * A purchase from an id-backed supplier opens a charge; paying from the
 * supplier page drops the balance and the invoice's remaining; a free-standing
 * and an invoice-linked purchase return move the balance and mark the invoice;
 * a named-invoice payment and a credit advance cover the other target modes;
 * an account refund closes a credit.
 */
test("supplier account: pay, return, and refund move one signed balance", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `حساب-تصنيف-${stamp}`;
  const itemName = `حساب-منتج-${stamp}`;
  const supplierName = `حساب-مورد-${stamp}`;

  // 1. seed a category + item (cost 1000)
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("1000");
  await page.getByLabel("سعر البيع (دج)").fill("1500");
  await page.getByTestId("item-save").click();

  // 2. purchase 2 units @1000 from a NEW supplier record (inline create)
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(supplierName);
  await page.getByTestId("purchase-supplier-create").click();
  await page.getByTestId("purchase-supplier-create-name").fill(supplierName);
  await page.getByTestId("purchase-supplier-create-save").click();

  await page.getByTestId("purchase-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await page.getByTestId("purchase-lines").getByLabel(`${itemName}: الكمية`).fill("2");
  // #162: the down-payment defaults to the full total; zero it so the whole
  // 2000 stays owed and opens the supplier charge
  await page.getByTestId("purchase-paid").fill("0");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("SUP-");
  // SAFETY: the saved card always formats purchase numbers as SUP-<digits>
  const invoiceNumber = (await page.getByTestId("purchase-saved-number").innerText()).match(/SUP-\d+/)![0]!;

  // 3. the supplier detail shows the charge as the balance
  await page.goto("/suppliers");
  await page.getByRole("link", { name: supplierName }).click();
  await expect(page.getByTestId("supplier-balance")).toBeVisible();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("2,000 دج");

  // 4. pay 500 (oldest-first default) → balance 1500
  await page.getByTestId("supplier-action-pay").click();
  await page.getByTestId("supplier-pay-amount").fill("500");
  await page.getByTestId("supplier-pay-confirm").click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("1,500 دج");

  // 5. free-standing return of 1 unit for 300 → balance 1200
  await page.getByTestId("supplier-action-return").click();
  await chooseSelectOption(page, page.getByTestId("supplier-return-mode"), "بدون فاتورة");
  await chooseSelectOption(page, page.getByTestId("supplier-return-item"), itemName);
  await page.getByTestId("supplier-return-quantity").fill("1");
  await page.getByTestId("supplier-return-amount").fill("300");
  await page.getByTestId("supplier-return-confirm").click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("1,200 دج");

  // 6. invoice-linked return of the other unit @1000 → debt reduction 1000,
  //    balance 200 and the invoice remaining drops to 200
  await page.getByTestId("supplier-action-return").click();
  await chooseSelectOption(page, page.getByTestId("supplier-return-invoice"), invoiceNumber);
  await page.getByTestId("supplier-return-lines").locator("tbody tr").first().locator("input").fill("1");
  await page.getByTestId("supplier-return-confirm").click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("200 دج");

  // 7. settle the named invoice exactly (target = INVOICE) → balance 0
  await page.getByTestId("supplier-action-pay").click();
  await chooseSelectOption(page, page.getByTestId("supplier-pay-target"), "فاتورة محددة");
  await chooseSelectOption(page, page.getByTestId("supplier-pay-invoice"), invoiceNumber);
  await page.getByTestId("supplier-pay-amount").fill("200");
  await page.getByTestId("supplier-pay-confirm").click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("0 دج");

  // the printed purchase invoice keeps the entries that name it: 2000 − 500 −
  // 1000 (invoice-linked return) − 200 (named payment) = 300 remaining. The
  // free-standing 300 return is credit, so it offsets the ACCOUNT balance to 0
  // without touching the invoice.
  await page.getByTestId("party-invoices").getByRole("link", { name: invoiceNumber }).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-remaining")).toHaveText("300 دج");
  await expect(page.getByTestId("invoice-returns-credit")).toHaveText("1,000 دج");
  await page.goBack();
  await expect(page.getByTestId("supplier-balance")).toBeVisible();

  // 8. a credit advance (target = CREDIT) → balance −500
  await page.getByTestId("supplier-action-pay").click();
  await chooseSelectOption(page, page.getByTestId("supplier-pay-target"), "رصيد مسبق");
  await page.getByTestId("supplier-pay-amount").fill("500");
  await page.getByTestId("supplier-pay-confirm").click();
  await expect(page.getByTestId("supplier-balance")).toContainText("رصيد لنا عند المورّد");
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("500 دج");

  // 9. account refund closes the 500 credit → balance 0
  await page.getByTestId("supplier-action-refund").click();
  await page.getByTestId("supplier-refund-amount").fill("500");
  await page.getByTestId("supplier-refund-confirm").click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("0 دج");
});
