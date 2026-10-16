import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { saveQuickAdd } from "./rpc-helpers";

/**
 * Issue #96 round 2 — the invoice-returns action must branch on the second
 * gate, not just on the list's total:
 *
 * 1. a PURCHASE invoice can never save a customer return (the api refuses it
 *    with RETURN_NOT_SALE), so the panel points at the supplier account — the
 *    place a purchase return is actually recorded — and never renders the
 *    customer-return form;
 * 2. after a return is saved, `savedReturn` replaces the form with a completion
 *    card. Until the history refetch lands, `returns` is still the pre-save
 *    list, so the empty state is up — and its action would focus a field that
 *    no longer exists. The action must be gone while the card is shown.
 *
 * The stale window is held open deterministically (the returnsForInvoice
 * response is gated), never raced by timing.
 */

test.describe.configure({ mode: "serial" });

test("a purchase invoice points at the supplier account, not a dead return form (#96 round 2)", async ({ page }) => {
  await signIn(page);
  const stamp = Date.now().toString();
  const categoryName = `ر2-تصنيف-${stamp}`;
  const itemName = `ر2-منتج-${stamp}`;
  const supplierName = `ر2-مورد-${stamp}`;

  // 1. a category + item
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

  // 2. a purchase invoice from a NEW supplier record (inline create)
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(supplierName);
  await page.getByTestId("purchase-supplier-create").click();
  await page.getByTestId("purchase-supplier-create-name").fill(supplierName);
  await page.getByTestId("purchase-supplier-create-save").click();

  await page.getByTestId("purchase-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await page.getByTestId("purchase-lines").getByLabel(`${itemName}: الكمية`).fill("2");
  await page.getByTestId("purchase-paid").fill("0");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const invoiceNumber = (await page.getByTestId("purchase-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // 3. open the purchase invoice
  await page.goto("/invoices");
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${invoiceNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();

  const panel = page.getByTestId("returns-panel");
  await expect(panel.getByTestId("returns-empty")).toBeVisible();
  await expect(panel).toContainText("مرتجعات المشتريات");
  // the dead end is gone: no customer-return action, no customer-return form
  await expect(page.getByTestId("returns-empty-action")).toHaveCount(0);
  await expect(page.getByTestId("returns-form")).toHaveCount(0);

  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".scratch/reviews/96/screenshots/round2/purchase-returns.png" });

  // 4. the offered path is the supplier account, where the return is recorded
  await page.getByTestId("returns-supplier-action").click();
  await expect(page.getByTestId("supplier-balance")).toBeVisible();
  await expect(page.getByText(supplierName, { exact: true }).first()).toBeVisible();
});

test("a saved return shows its card with no dead action while the history is stale (#96 round 2)", async ({ page }) => {
  await signIn(page);
  const stamp = Date.now().toString();
  const categoryName = `ر2ب-تصنيف-${stamp}`;
  const itemName = `ر2ب-منتج-${stamp}`;

  // 1. a category + item with stock, then a full sale
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
  await page.getByTestId("sale-paid").fill("0");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  const saleNumber = (await page.getByTestId("sale-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // 2. hold the POST-save history refetch open: the initial page-load read
  //    resolves, every later read waits on the gate
  let returnsCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/rpc/returnsForInvoice", async (route) => {
    returnsCalls += 1;
    if (returnsCalls > 1) await gate;
    await route.continue();
  });

  await page.goto("/invoices");
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${saleNumber}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();

  // the sale is fresh: empty history, a usable form and its action
  const panel = page.getByTestId("returns-panel");
  await expect(panel.getByTestId("returns-form")).toBeVisible();
  await expect(page.getByTestId("returns-empty-action")).toBeVisible();

  // 3. record the return through the REAL form
  await page.locator('[data-testid^="returns-qty-"]').first().fill("1");
  await page.getByTestId("returns-submit").click();
  await expect(page.getByTestId("returns-done")).toBeVisible();

  // 4. the refetch is still held, so the history is the pre-save empty list:
  //    the empty state is up, the form is gone, and the action must be gone too
  await expect(page.getByTestId("returns-empty")).toBeVisible();
  await expect(page.getByTestId("returns-empty-action")).toHaveCount(0);
  await expect(page.getByTestId("returns-form")).toHaveCount(0);
  await expect(page.getByTestId("returns-empty")).toContainText("تم تسجيل المرجوع للتو");

  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".scratch/reviews/96/screenshots/round2/saved-return-stale.png" });

  // 5. release the read: the saved return lands in the history and the empty
  //    state (with its withheld action) is gone — the end state is proven
  release();
  await expect(page.getByTestId("returns-row")).toBeVisible();
  await expect(page.getByTestId("returns-empty")).toHaveCount(0);
});
