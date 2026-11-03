import { expect, test, type Page } from "@playwright/test";
import type { InvoiceDetail, Item } from "../../packages/contracts/src/core";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { actAndAck, callRpc, seedCategoryId, waitForRpc } from "./rpc-helpers";

// The evidence surface is the help dialog, not the whole desktop.
test.use({ video: "on" });

async function pick(page: Page, name: string, kind: "sale" | "purchase") {
  await page.getByTestId(`${kind}-open-picker`).click();
  const picker = page.getByTestId("picker-dialog");
  await picker.getByPlaceholder("ابحث بالاسم أو الباركود…").fill(name);
  await picker.getByRole("button", { name: new RegExp(name) }).first().click();
  await expect(page.getByTestId(`${kind}-lines`)).toContainText(name);
}

test("workflow shortcuts respect dialogs, typed drafts, cancellation and existing keys", async ({ page }, info) => {
  // This covers both draft guards, dialog refusal and help evidence in one journey.
  test.setTimeout(60_000);
  await signIn(page);
  await expect(page.getByRole("button", { name: "اختصارات لوحة المفاتيح" })).toHaveAttribute("title", /\(\?\)$/);
  await expect(page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" })).toHaveAttribute("title", /Ctrl\/⌘\+Shift\+B/);
  await page.getByRole("button", { name: "اختصارات لوحة المفاتيح" }).click();
  const help = page.getByRole("dialog", { name: "اختصارات لوحة المفاتيح" });
  await expect(help).toBeVisible();
  await help.screenshot({ path: info.outputPath("shortcuts-help.png") });
  await page.keyboard.press("Control+n");
  await page.keyboard.press("Control+b");
  await expect(page).toHaveURL(/\/$/);
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();

  await page.getByTestId("new-sale-button").click();
  await expect(page).toHaveURL(/\/sale\?fresh=[1-9]\d*$/);
  const saleUrl = page.url();
  await expect(page.getByTestId("sale-open-picker")).toHaveAttribute("title", /\(Ctrl\+N\)$/);
  const customer = page.getByTestId("sale-customer");
  await page.keyboard.press("Escape");
  await page.getByTestId("sale-quick-add").click();
  const quick = page.getByTestId("sale-quick-form");
  await expect(customer).toHaveValue("");
  await expect(page.getByTestId("sale-lines")).toHaveCount(0);
  await expect(quick.getByTestId("sale-quick-name")).toHaveValue("");
  await expect(quick.getByTestId("sale-quick-barcode")).toHaveValue("");
  await expect(quick.locator('[name="quickCost"]')).toHaveValue("");
  await expect(quick.locator('[name="quickSell"]')).toHaveValue("");
  const stock = quick.getByTestId("sale-quick-stock");
  await stock.fill("7");
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(saleUrl);
  await expect(stock).toHaveValue("7");
  await stock.fill("");
  await customer.fill("مسودة الاختصار");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+n");
  const picker = page.getByTestId("picker-dialog");
  await expect(picker.getByPlaceholder("ابحث بالاسم أو الباركود…")).toBeFocused();
  await page.keyboard.press("Control+b");
  await expect(page).toHaveURL(saleUrl);
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(customer).toHaveValue("مسودة الاختصار");

  await customer.focus();
  await page.keyboard.press("Control+b");
  const discard = page.getByRole("dialog");
  await expect(discard).toBeVisible();
  await expect(discard).toContainText("فتح المشتريات؟");
  await expect(discard).toContainText("سيتم فقدان مسودة البيع غير المحفوظة");
  await page.keyboard.press("Control+n");
  await page.keyboard.press("Escape");
  await expect(discard).toBeHidden();
  await expect(customer).toHaveValue("مسودة الاختصار");
  await expect(customer).toBeFocused();
  await page.keyboard.press("Control+b");
  await page.getByTestId("new-sale-discard-confirm").click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();

  await expect(page.getByTestId("purchase-open-picker")).toHaveAttribute("title", /\(Ctrl\+B\)$/);
  const supplier = page.getByTestId("purchase-supplier");
  await supplier.fill("مسودة المورد");
  await page.keyboard.press("Escape");
  await supplier.focus();
  await page.keyboard.press("Control+n");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(supplier).toHaveValue("مسودة المورد");
  await supplier.focus();
  await page.keyboard.press("Control+n");
  await page.getByTestId("purchase-discard-confirm").click();
  await expect(page.getByTestId("sale-form")).toBeVisible();

  const sidebar = page.getByRole("complementary", { name: "التنقل الرئيسي" });
  const width = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
  await customer.focus();
  await page.keyboard.press("Control+Shift+b");
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).not.toBe(width);
  await expect(page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" })).toBeEnabled();
  await page.keyboard.press("Control+Shift+b");
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(width);
  await page.getByRole("heading", { name: "فاتورة بيع جديدة", exact: true }).click();
  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Ctrl+N");
  await expect(help).toContainText("Ctrl+B");
  await expect(help).not.toContainText("Ctrl/⌘ + K");
  await help.screenshot({ path: info.outputPath("shortcuts-help-active.png") });
});

test("shortcut-entered purchase and sale persist, a refused sale keeps its draft for retry", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف الاختصارات");
  const name = `اختصار-${Date.now()}`;
  const item = await callRpc<Item, object>(page, "itemsCreate", {
    name, categoryId, costPrice: 400, sellingPrice: 1000,
  });

  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await pick(page, name, "purchase");
  const purchaseQuantity = page.getByTestId("purchase-lines").getByLabel(`${name}: الكمية`);
  await purchaseQuantity.fill("2");
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(purchaseQuantity).toHaveValue("2");
  const purchase = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("purchase-save").click());
  await expect(page.getByTestId("purchase-saved-number")).toContainText(purchase.invoiceNumber);
  expect(purchase.kind).toBe("PURCHASE");
  expect(purchase.totalAmount).toBe(800);
  const storedPurchase = await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: purchase.id });
  expect(storedPurchase.lines[0]?.quantity).toBe(2);
  expect(storedPurchase.totalAmount).toBe(800);
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await expect(page.getByTestId("purchase-lines")).toHaveCount(0);
  await expect(page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, name, "sale");
  const quantity = page.getByTestId("sale-lines").getByLabel(`${name}: الكمية`);
  await quantity.fill("3");
  const refusal = waitForRpc(page, "invoicesCreate");
  void refusal.catch(() => undefined);
  await page.getByTestId("sale-save").click();
  const refusalResponse = await refusal;
  const refusalBody = await refusalResponse.json();
  console.log(`[issue-395-oversell-raw] ${JSON.stringify({ status: refusalResponse.status(), body: refusalBody })}`);
  expect(refusalResponse.ok()).toBe(false);
  expect(refusalBody.json).toMatchObject({ code: "BAD_REQUEST", message: "STOCK_NEGATIVE" });
  await expect(page.getByTestId("sale-error")).toBeVisible();
  await expect(quantity).toHaveValue("3");
  const afterRefusal = await callRpc<{ items: Item[] }, object>(page, "itemsAll", {});
  expect(afterRefusal.items.find((row) => row.id === item.id)?.stockOnHand).toBe(2);
  await quantity.focus();
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(quantity).toHaveValue("3");
  await quantity.fill("1");
  const sale = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
  await expect(page.getByTestId("sale-saved-number")).toContainText(sale.invoiceNumber);
  expect(sale.kind).toBe("SALE");
  expect(sale.totalAmount).toBe(1000);
  const storedSale = await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: sale.id });
  expect(storedSale.lines[0]?.itemId).toBe(item.id);
  expect(storedSale.lines[0]?.quantity).toBe(1);
  const storedItems = await callRpc<{ items: Item[] }, object>(page, "itemsAll", {});
  expect(storedItems.items.find((row) => row.id === item.id)?.stockOnHand).toBe(1);

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await expect(page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…")).toBeFocused();
});

