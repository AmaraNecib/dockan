import { expect, test, type Locator, type Page } from "@playwright/test";
import type { InvoiceDetail, Item } from "../../packages/contracts/src";
import { signIn } from "./auth-helpers";
import { actAndAck, callRpc, seedCategoryId } from "./rpc-helpers";
import { chooseSelectOption } from "./select-helpers";

let barcodeSequence = 0;

function freshBarcode() {
  return `${Date.now().toString().slice(-10)}${String(++barcodeSequence).padStart(2, "0")}`;
}

const evidence = process.env.PRICE_EVIDENCE === "1";
test.use({ viewport: { width: 1920, height: 1080 }, video: evidence ? { mode: "on", size: { width: 1920, height: 1080 } } : "off" });

async function choosePriceMode(group: Locator, mode: "AMOUNT" | "PERCENTAGE") {
  await group.getByText(mode === "AMOUNT" ? "دج" : "%", { exact: true }).click();
}

async function scan(page: Page, barcode: string) {
  await page.getByTestId("sale-open-picker").focus();
  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");
}

async function expectDiscountControlsCollapsed(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "إضافة خصم", exact: true })).toBeVisible();
  await expect(page.getByTestId("sale-discount-type")).toHaveCount(0);
  await expect(page.getByTestId("sale-discount-value")).toHaveCount(0);
}

async function openDiscountControls(page: Page): Promise<void> {
  const discountType = page.getByTestId("sale-discount-type");
  if (!(await discountType.isVisible())) {
    const addDiscount = page.getByRole("button", { name: "إضافة خصم", exact: true });
    await expect(addDiscount).toBeVisible();
    await addDiscount.click();
  }
  await expect(discountType).toBeVisible();
  await expect(page.getByTestId("sale-discount-value")).toBeVisible();
}

async function fixture(page: Page, sellingPrice = 333) {
  const categoryId = await seedCategoryId(page, "أسعار البيع");
  const barcode = freshBarcode();
  const item = await callRpc<Item, object>(page, "itemsCreateWithStock", { name: evidence ? "مصباح أمامي" : `مصباح-${barcode}`, barcode, categoryId, costPrice: 100, sellingPrice, stockOnHand: 20 });
  await page.goto("/sale");
  await scan(page, barcode);
  await expect(page.getByTestId("sale-lines")).toContainText(item.name);
  await expectDiscountControlsCollapsed(page);
  return { item, barcode };
}

