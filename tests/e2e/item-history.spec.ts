import { expect, test, type Page } from "@playwright/test";
import type { Category, InvoiceDetail, Item, ItemHistoryInput, ItemHistoryMovement } from "../../packages/contracts/src/core";
import { signIn } from "./auth-helpers";

// Public authenticated RPC is the accepted fixture seam, not a database shortcut.
type HistorySeed =
  | { procedure: "categoriesList"; input: Record<string, never> }
  | { procedure: "itemsCreate"; input: { name: string; categoryId: string; costPrice: number; sellingPrice: number } }
  | { procedure: "stockAddManual"; input: { itemId: string; delta: number; unitCost?: number; kind?: "PURCHASE"; occurredAt?: string } }
  | { procedure: "invoicesCreate"; input: { kind: "SALE"; lines: Array<{ itemId: string; quantity: number }> } }
  | { procedure: "itemsUpdate"; input: { id: string; sellingPrice: number; costPrice: number } }
  | { procedure: "itemsHistory"; input: ItemHistoryInput };

async function rpc<T>(page: Page, request: HistorySeed): Promise<T> {
  const result = await page.evaluate(async (seed: HistorySeed) => {
    const response = await fetch(`/api/rpc/${seed.procedure}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: seed.input }) });
    if (!response.ok) throw new Error(`Seed ${seed.procedure}: HTTP ${response.status}`);
    // SAFETY: successful oRPC responses wrap their declared output in json.
    return await response.json() as { json: unknown };
  }, request);
  // SAFETY: each caller names the public RPC output for its fixture request.
  return result.json as T;
}

async function seedHistory(page: Page, name: string) {
  const { items: categories } = await rpc<{ items: Category[] }>(page, { procedure: "categoriesList", input: {} });
  const category = categories[0];
  if (!category) throw new Error("Missing seeded default category");
  const item = await rpc<Item>(page, { procedure: "itemsCreate", input: { name, categoryId: category.id, costPrice: 100, sellingPrice: 300 } });
  await rpc(page, { procedure: "stockAddManual", input: { itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE", occurredAt: "2025-01-01T10:00:00" } });
  await rpc(page, { procedure: "stockAddManual", input: { itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE", occurredAt: "2025-01-02T10:00:00" } });
  const invoice = await rpc<InvoiceDetail>(page, { procedure: "invoicesCreate", input: { kind: "SALE", lines: [{ itemId: item.id, quantity: 6 }] } });
  await rpc(page, { procedure: "itemsUpdate", input: { id: item.id, sellingPrice: 999, costPrice: 400 } });
  return { item, invoice };
}

test.use({ viewport: { width: 1920, height: 1080 }, video: { mode: "on", size: { width: 1920, height: 1080 } } });

test.describe("item history 399", () => {

  test("recorded details, collapse cancellation and stable invoice/products navigation", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const { item, invoice } = await seedHistory(page, "بطارية سجل 399");
    await page.goto(`/items/${item.id}/history`);
    await expect(page.getByTestId("history-table")).toBeVisible();
    const surface = page.locator("section").filter({ has: page.getByTestId("history-table") });
    if (process.env.HISTORY_399_BEFORE) await surface.screenshot({ path: ".scratch/evidence/399/before.png" });
    await expect(page.getByRole("heading", { name: item.name, exact: true })).toBeVisible();
    const sale = page.getByTestId("history-table").locator("tbody tr[data-testid^='history-movement-row-']").filter({ hasText: "-6" });
    await expect(sale.getByTestId("stock-after")).toHaveText("4");
    const disclosure = sale.getByRole("button");
    await disclosure.focus();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const detail = sale.locator("xpath=following-sibling::tr[1]");
    await expect(detail.getByTestId(/^history-selling-price-/)).toContainText("300");
    await expect(detail.getByTestId(/^history-cost-total-/)).toContainText("700");
    await expect(detail.getByTestId(/^history-sale-total-/)).toContainText("1,800");
    await page.keyboard.press("Space");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(detail).toBeHidden();
    await disclosure.focus();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    if (process.env.HISTORY_399_EVIDENCE) {
      await surface.screenshot({ path: ".scratch/evidence/399/after.png" });
      // Evidence-only reading time. This is not a correctness synchronization.
      await page.waitForTimeout(10_000);
    }
    await page.keyboard.press("Space");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(detail).toBeHidden();
    const saved = await rpc<{ total: number; stockOnHand: number; movements: ItemHistoryMovement[] }>(page, { procedure: "itemsHistory", input: { itemId: item.id } });
    expect(saved.total).toBe(4);
    expect(saved.stockOnHand).toBe(4);
    await disclosure.click();
    await detail.getByRole("link", { name: invoice.invoiceNumber, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/invoices/${invoice.id}$`));
    if (process.env.HISTORY_399_EVIDENCE) await page.waitForTimeout(7_000);
    await page.goBack();
    await expect(page.getByRole("heading", { name: item.name, exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "مسار المنتج" }).getByRole("link", { name: "المنتجات", exact: true }).click();
    await expect(page).toHaveURL(/\/items$/);
    if (process.env.HISTORY_399_EVIDENCE) await page.waitForTimeout(7_000);
  });

  test("failed history read is explicit, retry recovers, leaving a pending read is safe", async ({ page }) => {
    await signIn(page);
    test.setTimeout(60_000);
    const { item } = await seedHistory(page, "بطارية سجل فشل 399");
    await page.route("**/api/rpc/itemsHistory", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ json: { code: "INTERNAL_SERVER_ERROR", message: "history unavailable" } }) }));
    await page.goto(`/items/${item.id}/history`);
    await expect(page.getByRole("alert")).toContainText("تعذر تحميل سجل المنتج", { timeout: 15_000 });
    await page.unroute("**/api/rpc/itemsHistory");
    await page.getByRole("button", { name: "إعادة المحاولة" }).click();
    await expect(page.getByTestId("history-table")).toBeVisible();
    let release = () => {};
    let responseReady = () => {};
    let responseDelivered = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { responseReady = resolve; });
    const delivered = new Promise<void>((resolve) => { responseDelivered = resolve; });
    await page.route("**/api/rpc/itemsHistory", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      responseReady();
      await held;
      await route.fulfill({ response });
      responseDelivered();
    });
    try {
      await page.reload();
      await ready;
      await page.getByRole("navigation", { name: "مسار المنتج" }).getByRole("link", { name: "المنتجات", exact: true }).click();
      await expect(page).toHaveURL(/\/items$/);
      await expect(page.getByRole("table")).toBeVisible();
      release();
      await delivered;
      await expect(page.getByRole("table")).toBeVisible();
      await expect(page.getByTestId("history-table")).toHaveCount(0);
      await expect(page).toHaveURL(/\/items$/);
    } finally {
      release();
      await page.unroute("**/api/rpc/itemsHistory");
    }
    const saved = await rpc<{ stockOnHand: number; total: number }>(page, { procedure: "itemsHistory", input: { itemId: item.id } });
    expect(saved).toMatchObject({ stockOnHand: 4, total: 4 });
  });
});
