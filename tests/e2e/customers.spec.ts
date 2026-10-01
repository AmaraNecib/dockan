import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * Customers & suppliers (issue 120). One flow proves the whole chain:
 * the sale picker creates and re-uses records, the invoice carries
 * counterparty_id (the customers page count/remaining only aggregates by id),
 * the debts screen groups the party, the detail page shows the stats + tabs,
 * and the delete rule blocks an invoiced record while deleting an empty one.
 */

/** The unique party names this spec creates; afterEach settles their debts. */
let cleanupPartyNames: string[] = [];

// Runs even when the test failed: the e2e DB is shared and later specs assert
// GLOBAL debt totals, so this spec must return its parties to zero debt
// regardless of where it stopped (Greptile P2.7).
test.afterEach(async ({ page }) => {
  const names = cleanupPartyNames;
  cleanupPartyNames = [];
  if (names.length === 0) return;
  await settlePartyDebts(page, names);
});

test("customers & suppliers: picker, invoice identity, detail page, delete rule", async ({ page }) => {
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `زبائن-تصنيف-${stamp}`;
  const itemName = `زبائن-منتج-${stamp}`;
  const supplierName = `مورد-${stamp}`;
  const customerName = `زبون-${stamp}`;
  const emptyCustomer = `زبون-فارغ-${stamp}`;
  // a valid Algerian mobile, unique per run: 0567 + six stamp digits
  const customerPhone = `0567${stamp.slice(-6)}`;
  const emptyPhone = `0577${stamp.slice(-6)}`;
  cleanupPartyNames = [supplierName, customerName];

  // 1. seed: a category + one item (cost 400, sell 1000)
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("item-save").click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: new RegExp(itemName) })).toBeVisible();

  // 2. purchase: the supplier is created inline from the picker and picked
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(supplierName);
  await page.getByTestId("purchase-supplier-create").click();
  await page.getByTestId("purchase-supplier-create-save").click();
  await expect(page.getByTestId("purchase-supplier")).toHaveValue(supplierName);
  await page.getByTestId("purchase-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await expect(page.getByTestId("purchase-lines")).toContainText(itemName);
  await page.getByTestId("purchase-lines").getByLabel(`${itemName}: الكمية`).fill("5");
  await page.getByTestId("purchase-paid").fill("800");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");

  // 3. first sale: the customer is created inline with her phone
  await page.getByRole("link", { name: "المبيعات" }).click();
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(customerName);
  await page.getByTestId("sale-customer-create").click();
  await page.getByTestId("sale-customer-create-phone").fill(customerPhone);
  await page.getByTestId("sale-customer-create-save").click();
  await expect(page.getByTestId("sale-customer")).toHaveValue(customerName);
  await page.getByTestId("sale-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`).fill("2");
  await page.getByTestId("sale-paid").fill("500");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");

  // 4. second sale picks the SAME record by name from the filtered list
  await page.getByTestId("sale-new").click();
  await page.getByTestId("sale-customer").fill(customerName);
  await expect(page.getByTestId("sale-customer-option").first()).toContainText(customerName);
  await page.getByTestId("sale-customer-option").first().click();
  await page.getByTestId("sale-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`).fill("1");
  await page.getByTestId("sale-paid").fill("1000");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");

  // 5. debts screen groups the id-backed party with the unpaid remainder
  await page.getByRole("link", { name: "الديون" }).click();
  const owedRow = page.getByTestId("debts-person").filter({ hasText: customerName });
  await expect(owedRow).toContainText("1500 دج");
  await expect(owedRow.getByTestId("debts-person-count")).toContainText("1");

  // 6. customers page: the aggregates only count by counterparty_id
  await page.getByRole("link", { name: "الزبائن", exact: true }).first().click();
  await expect(page.getByTestId("parties-page-customer")).toBeVisible();
  const customerRow = page.getByTestId("party-row").filter({ hasText: customerName });
  await expect(customerRow.getByTestId("party-row-count")).toHaveText("2");
  await expect(customerRow.getByTestId("party-row-remaining")).toContainText("1500");
  await expect(customerRow).toContainText("+213567");

  // search narrows the table by phone too
  await page.getByTestId("parties-search").fill(customerPhone);
  await expect(page.getByTestId("party-row")).toHaveCount(1);
  await page.getByTestId("parties-search").fill("");

  // 7. detail full page: header, stats strip, tabs
  await customerRow.getByTestId("party-row-link").click();
  await expect(page.getByTestId("party-detail-customer")).toBeVisible();
  await expect(page.getByTestId("party-detail-name")).toHaveText(customerName);
  await expect(page.getByTestId("party-stat-partyStatsCount")).toContainText("2");
  await expect(page.getByTestId("party-stat-partyStatsTotalSales")).toContainText("3000");
  await expect(page.getByTestId("party-stat-partyStatsPaid")).toContainText("1500");
  await expect(page.getByTestId("party-stat-partyStatsRemaining")).toContainText("1500");
  await expect(page.getByTestId("party-invoice-row")).toHaveCount(2);

  await page.getByTestId("party-tab-payments").click();
  await expect(page.getByTestId("party-payment-row")).toHaveCount(2);
  await expect(page.getByTestId("party-panel-payments")).toContainText("500");
  await expect(page.getByTestId("party-panel-payments")).toContainText("1000");

  await page.getByTestId("party-tab-info").click();
  await expect(page.getByTestId("party-form-name")).toHaveValue(customerName);
  await page.getByTestId("party-form-phone").fill(emptyPhone);
  await page.getByTestId("party-form-save").click();
  await expect(page.getByTestId("party-detail-notice")).toContainText("تم الحفظ");
  await expect(page.getByTestId("party-detail-phone")).toContainText(`+213${emptyPhone.slice(1)}`);

  // 8. the delete rule: an invoiced party keeps its delete button disabled
  await expect(page.getByTestId("party-detail-delete")).toBeDisabled();
  await expect(page.getByTestId("party-delete-blocked-hint")).toBeVisible();
  await page.getByTestId("party-detail-back").click();

  // 9. a zero-invoice party deletes; a duplicate phone is refused first
  await page.getByTestId("party-new").click();
  await page.getByTestId("party-form-name").fill(emptyCustomer);
  await page.getByTestId("party-form-phone").fill(emptyPhone);
  await page.getByTestId("party-form-save").click();
  await expect(page.getByTestId("party-form-error")).toContainText("رقم الهاتف مستعمل مع زبون آخر");
  await page.getByTestId("party-form-phone").fill("");
  await page.getByTestId("party-form-save").click();
  await expect(page.getByTestId("parties-notice")).toContainText("تم الحفظ");

  const emptyRow = page.getByTestId("party-row").filter({ hasText: emptyCustomer });
  await expect(emptyRow.getByTestId("party-row-count")).toHaveText("0");
  await emptyRow.getByTestId("party-row-delete").click();
  await page.getByTestId("party-delete-confirm").click();
  await expect(page.getByTestId("parties-notice")).toContainText("تم الحذف");
  await expect(page.getByTestId("party-row").filter({ hasText: emptyCustomer })).toHaveCount(0);

  // 10. suppliers get the same page with the purchase side's aggregates
  await page.getByTestId("party-role-supplier").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();
  const supplierRow = page.getByTestId("party-row").filter({ hasText: supplierName });
  await expect(supplierRow.getByTestId("party-row-count")).toHaveText("1");
  await expect(supplierRow.getByTestId("party-row-remaining")).toContainText("1200");

  // the supplier detail page is the same component on the purchase side
  await supplierRow.getByTestId("party-row-link").click();
  await expect(page.getByTestId("party-detail-supplier")).toBeVisible();
  await expect(page.getByTestId("party-detail-name")).toHaveText(supplierName);
  await expect(page.getByTestId("party-stat-partyStatsTotalPurchases")).toContainText("2000");
  await expect(page.getByTestId("party-stat-partyStatsRemaining")).toContainText("1200");
  await expect(page.getByTestId("party-invoice-row")).toHaveCount(1);
});

/**
 * Pay every remaining balance on invoices belonging to this spec's parties.
 * The shared DB must return to zero party-attributed debt or later specs'
 * global debt totals break; matching by the unique names (rather than by
 * captured invoice numbers) means it still works after a mid-test failure.
 */
async function settlePartyDebts(page: Page, names: string[]): Promise<void> {
  await page.goto("/invoices");
  await expect(page.getByTestId("invoices-page")).toBeVisible();
  const rows = page.getByTestId("invoice-row");
  const targets: string[] = [];
  for (let index = 0; index < (await rows.count()); index++) {
    const text = (await rows.nth(index).textContent()) ?? "";
    if (!names.some((name) => text.includes(name))) continue;
    const number = /INV-\d+/.exec(text)?.[0];
    if (number !== undefined) targets.push(number);
  }
  for (const number of targets) {
    const remainingText = (await page.getByTestId(`invoice-remaining-${number}`).textContent()) ?? "";
    const amount = Number(remainingText.replace(/[^\d]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    await page.getByTestId(`invoice-open-${number}`).click();
    await page.getByTestId("pmt-amount").fill(String(amount));
    await page.getByTestId("pmt-submit").click();
    await expect(page.getByTestId("pmt-done")).toBeVisible();
    await page.goto("/invoices");
    await expect(page.getByTestId("invoices-page")).toBeVisible();
  }
}
