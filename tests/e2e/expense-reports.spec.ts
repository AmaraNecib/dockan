import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption, expectSelectOption } from "./select-helpers";

/**
 * Expenses + profit reports. Specs share one wiped-at-boot sqlite
 * database and run sequentially, so unique names are used and monetary
 * assertions on the CURRENT_MONTH report are deltas against a baseline (other
 * specs sell items in the current month). Expenses are only ever recorded by
 * this spec, so their report figures can be asserted exactly.
 */

async function ensureAuthed(page: import("@playwright/test").Page) {
  await signIn(page);
}

/** Read the displayed amount (may be negative) out of a report figure cell.
 * Tolerates thousands separators and the Unicode minus sign. */
function parseAmount(text: string | null): number {
  const normalized = (text ?? "").replace(/[،,]/g, "").replace(/−/g, "-");
  const match = normalized.match(/-?\d+/);
  return match === null ? NaN : Number(match[0]);
}

/** Select an expense category by its visible label. The withdrawal category
 * includes a badge suffix, so the shared helper uses a partial accessible name. */
async function selectExpenseCategory(page: import("@playwright/test").Page, name: string) {
  await chooseSelectOption(page, page.getByTestId("expense-category"), name);
}

test("record expenses, filter and sort history, and see them in the profit report", async ({ page }) => {
  await ensureAuthed(page);
  const stamp = Date.now().toString();
  const withdrawalName = "سحوبات المالك";
  const rentAmount = "5000";
  const withdrawalAmount = "3000";
  const note = `كراء-${stamp}`;

  await page.goto("/expenses");
  await expect(page.getByTestId("expenses-page")).toBeVisible();

  // the seeded categories include a distinct owner-withdrawal option
  const categorySelect = page.getByTestId("expense-category");
  await expectSelectOption(page, categorySelect, "كراء المحل");
  await expectSelectOption(page, categorySelect, withdrawalName);

  // record an operating expense with a note
  await selectExpenseCategory(page, "كراء المحل");
  await page.getByTestId("expense-amount").fill(rentAmount);
  await page.getByTestId("expense-note").fill(note);
  await page.getByTestId("expense-save").click();
  await expect(page.getByTestId("expense-saved")).toContainText("تم تسجيل المصروف");
  await expect(page.getByTestId("expense-history")).toContainText(rentAmount);
  await expect(page.getByTestId("expense-history")).toContainText(note);

  // and an owner withdrawal — the row carries the distinct badge. Enter from a
  // field must submit the record form natively, exactly like the save button.
  await selectExpenseCategory(page, withdrawalName);
  await page.getByTestId("expense-amount").fill(withdrawalAmount);
  await page.getByTestId("expense-amount").press("Enter");
  const withdrawalRow = page.getByTestId("expense-history").locator("tbody tr", { hasText: withdrawalAmount });
  await expect(withdrawalRow).toContainText("سحب المالك");

  // sort by amount ascending: the withdrawal (3000) precedes rent (5000)
  await chooseSelectOption(page, page.getByTestId("expense-sort-by"), "المبلغ");
  await chooseSelectOption(page, page.getByTestId("expense-sort-dir"), "تصاعدي");
  const rows = page.getByTestId("expense-history").locator("tbody tr");
  await expect(rows.first()).toContainText(withdrawalAmount);
  await expect(rows.last()).toContainText("5000");

  // category filter: only the rent row remains while the rent chip is active
  await page.getByRole("button", { name: "كراء المحل", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(rentAmount);
  await page.getByTestId("expense-filter-all").click();
  await expect(rows).toHaveCount(2);

  // a backdated expense stays hidden under the current-month default window
  const backdatedNote = `مؤجل-${stamp}`;
  await selectExpenseCategory(page, "كراء المحل");
  await page.getByTestId("expense-amount").fill("777");
  await page.getByTestId("expense-note").fill(backdatedNote);

  // issue #119 — the field wears the app's day-first shape, never the OS
  // datetime-local shape, and a pasted stored value is refused by name
  const dateField = page.getByTestId("expense-date");
  await expect(dateField).toHaveValue(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  await dateField.fill("2020-01-15T12:00");
  await page.getByTestId("expense-save").click();
  await expect(page.getByTestId("expense-error")).toContainText("01/10/2026 00:34");
  await expect(dateField).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("expense-history")).not.toContainText(backdatedNote);

  // «الآن» restores a live now-shaped value AND clears the field's stale
  // refusal, so the error text and aria-invalid go with it
  await page.getByTestId("expense-date-now").click();
  await expect(dateField).toHaveValue(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  await expect(dateField).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("expense-error")).toBeHidden();

  // the real backdated moment records in the field's own shape
  await dateField.fill("15/01/2020 12:00");
  await page.getByTestId("expense-save").click();
  // assert on this row's own note, never on the amount: the other rows carry
  // `Date.now()` stamps that can contain any three digits by chance
  await expect(page.getByTestId("expense-history")).not.toContainText(backdatedNote);

  // …and appears only inside its own custom window. Issue #123: the bounds are
  // the day-first text field, not the OS datetime-local control, and the same
  // instants still filter the same row.
  await chooseSelectOption(page, page.getByTestId("expense-range-preset"), "فترة مخصصة");
  const customFrom = page.getByTestId("expense-custom-from");
  const customTo = page.getByTestId("expense-custom-to");
  await expect(customFrom).toHaveAttribute("type", "text");
  await expect(customTo).toHaveAttribute("type", "text");
  await customFrom.fill("01/01/2020 00:00");
  await customTo.fill("31/01/2020 23:59");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(backdatedNote);

  // an impossible bound is refused by name and is not applied: the window keeps
  // its last bound rather than silently widening to everything
  await customFrom.fill("31/02/2020 00:00");
  await customFrom.blur();
  await expect(page.getByTestId("expense-custom-from-error")).toContainText("01/10/2026 00:34");
  await expect(customFrom).toHaveAttribute("aria-invalid", "true");

  // «الآن» restores a live, valid bound and clears the refusal
  await page.getByTestId("expense-custom-from-now").click();
  await expect(customFrom).toHaveValue(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  await expect(page.getByTestId("expense-custom-from-error")).toHaveCount(0);
});

test("profit report reconciles revenue, COGS, expenses, withdrawals and the result", async ({ page }) => {
  await ensureAuthed(page);
  const stamp = Date.now().toString();
  const itemName = `ربح-تقرير-${stamp}`;
  const categoryName = `تقارير-تصنيف-${stamp}`;
  const rentAmount = 950;
  const withdrawalAmount = 250;

  // own category so this spec never depends on another spec's data
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // baseline before this test writes anything (expenses from test 1 in this
  // spec and sales from other specs already count, so everything is a delta)
  await page.goto("/reports");
  await expect(page.getByTestId("reports-page")).toBeVisible();
  const read = async (testid: string) => parseAmount(await page.getByTestId(testid).textContent());
  const readAbs = async (testid: string) => Math.abs(parseAmount(await page.getByTestId(testid).textContent()));
  const baselineRevenue = await read("report-revenue");
  const baselineCogsAbs = await readAbs("report-cogs");
  const baselineGross = await read("report-gross-profit");
  const baselineOperatingAbs = await readAbs("report-operating");
  const baselineWithdrawalsAbs = await readAbs("report-withdrawals");
  const baselineResult = await read("report-result");

  // issue #119 — one short day-first line beside the range select, no raw ISO
  // and no localized month names; the first date reads on the right in RTL
  const rangeLabel = page.getByTestId("report-range-label");
  await expect(rangeLabel).toHaveText(/^\d{2}\/\d{2}\/\d{4} — \d{2}\/\d{2}\/\d{4}$/);
  await expect(rangeLabel).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  const selectBox = await page.getByTestId("report-range-preset").boundingBox();
  const labelBox = await rangeLabel.boundingBox();
  expect(selectBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  // one line: the label's box sits on the select's row (RTL: to its left)
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(selectBox!.x + 1);
  expect(selectBox!.x - (labelBox!.x + labelBox!.width)).toBeLessThan(32);
  expect(Math.abs((selectBox!.y + selectBox!.height / 2) - (labelBox!.y + labelBox!.height / 2))).toBeLessThan(20);

  // expenses land exactly as deltas in the report (expense lines render with
  // a leading minus, so magnitudes are compared)
  await page.goto("/expenses");
  await selectExpenseCategory(page, "كراء المحل");
  await page.getByTestId("expense-amount").fill(String(rentAmount));
  await page.getByTestId("expense-save").click();
  await selectExpenseCategory(page, "سحوبات المالك");
  await page.getByTestId("expense-amount").fill(String(withdrawalAmount));
  await page.getByTestId("expense-save").click();
  await page.goto("/reports");
  await expect.poll(async () => readAbs("report-operating")).toBe(baselineOperatingAbs + rentAmount);
  await expect.poll(async () => readAbs("report-withdrawals")).toBe(baselineWithdrawalsAbs + withdrawalAmount);
  const afterExpensesResult = baselineResult - rentAmount - withdrawalAmount;
  await expect.poll(async () => read("report-result")).toBe(afterExpensesResult);

  // sell one unit of a fresh item: 1000 revenue, 400 COGS -> +600 gross profit
  await page.goto("/sale");
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("sale-quick-stock").fill("2");
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");

  // the final report shows exactly the deltas this test caused
  await page.goto("/reports");
  await expect.poll(async () => read("report-revenue")).toBe(baselineRevenue + 1000);
  await expect.poll(async () => readAbs("report-cogs")).toBe(baselineCogsAbs + 400);
  await expect.poll(async () => read("report-gross-profit")).toBe(baselineGross + 600);
  // operating expenses and withdrawals did not change from the sale
  await expect.poll(async () => readAbs("report-operating")).toBe(baselineOperatingAbs + rentAmount);
  await expect.poll(async () => readAbs("report-withdrawals")).toBe(baselineWithdrawalsAbs + withdrawalAmount);
  await expect.poll(async () => read("report-result")).toBe(baselineResult - rentAmount - withdrawalAmount + 600);

  // the per-category breakdown traces both expense lines
  await expect(page.getByTestId("report-breakdown")).toContainText("كراء المحل");
  await expect(page.getByTestId("report-breakdown")).toContainText("سحوبات المالك");
});

test("profit report range preset is the themed select and switches the window", async ({ page }) => {
  await ensureAuthed(page);
  await page.goto("/reports");
  await expect(page.getByTestId("reports-page")).toBeVisible();

  // The native <select> that fell back to OS rendering is gone: the control is
  // the themed trigger and choosing a preset opens, selects and closes it.
  const trigger = page.getByTestId("report-range-preset");
  await expect(trigger).toHaveAttribute("data-slot", "select-trigger");
  await chooseSelectOption(page, trigger, "آخر 7 أيام");
  await expect(trigger).toContainText("آخر 7 أيام");

  // a non-CUSTOM preset never reveals the custom date bounds
  await expect(page.getByTestId("report-custom-from")).toHaveCount(0);
  await expect(page.getByTestId("report-custom-to")).toHaveCount(0);

  // issue #123 — CUSTOM reveals the day-first text bounds; a typed day-first
  // window round-trips through the api and back onto the period line
  await chooseSelectOption(page, trigger, "فترة مخصصة");
  const reportFrom = page.getByTestId("report-custom-from");
  const reportTo = page.getByTestId("report-custom-to");
  await expect(reportFrom).toHaveAttribute("type", "text");
  await expect(reportTo).toHaveAttribute("type", "text");
  await reportFrom.fill("01/01/2020 00:00");
  await reportTo.fill("31/01/2020 23:59");
  await expect(page.getByTestId("report-range-label")).toContainText("01/01/2020");
  await expect(page.getByTestId("report-range-label")).toContainText("31/01/2020");

  // an impossible bound is refused visibly rather than widening the window
  await reportFrom.fill("31/02/2020 00:00");
  await reportFrom.blur();
  await expect(page.getByTestId("report-custom-from-error")).toContainText("01/10/2026 00:34");
  await expect(reportFrom).toHaveAttribute("aria-invalid", "true");
});
test("create a new expense category from the expenses screen and record against it", async ({ page }) => {
  await ensureAuthed(page);
  const stamp = Date.now().toString();
  const categoryName = `صيانة-${stamp}`;
  const amount = "1250";

  await page.goto("/expenses");
  await expect(page.getByTestId("expenses-page")).toBeVisible();

  // the category is required and named up front, not only at submit
  await expect(page.getByTestId("expense-category")).toContainText("اختر تصنيفاً…");

  // create the category without leaving the screen
  await page.getByTestId("expense-category-add").click();
  await expect(page.getByTestId("expense-category-form")).toBeVisible();
  await page.getByTestId("expense-category-name").fill(categoryName);
  await page.getByTestId("expense-category-create").click();

  // the new category is selected immediately and usable
  await expect(page.getByTestId("expense-category-created")).toContainText(categoryName);
  await expect(page.getByTestId("expense-category")).toContainText(categoryName);
  await expect(page.getByTestId("expense-category-form")).toHaveCount(0);

  // record an expense against it
  await page.getByTestId("expense-amount").fill(amount);
  await page.getByTestId("expense-save").click();
  await expect(page.getByTestId("expense-saved")).toContainText("تم تسجيل المصروف");
  // Select by the unique stamped category, never by the amount: Playwright
  // concatenates a row's cells without separators, so a numeric amount can match
  // a substring spanning another row's note stamp and amount (e.g. the note
  // ending "…5312" plus "5000" renders "…5312500", which contains "1250").
  const row = page.getByTestId("expense-history").locator("tbody tr", { hasText: categoryName });
  await expect(row).toContainText(amount);
});