test("navigation shortcuts cannot abandon a sale while its real save is pending", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف الحفظ");
  const name = `حفظ-اختصار-${Date.now()}`;
  await callRpc<Item, object>(page, "itemsCreateWithStock", {
    name, categoryId, costPrice: 400, sellingPrice: 1000, stockOnHand: 1,
  });
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, name, "sale");

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  await page.route("**/api/rpc/invoicesCreate", async (route) => {
    reached();
    await held;
    await route.continue();
  });
  let saved: Promise<InvoiceDetail> | undefined;
  try {
    saved = actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
    void saved.catch(() => undefined);
    await requested;
    await expect(page.getByTestId("sale-save")).toBeDisabled();
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Control+n");
    await expect(page).toHaveURL(/\/sale$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("sale-lines")).toContainText(name);
    release();
    const invoice = await saved;
    await expect(page.getByTestId("sale-saved-number")).toContainText(invoice.invoiceNumber);
    const persisted = await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: invoice.id });
    expect(persisted.totalAmount).toBe(1000);
  } finally {
    release();
    await saved?.catch(() => undefined);
    await page.unroute("**/api/rpc/invoicesCreate");
  }
});


test("pending purchase refuses navigation and discard until its saved result is visible", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف حماية الشراء");
  const name = `شراء-محمي-${Date.now()}`;
  const item = await callRpc<Item, object>(page, "itemsCreate", {
    name, categoryId, costPrice: 400, sellingPrice: 1000,
  });
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await pick(page, name, "purchase");
  const quantity = page.getByTestId("purchase-lines").getByLabel(`${name}: الكمية`);
  await quantity.fill("2");

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  await page.route("**/api/rpc/invoicesCreate", async (route) => {
    reached();
    await held;
    await route.continue();
  });
  let saved: Promise<InvoiceDetail> | undefined;
  try {
    saved = actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("purchase-save").click());
    void saved.catch(() => undefined);
    await requested;
    await expect(page.getByTestId("purchase-save")).toBeDisabled();
    await page.keyboard.press("Control+n");
    // A pending request is not discardable work. Do not offer a destructive answer.
    await expect(page.getByTestId("purchase-discard-confirm")).toHaveCount(0);
    await page.keyboard.press("Control+b");
    await expect(page.getByTestId("picker-dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/purchase$/);
    await page.keyboard.press("Escape");
    await expect(quantity).toHaveValue("2");
    await page.getByRole("button", { name: "اختصارات لوحة المفاتيح" }).click();
    const help = page.getByRole("dialog", { name: "اختصارات لوحة المفاتيح" });
    await expect(help).toBeVisible();
    release();
    const invoice = await saved;
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/purchase$/);
    await expect(page.getByTestId("purchase-saved-number")).toContainText(invoice.invoiceNumber);
    const persisted = await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: invoice.id });
    expect(persisted.totalAmount).toBe(800);
    expect(persisted.lines[0]?.quantity).toBe(2);
    const items = await callRpc<{ items: Item[] }, object>(page, "itemsAll", {});
    expect(items.items.find((row) => row.id === item.id)?.stockOnHand).toBe(2);
    await page.keyboard.press("Control+n");
    await expect(page.getByTestId("sale-form")).toBeVisible();
  } finally {
    release();
    await saved?.catch(() => undefined);
    await page.unroute("**/api/rpc/invoicesCreate");
  }
});



