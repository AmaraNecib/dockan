import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { callRpc, seedCategoryId } from "./rpc-helpers";
import { chooseSelectOption } from "./select-helpers";

const evidence = process.env.INVOICE_SEARCH_EVIDENCE;

async function searchAndAck(page: Page, search: Locator, value: string) {
  const expected = value.trim();
  const response = page.waitForResponse((candidate) => {
    if (candidate.request().method() !== "POST" || !candidate.url().includes("/api/rpc/invoicesList")) return false;
    try {
      // SAFETY: invoicesList requests use the shared oRPC `{ json: input }` envelope.
      const body = candidate.request().postDataJSON() as { json?: { search?: unknown } };
      return body.json?.search === expected;
    } catch {
      return false;
    }
  });
  await search.fill(value);
  const result = await response;
  expect(result.ok(), `invoice search ${JSON.stringify(expected)} failed with HTTP ${result.status()}`).toBe(true);
}
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
  const initialList = page.waitForResponse(response => response.url().includes("invoicesList"));
  await page.goto("/invoices");
  expect((await initialList).status()).toBe(200);
  await expect(page.getByTestId("invoice-row")).toHaveCount(10);
  await expect(page.getByTestId(`invoice-open-${target.invoiceNumber}`)).toHaveCount(0);
  if (evidence) await page.getByTestId("invoices-page").screenshot({ path: `.scratch/implementation/405-${evidence}.png` });
  await page.getByTestId("invoices-pager-page-2").click();
  const search = page.getByRole("searchbox", { name: "بحث الفواتير" });
  await expect(search).toBeVisible();
  const pause = async (ms = 3000) => { if (evidence === "after") await page.waitForTimeout(ms); };
  await pause();
  await searchAndAck(page, search, "اطار");
  await expect(page.getByTestId("invoice-row")).toHaveCount(2);
  await expect(page.getByTestId(`invoice-open-${target.invoiceNumber}`)).toHaveAttribute("href", `/invoices/${target.id}`);
  await pause();
  await chooseSelectOption(page, page.getByTestId("invoices-kind-filter"), "المبيعات");
  await chooseSelectOption(page, page.getByTestId("invoices-status-filter"), "غير مدفوعة");
  await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  await pause();
  await searchAndAck(page, search, "bc-405");
  await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  await pause();
  await searchAndAck(page, search, target.invoiceNumber);
  await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  await pause();
  await searchAndAck(page, search, "%_ ' OR 1=1 --");
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
  const categoryId = await seedCategoryId(page, "تصنيف عزل التحميل");
  const item = await callRpc<{ id: string }, unknown>(page, "itemsCreate", { name: "صنف عزل التحميل", barcode: "FIXTURE-ISO-A", categoryId, costPrice: 100, sellingPrice: 150, lowStockThreshold: 0 });
  const fixture = await callRpc<{ id: string; invoiceNumber: string }, unknown>(page, "invoicesCreate", { kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 1, unitPrice: 100 }] });
  let initialRouteEntered = false;
  let releaseInitialList: (() => void) | undefined;
  const initialListHeld = new Promise<void>(resolve => { releaseInitialList = resolve; });
  await page.route("**/api/rpc/invoicesList", async route => {
    initialRouteEntered = true;
    await initialListHeld;
    await route.continue();
  });
  const initialList = page.waitForResponse(response => response.url().includes("invoicesList"));
  const navigation = page.goto("/invoices");
  await expect.poll(() => initialRouteEntered).toBe(true);
  await expect(page.getByRole("status")).toHaveCount(0);
  releaseInitialList?.();
  await navigation;
  expect((await initialList).status()).toBe(200);
  await page.unroute("**/api/rpc/invoicesList");
  const search = page.getByRole("searchbox", { name: "بحث الفواتير" });
  await expect(search).toBeVisible();
  let release: (() => void) | undefined;
  let retryRouteEntered = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/rpc/invoicesList", async route => {
    retryRouteEntered = true;
    await blocked;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  try {
    await search.fill("query-405-retry");
    await expect.poll(() => retryRouteEntered).toBe(true);
    await expect(page.getByRole("status")).toBeVisible();
  } finally {
    release?.();
  }
  await expect(page.getByTestId("invoices-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("invoices-error").getByRole("alert")).toHaveText("تعذّر تحميل السجل، تحقق من الاتصال");
  await expect(search).toHaveValue("query-405-retry");
  await page.unroute("**/api/rpc/invoicesList");
  await page.getByTestId("invoices-retry").click();
  await expect(page.getByTestId("invoices-empty")).toBeVisible();
  await expect(search).toHaveValue("query-405-retry");

  // Revisit the cached empty search while a fresh response is held.
  await searchAndAck(page, search, "query-405-other");
  await expect(page.getByTestId("invoices-empty")).toBeVisible();
  let releaseCached: (() => void) | undefined;
  let cachedRouteEntered = false;
  let cachedDelivered = false;
  let cachedRouteError: unknown;
  const cachedHeld = new Promise<void>(resolve => { releaseCached = resolve; });
  await page.route("**/api/rpc/invoicesList", async route => {
    if (!route.request().postData()?.includes("query-405-retry")) {
      await route.continue();
      return;
    }
    cachedRouteEntered = true;
    try {
      const response = await route.fetch();
      await cachedHeld;
      await route.fulfill({ response });
    } catch (error) {
      cachedRouteError = error;
    } finally {
      cachedDelivered = true;
    }
  });
  try {
    await search.fill("query-405-retry");
    await expect.poll(() => cachedRouteEntered).toBe(true);
    await expect(page.getByRole("status", { name: "جارٍ تحميل الفواتير" })).toBeVisible();
    await expect(page.getByTestId("invoices-empty")).toBeVisible();
  } finally {
    releaseCached?.();
  }
  await expect.poll(() => cachedDelivered).toBe(true);
  expect(cachedRouteError).toBeUndefined();
  await expect(page.getByRole("status", { name: "جارٍ تحميل الفواتير" })).toHaveCount(0);
  await page.unroute("**/api/rpc/invoicesList");

  // Cancel an in-flight no-match search by clearing it. A late response must
  // not replace the unfiltered rows belonging to the new query key.
  let completeOld: (() => void) | undefined;
  let acknowledgeOld: (() => void) | undefined;
  let acknowledgeDelivery: (() => void) | undefined;
  let oldFetchError: unknown;
  let oldFulfillError: unknown;
  const held = new Promise<void>(resolve => { completeOld = resolve; });
  const oldReady = new Promise<void>(resolve => { acknowledgeOld = resolve; });
  const oldDelivered = new Promise<void>(resolve => { acknowledgeDelivery = resolve; });
  await page.route("**/api/rpc/invoicesList", async route => {
    if (!route.request().postData()?.includes("missing-405-late")) {
      await route.continue();
      return;
    }
    let response: Awaited<ReturnType<typeof route.fetch>> | undefined;
    try {
      response = await route.fetch();
    } catch (error) {
      oldFetchError = error;
    } finally {
      acknowledgeOld?.();
    }
    if (!response) {
      acknowledgeDelivery?.();
      return;
    }
    await held;
    try {
      await route.fulfill({ response });
    } catch (error) {
      oldFulfillError = error;
    } finally {
      acknowledgeDelivery?.();
    }
  });
  try {
    await search.fill("missing-405-late");
    await oldReady;
    expect(oldFetchError).toBeUndefined();
    await expect(page.getByRole("status", { name: "جارٍ تحميل الفواتير" })).toBeVisible();
    await page.getByTestId("invoices-search-clear").click();
    await expect(page.getByTestId("invoices-table")).toBeVisible();
    await expect(page.getByTestId(`invoice-open-${fixture.invoiceNumber}`)).toHaveAttribute("href", `/invoices/${fixture.id}`);
  } finally {
    completeOld?.();
  }
  // Query cancellation may abort the browser request, so observe the network
  // fixture's delivery, not a response event that an aborted fetch cannot emit.
  await oldDelivered;
  expect(oldFulfillError).toBeUndefined();
  await expect(search).toHaveValue("");
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await expect(page.getByTestId(`invoice-open-${fixture.invoiceNumber}`)).toHaveAttribute("href", `/invoices/${fixture.id}`);
  await expect(page.getByTestId("invoices-empty")).toHaveCount(0);
  await page.unroute("**/api/rpc/invoicesList");

  // A late matching response must not replace a newer no-match result.
  let releaseMatching: (() => void) | undefined;
  let matchingRouteEntered = false;
  let matchingFetchSucceeded = false;
  let matchingDelivered = false;
  let matchingRouteError: unknown;
  const matchingHeld = new Promise<void>(resolve => { releaseMatching = resolve; });
  await page.route("**/api/rpc/invoicesList", async route => {
    if (!route.request().postData()?.includes("FIXTURE-ISO-A")) {
      await route.continue();
      return;
    }
    matchingRouteEntered = true;
    try {
      const response = await route.fetch();
      matchingFetchSucceeded = true;
      await matchingHeld;
      await route.fulfill({ response });
    } catch (error) {
      matchingRouteError = error;
    } finally {
      matchingDelivered = true;
    }
  });
  try {
    await search.fill("FIXTURE-ISO-A");
    await expect.poll(() => matchingRouteEntered).toBe(true);
    expect(matchingFetchSucceeded).toBe(true);
    await searchAndAck(page, search, "newer-no-match-405");
    await expect(page.getByTestId("invoices-empty")).toBeVisible();
    releaseMatching?.();
    await expect.poll(() => matchingDelivered).toBe(true);
    expect(matchingRouteError).toBeUndefined();
    await expect(page.getByTestId("invoices-empty")).toBeVisible();
    await expect(page.getByTestId("invoice-row")).toHaveCount(0);
  } finally {
    releaseMatching?.();
  }
});