test("effective sale price: exact persisted amounts, percentages, reset, retry and immutable history (#397)", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page);
  const { item, barcode } = await fixture(page);
  const lines = page.getByTestId("sale-lines");
  const value = lines.getByLabel(`${item.name}: قيمة تعديل السعر`);
  const mode = lines.getByLabel(`${item.name}: نوع تعديل السعر`);
  const amountRadio = mode.getByRole("radio", { name: `${item.name}: دينار جزائري (دج)` });
  const percentageRadio = mode.getByRole("radio", { name: `${item.name}: نسبة مئوية` });
  await amountRadio.focus();
  await expect(amountRadio).toBeFocused();
  const amountSegment = await mode.getByText("دج", { exact: true }).boundingBox();
  const percentageSegment = await mode.getByText("%", { exact: true }).boundingBox();
  if (amountSegment === null || percentageSegment === null) throw new Error("missing visible sale price segment");
  expect(amountSegment.x).toBeGreaterThan(percentageSegment.x);
  await page.keyboard.press("ArrowLeft");
  await expect(percentageRadio).toBeChecked();
  await expect(percentageRadio).toBeFocused();
  if (process.env.PRICE_BEFORE === "1") await lines.locator("tbody tr").first().locator("td").nth(3).screenshot({ path: ".scratch/evidence/397/before-price.png" });
  await choosePriceMode(mode, "AMOUNT");
  await expect(value).toHaveValue("333");
  await expect(value).toHaveAttribute("dir", "ltr");
  await value.fill("٣٠١");
  await expect(page.getByTestId("sale-total")).toContainText("301");
  // 301 cannot be represented by an integer percent of 333. Refuse instead of changing money.
  await choosePriceMode(mode, "PERCENTAGE");
  await expect(value).toHaveValue("٣٠١");
  await expect(lines.getByRole("alert")).toContainText("دون تغيير السعر");
  await expect(amountRadio).toBeChecked();
  await expect(percentageRadio).not.toBeChecked();
  await expect(amountRadio).toBeFocused();
  await lines.getByTestId("sale-price-reset").click();
  await expect(lines.getByTestId("sale-price-reset")).toBeFocused();
  await expect(value).not.toBeFocused();
  await expect(value).toHaveValue("333");
  await choosePriceMode(mode, "PERCENTAGE");
  await expect(value).toHaveValue("100");
  await value.fill("٨٠");
  await expect(page.getByTestId("sale-total")).toContainText("266");
  await choosePriceMode(mode, "AMOUNT");
  await expect(value).toHaveValue("266");
  await choosePriceMode(mode, "PERCENTAGE");
  await expect(value).toHaveValue("٨٠");
  for (const invalid of ["", "-1", "101", "NaN", "12.5"]) {
    await value.fill(invalid);
    await page.getByTestId("sale-save").click();
    await expect(page.getByTestId("sale-error")).toContainText("أدخل تعديلاً صحيحاً للسعر");
    await expect(page.getByTestId("sale-saved")).toHaveCount(0);
  }
  await value.fill("80");
  await openDiscountControls(page);
  await chooseSelectOption(page, page.getByTestId("sale-discount-type"), "نسبة مئوية");
  await page.getByTestId("sale-discount-value").fill("10");
  await lines.getByLabel(`${item.name}: الكمية`).fill("21");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-error")).toContainText("الكمية غير متوفرة");
  await expect(value).toHaveValue("80");
  await lines.getByLabel(`${item.name}: الكمية`).fill("3");
  const saved = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
  expect(saved.subtotalAmount).toBe(798);
  expect(saved.discountAmount).toBe(80);
  expect(saved.totalAmount).toBe(718);
  expect(saved.lines[0]).toMatchObject({ defaultUnitPrice: 333, unitPrice: 266, quantity: 3, total: 798, cogsExact: 300, netTotal: 718 });
  const reopened = await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: saved.id });
  expect(reopened).toEqual(saved);
  await page.goto(`/invoices/${saved.id}`);
  await expect(page.getByTestId("invoice-page")).toContainText("718");
  await callRpc(page, "itemsUpdate", { id: item.id, sellingPrice: 500 });
  expect((await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: saved.id })).lines[0]).toEqual(saved.lines[0]);
  // Only the mode survives navigation. This customer's transaction value never does.
  await page.goto("/sale");
  await scan(page, barcode);
  await expectDiscountControlsCollapsed(page);
  await expect(value).toHaveValue("100");
  await expect(page.getByTestId("sale-total")).toContainText("500");
  await value.fill("50");
  await lines.getByTestId("sale-price-reset").click();
  await expect(value).toHaveValue("100");
  const resetSaved = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
  expect(resetSaved.totalAmount).toBe(500);
  expect(resetSaved.lines[0]).toMatchObject({ defaultUnitPrice: 500, unitPrice: 500, quantity: 1, total: 500 });
  await testInfo.attach("persisted-sale", { body: JSON.stringify({ saved, resetSaved }, null, 2), contentType: "application/json" });
});

test("resetting a sale price leaves keyboard barcode scans out of the price editor (#397)", async ({ page }) => {
  await signIn(page);
  const { item } = await fixture(page, 333);
  const barcode = freshBarcode();
  const barcodeItem = await callRpc<Item, object>(page, "itemsCreateWithStock", {
    name: `Short barcode ${barcode}`, barcode, categoryId: await seedCategoryId(page, "أسعار البيع"),
    costPrice: 100, sellingPrice: 250, stockOnHand: 20,
  });
  const lines = page.getByTestId("sale-lines");
  const originalPrice = lines.getByLabel(`${item.name}: قيمة تعديل السعر`);
  await choosePriceMode(lines.getByLabel(`${item.name}: نوع تعديل السعر`), "AMOUNT");
  await originalPrice.fill("301");
  const reset = lines.getByTestId("sale-price-reset");
  await reset.click();
  await expect(reset).toBeFocused();
  await expect(originalPrice).not.toBeFocused();

  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");

  await expect(lines).toContainText(barcodeItem.name);
  await expect(originalPrice).toHaveValue("333");
  await expect(lines.getByLabel(`${item.name}: الكمية`)).toHaveValue("1");
  const saved = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
  expect(saved.lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ defaultUnitPrice: 333, unitPrice: 333, quantity: 1 }),
    expect.objectContaining({ defaultUnitPrice: 250, unitPrice: 250, quantity: 1 }),
  ]));
});

