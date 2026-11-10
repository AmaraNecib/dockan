import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";

type SeedRequest =
  | { procedure: "categoriesList"; input: Record<string, never> }
  | { procedure: "itemsCreate"; input: { name: string; categoryId: string; costPrice: number; sellingPrice: number; lowStockThreshold: number } }
  | { procedure: "stockAddManual"; input: { itemId: string; delta: number; unitCost?: number; costPending?: boolean; kind: "PURCHASE"; occurredAt?: string } }
  | { procedure: "invoicesCreate"; input: { kind: "SALE"; lines: Array<{ itemId: string; quantity: number }> } }
  | { procedure: "itemsHistory"; input: { itemId: string } };

async function rpc<T>(page: Page, request: SeedRequest): Promise<T> {
  const value = await page.evaluate(async (seed) => {
    const response = await fetch(`/api/rpc/${seed.procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ json: seed.input }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${seed.procedure} failed: ${response.status} ${body}`);
    // SAFETY: authenticated oRPC responses wrap their declared value in `json`.
    return (JSON.parse(body) as { json: unknown }).json;
  }, request);
  // SAFETY: each call site supplies the public procedure's declared shape.
  return value as T;
}

async function createItem(page: Page, name: string) {
  const categories = await rpc<{ items: Array<{ id: string }> }>(page, { procedure: "categoriesList", input: {} });
  const category = categories.items[0];
  if (!category) throw new Error("Expected the seeded default category");
  return rpc<{ id: string }>(page, {
    procedure: "itemsCreate",
    input: { name, categoryId: category.id, costPrice: 0, sellingPrice: 400, lowStockThreshold: 0 },
  });
}

const evidence = process.env.ISSUE_393_EVIDENCE === "1";
test.use({ viewport: { width: 1280, height: 900 }, video: "on" });

test.describe("issue 393 receipt cost and return source", () => {
  test("resolve a pending receipt in history and retain its audit facts", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const stamp = Date.now().toString();
    const item = await createItem(page, `تكلفة إيصال ${stamp}`);
    await rpc(page, { procedure: "stockAddManual", input: { itemId: item.id, delta: 2, costPending: true, kind: "PURCHASE", occurredAt: "2026-01-10T10:00:00" } });

    await page.goto(`/items/${item.id}/history`);
    await expect(page.getByTestId("history-table")).toBeVisible();
    const receiptRow = page.getByTestId("history-table").locator("tbody tr[data-testid^='history-movement-row-']");
    await expect(receiptRow).toHaveCount(1);
    const rowId = (await receiptRow.getAttribute("data-testid"))?.replace("history-movement-row-", "");
    if (!rowId) throw new Error("Receipt movement row has no identity");
    await receiptRow.getByTestId(`history-toggle-${rowId}`).click();
    const detail = page.getByTestId(`history-detail-${rowId}`);
    const resolution = page.getByTestId(`receipt-resolution-${rowId}`);
    await expect(resolution).toContainText("تكلفة هذا الوارد ما زالت معلّقة");
    if (evidence) {
      fs.mkdirSync(".scratch/evidence/393", { recursive: true });
      await resolution.screenshot({ path: ".scratch/evidence/393/receipt-before.png" });
    }
    await resolution.getByTestId(`receipt-resolution-open-${rowId}`).click();
    await page.getByTestId("receipt-resolution-cost").fill("125");
    await page.getByTestId("receipt-resolution-reason").fill("فاتورة المورد مؤكدة");
    await page.getByTestId("receipt-resolution-save").click();
    const audit = page.getByTestId(`receipt-resolution-audit-${rowId}`);
    await expect(audit).toContainText("125");
    await expect(audit).toContainText("فاتورة المورد مؤكدة");
    await expect(audit).toContainText("التكلفة المسجلة عند الاستلام");
    await expect(detail.getByTestId(/^history-fact-unit-cost-/)).toContainText("125");
    if (evidence) await audit.screenshot({ path: ".scratch/evidence/393/receipt-after.png" });

    const persisted = await rpc<{ movements: Array<{ id: string; occurredAt: string; createdAt: string; details?: { receiptOriginalCost?: { costPending: boolean }; receiptResolution?: { unitCost: number; reason: string } } }> }>(page, { procedure: "itemsHistory", input: { itemId: item.id } });
    const savedReceipt = persisted.movements.find((movement) => movement.id === rowId);
    expect(savedReceipt).toMatchObject({
      occurredAt: "2026-01-10T10:00:00",
      details: { receiptOriginalCost: { costPending: true }, receiptResolution: { unitCost: 125, reason: "فاتورة المورد مؤكدة" } },
    });
  });

  test("asks for source allocation only when a return spans multiple receipts", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const stamp = Date.now().toString();
    const item = await createItem(page, `مصادر مرجوع ${stamp}`);
    await rpc(page, { procedure: "stockAddManual", input: { itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE", occurredAt: "2026-01-10T10:00:00" } });
    await rpc(page, { procedure: "stockAddManual", input: { itemId: item.id, delta: 1, unitCost: 200, kind: "PURCHASE", occurredAt: "2026-01-11T10:00:00" } });
    const invoice = await rpc<{ id: string; lines: Array<{ id: string }> }>(page, { procedure: "invoicesCreate", input: { kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] } });
    const line = invoice.lines[0];
    if (!line) throw new Error("Expected a saved sale line");

    await page.goto(`/invoices/${invoice.id}`);
    await expect(page.getByTestId("invoice-page")).toBeVisible();
    const returns = page.getByTestId("returns-panel");
    await expect(returns).toBeVisible();
    if (evidence) {
      fs.mkdirSync(".scratch/evidence/393", { recursive: true });
      await returns.screenshot({ path: ".scratch/evidence/393/return-source-before.png" });
    }
    const quantity = page.locator(`[data-testid="returns-qty-${item.name}"]`);
    await quantity.fill("1");
    const choice = page.getByTestId(`return-source-choice-${line.id}`);
    await expect(choice).toBeVisible();
    await expect(choice).toContainText("100");
    await expect(choice).toContainText("200");
    if (evidence) {
      fs.mkdirSync(".scratch/evidence/393", { recursive: true });
      await choice.screenshot({ path: ".scratch/evidence/393/return-source-after.png" });
    }

    const split = choice.getByRole("radio").first();
    await split.check();
    const sourceQuantities = choice.locator('input[data-testid^="return-source-qty-"]');
    await expect(sourceQuantities).toHaveCount(2);
    await sourceQuantities.nth(0).fill("1");
    await sourceQuantities.nth(1).fill("0");
    await expect(page.getByTestId("returns-submit")).toBeEnabled();
    await page.getByTestId("returns-reason").fill("تحديد مصدر الوحدات");
    await page.getByTestId("returns-submit").click();
    await expect(page.getByTestId("returns-done")).toContainText("تم تسجيل المرجوع");
  });
});
