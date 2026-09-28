import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

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
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
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
