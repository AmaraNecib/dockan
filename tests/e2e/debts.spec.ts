import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * Debts screen (/debts). After first-time setup, seed a
 * category + item, then create a sale with a typed customer and a partial
 * payment (customer owes us 1500) and a purchase with a typed supplier and a
 * partial payment (we owe the supplier 1200). The debts page must render both
 * groups (owedToUs / weOwe) with per-person remaining totals and invoice
 * counts, and clicking a person must open that person's unpaid invoices.
 */
test("debts screen: both directions grouped with totals, counts, and drill-down", async ({ page }) => {
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // 1. seed: a category + one item (cost 400, sell 1000)
  const stamp = Date.now().toString();
  const categoryName = `ديون-تصنيف-${stamp}`;
  const itemName = `ديون-منتج-${stamp}`;

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

  // 2. purchase: supplier typed name, partial payment → we owe 1200 of 2000
  const supplierName = `مورد مستحق-${stamp}`;
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(supplierName);
  await page.getByTestId("purchase-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await expect(page.getByTestId("purchase-lines")).toContainText(itemName);
  await page.getByTestId("purchase-lines").getByLabel(`${itemName}: الكمية`).fill("5");
  await page.getByTestId("purchase-paid").fill("800");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");

  // 3. sale: customer typed name, partial payment → customer owes us 1500 of 2000
  const customerName = `زبون مدين-${stamp}`;
  await page.getByRole("link", { name: "المبيعات" }).click();
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(customerName);
  await page.getByTestId("sale-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`).fill("2");
  await page.getByTestId("sale-paid").fill("500");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");

  // 4. debts screen: both directions rendered with totals + counts
  await page.getByRole("link", { name: "الديون" }).click();
  await expect(page.getByTestId("debts-page")).toBeVisible();
  await expect(page.getByText("مستحقاتنا عند الزبائن")).toBeVisible();
  await expect(page.getByText("مستحقات الموردين عندنا")).toBeVisible();
  // the whole app is an Arabic RTL screen (acceptance bullet)
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // group headers sum their persons: 1500 owed to us, 1200 owed to the supplier
  await expect(page.getByTestId("debts-group-owed-total")).toContainText("1500 دج");
  await expect(page.getByTestId("debts-group-owed-count")).toHaveText("1");
  await expect(page.getByTestId("debts-group-weowe-total")).toContainText("1200 دج");
  await expect(page.getByTestId("debts-group-weowe-count")).toHaveText("1");

  // the customer owes us: one invoice, 1500 remaining
  const owedRow = page.getByTestId("debts-person").filter({ hasText: customerName });
  await expect(owedRow).toContainText("1500 دج");
  await expect(owedRow.getByTestId("debts-person-count")).toContainText("1");

  // we owe the supplier: one invoice, 1200 remaining
  const weOweRow = page.getByTestId("debts-person").filter({ hasText: supplierName });
  await expect(weOweRow).toContainText("1200 دج");
  await expect(weOweRow.getByTestId("debts-person-count")).toContainText("1");

  // directions stay in their own groups
  await expect(page.getByTestId("debts-group-owed")).toContainText(customerName);
  await expect(page.getByTestId("debts-group-owed")).not.toContainText(supplierName);
  await expect(page.getByTestId("debts-group-weowe")).toContainText(supplierName);
  await expect(page.getByTestId("debts-group-weowe")).not.toContainText(customerName);

  // 5. clicking the customer's row opens her unpaid sale invoice
  await owedRow.click();
  const invoiceTable = page.getByTestId("debts-page").getByTestId("debts-invoices");
  await expect(invoiceTable).toContainText("INV-");
  await expect(invoiceTable.getByTestId("debts-invoice-row")).toContainText("1500 دج");
  await expect(invoiceTable.getByTestId("debts-invoice-row")).toContainText("2000 دج");

  // collapsing removes the invoice list again
  await owedRow.click();
  await expect(page.getByTestId("debts-page").getByTestId("debts-invoices")).toHaveCount(0);
});