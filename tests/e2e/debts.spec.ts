import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { captureEvidence, expectCurrencyLeftOfFigures } from "./money-display-helpers";
import { runE2eReset } from "./reset-helpers";

// #254 evidence (#259): the money display is a VISUAL change, so this spec can
// record a video at real user pace when a lane asks for one. CI never sets
// E2E_VIDEO, so CI records nothing.
test.use({ video: process.env.E2E_VIDEO === "1" ? "on" : "off" });

/**
 * Debts screen (/debts). After first-time setup, seed a
 * category + item, then create a sale with a typed customer and a partial
 * payment (customer owes us 1500) and a purchase with a typed supplier and a
 * partial payment (we owe the supplier 1200). The debts page must render both
 * groups (owedToUs / weOwe) with per-person remaining totals and invoice
 * counts, and clicking a person must open that person's unpaid invoices.
 */

/**
 * Own the precondition instead of borrowing it.
 *
 * The assertions below are EXACT GLOBAL figures — the "we owe" group is
 * 1200 دج over one invoice, "owed to us" 1500 دج over one. Those are only true
 * statements on a database holding exactly this spec's records, so the spec
 * resets shop records first, the way `00-onboarding.spec.ts` and
 * `01-empty-states.spec.ts` already do. Every other spec here asserts counts
 * it filtered by a name it created; this is the one that reads the database's
 * sum, so it is the one that has to own the database's starting state.
 *
 * Relying on the previous spec's tidiness is exactly what broke CI: the
 * round-2 `96-returns-supplier-action.spec.ts` leaves an unpaid purchase of
 * 2000 دج, and that group read "3200 دج" (#96 round 3).
 */
test.beforeAll(() => {
  runE2eReset("reset-e2e-records.mjs");
});

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
  await expect(page.getByTestId("purchase-saved-number")).toContainText("SUP-");

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
  // the lane's before/after image (#259) lands here, before the first assertion
  // the #254 change moves
  await captureEvidence(page, "debts-page");

  // group headers sum their persons: 1500 owed to us, 1200 owed to the supplier
  await expect(page.getByTestId("debts-group-owed-total")).toContainText("1,500 دج");
  await expect(page.getByTestId("debts-group-owed-count")).toHaveText("1");
  await expect(page.getByTestId("debts-group-weowe-total")).toContainText("1,200 دج");
  await expect(page.getByTestId("debts-group-weowe-count")).toHaveText("1");

  // the customer owes us: one invoice, 1500 remaining
  const owedRow = page.getByTestId("debts-person").filter({ hasText: customerName });
  await expect(owedRow).toContainText("1,500 دج");
  await expect(owedRow.getByTestId("debts-person-count")).toContainText("1");

  // we owe the supplier: one invoice, 1200 remaining
  const weOweRow = page.getByTestId("debts-person").filter({ hasText: supplierName });
  await expect(weOweRow).toContainText("1,200 دج");
  await expect(weOweRow.getByTestId("debts-person-count")).toContainText("1");

  // 4b. #254 money display: the figures are grouped Western digits, and the
  // currency is the RTL run AFTER the isolated figures — drawn to the LEFT of
  // them in this RTL row. A separate placement (or a sibling sign) is what the
  // ticket measured as `92500 د.ج −` reading left to right.
  const weOweTotal = weOweRow.getByTestId("debts-person-total");
  // #260 polarity (merged while #254 was in flight): a typed-name purchase is a
  // debt, so the signed row reads "− 1,200". The grouping/bidi half is #254's.
  await expect(weOweTotal.getByTestId("money-figures")).toHaveText("− 1,200");
  await expectCurrencyLeftOfFigures(weOweTotal);

  // directions stay in their own groups
  await expect(page.getByTestId("debts-group-owed")).toContainText(customerName);
  await expect(page.getByTestId("debts-group-owed")).not.toContainText(supplierName);
  await expect(page.getByTestId("debts-group-weowe")).toContainText(supplierName);
  await expect(page.getByTestId("debts-group-weowe")).not.toContainText(customerName);

  // 5. clicking the customer's row opens her unpaid sale invoice
  await owedRow.click();
  const invoiceTable = page.getByTestId("debts-page").getByTestId("debts-invoices");
  await expect(invoiceTable).toContainText("INV-");
  await expect(invoiceTable.getByTestId("debts-invoice-row")).toContainText("1,500 دج");
  await expect(invoiceTable.getByTestId("debts-invoice-row")).toContainText("2,000 دج");

  // collapsing removes the invoice list again
  await owedRow.click();
  await expect(page.getByTestId("debts-page").getByTestId("debts-invoices")).toHaveCount(0);
});