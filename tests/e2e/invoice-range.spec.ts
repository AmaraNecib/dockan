import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { callRpc, seedCategoryId } from "./rpc-helpers";
import { chooseSelectOption } from "./select-helpers";

test.use({ video: "on", viewport: { width: 1920, height: 1080 } });

type ItemCreate = { name: string; categoryId: string; costPrice: number; sellingPrice: number; lowStockThreshold: number };
type InvoiceCreate = { kind: "PURCHASE"; invoiceDate: string; lines: Array<{ itemId: string; quantity: number; unitPrice: number }> };

test("invoice list filters persisted ranges, sorts business dates, and clears defaults (#406)", async ({ page }) => {
  test.setTimeout(60_000);
  // These brief holds are only for readable evidence playback. Assertions below
  // complete each UI transition before the hold; playback remains real-time.
  const holdForEvidence = () => page.waitForTimeout(2_500);
  await signIn(page);
  const existingInvoices = await callRpc<{ total: number }, { limit: number; offset: number }>(page, "invoicesList", { limit: 1, offset: 0 });
  const stamp = Date.now().toString();
  const categoryId = await seedCategoryId(page, `range-${stamp}`);
  const item = await callRpc<{ id: string }, ItemCreate>(page, "itemsCreate", {
    name: `range item ${stamp}`, categoryId, costPrice: 100, sellingPrice: 150, lowStockThreshold: 0,
  });
  const seeded: Array<{ invoiceNumber: string; invoiceDate: string }> = [];
  for (const invoiceDate of ["2090-01-01", "2090-01-02", "2090-01-03"]) {
    const invoice = await callRpc<{ invoiceNumber: string }, InvoiceCreate>(page, "invoicesCreate", {
      kind: "PURCHASE", invoiceDate, lines: [{ itemId: item.id, quantity: 1, unitPrice: 100 }],
    });
    seeded.push({ invoiceNumber: invoice.invoiceNumber, invoiceDate });
  }
  const [first, second, third] = seeded;
  if (first === undefined || second === undefined || third === undefined) throw new Error("expected three persisted invoice fixtures");
  const sequenceOf = (invoiceNumber: string): string => {
    const match = /^SUP-(\d+)$/u.exec(invoiceNumber);
    if (match?.[1] === undefined) throw new Error(`unexpected generated purchase number: ${invoiceNumber}`);
    return match[1];
  };

  await page.goto("/invoices");
  const surface = page.getByTestId("invoices-page");
  await expect(surface).toBeVisible();
  await holdForEvidence();
  const evidence = path.resolve(process.cwd(), ".scratch/evidence/406");
  fs.mkdirSync(evidence, { recursive: true });
  await surface.screenshot({ path: path.join(evidence, "after-invoice-page-review-fix.png") });
  await page.getByTestId("invoices-range-filters-toggle").click();
  await expect(page.getByTestId("invoices-range-details")).toHaveAttribute("open", "");
  const fromDate = page.getByTestId("invoices-from-date");
  const toDate = page.getByTestId("invoices-to-date");
  const fromNumber = page.getByTestId("invoices-from-number");
  const toNumber = page.getByTestId("invoices-to-number");
  const rows = page.getByTestId("invoice-row");
  const rowNumbers = async () => (await rows.all()).map(async (row) => (await row.locator("td").first().innerText()).trim());
  const visibleNumbers = async () => Promise.all(await rowNumbers());

  await fromDate.fill("2090-01-02");
  await toDate.fill("2090-01-02");
  await fromNumber.fill(sequenceOf(second.invoiceNumber));
  await toNumber.fill(third.invoiceNumber);
  await expect(rows).toHaveCount(1);
  expect(await visibleNumbers()).toEqual([second.invoiceNumber]);
  await holdForEvidence();

  await fromDate.fill("2090-01-01");
  await toDate.fill("2090-01-03");
  await fromNumber.fill(sequenceOf(second.invoiceNumber));
  await toNumber.fill(sequenceOf(third.invoiceNumber));
  await expect(rows).toHaveCount(2);
  const order = page.getByTestId("invoices-order-filter");
  await order.click();
  await page.getByRole("option", { name: "الأقدم أولاً" }).click();
  await expect.poll(visibleNumbers).toEqual([second.invoiceNumber, third.invoiceNumber]);
  await holdForEvidence();
  await order.click();
  await page.getByRole("option", { name: "الأحدث أولاً" }).click();
  await expect.poll(visibleNumbers).toEqual([third.invoiceNumber, second.invoiceNumber]);
  await holdForEvidence();

  await fromDate.fill("2090-01-03");
  await toDate.fill("2090-01-01");
  await expect(page.getByTestId("invoices-range-error")).toContainText("تاريخ البداية");
  await expect(rows).toHaveCount(0);
  await holdForEvidence();

  await page.getByTestId("invoices-filters-clear").click();
  await expect(rows).toHaveCount(Math.min(existingInvoices.total + 3, 500));
  await expect(page.getByTestId("invoices-range-error")).toHaveCount(0);
  await holdForEvidence();
  await chooseSelectOption(page, page.getByTestId("invoices-kind-filter"), "المشتريات");
  await chooseSelectOption(page, page.getByTestId("invoices-status-filter"), "غير مدفوعة");
  await page.getByTestId("invoices-search").fill(`range item ${stamp}`);
  await expect(rows).toHaveCount(3);
  await holdForEvidence();
  await page.getByTestId("invoices-page").screenshot({ path: path.join(evidence, "after-invoice-page-review-fix-filtered.png") });
});
