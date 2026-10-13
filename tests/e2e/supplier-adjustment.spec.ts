import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * #176 — supplier adjustments (تسوية) and the bulk opening-balance screen
 * (رصيد افتتاحي). Records an opening balance from the bulk screen, then an
 * invoice-linked خصم on the supplier page, and checks that the account balance
 * and the invoice's remaining agree.
 */
test("supplier adjustment: a bulk رصيد افتتاحي and a linked خصم agree with the invoice", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `تسوية-تصنيف-${stamp}`;
  const itemName = `تسوية-منتج-${stamp}`;
  const supplierName = `تسوية-مورد-${stamp}`;
  const openingSupplierName = `رصيد-افتتاحي-مورد-${stamp}`;

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

  // 2. purchase 5 units @1000 from a NEW supplier (paid 0 → the whole 5000 owed)
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(supplierName);
  await page.getByTestId("purchase-supplier-create").click();
  await page.getByTestId("purchase-supplier-create-name").fill(supplierName);
  await page.getByTestId("purchase-supplier-create-save").click();

  await page.getByTestId("purchase-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await page.getByTestId("purchase-lines").getByLabel(`${itemName}: الكمية`).fill("5");
  await page.getByTestId("purchase-paid").fill("0");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const invoiceNumber = (await page.getByTestId("purchase-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // 3. the bulk رصيد افتتاحي screen: create a supplier inline with 800 نسالوه
  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-new-name").fill(openingSupplierName);
  await page.getByTestId("opening-balance-new-amount").fill("800");
  await page.getByTestId("opening-balance-save").click();

  const saved = page.getByTestId("opening-balance-saved");
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(openingSupplierName);
  await expect(saved).toContainText("800 دج");
  await page.getByTestId("opening-balance-done").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();

  // 4. the new supplier exists and carries its opening balance
  await page.getByRole("link", { name: openingSupplierName }).click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("800 دج");

  // 5. the purchased supplier shows the charge
  await page.goto("/suppliers");
  await page.getByRole("link", { name: supplierName }).click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("5000 دج");

  // 6. an invoice-linked خصم of 500: the balance and the invoice both drop
  await page.getByTestId("supplier-action-adjust").click();
  await page.getByTestId("supplier-adjust-direction-they-owe").click();
  await page.getByTestId("supplier-adjust-amount").fill("500");
  await page.getByTestId("supplierAdjustPresetDiscount").click();
  await page.getByTestId("supplier-adjust-link").check();
  await chooseSelectOption(page, page.getByTestId("supplier-adjust-invoice"), invoiceNumber);
  await expect(page.getByTestId("supplier-adjust-preview-remaining")).toContainText("4500 دج");
  await page.getByTestId("supplier-adjust-confirm").click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("4500 دج");

  // the account row names the adjustment and its direction
  await page.getByTestId("party-tab-payments").click();
  await expect(page.getByTestId("supplier-entry-kind-ADJUSTMENT").first()).toBeVisible();
  await expect(page.getByTestId("supplier-entry-direction").first()).toContainText("يسالنا");

  // 7. the invoice agrees: remaining 4500, the 500 surfaced as settled credit
  await page.getByTestId("party-tab-invoices").click();
  await page.getByTestId("party-invoices").getByRole("link", { name: invoiceNumber }).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-remaining")).toHaveText("4500 دج");
  await expect(page.getByTestId("invoice-returns-credit")).toHaveText("500 دج");
});
