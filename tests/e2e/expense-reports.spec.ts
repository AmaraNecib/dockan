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

  // and an owner withdrawal — the row carries the distinct badge
  await selectExpenseCategory(page, withdrawalName);
  await page.getByTestId("expense-amount").fill(withdrawalAmount);
  await page.getByTestId("expense-save").click();
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
  await page.getByTestId("expense-date").fill("2020-01-15T12:00");
  await page.getByTestId("expense-save").click();
  // assert on this row's own note, never on the amount: the other rows carry
  // `Date.now()` stamps that can contain any three digits by chance
  await expect(page.getByTestId("expense-history")).not.toContainText(backdatedNote);

  // …and appears only inside its own custom window
  await chooseSelectOption(page, page.getByTestId("expense-range-preset"), "فترة مخصصة");
  await page.getByTestId("expense-custom-from").fill("2020-01-01T00:00");
  await page.getByTestId("expense-custom-to").fill("2020-01-31T23:59");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(backdatedNote);
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

  // the localized range label renders an RTL Arabic sentence with each date
  // LTR-isolated, and no raw ISO timestamp / clock time leaks through
  const rangeLabel = page.getByTestId("report-range-label");
  await expect(rangeLabel).toHaveAttribute("dir", "rtl");
  await expect(rangeLabel).toContainText("من");
  await expect(rangeLabel).toContainText("إلى");
  await expect(rangeLabel).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  const rangeDates = page.locator("[data-testid='report-range-label'] > span[dir='ltr']");
  await expect(rangeDates).toHaveCount(2);
  // each isolated span carries the day/month/year, including the Arabic month name
  await expect(rangeDates.nth(0)).toContainText(/[\u0600-\u06FF]/);
  await expect(rangeDates.nth(1)).toContainText(/[\u0600-\u06FF]/);

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
  await page.getByTestId("sale-quick-stock-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await page.getByLabel("التصنيف").selectOption({ label: categoryName });
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