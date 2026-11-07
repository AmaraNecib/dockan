import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption, expectSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { actAndAck, callRpc, saveQuickAdd, seedCategoryId } from "./rpc-helpers";

async function setDisabledInput(locator: import("@playwright/test").Locator, disabled: boolean): Promise<void> {
  await locator.evaluate((element, nextDisabled) => {
    if (!(element instanceof HTMLInputElement)) throw new Error("category control is not an input");
    element.disabled = nextDisabled;
  }, disabled);
}

/**
 * Issue #98 — items flow. One-step item + opening stock, inline price
 * correction, stock-add prefilled from the item, and keyboard-operable tabs.
 * The scan flow, low-stock badge, profit preview and stock ledger keep their
 * own specs; this one proves the new flow end to end.
 */
test("items flow: one-step stock, inline edit, and prefilled stock add", async ({ page }) => {
  const stamp = Date.now().toString();
  const categoryName = `تدفق-تصنيف-${stamp}`;
  const stockedName = `مخزون-${stamp}`;
  const plainName = `بلا-كمية-${stamp}`;

  await signIn(page);

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // The table is the default; the add job is one deliberate tab away.
  await page.goto("/items");
  await expect(page.getByRole("tab", { name: "المنتجات" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#items-panel-products")).toBeVisible();
  await expect(page.locator("#items-panel-add")).toBeHidden();

  // Switch tabs with the keyboard: arrow moves selection and focus.
  await page.getByRole("tab", { name: "المنتجات" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "إضافة ومخزون" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#items-panel-add")).toBeVisible();

  // 1. Item + opening stock in ONE submit, no scan involved. No barcode read.
  const category = page.getByLabel("التصنيف");
  await setDisabledInput(category, true);
  const chooseAfterLoad = chooseSelectOption(page, category, categoryName);
  await expect(category).toBeDisabled();
  await setDisabledInput(category, false);
  await chooseAfterLoad;

  await setDisabledInput(category, true);
  const expectAfterLoad = expectSelectOption(page, category, categoryName);
  await expect(category).toBeDisabled();
  await setDisabledInput(category, false);
  await expectAfterLoad;

  await page.getByTestId("item-name").fill(stockedName);
  await page.getByLabel("سعر الشراء (دج)").fill("100");
  await page.getByLabel("سعر البيع (دج)").fill("200");
  await page.getByTestId("initial-stock").fill("9");
  await page.getByTestId("item-save").click();

  // the success reset clears the form; wait for it before typing the next item
  await expect(page.getByTestId("item-name")).toHaveValue("");

  // 2. A blank opening stock is the plain item: stock 0, still saved.
  await page.getByTestId("item-name").fill(plainName);
  await page.getByLabel("سعر الشراء (دج)").fill("50");
  await page.getByLabel("سعر البيع (دج)").fill("90");
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("item-name")).toHaveValue("");

  await openItemsTab(page, "products");
  // exact cell match: `مخزون-…` is a substring of `بدون-مخزون-…`, so a row-name
  // regex would resolve to two rows (strict-mode violation)
  const stockedRow = page.locator("tr").filter({ has: page.getByRole("cell", { name: stockedName, exact: true }) });
  const plainRow = page.locator("tr").filter({ has: page.getByRole("cell", { name: plainName, exact: true }) });
  await expect(stockedRow.getByTestId("stock-after-cell")).toHaveText("9");
  // the zero-stock item also carries the low badge (0 <= default threshold 5)
  await expect(plainRow.getByTestId("stock-after-cell")).toHaveText(/^0\b/);
  await expect(plainRow.getByTestId("stock-after-cell")).toContainText("منخفض");

  // 3. Correct a price from the table; the change persists across a reload.
  await stockedRow.getByRole("button", { name: "تعديل" }).click();
  await page.getByTestId("edit-sell").fill("777");
  await page.getByTestId("edit-save").click();
  await expect(stockedRow).toContainText("777");

  await page.reload();
  await expect(stockedRow).toContainText("777");

  // 4. Add stock to the existing item: selling price shown, unit cost prefilled.
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByTestId("stock-item"), stockedName);
  await expect(page.getByTestId("stock-selling-price")).toContainText("777");
  await expect(page.getByTestId("stock-unit-cost")).toHaveValue("100");

  await page.getByTestId("stock-delta").fill("3");
  await page.getByTestId("stock-form").getByRole("button", { name: "تسجيل" }).click();
  await expect(page.getByTestId("stock-done")).toContainText("تم تسجيل الحركة");

  await openItemsTab(page, "products");
  await expect(stockedRow.getByTestId("stock-after-cell")).toHaveText("12");
});

/**
 * Issue #98 review fixes — money blockers. The stock form's unit-cost prefill
 * must follow a cost correction, and a zero-price item (sale quick-add creates
 * selling 0) must stay editable without forcing a price change.
 */
test("stock prefill follows a cost correction and stays editable end to end", async ({ page }) => {
  const stamp = Date.now().toString();
  const categoryName = `تكلفة-تصنيف-${stamp}`;
  const itemName = `تكلفة-منتج-${stamp}`;

  await signIn(page);

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("100");
  await page.getByLabel("سعر البيع (دج)").fill("200");
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("item-name")).toHaveValue("");

  // the still-mounted stock form prefills the fresh item's known cost
  await chooseSelectOption(page, page.getByTestId("stock-item"), itemName);
  await expect(page.getByTestId("stock-unit-cost")).toHaveValue("100");

  // correct the cost from the products table
  await openItemsTab(page, "products");
  const row = page.locator("tr").filter({ has: page.getByRole("cell", { name: itemName, exact: true }) });
  await row.getByRole("button", { name: "تعديل" }).click();
  await page.getByTestId("edit-cost").fill("150");
  await page.getByTestId("edit-save").click();
  await expect(row).toContainText("150");

  // back on the add tab, the untouched prefill refreshed to the corrected cost
  await openItemsTab(page, "add");
  await expect(page.getByTestId("stock-unit-cost")).toHaveValue("150");

  // a hand-edited value is what gets submitted
  await page.getByTestId("stock-unit-cost").fill("999");
  await page.getByTestId("stock-delta").fill("1");
  await page.getByTestId("stock-form").getByRole("button", { name: "تسجيل" }).click();
  await expect(page.getByTestId("stock-done")).toContainText("تم تسجيل الحركة");
});

test("a zero-price item from sale quick-add stays editable", async ({ page }) => {
  const stamp = Date.now().toString();
  const categoryName = `صفر-تصنيف-${stamp}`;
  const itemName = `صفر-منتج-${stamp}`;
  const renamed = `${itemName}-معدل`;

  await signIn(page);

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // sale quick-add permits selling price 0
  await page.goto("/sale");
  await page.getByTestId("sale-quick-add").click();
  const quick = page.getByTestId("sale-quick-form");
  await page.getByTestId("sale-quick-name").fill(itemName);
  // The category picker stays disabled until its list has answered.
  const quickCategory = page.getByTestId("sale-quick-category");
  await expect(quickCategory).toBeEnabled();
  await chooseSelectOption(page, quickCategory, categoryName);
  await quick.getByLabel("سعر الشراء (دج)").fill("50");
  await quick.getByLabel("سعر البيع (دج)").fill("0");
  // a blank opening quantity takes the plain create path, so the procedure is
  // itemsCreate — arming itemsCreateWithStock here would never fire
  await saveQuickAdd(page, {
    procedure: "itemsCreate",
    save: quick.getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);

  // a name-only correction saves without touching the zero price
  await page.goto("/items");
  const row = page.locator("tr").filter({ has: page.getByRole("cell", { name: itemName, exact: true }) });
  await row.getByRole("button", { name: "تعديل" }).click();
  await page.getByTestId("edit-name").fill(renamed);
  await page.getByTestId("edit-save").click();
  await expect(page.locator("tr").filter({ has: page.getByRole("cell", { name: renamed, exact: true }) })).toBeVisible();
});

test("products table search reaches full-catalogue matches and keeps edit/history actions (#388)", async ({ page }) => {
  const stamp = Date.now().toString();
  await signIn(page);
  const categoryId = await seedCategoryId(page, `بحث-تصنيف-${stamp}`);
  for (let index = 0; index < 24; index++) {
    await callRpc(page, "itemsCreate", {
      name: `000388-${stamp}-${String(index).padStart(2, "0")}`,
      categoryId,
      costPrice: 100,
      sellingPrice: 150,
    });
  }
  const targetName = `مصطفى 388 ${stamp}`;
  const barcode = `FIND388-${stamp}`;
  await callRpc(page, "itemsCreate", {
    name: targetName,
    barcode,
    categoryId,
    costPrice: 100,
    sellingPrice: 150,
  });
  await callRpc(page, "preferencesSet", { key: "ui.pageSize", value: "10" });

  await page.goto("/items");
  await expect(page.getByTestId("items-pager-next")).toBeEnabled();
  await page.getByTestId("items-pager-next").click();
  await expect(page.getByTestId("items-pager-page-2")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("cell", { name: targetName, exact: true })).toHaveCount(0);

  const search = page.getByTestId("catalog-search");
  await search.fill("مصطفي 388");
  const row = page.locator("tr").filter({ has: page.getByRole("cell", { name: targetName, exact: true }) });
  await expect(row).toBeVisible();
  await expect(page.getByTestId("items-search-total")).toHaveText("النتائج: 1");

  await search.fill(barcode.toLowerCase());
  await expect(row).toBeVisible();
  await expect(page.getByTestId("items-search-total")).toHaveText("النتائج: 1");
  await row.getByRole("button", { name: "تعديل" }).click();
  await page.getByTestId("edit-sell").fill("777");
  await actAndAck(page, "itemsUpdate", () => page.getByTestId("edit-save").click());
  await expect(row).toContainText("777");

  await row.getByRole("link", { name: "السجل" }).click();
  await expect(page.getByRole("heading").filter({ hasText: targetName })).toBeVisible();
});

test("sale quick-add creates a category explicitly and keeps item and customer drafts", async ({ page }) => {
  const stamp = Date.now();
  const categoryName = `تصنيف سريع-${stamp}`;
  const itemName = `منتج سريع-${stamp}`;
  const customerName = `زبون سريع-${stamp}`;

  await signIn(page);
  await page.goto("/sale");
  await page.getByTestId("sale-quick-add").click();
  const quick = page.getByTestId("sale-quick-form");
  const category = page.getByTestId("sale-quick-category");
  await expect(category).toBeEnabled();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await quick.getByLabel("سعر الشراء (دج)").fill("100");
  await quick.getByLabel("سعر البيع (دج)").fill("200");
  await page.getByTestId("sale-quick-stock").fill("2");
  await category.fill(categoryName);
  const createCategory = page.getByTestId("sale-quick-category-create");
  await expect(createCategory).toBeVisible();
  const createdCategory = await actAndAck<{ id: string }>(page, "categoriesCreate", () => page.keyboard.press("Enter"));
  await expect(category).toHaveValue(categoryName);
  await expect(page.getByTestId("sale-quick-name")).toHaveValue(itemName);
  await expect(page.getByTestId("sale-quick-stock")).toHaveValue("2");

  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: quick.getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);

  const customer = page.getByTestId("sale-customer");
  await customer.fill(customerName);
  const createCustomer = page.getByTestId("sale-customer-create");
  await expect(createCustomer).toBeVisible();
  await createCustomer.click();
  const createPanel = page.getByTestId("sale-customer-create-panel");
  await expect(createPanel).toBeVisible();
  await expect(page.getByTestId("sale-customer-create-name")).toHaveValue(customerName);
  const createdParty = await actAndAck<{ id: string }>(page, "customersCreate", () => page.getByTestId("sale-customer-create-save").click());
  expect(createdCategory.id).toBeTruthy();
  expect(createdParty.id).toBeTruthy();
  await expect(customer).toHaveValue(customerName);
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
});