test("failed pending purchase forgets blocked navigation and keeps its draft for a real retry", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف إعادة محاولة الشراء");
  const name = `شراء-إعادة-محاولة-${Date.now()}`;
  const item = await callRpc<Item, object>(page, "itemsCreate", {
    name, categoryId, costPrice: 400, sellingPrice: 1000,
  });
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await pick(page, name, "purchase");
  const quantity = page.getByTestId("purchase-lines").getByLabel(`${name}: الكمية`);
  await quantity.fill("2");

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  const pattern = "**/api/rpc/invoicesCreate";
  await page.route(pattern, async (route) => {
    reached();
    await held;
    // Fail at the transport boundary before the request reaches the real store.
    await route.abort("connectionfailed");
  });
  try {
    await page.getByTestId("purchase-save").click();
    await requested;
    await expect(page.getByTestId("purchase-save")).toBeDisabled();
    await page.keyboard.press("Control+n");
    await expect(page.getByTestId("purchase-discard-confirm")).toHaveCount(0);
    await page.getByRole("button", { name: "اختصارات لوحة المفاتيح" }).click();
    const help = page.getByRole("dialog", { name: "اختصارات لوحة المفاتيح" });
    await expect(help).toBeVisible();
    release();
    await expect(page.getByTestId("purchase-error")).toBeVisible();
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/purchase$/);
    await expect(quantity).toHaveValue("2");
    await expect(page.getByTestId("purchase-save")).toBeEnabled();
    const beforeRetry = await callRpc<{ items: Item[] }, object>(page, "itemsAll", {});
    expect(beforeRetry.items.find((row) => row.id === item.id)?.stockOnHand).toBe(0);

    await page.keyboard.press("Control+n");
    await expect(page.getByTestId("purchase-discard-confirm")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/purchase$/);
    await expect(quantity).toHaveValue("2");
    await page.unroute(pattern);
    const invoice = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("purchase-save").click());
    await expect(page.getByTestId("purchase-saved-number")).toContainText(invoice.invoiceNumber);
    const persisted = await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: invoice.id });
    expect(persisted.totalAmount).toBe(800);
    expect(persisted.lines[0]?.quantity).toBe(2);
    const afterRetry = await callRpc<{ items: Item[] }, object>(page, "itemsAll", {});
    expect(afterRetry.items.find((row) => row.id === item.id)?.stockOnHand).toBe(2);
    await page.keyboard.press("Control+n");
    await expect(page.getByTestId("sale-form")).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a browser-typed first sale character is protected by Ctrl+B and cancellation", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+n");
  const customer = page.getByTestId("sale-customer");
  await expect(customer).toBeEmpty();
  await customer.pressSequentially("x");
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
  await expect(page).toHaveURL(/\/sale$/);
  await expect(customer).toHaveValue("x");
  await page.keyboard.press("Escape");
  await expect(customer).toBeFocused();
  await customer.pressSequentially("y");
  await expect(customer).toHaveValue("xy");
});

