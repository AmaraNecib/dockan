import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * E2E flow: create an item, add stock manually through the ledger,
 * verify the raised stock in the items list, open the item history and check
 * the derived stock-after column, then confirm an oversell is rejected and
 * changes nothing. (Opening-row backfill behavior is covered by store tests.)
 */
test("add stock manually, item history shows movements with derived stock", async ({ page }) => {
  // 0. sign in
  await signIn(page);

  // 1. create a category + an item (stock starts at 0)
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("بطاريات");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("بطاريات", { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await page.getByTestId("item-name").fill("مكواة 27");
  await page.getByLabel("سعر الشراء (دج)").fill("2000");
  await page.getByLabel("سعر البيع (دج)").fill("3500");
  // threshold 0 keeps this item off the shared low-stock dashboard so the
  // other spec files' assertions stay deterministic
  await page.getByLabel("حد التنبيه").fill("0");
  await page.getByRole("button", { name: "حفظ" }).click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /مكواة 27/ })).toBeVisible();

  // 2. record a manual stock-in of 6 units at 2000 DZD
  await openItemsTab(page, "add");
  const stockForm = page.getByTestId("stock-form");
  await chooseSelectOption(page, stockForm.getByRole("combobox"), "مكواة 27");
  await page.getByTestId("stock-delta").fill("6");
  await stockForm.getByLabel("تكلفة الوحدة (دج)").fill("2000");
  await stockForm.getByRole("button", { name: "تسجيل" }).click();
  await expect(page.getByTestId("stock-done")).toContainText("تم تسجيل الحركة");

  // 3. the items list reflects the new stock (exact cell match, not substring)
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /مكواة 27/ }).getByTestId("stock-after-cell")).toHaveText("6");

  // 4. history: the manual movement with derived stock-after. A fresh item
  // has no ledger history before this, so exactly one row exists (the
  // synthetic "opening" backfill applies only to pre-ledger items).
  await page
    .getByRole("row", { name: /مكواة 27/ })
    .getByRole("link", { name: "السجل" })
    .click();
  await expect(page.getByTestId("history-table")).toBeVisible();
  const rows = page.getByTestId("history-table").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("+6");
  await expect(page.getByTestId("stock-after").last()).toHaveText("6");

  // 5. overselling is rejected by the api with a translated error…
  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByTestId("stock-form").getByRole("combobox"), "مكواة 27");
  await page.getByTestId("stock-delta").fill("-99");
  await page.getByTestId("stock-form").getByRole("button", { name: "تسجيل" }).click();
  await expect(page.getByTestId("stock-error")).toContainText("الكمية غير متوفرة في المخزون");
  // …and the rejected delta changed nothing
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /مكواة 27/ }).getByTestId("stock-after-cell")).toHaveText("6");
});

/**
 * Issue #144 — an owner-edited cost is a ledger fact. The edit must survive the
 * next inflow's weighted-average replay, and the history must show it as a
 * distinct zero-quantity correction row.
 */
test("an edited cost survives the next inflow and shows as a correction movement", async ({ page }) => {
  const stamp = Date.now().toString();
  const categoryName = `تكلفة-تصنيف-${stamp}`;
  const itemName = `تكلفة-منتج-${stamp}`;

  await signIn(page);

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // opening stock 10 @ 100
  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("100");
  await page.getByLabel("سعر البيع (دج)").fill("200");
  await page.getByTestId("initial-stock").fill("10");
  await page.getByTestId("item-save").click();
  await expect(page.getByTestId("item-name")).toHaveValue("");

  // edit the cost to 300
  await openItemsTab(page, "products");
  const row = page.locator("tr").filter({ has: page.getByRole("cell", { name: itemName, exact: true }) });
  await row.getByRole("button", { name: "تعديل" }).click();
  await page.getByTestId("edit-cost").fill("300");
  await page.getByTestId("edit-save").click();
  await expect(row).toContainText("300");

  // the history records the edit as a zero-quantity correction
  await row.getByRole("link", { name: "السجل" }).click();
  await expect(page.getByTestId("history-table")).toBeVisible();
  const historyRows = page.getByTestId("history-table").locator("tbody tr");
  await expect(historyRows).toHaveCount(2);
  await expect(historyRows.last()).toContainText("تصحيح تكلفة يدوي");
  await expect(historyRows.last()).toContainText("300");
  // a zero-quantity correction is not a stock loss: neutral delta styling
  await expect(historyRows.last().getByRole("cell").nth(2)).toHaveClass(/text-muted-foreground/);
  await expect(historyRows.last().getByRole("cell").nth(2)).not.toHaveClass(/text-destructive/);

  // a later inflow replays the ledger: (10×300 + 10×200) / 20 = 250
  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByTestId("stock-item"), itemName);
  await page.getByTestId("stock-delta").fill("10");
  await page.getByTestId("stock-unit-cost").fill("200");
  await page.getByTestId("stock-form").getByRole("button", { name: "تسجيل" }).click();
  await expect(page.getByTestId("stock-done")).toContainText("تم تسجيل الحركة");

  // the prefill now shows the corrected average, so the edit survived
  await expect(page.getByTestId("stock-unit-cost")).toHaveValue("250");
});