test("effective sale price: cancellation, explicit zero and catalogue changes preserve amount meaning (#397)", async ({ page }) => {
  await signIn(page);
  const { item, barcode } = await fixture(page, 1000);
  const lines = page.getByTestId("sale-lines");
  const value = lines.getByLabel(`${item.name}: قيمة تعديل السعر`);
  await choosePriceMode(lines.getByLabel(`${item.name}: نوع تعديل السعر`), "AMOUNT");
  await value.fill("875");
  await page.getByTestId("new-sale-button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "إغلاق" }).click();
  await expect(value).toHaveValue("875");
  await page.getByTestId("new-sale-button").click();
  await page.getByTestId("new-sale-discard-confirm").click();
  await expect(page.getByTestId("sale-empty")).toBeVisible();
  await scan(page, barcode);
  await expectDiscountControlsCollapsed(page);
  await expect(value).toHaveValue("1000");
  await value.fill("900");
  // A scan while a mode radio has focus adds quantity without changing the edited price or saving.
  // The same barcode was just scanned; let the documented 1200ms duplicate guard expire.
  await page.waitForTimeout(1300);
  await lines.getByRole("radio", { name: `${item.name}: دينار جزائري (دج)` }).focus();
  // Exceed CI's 250 ms VITE_SCAN_MAX_GAP_MS so editable-target handling would clear the buffer.
  await page.keyboard.type(barcode, { delay: 300 });
  await page.keyboard.press("Enter");
  await expect(lines.getByLabel(`${item.name}: الكمية`)).toHaveValue("2");
  await expect(value).toHaveValue("900");
  await expect(page.getByTestId("sale-saved")).toHaveCount(0);
  await callRpc(page, "itemsUpdate", { id: item.id, sellingPrice: 1200 });
  await openDiscountControls(page);
  await chooseSelectOption(page, page.getByTestId("sale-discount-type"), "مبلغ");
  await page.getByTestId("sale-discount-value").fill("100");
  const saved = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
  expect(saved.totalAmount).toBe(1700);
  expect(saved.lines[0]).toMatchObject({ defaultUnitPrice: 1200, unitPrice: 900, quantity: 2, total: 1800, netTotal: 1700 });
  await page.goto("/sale");
  await scan(page, barcode);
  await expect(value).toHaveValue("1200");
  await value.fill("٠");
  const zero = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
  expect(zero.totalAmount).toBe(0);
  expect(zero.lines[0]).toMatchObject({ defaultUnitPrice: 1200, unitPrice: 0, total: 0 });
  expect((await callRpc<InvoiceDetail, object>(page, "invoicesGet", { id: zero.id })).totalAmount).toBe(0);
});

if (evidence) test("sale page approval evidence: light, dark and mobile", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.evaluate(() => localStorage.setItem("theme", "light"));
  await callRpc(page, "preferencesSet", { key: "ui.sale.priceMode", value: "PERCENTAGE" });
  const { item } = await fixture(page, 7_500);
  await page.setViewportSize({ width: 1440, height: 960 });

  const lines = page.getByTestId("sale-lines");
  const value = lines.getByLabel(`${item.name}: قيمة تعديل السعر`);
  await expect(lines.getByRole("radio", { name: `${item.name}: نسبة مئوية` })).toBeChecked();
  await expect(value).toHaveValue("100");
  await expect(page.locator("html")).toHaveClass(/light/);
  await value.fill("80");
  await expect(page.getByTestId("sale-total")).toContainText("6,000");
  await expect(page.getByTestId("sale-lines")).toContainText("7,500");
  await page.waitForTimeout(900);
  await page.screenshot({ path: ".scratch/evidence/sale-page/light-desktop.png" });

  await page.getByRole("button", { name: "المظهر" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.waitForTimeout(900);
  await page.screenshot({ path: ".scratch/evidence/sale-page/dark-desktop.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "توسيع / طي الشريط الجانبي" }).click();
  await expect(page.getByTestId("sale-save")).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: ".scratch/evidence/sale-page/dark-mobile.png", fullPage: true });
});

if (evidence) test("price editor user journey at reading pace (#397 evidence)", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page);
  const { item } = await fixture(page, 1000);
  const lines = page.getByTestId("sale-lines");
  const value = lines.getByLabel(`${item.name}: قيمة تعديل السعر`);
  const mode = lines.getByLabel(`${item.name}: نوع تعديل السعر`);
  const pause = () => page.waitForTimeout(2500);
  await choosePriceMode(mode, "AMOUNT");
  await expect(value).toHaveValue("1000");
  await lines.locator("tbody tr td").nth(3).screenshot({ path: ".scratch/evidence/397/after-price.png" });
  await pause();
  await value.fill("800");
  await pause();
  await choosePriceMode(mode, "PERCENTAGE");
  await pause();
  await value.fill("75");
  await pause();
  await value.fill("");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-error")).toContainText("أدخل تعديلاً صحيحاً للسعر");
  await pause();
  await lines.getByTestId("sale-price-reset").click();
  await pause();
  await choosePriceMode(mode, "AMOUNT");
  await value.fill("900");
  await openDiscountControls(page);
  await chooseSelectOption(page, page.getByTestId("sale-discount-type"), "مبلغ");
  await page.getByTestId("sale-discount-value").fill("100");
  await expect(page.getByTestId("sale-total")).toContainText("800");
  await pause();
  const saved = await actAndAck<InvoiceDetail>(page, "invoicesCreate", () => page.getByTestId("sale-save").click());
  expect(saved.totalAmount).toBe(800);
  await pause();
  await page.getByTestId("sale-open-invoice").click();
  await expect(page.getByTestId("invoice-page")).toContainText("800");
  await pause();
  await testInfo.attach("saved-evidence-invoice", { body: JSON.stringify(saved, null, 2), contentType: "application/json" });
});