test("cancelling purchase navigation restores the sale field without manual refocus", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+n");
  const customer = page.getByTestId("sale-customer");
  await expect(customer).toBeVisible();
  await customer.fill("مسودة ترجع إليها الكتابة");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(customer).toBeFocused();
  await expect(customer).toHaveValue("مسودة ترجع إليها الكتابة");
  await page.keyboard.type(" بعد الإلغاء");
  await expect(customer).toHaveValue("مسودة ترجع إليها الكتابة بعد الإلغاء");
});


test("a first sale edit and Ctrl+B in one browser task still asks before discarding", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();

  const customer = page.getByTestId("sale-customer");
  await expect(customer).toBeEmpty();
  await expect(page.getByTestId("sale-empty")).toBeVisible();
  const saleUrl = page.url();
  const customerName = "مسودة فورية";

  // No await separates the real input event from Ctrl+B. This same-task
  // synthetic sequence is stricter than ordinary physical key delivery.
  await page.evaluate((value) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="sale-customer"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (input === null || setter === undefined) throw new Error("sale-customer or native value setter is missing");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
  }, customerName);

  await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
  await expect(customer).toHaveValue(customerName);
  await expect(page).toHaveURL(saleUrl);
});


test("Ctrl+B in the sale-save click task cannot interrupt the pending sale", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف حفظ فوري");
  const name = `حفظ-فوري-${Date.now()}`;
  await callRpc<Item, object>(page, "itemsCreateWithStock", {
    name, categoryId, costPrice: 400, sellingPrice: 1000, stockOnHand: 1,
  });

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, name, "sale");
  const saleUrl = page.url();

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  await page.route("**/api/rpc/invoicesCreate", async (route) => {
    reached();
    await held;
    await route.continue();
  });

  let saved: Promise<InvoiceDetail> | undefined;
  try {
    saved = actAndAck<InvoiceDetail>(page, "invoicesCreate", async () => {
      // The save click and shortcut dispatch share one page task. The request
      // interception and disabled-state assertions happen only after this returns.
      await page.evaluate(() => {
        const save = document.querySelector<HTMLButtonElement>('[data-testid="sale-save"]');
        if (save === null) throw new Error("sale-save is missing");
        save.click();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
      });
    });
    void saved.catch(() => undefined);

    await requested;
    await expect(page.getByTestId("sale-save")).toBeDisabled();
    await expect(page).toHaveURL(saleUrl);
    await expect(page.getByTestId("new-sale-discard-confirm")).toHaveCount(0);

    release();
    const invoice = await saved;
    await expect(page.getByTestId("sale-saved-number")).toContainText(invoice.invoiceNumber);
    await expect(page).toHaveURL(saleUrl);
    await expect(page.getByTestId("new-sale-discard-confirm")).toHaveCount(0);
    expect(invoice.kind).toBe("SALE");
    expect(invoice.totalAmount).toBe(1000);
  } finally {
    release();
    await saved?.catch(() => undefined);
    await page.unroute("**/api/rpc/invoicesCreate");
  }
});

test("picker search does not mark an empty sale dirty", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();

  await page.getByTestId("sale-open-picker").click();
  const picker = page.getByTestId("picker-dialog");
  await picker.getByRole("combobox").fill("catalog lookup only");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("new-sale-discard-confirm")).toHaveCount(0);
  await expect(page.getByTestId("purchase-form")).toBeVisible();
});

test("an explicit sale quick-add category choice blocks Ctrl+B until reset", async ({ page }) => {
  await signIn(page);
  const suffix = Date.now().toString();
  await callRpc<{ id: string }, { name: string }>(page, "categoriesCreate", { name: `اختصار افتراضي ${suffix}` });
  await callRpc<{ id: string }, { name: string }>(page, "categoriesCreate", { name: `اختيار مختصر ${suffix}` });
  const categories = await callRpc<{ items: Array<{ id: string; name: string }> }, Record<string, never>>(
    page,
    "categoriesList",
    {},
  );
  expect(categories.items.length).toBeGreaterThan(1);
  const defaultCategory = categories.items[0];
  if (defaultCategory === undefined) throw new Error("categoriesList returned no category");
  const explicitCategory = categories.items.find((category) => category.id !== defaultCategory.id);
  if (explicitCategory === undefined) throw new Error("categoriesList returned no second category");

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  const saleUrl = page.url();
  await page.getByTestId("sale-quick-add").click();
  const quick = page.getByTestId("sale-quick-form");
  const category = page.getByTestId("sale-quick-category");
  await expect(quick).toBeVisible();
  await expect(category).toBeEnabled();
  await chooseSelectOption(page, category, explicitCategory.name);

  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
  await expect(page).toHaveURL(saleUrl);
  await page.keyboard.press("Escape");
  await expect(category).toContainText(explicitCategory.name);

  await quick.getByRole("button", { name: "إغلاق", exact: true }).click();
  await expect(quick).toHaveCount(0);
  await page.getByTestId("sale-quick-add").click();
  await expect(category).toContainText(defaultCategory.name);
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("new-sale-discard-confirm")).toHaveCount(0);
  await expect(page.getByTestId("purchase-form")).toBeVisible();
});

