import { expect, test, type Page } from "@playwright/test";
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
test("sale → debt-defaulted return → stock back (marked) + voucher route + review accept", async ({ page }) => {
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

  // 3. open the invoice and record a 1-unit return; the sale carries the full
  // 900 debt, so #256 pre-selects the DEBT and no cash changes hands
  await page.getByRole("link", { name: "الفواتير" }).click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${saleNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  const returnsPanel = page.getByTestId("returns-panel");
  await expect(returnsPanel).toBeVisible();
  await expect(page.locator('[data-testid^="returns-qty-"]')).toBeVisible();
  await expect(returnsPanel).toContainText("المتبقي: 1");
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  // the visible default: the debt-first preset, previewed as 900 to debt / 0 cash
  await expect(page.getByTestId("returns-settlement")).toContainText("كله خصم من الدين");
  await expect(page.getByTestId("returns-value")).toContainText("900");
  await expect(page.getByTestId("returns-collected")).toContainText("0");
  await expect(page.getByTestId("returns-debt-offset")).toHaveText(/^900\b/);
  await expect(page.getByTestId("returns-cash-now")).toHaveText(/^0\b/);
  // the whole return fits the debt, so the app picks it without asking
  await expect(page.getByTestId("returns-debt-default-note")).toHaveCount(0);
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
  // #256 — the default settled the whole value against the debt, so no cash
  await expect(voucher.getByTestId("return-voucher-cash")).toContainText("0");
  await expect(voucher.getByTestId("return-voucher-debt")).toContainText("900");
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
 * down payment leaves 700 of debt; returning the unit is worth 900, so 700 can
 * go to debt and 200 MUST be handed back as cash. Round 2 makes that split the
 * DERIVED DEFAULT (the owner answered the question), so the panel pre-selects
 * it and names both figures — and re-picking "all debt" explicitly still keeps
 * #162's cap and warns about the cash it forces. Once accepted, the invoice
 * header must reconcile: total − paid − returns = remaining.
 */
test("settlement names the derived split, keeps the explicit debt cap, and the header reconciles", async ({ page }) => {
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

  // … the return is bigger than the debt, so the approved default is the SPLIT:
  // debt to zero (700) and 200 handed back as cash. The panel pre-selects it,
  // names both figures, and does NOT warn about a cap — nothing was capped
  await expect(page.getByTestId("returns-debt-default-note")).toBeVisible();
  await expect(page.getByTestId("returns-debt-default-note")).toContainText("700");
  await expect(page.getByTestId("returns-debt-default-note")).toContainText("200");
  await expect(page.getByTestId("returns-debt-offset")).toHaveText(/^700\b/);
  await expect(page.getByTestId("returns-cash-now")).toHaveText(/^200\b/);
  await expect(page.getByTestId("returns-debt-cap-note")).toHaveCount(0);

  // the owner re-picks the debt-first method by hand: that is #162's explicit
  // choice, still capped at THIS invoice's 700 — and now the cap is announced
  await chooseSelectOption(page, page.getByTestId("returns-settlement"), "كله خصم من الدين");
  await expect(page.getByTestId("returns-debt-offset")).toHaveText(/^700\b/);
  await expect(page.getByTestId("returns-cash-now")).toHaveText(/^200\b/);
  const capNote = page.getByTestId("returns-debt-cap-note");
  await expect(capNote).toBeVisible();
  await expect(capNote).toContainText("700");
  await expect(capNote).toContainText("200");
  // … and the owner can hand the settlement back to the derived default
  await page.getByTestId("returns-debt-confirm").click();
  await expect(page.getByTestId("returns-debt-cap-note")).toHaveCount(0);
  await expect(page.getByTestId("returns-debt-default-note")).toBeVisible();

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

/**
 *#256 round 2 — seed one record through the real RPC wire. The oRPC fetch link
 * posts `{json: input}` to /api/rpc/<procedure> and answers `{json: output}`
 * (see @orpc/client's StandardRPCSerializer), the same wire
 * `invoice-print-a4.spec.ts` seeds through. Three invoices for one party
 * through the UI is a long, flaky walk that tests nothing this spec asserts, so
 * they are seeded here; every assertion below is the real screen.
 */
type SeedRequest =
  | { procedure: "categoriesCreate"; input: { name: string } }
  | {
      procedure: "itemsCreateWithStock";
      input: { name: string; categoryId: string; costPrice: number; sellingPrice: number; stockOnHand: number };
    }
  | {
      procedure: "invoicesCreate";
      input: {
        kind: "SALE";
        counterpartyName: string;
        invoiceDate: string;
        initialPaid?: number;
        lines: Array<{ itemId: string; quantity: number }>;
      };
    };

async function seedRpc<T>(page: Page, request: SeedRequest): Promise<T> {
  const output = await page.evaluate(async (call) => {
    const response = await fetch(`/api/rpc/${call.procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: call.input }),
      credentials: "include",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${call.procedure} failed: ${response.status} ${text}`);
    // SAFETY: the oRPC serializer answers `{json: <declared output>}`; the
    // `ok()` check above already rejected a refusal envelope
    return (JSON.parse(text) as { json: unknown }).json;
  }, request);
  // SAFETY: the value above is the procedure's declared output (same wire the
  // app's own RPC link reads), so the caller's T names it
  return output as T;
}

/**
 * #256 round 2 — the owner approved the cross-invoice answer: the default takes
 * the refund off the party's WHOLE tab, "in this invoice or in another
 * invoice", allocated across the open invoices OLDEST FIRST. The three invoices
 * are seeded through the app's own RPC (the UI path to three invoices for one
 * party is a long, flaky walk that tests nothing this spec asserts); everything
 * asserted below is the real screen: the derived default, the note naming the
 * tab, the accept, and BOTH invoice headers reconciling
 * (`total − paid − returnCredit = remaining`).
 */
test("an accepted return relieves the party's older invoices, oldest first, and both headers reconcile", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `توزيع-تصنيف-${stamp}`;
  const itemName = `توزيع-منتج-${stamp}`;
  const customerName = `زبون توزيع-${stamp}`;
  interface CreatedItem { id: string }
  interface CreatedInvoice { id: string; invoiceNumber: string; lines: Array<{ id: string }> }
  const category = await seedRpc<{ id: string }>(page, { procedure: "categoriesCreate", input: { name: categoryName } });
  const item = await seedRpc<CreatedItem>(page, {
    procedure: "itemsCreateWithStock",
    input: { name: itemName, categoryId: category.id, costPrice: 100, sellingPrice: 300, stockOnHand: 10 },
  });
  const sale = async (quantity: number, paid: number, invoiceDate: string): Promise<CreatedInvoice> => {
    const base = { kind: "SALE" as const, counterpartyName: customerName, invoiceDate, lines: [{ itemId: item.id, quantity }] };
    // `initialPaid` must be POSITIVE when present: 0 is sent as an absent field,
    // exactly as the sale form does for an unpaid invoice
    const input = paid > 0 ? { ...base, initialPaid: paid } : base;
    return seedRpc<CreatedInvoice>(page, { procedure: "invoicesCreate", input });
  };
  // oldest first: A owes 600, B owes 900, and C (the returned one) is paid in full
  const invoiceOld = await sale(2, 0, "2026-01-05");
  const invoiceNew = await sale(3, 0, "2026-03-05");
  const invoiceReturn = await sale(3, 900, "2026-04-05");

  // the return is recorded from the real invoice screen
  await page.goto(`/invoices/${invoiceReturn.id}`);
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await page.locator('[data-testid^="returns-qty-"]').fill("3");
  await expect(page.getByTestId("returns-value")).toContainText("900");
  // the whole 900 goes to the tab, which is not on this invoice at all: the
  // panel shows the tab and says the offset spreads oldest-first
  await expect(page.getByTestId("returns-party-debt")).toContainText("1500");
  await expect(page.getByTestId("returns-debt-default-note")).toContainText("الأقدم");
  await expect(page.getByTestId("returns-debt-offset")).toHaveText(/^900\b/);
  await expect(page.getByTestId("returns-cash-now")).toHaveText(/^0\b/);
  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");
  const returnNumber = (await page.getByTestId("returns-row").innerText()).match(/RTN-\d+/)![0]!;

  // while pending nothing moves (#68)
  await page.goto(`/invoices/${invoiceOld.id}`);
  await expect(page.getByTestId("invoice-remaining")).toHaveText(/^600\b/);
  await page.goto(`/invoices/${invoiceNew.id}`);
  await expect(page.getByTestId("invoice-remaining")).toHaveText(/^900\b/);

  // accept, then the 900 is taken off the oldest tab first: 600 then 300
  await openSystemNav(page);
  await page.getByRole("link", { name: "المرتجعات" }).click();
  await expect(page.getByTestId("returns-page")).toBeVisible();
  await page.getByTestId(`returns-accept-${returnNumber}`).click();
  await expect(page.getByTestId(`returns-review-${returnNumber}`).getByTestId("returns-status-ACCEPTED")).toContainText("مقبول");

  await page.goto(`/invoices/${invoiceOld.id}`);
  await expect(page.getByTestId("invoice-returns-credit")).toHaveText(/^600\b/);
  await expect(page.getByTestId("invoice-remaining")).toHaveText(/^0\b/);
  await page.goto(`/invoices/${invoiceNew.id}`);
  await expect(page.getByTestId("invoice-returns-credit")).toHaveText(/^300\b/);
  await expect(page.getByTestId("invoice-remaining")).toHaveText(/^600\b/);
});

/**
 * #256 round 3 — the settlement control must survive a SAVE. Recording a
 * debt-defaulted return clears the form, and the derived preset at value 0 is
 * "all debt" again — the SAME value it was before, so the old mirror-effect
 * never re-applied it: the method went blank and the next return previewed no
 * cash / debt split at all. Asserted on the real screen, without the owner
 * touching the control: the method is displayed and typing the remaining unit
 * previews the split.
 */
test("the derived settlement method and its preview come back for the next return after a save (#256 round 3)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `افتراضي-تصنيف-${stamp}`;
  const itemName = `افتراضي-منتج-${stamp}`;
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  // 2 × 900 unpaid: the invoice carries the full 1800 debt, so the derived
  // method is all-debt and both units can be returned (one at a time)
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
  // the sale LINE carries 2 units (the quick-add stock is the item's own stock)
  await page.getByLabel(`${itemName}: الكمية`).fill("2");
  await expect(page.getByTestId("sale-total")).toContainText("1800");
  await page.getByTestId("sale-paid").fill("0");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const saleNumber = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;

  await page.getByRole("link", { name: "الفواتير" }).click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${saleNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();

  // first return: 1 of the 2 units, untouched → the derived all-debt default
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  await expect(page.getByTestId("returns-settlement")).toContainText("كله خصم من الدين");
  await expect(page.getByTestId("returns-debt-offset")).toHaveText(/^900\b/);
  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");

  // the NEXT return: the method comes back displayed and derived, and typing
  // the remaining unit previews the split again
  await page.getByTestId("returns-new").click();
  await expect(page.getByTestId("returns-settlement")).toContainText("كله خصم من الدين");
  await page.locator('[data-testid^="returns-qty-"]').fill("1");
  await expect(page.getByTestId("returns-debt-offset")).toHaveText(/^900\b/);
  await expect(page.getByTestId("returns-cash-now")).toHaveText(/^0\b/);
});
