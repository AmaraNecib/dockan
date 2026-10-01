import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";

/**
 * Invoice print — the settled A4 sheet (#121).
 *
 * A 12-line sale is seeded through the real RPC wire (the sale form bumps a
 * quantity instead of adding a line, so the UI cannot reach a paginating
 * invoice quickly). The assertion then covers the paper contract:
 *
 * - exactly 2 A4 sheets, with the FULL store header on both (model 1);
 * - a long invoice paginates: 10 lines on sheet 1, 2 on sheet 2, page 1
 *   carrying the running total «المجموع المنقول» and page 2 closing;
 * - the payment history is on the invoice (decision A);
 * - every foot carries «صفحة X من Y» and the invoice number;
 * - `@page { size: A4; margin: 0 }` reaches the print pipeline, so the sheets
 *   start at the page origin and Chrome's URL/date header (drawn in the page
 *   margin box) has nowhere to render;
 * - a real `page.pdf()` with `displayHeaderFooter: true` is 2 pages, every
 *   MediaBox is A4, and the fonts are embedded (Arabic text intact).
 *
 * The default headless PDF has no browser header at all, so the header
 * assertion targets its mechanism: the zero page margin plus the geometry
 * check below. (A local `pdftotext` run of the generated PDF shows no page URL
 * or date outside the sheet.)
 */

function pdfPageCount(pdf: Buffer): number {
  // `/Type /Page` only: the `\b` keeps `/Type /Pages` out
  return (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
}

function pdfMediaBoxes(pdf: Buffer): Array<{ width: number; height: number }> {
  const boxes: Array<{ width: number; height: number }> = [];
  for (const match of pdf.toString("latin1").matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)) {
    const [x1, y1, x2, y2] = (match[1] ?? "").trim().split(/\s+/).map(Number);
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      boxes.push({ width: x2 - x1, height: y2 - y1 });
    }
  }
  return boxes;
}