test("unknown scan create choice publishes barcode work before Ctrl+B", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();

  const saleUrl = page.url();
  const barcode = `SHORTCUT-UNKNOWN-${Date.now()}`;
  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create").click();
  const quick = page.getByTestId("sale-quick-form");
  const barcodeInput = page.getByTestId("sale-quick-barcode");
  await expect(page.getByTestId("unknown-scan-dialog")).toHaveCount(0);
  await expect(quick).toBeVisible();
  await expect(barcodeInput).toHaveValue(barcode);

  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
  await expect(page).toHaveURL(saleUrl);
});

test("New Sale confirmation cannot navigate while an invoice save is pending", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف تأكيد حفظ البيع");
  const name = `بيع-تأكيد-معلق-${Date.now()}`;
  await callRpc<Item, object>(page, "itemsCreateWithStock", {
    name, categoryId, costPrice: 400, sellingPrice: 1000, stockOnHand: 1,
  });

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, name, "sale");
  const saleUrl = page.url();
  await page.getByTestId("new-sale-button").click();
  const discard = page.getByTestId("new-sale-discard-confirm");
  await expect(discard).toBeVisible();

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  await page.route("**/api/rpc/invoicesCreate", async (route) => {
    reached();
    await held;
    await route.continue();
  });

  let saved: Promise<InvoiceDetail> | undefined;
  try {
    saved = actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error("sale-save is not a button");
      button.click();
    }));
    void saved.catch(() => undefined);
    await requested;
    await expect(page.getByTestId("sale-save")).toBeDisabled();

    await discard.click();
    await expect(discard).toBeVisible();
    await expect(page).toHaveURL(saleUrl);

    release();
    const invoice = await saved;
    await expect(page.getByTestId("sale-saved-number")).toContainText(invoice.invoiceNumber);
    await expect(page).toHaveURL(saleUrl);
    expect(invoice.kind).toBe("SALE");
    expect(invoice.totalAmount).toBe(1000);
    const persisted = await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: invoice.id });
    expect(persisted.totalAmount).toBe(1000);
  } finally {
    release();
    await saved?.catch(() => undefined);
    await page.unroute("**/api/rpc/invoicesCreate");
  }
});

test("a late invoice success cannot clear a new sale owner's draft after sidebar navigation", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف ملكية البيع");
  const name = `بيع-قديم-معلق-${Date.now()}`;
  await callRpc<Item, object>(page, "itemsCreateWithStock", {
    name, categoryId, costPrice: 400, sellingPrice: 1000, stockOnHand: 1,
  });

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, name, "sale");

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  const routePattern = "**/api/rpc/invoicesCreate";
  await page.route(routePattern, async (route) => {
    reached();
    await held;
    await route.continue();
  });

  let saved: Promise<InvoiceDetail> | undefined;
  try {
    saved = actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
    void saved.catch(() => undefined);
    await requested;

    // Sidebar navigation stays unguarded. This covers an old callback writing to a new owner.
    await page.getByRole("link", { name: "المشتريات" }).click();
    await expect(page.getByTestId("purchase-form")).toBeVisible();
    await page.getByRole("link", { name: "المبيعات" }).click();
    await expect(page.getByTestId("sale-form")).toBeVisible();
    const customer = page.getByTestId("sale-customer");
    await customer.fill("مسودة البيع الجديد");

    release();
    const invoice = await saved;
    expect(invoice.kind).toBe("SALE");
    expect(invoice.totalAmount).toBe(1000);
    await page.keyboard.press("Control+b");
    await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(customer).toHaveValue("مسودة البيع الجديد");
  } finally {
    release();
    await saved?.catch(() => undefined);
    await page.unroute(routePattern);
  }
});

