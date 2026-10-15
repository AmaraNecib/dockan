import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { actAndAck, rpcOutput, saveQuickAdd } from "./rpc-helpers";
import { chooseSelectOption } from "./select-helpers";

/**
 * Receipt printing e2e: the print button on the invoice screen produces a
 * receipt document with the store identity, invoice number, lines, totals and
 * paid/remaining.
 * A sale is recorded with a partial down payment, the remaining instalment
 * is settled on the invoice screen (paid invoice, 2 payment rows shown on the
 * SCREEN), then the print button opens the print-only route whose receipt
 * document carries the store identity, invoice number, lines, totals and
 * paid/remaining — and deliberately NOT the payment log (owner decision).
 *
 * NOTE ON THE OS DIALOG: window.print() opens the system print dialog, which
 * is headless-hostile (no OS dialog in CI). The assertion therefore targets
 * the print route's document content — the exact page that would reach the
 * printer — and the dialog itself is exercised manually in the desktop
 * shell (WebView2 renders the same window.print() as a system dialog).
 */
test("invoice print button → receipt document with identity, totals and payments", async ({ page }) => {
  // 0. sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // 1. a known store identity so the receipt's header is asserted, not assumed
  const stamp = Date.now().toString();
  const storeName = `متجر-الإيصال-${stamp}`;
  await page.goto("/settings");
  await page.getByTestId("settings-name").fill(storeName);
  // loose Algerian input is normalized at the api boundary to canonical +213 form,
  // so the receipt header is asserted in its canonical spelling
  await page.getByTestId("settings-phone").fill("066 12 34 56 7");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toContainText("تم حفظ الإعدادات");

  // 2. category + item, then a sale with a partial down payment (500/900)
  const categoryName = `إيصال-تصنيف-${stamp}`;
  const itemName = `إيصال-منتج-${stamp}`;
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("200");
  await page.getByLabel("سعر البيع (دج)").fill("900");
  await page.getByTestId("sale-quick-stock").fill("2");
  // Ack the quick-add's own write (issue 191) through the shared helper every
  // other quick-add site now uses (issue 196). The form takes the
  // create-with-stock path whenever a quantity is given, so the procedure is
  // itemsCreateWithStock — an ack armed for itemsCreate would never fire. The
  // cart line is added only from this response and keyed on the id it issues,
  // and it is the last writer of sale-save's disabled state before the save
  // click below.
  const created = await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await page.getByTestId("sale-paid").fill("500");
  await expect(page.getByTestId("sale-total")).toContainText("900");
  // The row the sale will send is the one the api just created — keyed on the
  // id it issued — and the save must be clickable: the app disables it while an
  // item write is still in flight. Assert both before arming the save's own
  // acknowledgement, so a stuck cart or a stale disabled state fails here by
  // name instead of as an unattributable timeout inside that wait (issue 191).
  const cartRow = page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`);
  await expect(cartRow).toHaveValue("1");
  await expect(cartRow).toHaveAttribute("name", `quantity-${created.id}`);
  await expect(page.getByTestId("sale-save")).toBeEnabled();
  // Wait on the api acknowledgement, not a 5 s UI poll: under CI load the write
  // can outlast the default expect window even though it lands (issue 179).
  // The number asserted below is the one the server actually allocated.
  const saved = await rpcOutput<{ invoiceNumber: string }>(
    await actAndAck(page, "invoicesCreate", async () => {
      await page.getByTestId("sale-save").click();
      // submit() refuses client-side before sending anything (empty cart, a
      // party that still needs picking, an over-total paid amount) and records
      // that refusal synchronously: asserting it away keeps such a regression a
      // named failure here instead of a wait for a request never sent
      await expect(page.getByTestId("sale-error")).toHaveCount(0);
    }),
  );
  // the contract guarantees the server-issued number's INV-<digits> shape
  const number = saved.invoiceNumber;
  expect(number).toMatch(/^INV-\d+$/);
  // and the card renders that exact server-issued number
  await expect(page.getByTestId("sale-saved-number")).toContainText(number);

  // 3. open the invoice detail, settle the remaining 400 → fully paid
  await page.getByRole("link", { name: "الفواتير" }).click();
  await expect(page.getByTestId("invoices-table")).toBeVisible();
  await page.getByTestId(`invoice-open-${number}`).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-remaining")).toContainText("400");
  await page.getByTestId("pmt-amount").fill("400");
  await page.getByTestId("pmt-submit").click();
  await expect(page.getByTestId("invoice-remaining")).toContainText("0");
  const history = page.getByTestId("pmt-history").locator("tbody tr");
  await expect(history).toHaveCount(2);

  // 4. the print button opens the print-only route
  await page.getByTestId("invoice-print").click();
  await expect(page.getByTestId("receipt-page")).toBeVisible();

  // 5. the receipt document carries everything the paper needs
  const receipt = page.getByTestId("receipt-view");
  await expect(receipt.getByTestId("receipt-store")).toContainText(storeName);
  await expect(receipt.getByTestId("receipt-phone")).toContainText("0661234567");
  await expect(receipt.getByTestId("receipt-number")).toContainText(number);
  // the settled sheet (#121): one A4 page, store header, colon-labelled meta row
  await expect(receipt.getByTestId("receipt-sheet")).toHaveCount(1);
  await expect(receipt.getByTestId("receipt-page-num")).toHaveText("صفحة 1 من 1");
  await expect(receipt.getByTestId("receipt-date")).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  await expect(receipt.getByTestId("receipt-kind")).toHaveText("فاتورة بيع");
  await expect(receipt.getByTestId("receipt-items-title")).toHaveText("المشتريات");
  await expect(receipt.locator(".print-sheet-meta")).toContainText("التاريخ والوقت");
  await expect(receipt.locator(".print-sheet-contacts")).toContainText("رقم الهاتف");
  // the left header block always shows its address label, with the saved value
  // or an em dash (earlier specs may have saved an address)
  await expect(receipt.locator(".print-sheet-contacts")).toContainText("العنوان");
  const colon = await receipt.locator(".print-sheet-meta dt").first().evaluate((el) => getComputedStyle(el, "::after").content);
  expect(colon).toContain(":");
  // lines: one item, qty 1 @ 900 → line total 900
  await expect(receipt.getByTestId("receipt-line")).toHaveCount(1);
  await expect(receipt.getByTestId("receipt-line").first()).toContainText(itemName);
  await expect(receipt.getByTestId("receipt-line").first()).toContainText("900");
  // totals: subtotal, discount (none), final, paid, remaining (settled)
  await expect(receipt.getByTestId("receipt-subtotal")).toContainText("900");
  await expect(receipt.getByTestId("receipt-discount")).toContainText("0");
  await expect(receipt.getByTestId("receipt-total")).toContainText("900");
  await expect(receipt.getByTestId("receipt-paid")).toContainText("900");
  await expect(receipt.getByTestId("receipt-remaining")).toContainText("0");
  // the printed invoice does NOT carry the payments log (owner decision): the
  // screen showed both rows above, the paper shows none
  await expect(receipt.getByTestId("receipt-payments")).toHaveCount(0);
  await expect(receipt.getByTestId("receipt-payment")).toHaveCount(0);

  // 6. the toolbar offers the way back (and stays off the paper via print-hidden)
  await expect(page.getByTestId("receipt-back")).toContainText("رجوع للفاتورة");
  await page.getByTestId("receipt-back").click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
});