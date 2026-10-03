import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { extractPdfText, pdfMediaBoxes, pdfPageCount } from "./pdf-helpers";

/**
 * Invoice print — the settled A4 sheet (#121).
 *
 * Invoices are seeded through the real RPC wire (the sale form bumps a
 * quantity instead of adding a line, so the UI cannot reach a paginating
 * invoice quickly). The assertions cover the paper contract:
 *
 * - exactly 2 A4 sheets for a 12-line sale, with the FULL store header on
 *   both (model 1), 6 lines then 6 (the paginator balances evenly; no payment
 *   block claims the closing sheet's spare room);
 * - a 5-line invoice stays on ONE sheet (the paginator reserves no payment room);
 * - a purchase swaps the meta row to «المورّد» / «فاتورة شراء»;
 * - page 1 carries the running total «المجموع المنقول»; page 2 closes with
 *   the full totals. The payments log stays on the invoice SCREEN, never the
 *   paper (owner decision);
 * - every foot carries «صفحة X من Y» and the invoice number, and the page
 *   counter sits dead-centre on every sheet whatever the store name width;
 * - the currency دج is drawn LEFT of the amount in an RTL cell;
 * - `@page { size: A4; margin: 0 }` reaches the print pipeline, so the sheets
 *   start at the page origin and Chrome's URL/date header (drawn in the page
 *   margin box) has nowhere to render;
 * - a real `page.pdf()` is 2 pages, every MediaBox is A4, the fonts are
 *   embedded, and no page URL appears in the decoded PDF text.
 *
 * The URL scan is proof-positive: CDP prints the default header/footer
 * templates empty, so the test also prints a control PDF with Chrome's own
 * `.url` header template and asserts the scanner finds the URL there. The
 * subject PDF, printed with `displayHeaderFooter: true`, must stay clean.
 */

/**
 * The page counter must sit dead-centre in the sheet whatever the side texts
 * are. The foot is a `1fr auto 1fr` grid, so the counter column's centre has
 * to match the sheet's centre within a pixel of rounding. A long store name or
 * document ref must not push it off-centre (they wrap inside their own track).
 */
async function expectPageCounterCentred(sheet: Locator): Promise<void> {
  const [sheetBox, counterBox] = await Promise.all([
    sheet.boundingBox(),
    sheet.getByTestId("receipt-page-num").boundingBox(),
  ]);
  expect(sheetBox).not.toBeNull();
  expect(counterBox).not.toBeNull();
  const sheetCentre = (sheetBox?.x ?? 0) + (sheetBox?.width ?? 0) / 2;
  const counterCentre = (counterBox?.x ?? 0) + (counterBox?.width ?? 0) / 2;
  expect(Math.abs(sheetCentre - counterCentre)).toBeLessThanOrEqual(2);
}

interface SeededInvoice {
  id: string;
  invoiceNumber: string;
}

interface InvoiceSeed {
  kind: "SALE" | "PURCHASE";
  lineCount: number;
  counterpartyName: string;
  /** business date (YYYY-MM-DD); omitted means today */
  invoiceDate?: string;
  /** cash paid at invoice time; omitted means no payment history at all */
  initialPaid?: number;
}

async function setStoreIdentity(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByTestId("settings-name").fill("ماني للاكسسوارات اوتو");
  await page.getByTestId("settings-phone").fill("0555123456");
  await page.getByTestId("settings-address").fill("حي 5 جويلية، البليدة");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toContainText("تم حفظ الإعدادات");
}

/**
 * Seed one invoice through the real RPC wire. The oRPC fetch link posts
 * `{json: input}` to /api/rpc/<procedure> and answers `{json: output}`
 * (see @orpc/client's StandardRPCSerializer).
 */
async function seedInvoice(page: Page, seed: InvoiceSeed): Promise<SeededInvoice> {
  return page.evaluate(async (spec) => {
    type SeedRequest =
      | { procedure: "categoriesCreate"; input: { name: string } }
      | {
          procedure: "itemsCreateWithStock";
          input: { name: string; categoryId: string; costPrice: number; sellingPrice: number; stockOnHand: number };
        }
      | {
          procedure: "invoicesCreate";
          input: {
            kind: "SALE" | "PURCHASE";
            counterpartyName: string;
            invoiceDate?: string;
            initialPaid?: number;
            lines: Array<{ itemId: string; quantity: number }>;
          };
        };

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
    const category = JSON.parse(
      await call({ procedure: "categoriesCreate", input: { name: `طباعة-${spec.kind}-${Date.now()}` } }),
    ) as { json: { id: string } };
    // SAFETY: itemsCreateWithStock's contract answers the created item, whose id is a string
    const item = JSON.parse(
      await call({
        procedure: "itemsCreateWithStock",
        input: { name: "بطارية سيارة 70 أمبير", categoryId: category.json.id, costPrice: 50, sellingPrice: 100, stockOnHand: 40 },
      }),
    ) as { json: { id: string } };
    // SAFETY: invoicesCreate's contract answers the invoice detail, whose id and number are strings
    const invoice = JSON.parse(
      await call({
        procedure: "invoicesCreate",
        input: {
          kind: spec.kind,
          counterpartyName: spec.counterpartyName,
          invoiceDate: spec.invoiceDate,
          initialPaid: spec.initialPaid,
          lines: Array.from({ length: spec.lineCount }, () => ({ itemId: item.json.id, quantity: 1 })),
        },
      }),
    ) as { json: { id: string; invoiceNumber: string } };
    return { id: invoice.json.id, invoiceNumber: invoice.json.invoiceNumber };
  }, seed);
}