test("same-task last-line removal keeps an invalid payment percentage guarded", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف نسبة الدفع");
  const name = `بيع-نسبة-غير-صالحة-${Date.now()}`;
  await callRpc<Item, object>(page, "itemsCreateWithStock", {
    name, categoryId, costPrice: 400, sellingPrice: 1000, stockOnHand: 1,
  });

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, name, "sale");
  await page.getByTestId("sale-paid-percentage").fill("12.5");
  await expect(page.getByTestId("sale-paid")).toHaveValue("");

  const saleUrl = page.url();
  await page.evaluate(() => {
    const remove = document.querySelector<HTMLButtonElement>('button[aria-label^="حذف"]');
    if (remove === null) throw new Error("sale line remove button is missing");
    remove.click();
    // Synthetic same-task ordering only; this does not prove physical WebView2 delivery.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
  });

  await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
  await expect(page).toHaveURL(saleUrl);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await expect(page.getByTestId("sale-lines")).toHaveCount(0);
});

test("sale quick-add inputs stay disabled while item create is pending", async ({ page }) => {
  await signIn(page);
  await seedCategoryId(page, "تصنيف إنشاء سريع معلق");
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-add").click();

  const quick = page.getByTestId("sale-quick-form");
  await expect(quick.getByTestId("sale-quick-category")).toBeEnabled();
  const name = `إنشاء-سريع-معلق-${Date.now()}`;
  const nameInput = quick.getByTestId("sale-quick-name");
  await nameInput.fill(name);
  await quick.locator('input[name="quickCost"]').fill("400");
  await quick.locator('input[name="quickSell"]').fill("1000");

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  const routePattern = "**/api/rpc/itemsCreate";
  await page.route(routePattern, async (route) => {
    reached();
    await held;
    await route.continue();
  });

  let created: Promise<Item> | undefined;
  try {
    created = actAndAck<Item>(page, "itemsCreate", () => quick.locator('button[type="submit"]').click());
    void created.catch(() => undefined);
    await requested;

    await expect(nameInput).toBeDisabled();
    await expect(quick).toHaveAttribute("aria-busy", "true");
    await expect(quick.getByTestId("sale-quick-barcode")).toBeDisabled();
    await expect(quick.locator('input[name="quickCost"]')).toBeDisabled();
    await expect(quick.locator('input[name="quickSell"]')).toBeDisabled();
    await expect(quick.getByTestId("sale-quick-stock")).toBeDisabled();
    await expect(quick.getByTestId("sale-quick-category")).toBeDisabled();
    await expect(quick.getByRole("button", { name: "إغلاق", exact: true })).toBeDisabled();

    release();
    const item = await created;
    await expect(quick).toHaveCount(0);
    await expect(page.getByTestId("sale-lines").getByLabel(`${name}: الكمية`)).toHaveAttribute(
      "name",
      `quantity-${item.id}`,
    );
  } finally {
    release();
    await created?.catch(() => undefined);
    await page.unroute(routePattern);
  }
});

