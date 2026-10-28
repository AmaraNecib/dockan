import { expect, test, type Page } from "@playwright/test";
import type { InvoiceDetail, Item } from "../../packages/contracts/src/core";
import { signIn } from "./auth-helpers";
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

  const customer = page.getByTestId("sale-customer");
  await customer.fill("مسودة الاختصار");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+n");
  const picker = page.getByTestId("picker-dialog");
  await expect(picker.getByPlaceholder("ابحث بالاسم أو الباركود…")).toBeFocused();
  await page.keyboard.press("Control+b");
  await expect(page).toHaveURL(/\/sale$/);
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(customer).toHaveValue("مسودة الاختصار");

  await customer.focus();
  await page.keyboard.press("Control+b");
  const discard = page.getByRole("dialog");
  await expect(discard).toBeVisible();
  await page.keyboard.press("Control+n");
  await page.keyboard.press("Escape");
  await expect(discard).toBeHidden();
  await expect(customer).toHaveValue("مسودة الاختصار");
  await customer.focus();
  await page.keyboard.press("Control+b");
  await page.getByTestId("new-sale-discard-confirm").click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();

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
  await page.getByTestId("purchase-lines").getByLabel(`${name}: الكمية`).fill("2");
  const purchase = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("purchase-save").click());
  await expect(page.getByTestId("purchase-saved-number")).toContainText(purchase.invoiceNumber);
  expect(purchase.kind).toBe("PURCHASE");
  expect(purchase.totalAmount).toBe(800);
  const storedPurchase = await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: purchase.id });
  expect(storedPurchase.lines[0]?.quantity).toBe(2);

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await pick(page, name, "sale");
  const quantity = page.getByTestId("sale-lines").getByLabel(`${name}: الكمية`);
  await quantity.fill("3");
  const refusal = waitForRpc(page, "invoicesCreate");
  await page.getByTestId("sale-save").click();
  expect((await refusal).ok()).toBe(false);
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
  try {
    const saved = actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
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
    await page.unroute("**/api/rpc/invoicesCreate");
  }
});