test("invoice print: a 12-line sale prints as exactly 2 A4 sheets, no browser header", async ({ page }) => {
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // 1. a known store identity, address included: the sheet's left header block
  await setStoreIdentity(page);

  // 2. a 12-line sale, 500 paid up front → subtotal 1,200, remaining 700.
  //    BACKDATED on purpose: the paper must keep the business date and only
  //    take the clock time from the recording moment.
  const seeded = await seedInvoice(page, {
    kind: "SALE",
    lineCount: 12,
    counterpartyName: "علي علي",
    invoiceDate: "2026-09-15",
    initialPaid: 500,
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
    // the business date (2026-09-15) with the recording time, 24-hour
    await expect(sheet.getByTestId("receipt-date")).toHaveText(/^15\/09\/2026 \d{2}:\d{2}$/);
    await expect(sheet.locator(".print-sheet-contacts")).toContainText("رقم الهاتف");
    await expect(sheet.locator(".print-sheet-contacts")).toContainText("العنوان");
    await expect(sheet.locator(".print-sheet-meta")).toContainText("التاريخ والوقت");
  }
  await expect(last.getByTestId("receipt-kind")).toHaveText("فاتورة بيع");
  await expect(last.locator(".print-sheet-meta")).toContainText("الزبون");

  // 5. the 12 lines are printed once, balanced 6/6 over the two sheets
  await expect(page.getByTestId("receipt-line")).toHaveCount(12);
  await expect(first.getByTestId("receipt-line")).toHaveCount(6);
  await expect(last.getByTestId("receipt-line")).toHaveCount(6);
  await expect(first.getByTestId("receipt-items-title")).toHaveText("المشتريات");
  await expect(last.getByTestId("receipt-items-title")).toHaveCount(0);

  // 6. one rule above the totals: the non-closing sheet carries the running
  //    total only (never «مجموع هذه الصفحة»), the closing sheet totals up
  await expect(first.getByTestId("receipt-carried-total")).toContainText("المجموع المنقول");
  await expect(first.getByTestId("receipt-carried-total")).toContainText("600");
  await expect(first.getByTestId("receipt-total")).toHaveCount(0);
  await expect(first).not.toContainText("مجموع هذه الصفحة");
  await expect(last.getByTestId("receipt-carry-in")).toContainText("منقول من الصفحة السابقة");
  await expect(last.getByTestId("receipt-carry-in")).toContainText("600");
  await expect(last.getByTestId("receipt-subtotal")).toContainText("1,200");
  await expect(last.getByTestId("receipt-paid")).toContainText("500");
  await expect(last.getByTestId("receipt-remaining")).toContainText("700");

  // 7. the payments log stays on the SCREEN: the printed invoice carries none
  //    of it (owner decision, reversing the original "decision A")
  await expect(last.getByTestId("receipt-payments")).toHaveCount(0);
  await expect(last.getByTestId("receipt-payment")).toHaveCount(0);
  await expect(page.getByTestId("receipt-payment")).toHaveCount(0);

  // 8. the foot is pinned to every sheet with the page number and invoice
  //    number, and the page counter is dead-centre however wide the store name
  //    or the ref grow
  await expect(first.getByTestId("receipt-page-num")).toHaveText("صفحة 1 من 2");
  await expect(last.getByTestId("receipt-page-num")).toHaveText("صفحة 2 من 2");
  await expect(first.getByTestId("receipt-ref")).toHaveText(seeded.invoiceNumber);
  await expect(last.getByTestId("receipt-ref")).toHaveText(seeded.invoiceNumber);
  await expectPageCounterCentred(first);
  await expectPageCounterCentred(last);

  // 9. RTL money: the currency's right edge sits left of the amount's left edge
  const moneyCell = last.getByTestId("receipt-line").first().locator("td").nth(3);
  const amountBox = await moneyCell.locator(".print-sheet-ltr").boundingBox();
  const currencyBox = await moneyCell.locator(".print-sheet-cur").boundingBox();
  expect(amountBox).not.toBeNull();
  expect(currencyBox).not.toBeNull();
  expect((currencyBox?.x ?? 0) + (currencyBox?.width ?? 0)).toBeLessThanOrEqual((amountBox?.x ?? Number.MAX_SAFE_INTEGER) + 1);

  // 10. the @page rule that removes the browser's header/footer is in the built
  //     stylesheet: size A4 + zero margin box
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

  // 11. in print media the sheet starts at the top of the page (no margin box
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

  // 12. a real print-to-PDF: exactly 2 A4 pages, embedded fonts, and no Chrome
  //     URL/date banner in the decoded text. CDP prints the default header/
  //     footer templates empty, so the positive control below draws the URL
  //     with Chrome's own `.url` class and proves the scanner can see a drawn
  //     banner; the subject PDF (the production call) must stay clean.
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
  expect(extractPdfText(pdf)).not.toContain("127.0.0.1");
  expect(extractPdfText(pdf)).not.toContain("http");

  const headerControl = await page.pdf({
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:10px; width:100%; margin:0 10mm;"><span class="url"></span> | <span class="date"></span></div>',
    footerTemplate:
      '<div style="font-size:10px; width:100%; margin:0 10mm; text-align:center;"><span class="pageNumber"></span>/<span class="totalPages"></span></div>',
  });
  expect(extractPdfText(headerControl)).toContain("127.0.0.1");

  // 13. the app's invoice detail screen shows the same business date + time,
  //     so the paper and the screen cannot disagree
  await page.goto(`/invoices/${seeded.id}`);
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-date")).toHaveText(/^15\/09\/2026 \d{2}:\d{2}$/);
});

test("invoice print: a 5-line purchase fits one sheet and labels the supplier", async ({ page }) => {
  await signIn(page);
  await setStoreIdentity(page);

  // no initial payment: there is no payment section left to reserve room for.
  // The supplier name is LONG on purpose: the meta row must let it wrap
  // instead of running off the A4 width.
  const longSupplier = "مورّد الاختبار لقطع غيار السيارات والاكسسوارات بشارع الاستقلال";
  const seeded = await seedInvoice(page, { kind: "PURCHASE", lineCount: 5, counterpartyName: longSupplier });

  await page.goto(`/invoices/${seeded.id}/print`);
  await expect(page.getByTestId("receipt-page")).toBeVisible();
  await expect(page.getByTestId("receipt-sheet")).toHaveCount(1);
  const sheet = page.getByTestId("receipt-sheet");
  await expect(sheet.getByTestId("receipt-store")).toHaveText("ماني للاكسسوارات اوتو");
  await expect(sheet.getByTestId("receipt-kind")).toHaveText("فاتورة شراء");
  await expect(sheet.locator(".print-sheet-meta")).toContainText("المورّد");
  await expect(sheet.locator(".print-sheet-meta")).toContainText(longSupplier);
  await expect(sheet.locator(".print-sheet-meta")).not.toContainText("الزبون");
  await expect(page.getByTestId("receipt-line")).toHaveCount(5);
  await expect(page.getByTestId("receipt-payments")).toHaveCount(0);
  await expect(sheet.getByTestId("receipt-page-num")).toHaveText("صفحة 1 من 1");
  await expectPageCounterCentred(sheet);
  // a long value wraps inside the meta row: no horizontal overflow
  const metaOverflow = await sheet.locator(".print-sheet-meta").evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(metaOverflow.scrollWidth).toBeLessThanOrEqual(metaOverflow.clientWidth + 1);
  // the long name must not squeeze the short fields onto second lines
  const numberBox = await sheet.getByTestId("receipt-number").boundingBox();
  expect(numberBox?.height ?? 999).toBeLessThan(30);

  // one sheet = one A4 page
  const pdf = await page.pdf({ preferCSSPageSize: true });
  expect(pdfPageCount(pdf)).toBe(1);
  const boxes = pdfMediaBoxes(pdf);
  expect(boxes).toHaveLength(1);
  expect(Math.abs((boxes[0]?.width ?? 0) - 594.96)).toBeLessThan(2);
});

test("invoice print: the page counter stays centred under a long store name", async ({ page }) => {
  await signIn(page);

  // a store name wide enough to wrap in the foot's right-hand track: without
  // the equal-width grid columns it would push the middle counter off-centre
  const longName = "مؤسسة ماني للاكسسوارات وقطع غيار السيارات الأوروبية واليابانية ذ.م.م.";
  await page.goto("/settings");
  await page.getByTestId("settings-name").fill(longName);
  await page.getByTestId("settings-address").fill("حي 5 جويلية، البليدة");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toContainText("تم حفظ الإعدادات");

  const seeded = await seedInvoice(page, { kind: "SALE", lineCount: 2, counterpartyName: "علي علي" });
  await page.goto(`/invoices/${seeded.id}/print`);
  await expect(page.getByTestId("receipt-page")).toBeVisible();
  const sheet = page.getByTestId("receipt-sheet");
  await expect(sheet).toHaveCount(1);
  await expect(sheet.getByTestId("receipt-ref")).toHaveText(seeded.invoiceNumber);
  // the long store name wraps in the foot rather than shifting the counter
  await expectPageCounterCentred(sheet);
  expect(await sheet.getByTestId("receipt-page-num").isVisible()).toBe(true);
});