test("sale quick-add refusal preserves the form and re-enables its dirty guard", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف رفض إنشاء سريع");
  const duplicateBarcode = `REFUSED-QUICK-${Date.now()}`;
  await callRpc<Item, object>(page, "itemsCreate", {
    name: `عنصر موجود-${Date.now()}`,
    categoryId,
    costPrice: 100,
    sellingPrice: 200,
    barcode: duplicateBarcode,
  });
  const selectedCategoryName = `تصنيف صريح رفض-${Date.now()}`;
  await callRpc<{ id: string }, { name: string }>(page, "categoriesCreate", { name: selectedCategoryName });

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-add").click();
  const quick = page.getByTestId("sale-quick-form");
  const nameInput = quick.getByTestId("sale-quick-name");
  const barcodeInput = quick.getByTestId("sale-quick-barcode");
  const categoryControl = quick.getByTestId("sale-quick-category");
  const costInput = quick.locator('input[name="quickCost"]');
  const sellInput = quick.locator('input[name="quickSell"]');
  const stockInput = quick.getByTestId("sale-quick-stock");
  const saveButton = quick.locator('button[type="submit"]');
  const closeButton = quick.getByRole("button", { name: "إغلاق", exact: true });
  const enteredName = `إنشاء مرفوض-${Date.now()}`;
  await nameInput.fill(enteredName);
  await barcodeInput.fill(duplicateBarcode);
  await chooseSelectOption(page, categoryControl, selectedCategoryName);
  await costInput.fill("400");
  await sellInput.fill("1000");
  await stockInput.fill("0");

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  const routePattern = "**/api/rpc/itemsCreate";
  await page.route(routePattern, async (route) => {
    reached();
    await held;
    await route.continue();
  });

  const refusal = waitForRpc(page, "itemsCreate");
  void refusal.catch(() => undefined);
  try {
    await saveButton.click();
    await requested;

    await expect(quick).toHaveAttribute("aria-busy", "true");
    await expect(nameInput).toBeDisabled();
    await expect(barcodeInput).toBeDisabled();
    await expect(categoryControl).toBeDisabled();
    await expect(costInput).toBeDisabled();
    await expect(sellInput).toBeDisabled();
    await expect(stockInput).toBeDisabled();
    await expect(saveButton).toBeDisabled();
    await expect(closeButton).toBeDisabled();
    await expect(page.getByTestId("sale-quick-add")).toBeDisabled();
    await page.getByTestId("sale-quick-add").evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error("sale-quick-add is not a button");
      button.click();
    });
    await expect(nameInput).toHaveValue(enteredName);

    release();
    const refusalResponse = await refusal;
    const refusalBody = await refusalResponse.json();
    console.log(`[issue-395-quick-add-refusal-raw] ${JSON.stringify({ status: refusalResponse.status(), body: refusalBody })}`);
    expect(refusalResponse.status()).toBe(409);
    expect(refusalBody).toEqual({
      json: { defined: false, code: "CONFLICT", status: 409, message: "BARCODE_EXISTS" },
    });

    await expect(quick).toHaveAttribute("aria-busy", "false");
    await expect(nameInput).toBeEnabled();
    await expect(barcodeInput).toBeEnabled();
    await expect(categoryControl).toBeEnabled();
    await expect(costInput).toBeEnabled();
    await expect(sellInput).toBeEnabled();
    await expect(stockInput).toBeEnabled();
    await expect(saveButton).toBeEnabled();
    await expect(closeButton).toBeEnabled();
    await expect(nameInput).toHaveValue(enteredName);
    await expect(barcodeInput).toHaveValue(duplicateBarcode);
    await expect(categoryControl).toContainText(selectedCategoryName);
    await expect(costInput).toHaveValue("400");
    await expect(sellInput).toHaveValue("1000");
    await expect(stockInput).toHaveValue("0");
    await expect(page.getByTestId("sale-error")).toBeVisible();

    await page.keyboard.press("Control+b");
    const discard = page.getByTestId("new-sale-discard-confirm");
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(discard).toHaveCount(0);
    await expect(nameInput).toHaveValue(enteredName);
    await expect(barcodeInput).toHaveValue(duplicateBarcode);
    await expect(categoryControl).toContainText(selectedCategoryName);
    await expect(costInput).toHaveValue("400");
    await expect(sellInput).toHaveValue("1000");
    await expect(stockInput).toHaveValue("0");

    await closeButton.click();
    await expect(quick).toHaveCount(0);
  } finally {
    release();
    await page.unroute(routePattern);
  }
});

test("invoice success preserves quick-add edits and asks before New Sale or Ctrl+B", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف حفظ مسودة سريعة");
  const itemName = `بيع-مسودة-سريعة-${Date.now()}`;
  await callRpc<Item, object>(page, "itemsCreateWithStock", {
    name: itemName, categoryId, costPrice: 400, sellingPrice: 1000, stockOnHand: 1,
  });

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, itemName, "sale");
  await page.getByTestId("sale-quick-add").click();
  const quick = page.getByTestId("sale-quick-form");
  const quickName = quick.getByTestId("sale-quick-name");
  const quickBarcode = quick.getByTestId("sale-quick-barcode");
  await quickName.fill("منتج غير مكتمل قبل الحفظ");
  await quick.locator('input[name="quickCost"]').fill("100");
  await quick.locator('input[name="quickSell"]').fill("200");

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const requested = new Promise<void>((resolve) => { reached = resolve; });
  const routePattern = "**/api/rpc/invoicesCreate";
  await page.route(routePattern, async (route) => {
    reached();
    await held;
    await route.continue();
  });

  let saved: Promise<InvoiceDetail> | undefined;
  try {
    saved = actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
    void saved.catch(() => undefined);
    await requested;
    await expect(quickName).toBeEnabled();
    await quickName.fill("منتج غير مكتمل أثناء الحفظ");
    await quickBarcode.fill("QUICK-DRAFT-395");

    release();
    const invoice = await saved;
    await expect(page.getByTestId("sale-saved-number")).toContainText(invoice.invoiceNumber);
    const discard = page.getByTestId("new-sale-discard-confirm");
    await page.getByTestId("new-sale-button").click();
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sale-saved")).toBeVisible();

    await page.getByTestId("sale-new").click();
    await expect(page.getByTestId("sale-form")).toBeVisible();
    await expect(quickName).toHaveValue("منتج غير مكتمل أثناء الحفظ");
    await expect(quickBarcode).toHaveValue("QUICK-DRAFT-395");
    await expect(quick.locator('input[name="quickCost"]')).toHaveValue("100");
    await expect(quick.locator('input[name="quickSell"]')).toHaveValue("200");

    await page.keyboard.press("Control+b");
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(quickName).toHaveValue("منتج غير مكتمل أثناء الحفظ");
    await expect(quickBarcode).toHaveValue("QUICK-DRAFT-395");
  } finally {
    release();
    await saved?.catch(() => undefined);
    await page.unroute(routePattern);
  }
});