test("invoice print: a long invoice prints as exactly 2 A4 sheets, no browser header", async ({ page }) => {
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // 1. a known store identity, address included: the sheet's left header block
  await page.goto("/settings");
  await page.getByTestId("settings-name").fill("ماني للاكسسوارات اوتو");
  await page.getByTestId("settings-phone").fill("0555123456");
  await page.getByTestId("settings-address").fill("حي 5 جويلية، البليدة");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toContainText("تم حفظ الإعدادات");

  // 2. a 12-line sale seeded through the real RPC wire. The oRPC fetch link
  //    posts `{json: input}` to /api/rpc/<procedure> and answers `{json: output}`
  //    (see @orpc/client's StandardRPCSerializer).
  const seeded = await page.evaluate(async () => {
    type SeedRequest =
      | { procedure: "categoriesCreate"; input: { name: string } }
      | { procedure: "itemsCreateWithStock"; input: { name: string; categoryId: string; costPrice: number; sellingPrice: number; stockOnHand: number } }
      | { procedure: "invoicesCreate"; input: { kind: "SALE"; counterpartyName: string; initialPaid: number; lines: Array<{ itemId: string; quantity: number }> } };

    async function call(request: SeedRequest): Promise<string> {
      const response = await fetch(`/api/rpc/${request.procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: request.input }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${request.procedure} failed: ${response.status} ${text}`);
      return text;
    }

    // SAFETY: categoriesCreate's contract answers the created category, whose id is a string
    const category = JSON.parse(await call({ procedure: "categoriesCreate", input: { name: `طباعة-${Date.now()}` } })) as { json: { id: string } };
    // SAFETY: itemsCreateWithStock's contract answers the created item, whose id is a string
    const item = JSON.parse(
      await call({
        procedure: "itemsCreateWithStock",
        input: { name: "بطارية سيارة 70 أمبير", categoryId: category.json.id, costPrice: 50, sellingPrice: 100, stockOnHand: 20 },
      }),
    ) as { json: { id: string } };
    // SAFETY: invoicesCreate's contract answers the invoice detail, whose id and number are strings
    const invoice = JSON.parse(
      await call({
        procedure: "invoicesCreate",
        input: {
          kind: "SALE",
          counterpartyName: "علي علي",
          initialPaid: 500,
          lines: Array.from({ length: 12 }, () => ({ itemId: item.json.id, quantity: 1 })),
        },
      }),
    ) as { json: { id: string; invoiceNumber: string } };
    return invoice.json;
  });

  // 3. the print-only route renders the document the dialog would capture
  await page.goto(`/invoices/${seeded.id}/print`);
  await expect(page.getByTestId("receipt-page")).toBeVisible();
  await expect(page.getByTestId("receipt-sheet")).toHaveCount(2);
  const sheets = page.getByTestId("receipt-sheet");
  const first = sheets.nth(0);
  const last = sheets.nth(1);

  // 4. every sheet carries the full header: store, contacts and the meta row
  for (const sheet of [first, last]) {
    await expect(sheet.getByTestId("receipt-store")).toHaveText("ماني للاكسسوارات اوتو");
    await expect(sheet.getByTestId("receipt-phone")).toHaveText("+213555123456");
    await expect(sheet.getByTestId("receipt-address")).toHaveText("حي 5 جويلية، البليدة");
    await expect(sheet.getByTestId("receipt-number")).toHaveText(seeded.invoiceNumber);
    await expect(sheet.getByTestId("receipt-date")).toHaveText(/^\d{2}\/\d{2}\/\d{4}$/);
    await expect(sheet.locator(".print-sheet-contacts")).toContainText("رقم الهاتف");
    await expect(sheet.locator(".print-sheet-contacts")).toContainText("العنوان");
    await expect(sheet.locator(".print-sheet-meta")).toContainText("التاريخ والوقت");
  }
  await expect(last.getByTestId("receipt-kind")).toHaveText("فاتورة بيع");
  await expect(last.locator(".print-sheet-meta")).toContainText("الزبون");

  // 5. the 12 lines are printed once, split over the two sheets
  await expect(page.getByTestId("receipt-line")).toHaveCount(12);
  await expect(first.getByTestId("receipt-line")).toHaveCount(10);
  await expect(last.getByTestId("receipt-line")).toHaveCount(2);
  await expect(first.getByTestId("receipt-items-title")).toHaveText("المشتريات");
  await expect(last.getByTestId("receipt-items-title")).toHaveCount(0);

  // 6. one rule above the totals: the non-closing sheet carries the running
  //    total only (never «مجموع هذه الصفحة»), the closing sheet totals up
  await expect(first.getByTestId("receipt-carried-total")).toContainText("المجموع المنقول");
  await expect(first.getByTestId("receipt-carried-total")).toContainText("1,000");
  await expect(first.getByTestId("receipt-total")).toHaveCount(0);
  await expect(first).not.toContainText("مجموع هذه الصفحة");
  await expect(last.getByTestId("receipt-carry-in")).toContainText("منقول من الصفحة السابقة");
  await expect(last.getByTestId("receipt-carry-in")).toContainText("1,000");
  await expect(last.getByTestId("receipt-subtotal")).toContainText("1,200");
  await expect(last.getByTestId("receipt-paid")).toContainText("500");
  await expect(last.getByTestId("receipt-remaining")).toContainText("700");

  // 7. payment history (decision A) with the app-wide date/time shape
  await expect(last.getByTestId("receipt-payments")).toContainText("سجل الدفعات");
  await expect(last.getByTestId("receipt-payment")).toHaveCount(1);
  await expect(last.getByTestId("receipt-payment").locator("td").first()).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

  // 8. the foot is pinned to every sheet with the page number and invoice number
  await expect(first.getByTestId("receipt-page-num")).toHaveText("صفحة 1 من 2");
  await expect(last.getByTestId("receipt-page-num")).toHaveText("صفحة 2 من 2");
  await expect(first.getByTestId("receipt-ref")).toHaveText(seeded.invoiceNumber);
  await expect(last.getByTestId("receipt-ref")).toHaveText(seeded.invoiceNumber);

  // 9. the @page rule that removes the browser's header/footer is in the built
  //    stylesheet: size A4 + zero margin box
  const pageRules = await page.evaluate(() => {
    const rules: Array<{ margin: string; size: string }> = [];
    for (const styleSheet of Array.from(document.styleSheets)) {
      let cssRules: CSSRuleList | null = null;
      try {
        cssRules = styleSheet.cssRules;
      } catch {
        continue; // cross-origin sheet
      }
      for (const rule of Array.from(cssRules)) {
        if (rule.cssText.startsWith("@page")) {
          // SAFETY: only an @page rule's cssText starts with "@page"
          const pageRule = rule as CSSPageRule;
          rules.push({ margin: pageRule.style.margin, size: pageRule.style.size });
        }
      }
    }
    return rules;
  });
  expect(pageRules.some((rule) => rule.margin === "0px" && /a4/i.test(rule.size))).toBe(true);

  // 10. in print media the sheet starts at the top of the page (no margin box
  //     for Chrome's URL/date header) and measures exactly 210×297mm. The
  //     horizontal offset is not asserted: print emulation keeps the window
  //     viewport, while the PDF lays out on the 210mm paper box.
  await page.emulateMedia({ media: "print" });
  const sheetBox = await page.evaluate(() => {
    const sheet = document.querySelector(".print-sheet");
    if (sheet === null) return null;
    const rect = sheet.getBoundingClientRect();
    return { top: rect.top, width: rect.width, height: rect.height, viewport: window.innerWidth };
  });
  expect(sheetBox).not.toBeNull();
  expect(sheetBox?.top ?? -1).toBeLessThan(1);
  expect(sheetBox?.width ?? 9999).toBeLessThanOrEqual(sheetBox?.viewport ?? 0);
  expect(Math.abs((sheetBox?.width ?? 0) - 793.7)).toBeLessThan(2); // 210mm at 96dpi
  expect(Math.abs((sheetBox?.height ?? 0) - 1122.5)).toBeLessThan(5); // 297mm at 96dpi

  // 11. a real print-to-PDF: exactly 2 A4 pages, no browser header/footer box,
  //     fonts embedded so the Arabic text survives
  await page.evaluate(() => document.fonts.ready);
  const pdf = await page.pdf({ preferCSSPageSize: true, displayHeaderFooter: true, printBackground: true });
  expect(pdfPageCount(pdf)).toBe(2);
  const boxes = pdfMediaBoxes(pdf);
  expect(boxes).toHaveLength(2);
  for (const box of boxes) {
    expect(Math.abs(box.width - 594.96)).toBeLessThan(2);
    expect(Math.abs(box.height - 841.92)).toBeLessThan(2);
  }
  expect(pdf.length).toBeGreaterThan(10_000);
  expect(pdf.toString("latin1")).toContain("/FontFile");
});
