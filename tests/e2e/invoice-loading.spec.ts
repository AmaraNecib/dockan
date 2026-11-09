import { expect, test } from "@playwright/test";
import type { InvoiceDetail } from "../../packages/contracts/src/core";

import { signIn } from "./auth-helpers";
import { callRpc, seedCategoryId } from "./rpc-helpers";

test.use({ video: { mode: "on", size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } });

test("invoice detail announces loading, preserves the real error, and recovers", async ({ page }, testInfo) => {
  await signIn(page);
  const stamp = Date.now().toString();
  const categoryId = await seedCategoryId(page, `تحميل-${stamp}`);
  const item = await callRpc<{ id: string }, {
    name: string;
    categoryId: string;
    costPrice: number;
    sellingPrice: number;
    stockOnHand: number;
  }>(page, "itemsCreateWithStock", {
    name: `منتج تحميل-${stamp}`,
    categoryId,
    costPrice: 100,
    sellingPrice: 250,
    stockOnHand: 1,
  });
  const invoice = await callRpc<InvoiceDetail, {
    kind: "SALE";
    lines: Array<{ itemId: string; quantity: number; unitPrice: number }>;
  }>(page, "invoicesCreate", {
    kind: "SALE",
    lines: [{ itemId: item.id, quantity: 1, unitPrice: 250 }],
  });

  let mode: "hold" | "error" | "continue" = "hold";
  let releaseHeld!: () => void;
  let notifyHeld!: () => void;
  const heldRequest = new Promise<void>((resolve) => { notifyHeld = resolve; });
  await page.route("**/api/rpc/invoicesGet**", async (route) => {
    if (mode === "hold") {
      mode = "continue";
      await new Promise<void>((resolve) => {
        releaseHeld = resolve;
        notifyHeld();
      });
      await route.continue();
      return;
    }
    if (mode === "error") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ json: { code: "INTERNAL_SERVER_ERROR", message: "Synthetic invoice read failure" } }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/invoices/${invoice.id}`);
  await heldRequest;
  const loading = page.getByTestId("invoice-loading");
  await expect(loading).toHaveText("جارٍ تحميل الفاتورة");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await loading.screenshot({ path: testInfo.outputPath("invoice-loading-pending.png") });

  releaseHeld();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-number")).toHaveText(invoice.invoiceNumber);
  await page.getByTestId("invoice-page").locator("h1").screenshot({ path: testInfo.outputPath("invoice-loading-loaded.png") });

  mode = "error";
  await page.reload();
  await expect(page.getByTestId("invoice-error-text")).toHaveText("تعذّر إكمال العملية. أعد المحاولة.", { timeout: 25_000 });

  mode = "continue";
  await page.reload();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-number")).toHaveText(invoice.invoiceNumber);
});