test("a refused old invoice cannot clear a newer owner's pending quick-add", async ({ page }) => {
  await signIn(page);
  const categoryId = await seedCategoryId(page, "تصنيف رفض البيع القديم");
  const itemName = `بيع-رفض-قديم-${Date.now()}`;
  const oldItem = await callRpc<Item, object>(page, "itemsCreateWithStock", {
    name: itemName, categoryId, costPrice: 400, sellingPrice: 1000, stockOnHand: 1,
  });

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, itemName, "sale");
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`).fill("2");

  let releaseOld = () => {};
  const heldOld = new Promise<void>((resolve) => { releaseOld = resolve; });
  let reachedOld = () => {};
  const requestedOld = new Promise<void>((resolve) => { reachedOld = resolve; });
  const invoicePattern = "**/api/rpc/invoicesCreate";
  await page.route(invoicePattern, async (route) => {
    reachedOld();
    await heldOld;
    await route.continue();
  });
  const refusal = waitForRpc(page, "invoicesCreate");
  void refusal.catch(() => undefined);

  let releaseNew = () => {};
  const heldNew = new Promise<void>((resolve) => { releaseNew = resolve; });
  let reachedNew = () => {};
  const requestedNew = new Promise<void>((resolve) => { reachedNew = resolve; });
  const itemPattern = "**/api/rpc/itemsCreate";
  await page.route(itemPattern, async (route) => {
    reachedNew();
    await heldNew;
    await route.continue();
  });

  let created: Promise<Item> | undefined;
  try {
    await page.getByTestId("sale-save").click();
    await requestedOld;
    await page.getByRole("link", { name: "المشتريات" }).click();
    await expect(page.getByTestId("purchase-form")).toBeVisible();
    await page.getByRole("link", { name: "المبيعات" }).click();
    await expect(page.getByTestId("sale-form")).toBeVisible();
    const customer = page.getByTestId("sale-customer");
    await customer.fill("مسودة مع طلب جديد معلق");

    await page.getByTestId("sale-quick-add").click();
    const quick = page.getByTestId("sale-quick-form");
    const quickName = quick.getByTestId("sale-quick-name");
    const newName = `إنشاء-بعد-رفض-${Date.now()}`;
    await quickName.fill(newName);
    await quick.locator('input[name="quickCost"]').fill("100");
    await quick.locator('input[name="quickSell"]').fill("300");
    created = actAndAck<Item>(page, "itemsCreate", () => quick.locator('button[type="submit"]').click());
    void created.catch(() => undefined);
    await requestedNew;
    await expect(page.getByTestId("new-sale-button")).toBeDisabled();

    releaseOld();
    const refusalResponse = await refusal;
    const refusalBody = await refusalResponse.json();
    console.log(`[issue-395-stale-refusal-raw] ${JSON.stringify({ status: refusalResponse.status(), body: refusalBody })}`);
    expect(refusalResponse.ok()).toBe(false);
    const stockAfterRefusal = await callRpc<{ items: Item[] }, object>(page, "itemsAll", {});
    expect(stockAfterRefusal.items.find((item) => item.id === oldItem.id)?.stockOnHand).toBe(1);

    await expect(page.getByTestId("new-sale-button")).toBeDisabled();
    await page.keyboard.press("Control+b");
    await expect(page.getByTestId("sale-form")).toBeVisible();
    await expect(page.getByTestId("purchase-form")).toHaveCount(0);

    releaseNew();
    const createdItem = await created;
    await expect(quick).toHaveCount(0);
    await expect(page.getByTestId("sale-lines").getByLabel(`${newName}: الكمية`)).toHaveAttribute(
      "name",
      `quantity-${createdItem.id}`,
    );
    await expect(page.getByTestId("new-sale-button")).toBeEnabled();
    await page.keyboard.press("Control+b");
    await expect(page.getByTestId("new-sale-discard-confirm")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(customer).toHaveValue("مسودة مع طلب جديد معلق");
  } finally {
    releaseOld();
    releaseNew();
    await created?.catch(() => undefined);
    await page.unroute(invoicePattern);
    await page.unroute(itemPattern);
  }
});
