import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { actAndAck, callRpc, seedCategoryId } from "./rpc-helpers";
import { chooseSelectOption } from "./select-helpers";

const evidence = process.env.INVOICE_SEARCH_EVIDENCE;
test.use({ viewport: { width: 1920, height: 1080 } });
if (evidence) test.use({ video: { mode: "on", size: { width: 1920, height: 1080 } } });

test("invoice contents search retains historical names, resets paging and opens the exact invoice", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, { startPath: "/invoices", landingTestId: "invoices-page" });
  const categoryId = await seedCategoryId(page, "تصنيف بحث الفواتير");
  const item = await callRpc<{ id: string }, unknown>(page, "itemsCreate", { name: "الْإِطَار القديم", barcode: "BC-405", categoryId, costPrice: 100, sellingPrice: 150, lowStockThreshold: 0 });
  await callRpc(page, "invoicesCreate", { kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 20, unitPrice: 100 }] });
  const target = await callRpc<{ id: string; invoiceNumber: string }, unknown>(page, "invoicesCreate", { kind: "SALE", invoiceDate: "2020-01-01", lines: [{ itemId: item.id, quantity: 1 }, { itemId: item.id, quantity: 1 }] });
  await callRpc(page, "itemsUpdate", { id: item.id, name: "اسم جديد" });
  for (let i = 0; i < 11; i++) await callRpc(page, "invoicesCreate", { kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 1, unitPrice: 100 }] });
  await callRpc(page, "preferencesSet", { key: "ui.pageSize", value: "10" });
  await page.goto("/invoices");
  await expect(page.getByTestId("invoice-row")).toHaveCount(10);
  await expect(page.getByTestId(`invoice-open-${target.invoiceNumber}`)).toHaveCount(0);
  if (evidence) await page.getByTestId("invoices-page").screenshot({ path: `.scratch/implementation/405-${evidence}.png` });
  await page.getByTestId("invoices-pager-page-2").click();
  const search = page.getByRole("searchbox", { name: "بحث الفواتير" });
  await expect(search).toBeVisible();
  const pause = async (ms = 3000) => { if (evidence === "after") await page.waitForTimeout(ms); };
  await pause();
  await actAndAck(page, "invoicesList", () => search.fill("اطار"));
  await expect(page.getByTestId("invoice-row")).toHaveCount(2);
  await expect(page.getByTestId(`invoice-open-${target.invoiceNumber}`)).toHaveAttribute("href", `/invoices/${target.id}`);
  await pause();
  await chooseSelectOption(page, page.getByTestId("invoices-kind-filter"), "المبيعات");
  await chooseSelectOption(page, page.getByTestId("invoices-status-filter"), "غير مدفوعة");
  await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  await pause();
  await actAndAck(page, "invoicesList", () => search.fill("bc-405"));
  await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  await pause();
  await actAndAck(page, "invoicesList", () => search.fill(target.invoiceNumber));
  await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  await pause();
  await actAndAck(page, "invoicesList", () => search.fill("%_ ' OR 1=1 --"));
  await expect(page.getByTestId("invoices-empty")).toBeVisible();
  await pause();
  await page.getByTestId("invoices-empty-action").click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(page.getByTestId("invoice-row")).toHaveCount(10);
  await expect(page.getByTestId("invoices-pager-page-1")).toHaveAttribute("aria-current", "page");
  await pause();
  await search.fill("اطار");
  await expect(page.getByTestId("invoice-row")).toHaveCount(2);
  await page.getByTestId("invoices-search-clear").click();
  await expect(search).toBeFocused();
  await expect(page.getByTestId("invoice-row")).toHaveCount(10);
  await pause();
  await search.fill("اطار");
  await expect(page.getByTestId("invoice-row")).toHaveCount(2);
  await page.getByTestId(`invoice-open-${target.invoiceNumber}`).click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${target.id}$`));
  await expect(page.getByTestId("invoice-page")).toContainText("الْإِطَار القديم");
  await pause();
});

test("invoice search exposes loading and retry without losing the query", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, { startPath: "/invoices", landingTestId: "invoices-page" });
  await page.goto("/invoices");
  const search = page.getByRole("searchbox", { name: "بحث الفواتير" });
  await expect(search).toBeVisible();
  let release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/rpc/invoicesList", async route => {
    await blocked;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await search.fill("query-405-retry");
  await expect(page.getByRole("status")).toBeVisible();
  if (!release) throw new Error("Loading barrier was not initialized");
  release();
  await expect(page.getByTestId("invoices-error")).toBeVisible({ timeout: 15_000 });
  await expect(search).toHaveValue("query-405-retry");
  await page.unroute("**/api/rpc/invoicesList");
  await page.getByTestId("invoices-retry").click();
  await expect(page.getByTestId("invoices-empty")).toBeVisible();
  await expect(search).toHaveValue("query-405-retry");

  // Cancel an in-flight no-match search by clearing it. A late response must
  // not replace the unfiltered rows belonging to the new query key.
  let completeOld: (() => void) | undefined;
  let acknowledgeOld: (() => void) | undefined;
  let acknowledgeDelivery: (() => void) | undefined;
  const held = new Promise<void>(resolve => { completeOld = resolve; });
  const oldReady = new Promise<void>(resolve => { acknowledgeOld = resolve; });
  const oldDelivered = new Promise<void>(resolve => { acknowledgeDelivery = resolve; });
  await page.route("**/api/rpc/invoicesList", async route => {
    if (!route.request().postData()?.includes("missing-405-late")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    acknowledgeOld?.();
    await held;
    await route.fulfill({ response });
    acknowledgeDelivery?.();
  });
  await search.fill("missing-405-late");
  await expect(page.getByRole("status")).toBeVisible();
  await oldReady;
  await page.getByTestId("invoices-search-clear").click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  if (!completeOld) throw new Error("Cancellation barrier was not initialized");
  completeOld();
  // Query cancellation may abort the browser request, so observe the network
  // fixture's delivery, not a response event that an aborted fetch cannot emit.
  await oldDelivered;
  await expect(search).toHaveValue("");
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await expect(page.getByTestId("invoices-empty")).toHaveCount(0);
});
