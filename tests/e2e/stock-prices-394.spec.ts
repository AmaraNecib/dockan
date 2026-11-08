import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { openItemsTab } from "./items-helpers";

test.use({ video: "on" });

type SeedRequest =
  | { procedure: "categoriesList"; input: Record<string, never> }
  | { procedure: "itemsCreate"; input: { name: string; categoryId: string; costPrice: number; sellingPrice: number; lowStockThreshold: number } }
  | { procedure: "itemsAll"; input?: Record<string, never> };

async function rpc<T>(page: Page, request: SeedRequest): Promise<T> {
  const result = await page.evaluate(async ({ procedure, input }: SeedRequest) => {
    const response = await fetch(`/api/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input ?? {} }),
    });
    if (!response.ok) throw new Error(`${procedure} failed with HTTP ${response.status}`);
    // SAFETY: the RPC success envelope has one `json` value; the caller binds its procedure output below.
    const answer = (await response.json()) as { json: unknown };
    return answer.json;
  }, request);
  // SAFETY: each test call supplies T for the named procedure's declared output.
  return result as T;
}

test("stock entry searches all items and saves both prices without losing a failed draft", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const evidenceDir = path.resolve(process.cwd(), ".scratch/evidence/394");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const suffix = Date.now().toString();
  await signIn(page);
  const categories = await rpc<{ items: Array<{ id: string }> }>(page, { procedure: "categoriesList", input: {} });
  const categoryId = categories.items[0]?.id;
  if (categoryId === undefined) throw new Error("The seeded store has no category");
  for (let index = 0; index < 55; index++) {
    await rpc(page, {
      procedure: "itemsCreate",
      input: { name: `394-catalog-${suffix}-${String(index).padStart(2, "0")}`, categoryId, costPrice: 100, sellingPrice: 200, lowStockThreshold: 0 },
    });
  }
  const itemName = `آلات التخزين 394-${suffix}`;
  await rpc(page, {
    procedure: "itemsCreate",
    input: { name: itemName, categoryId, costPrice: 100, sellingPrice: 250, lowStockThreshold: 0 },
  });

  await page.goto("/items");
  await openItemsTab(page, "add");
  const form = page.getByTestId("stock-form");
  const picker = page.getByTestId("stock-item");
  await picker.fill(`الات التخزين 394-${suffix}`);
  await expect(page.getByRole("option", { name: itemName, exact: true })).toBeVisible();
  await picker.press("ArrowDown");
  await picker.press("Enter");
  await expect(picker).toHaveValue(itemName);

  const sellingPriceControl = page.getByTestId("stock-selling-price");
  const canEditSellingPrice = await sellingPriceControl.evaluate((element) => element instanceof HTMLInputElement);
  if (!canEditSellingPrice) {
    await form.screenshot({ path: path.join(evidenceDir, "before.png") });
    return; // baseline capture stops at the pre-issue read-only price.
  }

  let stockRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/rpc/stockAddManual")) stockRequests += 1;
  });
  await picker.fill("no matching item");
  await picker.press("Escape");
  await expect(picker).toHaveValue(itemName);
  await expect(page.getByTestId("stock-delta")).toHaveValue("");
  expect(stockRequests).toBe(0);

  await page.getByTestId("stock-delta").fill("3");
  await page.getByTestId("stock-unit-cost").fill("140");
  await page.getByTestId("stock-selling-price").fill("375");
  await form.screenshot({ path: path.join(evidenceDir, "after.png") });

  await page.route("**/api/rpc/stockAddManual", (route) => route.abort(), { times: 1 });
  await page.getByTestId("stock-save").click();
  await expect(page.getByTestId("stock-error")).toBeVisible();
  await expect(page.getByTestId("stock-delta")).toHaveValue("3");
  await expect(page.getByTestId("stock-unit-cost")).toHaveValue("140");
  await expect(page.getByTestId("stock-selling-price")).toHaveValue("375");
  expect(stockRequests).toBe(1);
  await page.unroute("**/api/rpc/stockAddManual");

  await page.getByTestId("stock-save").click();
  await expect(page.getByTestId("stock-done")).toBeVisible();
  expect(stockRequests).toBe(2);
  const saved = await rpc<{ items: Array<{ id: string; name: string; stockOnHand: number; costPrice: number; sellingPrice: number }> }>(page, {
    procedure: "itemsAll",
  });
  expect(saved.items.find((item) => item.name === itemName)).toMatchObject({ stockOnHand: 3, costPrice: 140, sellingPrice: 375 });

  await expect(page.getByTestId("stock-selling-price")).toHaveValue("375");
  await page.getByTestId("stock-delta").fill("4");
  await page.getByTestId("stock-unit-cost").fill("150");
  await page.getByTestId("stock-selling-price").fill("400");
  // Commit through the real API, then hide its response from the form.
  await page.route("**/api/rpc/stockAddManual", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort();
  }, { times: 1 });
  await page.getByTestId("stock-save").click();
  await expect(page.getByTestId("stock-error")).toBeVisible();
  await expect(page.getByTestId("stock-new-entry")).toHaveCount(0);
  await page.unroute("**/api/rpc/stockAddManual");
  await page.getByTestId("stock-save").click();
  await expect(page.getByTestId("stock-new-entry")).toBeVisible();
  await expect(page.getByTestId("stock-delta")).toHaveValue("4");
  const afterRetry = await rpc<{ items: Array<{ name: string; stockOnHand: number; sellingPrice: number }> }>(page, { procedure: "itemsAll" });
  expect(afterRetry.items.find((item) => item.name === itemName)).toMatchObject({ stockOnHand: 7, sellingPrice: 400 });
  await form.screenshot({ path: path.join(evidenceDir, "duplicate-recovery.png") });

  await page.getByTestId("stock-new-entry").press("Enter");
  await expect(page.getByTestId("stock-delta")).toHaveValue("");
  await expect(page.getByTestId("stock-delta")).toBeFocused();
  await expect(page.getByTestId("stock-selling-price")).toHaveValue("400");
  await page.getByTestId("stock-delta").fill("2");
  await page.getByTestId("stock-save").click();
  await expect(page.getByTestId("stock-done")).toBeVisible();
  const afterNewReceipt = await rpc<{ items: Array<{ name: string; stockOnHand: number; sellingPrice: number }> }>(page, { procedure: "itemsAll" });
  expect(afterNewReceipt.items.find((item) => item.name === itemName)).toMatchObject({ stockOnHand: 9, sellingPrice: 400 });

  await testInfo.attach("stock-form-before", { path: path.join(evidenceDir, "before.png"), contentType: "image/png" });
  await testInfo.attach("stock-form-after", { path: path.join(evidenceDir, "after.png"), contentType: "image/png" });
});
