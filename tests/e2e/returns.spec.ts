import { expect, test } from "@playwright/test";
import { openSystemNav, signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { saveQuickAdd } from "./rpc-helpers";

/**
 * Returns & refunds e2e: a sale is recorded, the customer returns the unit on
 * the invoice screen (cash refund), the stock comes straight back into the
 * item history marked as a return, the on-demand return voucher renders the
 * store identity / return + invoice numbers / line / refund total, and the
 * owner reviews and accepts the return from the /returns screen (the pending
 * mark is consumed).
 */
test("sale → cash return → stock back (marked) + voucher route + review accept", async ({ page }) => {
  // 0. sign in
  await signIn(page);

  // 1. a known store identity so the voucher's header is asserted, not assumed
  const stamp = Date.now().toString();
  const storeName = `متجر-المرجوع-${stamp}`;
  await page.goto("/settings");
  await page.getByTestId("settings-name").fill(storeName);
  await page.getByTestId("settings-phone").fill("066 12 34 56 7");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toContainText("تم حفظ الإعدادات");

  // 2. category + item with stock, then a full cash sale
  const categoryName = `مرجوع-تصنيف-${stamp}`;
  const itemName = `مرجوع-منتج-${stamp}`;
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("900");
  await page.getByTestId("sale-quick-stock").fill("2");
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  expect(await page.getByTestId("sale-total").textContent()).toContain("900"); // 1 × 900
  // #162: zero the default full payment so the sale carries the full 900 debt
  // the all-cash return then warns about
  await page.getByTestId("sale-paid").fill("0");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const saleNumber = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // 3. open the invoice and record a 1-unit cash return; the sale was recorded
  // without a down payment, so the all-cash settlement triggers the soft
  // collected-money warning (owner decides — the api never blocks)
  await page.getByRole("link", { name: "الفواتير" }).click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${saleNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  const returnsPanel = page.getByTestId("returns-panel");
  await expect(returnsPanel).toBeVisible();
  await expect(page.locator('[data-testid^="returns-qty-"]')).toBeVisible();
  await expect(returnsPanel).toContainText("المتبقي: 1");
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  // the return value (900) vs collected-so-far (0) and the soft warning
  await expect(page.getByTestId("returns-value")).toContainText("900");
  await expect(page.getByTestId("returns-collected")).toContainText("0");
  await expect(page.getByTestId("returns-cash-warning")).toBeVisible();
  // an all-debt split would be capped by the 900 debt — keep the default
  // all-cash settlement (owner's choice) and record the return
  await page.getByTestId("returns-reason").fill("الزبون بدل رأيه");
  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");

  // 4. the return lands in the panel history with a return number
  const historyRow = page.getByTestId("returns-row");
  await expect(historyRow).toBeVisible();
  const returnNumber = (await historyRow.innerText()).match(/RTN-\d+/)![0]!;
  await expect(historyRow).toContainText("900 دج");
  await expect(historyRow).toContainText("قيد المراجعة");

  // 5. the on-demand voucher renders store identity + return/invoice numbers + line + total
  await page.locator(`[data-testid="return-print-${returnNumber}"]`).click();
  await expect(page.getByTestId("return-voucher-page")).toBeVisible();
  const voucher = page.getByTestId("return-voucher-view");
  await expect(voucher.getByTestId("return-voucher-store")).toContainText(storeName);
  await expect(voucher.getByTestId("return-voucher-phone")).toContainText("0661234567");
  await expect(voucher.getByTestId("return-voucher-number")).toContainText(returnNumber);
  await expect(voucher.getByTestId("return-voucher-invoice")).toContainText(saleNumber);
  await expect(voucher.getByTestId("return-voucher-line")).toContainText(itemName);
  await expect(voucher.getByTestId("return-voucher-line")).toContainText("900");
  await expect(voucher.getByTestId("return-voucher-total")).toContainText("900");
  await expect(voucher.getByTestId("return-voucher-cash")).toContainText("900");
  await expect(voucher.getByTestId("return-voucher-debt")).toContainText("0");
  await expect(voucher.getByTestId("return-voucher-status")).toContainText("قيد المراجعة");
  await page.getByTestId("return-voucher-back").click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();

  // 6. stock is back in the item history, visibly marked as a return
  await openSystemNav(page);
  await page.getByRole("link", { name: "المنتجات" }).click();
  const itemRow = page.getByRole("row", { name: new RegExp(itemName) });
  await expect(itemRow.getByTestId("stock-after-cell")).toContainText("2");
  await itemRow.getByRole("link", { name: "السجل" }).click();
  await expect(page.getByTestId("history-table")).toBeVisible();
  const movementRows = page.getByTestId("history-table").locator("tbody tr");
  // opening +2, sale −1, return +1: the last movement carries the visible
  // return marker and the stock is back at 2
  await expect(movementRows).toHaveCount(3);
  await expect(movementRows.nth(2)).toContainText("مرجوع");
  await expect(movementRows.nth(2)).toContainText("+1");
  await expect(movementRows.nth(2)).toContainText("2"); // stock after the return

  // 7. the owner reviews on /returns and accepts — the pending mark is consumed
  await page.getByRole("link", { name: "المرتجعات" }).click();
  await expect(page.getByTestId("returns-page")).toBeVisible();
  await expect(page.getByTestId(`returns-review-${returnNumber}`)).toBeVisible();
  await page.getByTestId(`returns-accept-${returnNumber}`).click();
  // scoped to THIS return's card: every spec shares one database, so an
  // unscoped status testid can match returns left by an earlier test and trip
  // Playwright's strict mode
  await expect(page.getByTestId(`returns-review-${returnNumber}`).getByTestId("returns-status-ACCEPTED")).toContainText("مقبول");
  await expect(page.getByTestId(`returns-actions-${returnNumber}`)).toHaveCount(0);
});

/**
 * The settlement panel must make the debt cap legible. A 900 sale with a 200
 * down payment leaves 700 of debt; returning the unit is worth 900, so only 700
 * can go to debt and 200 MUST be handed back as cash. The owner has to see the
 * 700, see the split, and be told which part the cap forced into cash — a
 * correct settlement that looks like a mistake is a defect. Once accepted, the
 * invoice header must reconcile: total − paid − returns = remaining.
 */
test("settlement names the debt cap, and the header reconciles after acceptance", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `سقف-تصنيف-${stamp}`;
  const itemName = `سقف-منتج-${stamp}`;
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // 1 × 900 with a 200 down payment → total 900, paid 200, remaining 700
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("900");
  await page.getByTestId("sale-quick-stock").fill("1");
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);
  await page.getByTestId("sale-paid").fill("200");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const saleNumber = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;

  await page.getByRole("link", { name: "الفواتير" }).click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${saleNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();

  // the header states the debt the owner has to reason about, and there is no
  // return credit yet — the row must not appear until a return has relieved
  // debt. `toHaveText` (not `toContainText`) so "700" cannot satisfy an
  // assertion about "0", and "700" cannot match "1700".
  await expect(page.getByTestId("invoice-remaining")).toHaveText(/^700\b/);
  await expect(page.getByTestId("invoice-returns-credit")).toHaveCount(0);

  // the panel shows the remaining debt beside the return value …
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  await expect(page.getByTestId("returns-value")).toContainText("900");
  await expect(page.getByTestId("returns-remaining-debt")).toHaveText(/^700\b/);

  // … and an all-debt choice is capped at 700, so 200 is forced into cash —
  // the split is shown and the note names both figures instead of leaving the
  // cash figure to change silently under the owner's chosen preset
  await chooseSelectOption(page, page.getByTestId("returns-settlement"), "كله خصم من الدين");
  await expect(page.getByTestId("returns-debt-offset")).toHaveText(/^700\b/);
  await expect(page.getByTestId("returns-cash-now")).toHaveText(/^200\b/);
  const capNote = page.getByTestId("returns-debt-cap-note");
  await expect(capNote).toBeVisible();
  await expect(capNote).toContainText("700");
  await expect(capNote).toContainText("200");

  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");
  const returnNumber = (await page.getByTestId("returns-row").innerText()).match(/RTN-\d+/)![0]!;

  // accept it, then the header reconciles: 900 − 200 − 700 = 0
  await openSystemNav(page);
  await page.getByRole("link", { name: "المرتجعات" }).click();
  await expect(page.getByTestId("returns-page")).toBeVisible();
  await page.getByTestId(`returns-accept-${returnNumber}`).click();
  await expect(page.getByTestId(`returns-review-${returnNumber}`).getByTestId("returns-status-ACCEPTED")).toContainText("مقبول");

  await page.goto("/invoices");
  await page.getByTestId(`invoice-open-${saleNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-returns-credit")).toHaveText(/^700\b/);
  await expect(page.getByTestId("invoice-remaining")).toHaveText(/^0\b/);
});
