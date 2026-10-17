import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { saveQuickAdd } from "./rpc-helpers";

/**
 * Sale checkout through the existing catalog seams. The flow uses
 * an unknown scan's explicit create-with-stock choice, the picker, an exact
 * scan, both negotiated-price modes, both invoice discount modes, and an
 * oversell rejection that leaves the cart available. The stocked path is
 * pinned separately for its required opening quantity and its focus move.
 */
test("scan create-with-stock refuses a blank or zero quantity and focuses it on a second scan", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `مسح-تصنيف-${stamp}`;
  const itemName = `مسح-بمخزون-${stamp}`;
  const firstUnknown = `REQ-A-${stamp}`;
  const secondUnknown = `REQ-B-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();

  // First unknown scan takes the PLAIN create path, which may stay open while
  // the next scan arrives — the stocked path must still land focus on stock.
  await page.keyboard.type(firstUnknown, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create").click();
  await expect(page.getByTestId("sale-quick-form")).toBeVisible();
  await expect(page.getByTestId("sale-quick-barcode")).toHaveValue(firstUnknown);
  // the plain path's quantity stays optional
  await expect(page.getByTestId("sale-quick-stock")).not.toHaveAttribute("aria-required", "true");

  await page.keyboard.type(secondUnknown, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create-stock").click();
  // same form, new code, and focus on the field the choice was made for
  await expect(page.getByTestId("sale-quick-barcode")).toHaveValue(secondUnknown);
  await expect(page.getByTestId("sale-quick-stock")).toBeFocused();
  await expect(page.getByTestId("sale-quick-stock")).toHaveAttribute("aria-required", "true");

  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");

  // blank must not create an unsellable item: the submit is refused by name
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-error")).toContainText("أدخل كمية مخزون أكبر من صفر");
  await expect(page.getByTestId("sale-quick-form")).toBeVisible();

  // an explicit 0 is refused on this path too
  await page.getByTestId("sale-quick-stock").fill("0");
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-error")).toContainText("أدخل كمية مخزون أكبر من صفر");
  await expect(page.getByTestId("sale-quick-form")).toBeVisible();

  // an unreadable value keeps the invalid-value message, distinct from the
  // required-quantity one
  await page.getByTestId("sale-quick-stock").fill("-1");
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-error")).toContainText("أدخل مخزوناً أولياً صحيحاً");
  await expect(page.getByTestId("sale-error")).not.toContainText("أدخل كمية مخزون أكبر من صفر");

  // a positive quantity records the opening movement and lines the item up
  await page.getByTestId("sale-quick-stock").fill("3");
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);

  // and that stock is real: the sale against it passes the stock check
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
});

test("sale checkout: an invalid price override outranks the payment it invalidates (#198)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `ترتيب-تصنيف-${stamp}`;
  const itemName = `ترتيب-منتج-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("sale-quick-stock").fill("5");
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);

  // A payment the override will invalidate: 999 is not the 1000 default, so the
  // pair's source pins to the amount and survives the total dropping to 13.
  await page.getByTestId("sale-paid").fill("999");
  await chooseSelectOption(page, page.getByTestId("sale-lines").getByLabel(`${itemName}: نوع تعديل السعر`), "مبلغ");
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: قيمة تعديل السعر`).fill("12.5");
  await expect(page.getByTestId("sale-total")).toContainText("13");

  // the fractional override is the real problem; the payment-vs-total check
  // must not shadow it, which is what the order invariant prevents
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-error")).toContainText("أدخل تعديلاً صحيحاً للسعر");
  await expect(page.getByTestId("sale-error")).not.toContainText("أدخل مبلغاً صحيحاً غير سالب");
  await expect(page.getByTestId("sale-saved")).toHaveCount(0);
});

test("sale checkout: scan, picker, negotiated prices, discounts, and oversell", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `بيع-تصنيف-${stamp}`;
  const itemName = `بيع-ممسوح-${stamp}`;
  const secondName = `بيع-نسبة-${stamp}`;
  const barcode = `SALE-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();

  // Unknown scan must open an explicit choice dialog; create-with-stock then
  // returns the new known item to the sale cart without an invoice.
  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create-stock").click();
  await expect(page.getByTestId("sale-quick-form")).toBeVisible();
  await expect(page.getByTestId("sale-quick-barcode")).toHaveValue(barcode);
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("sale-quick-stock").fill("5");
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);

  // A known exact scan adds immediately (rather than merely showing a toast).
  // The scanner intentionally suppresses an identical commit briefly; wait
  // beyond that window because the unknown scan used the same code.
  await page.waitForTimeout(1_300);
  await page.getByTestId("sale-save").blur();
  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`)).toHaveValue("2");

  // Manual picker search is the same catalog seam and adds another unit.
  await page.getByTestId("sale-open-picker").click();
  const picker = page.getByTestId("picker-dialog");
  await picker.getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await picker.getByRole("button", { name: new RegExp(itemName) }).first().click();
  await expect(page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`)).toHaveValue("3");

  // Amount negotiated price + amount invoice discount: 3 × 900 − 100.
  // Choosing an override type with an EMPTY value must not submit a free
  // (0 DZD) line: save is rejected, the error is shown, the cart stays intact.
  await chooseSelectOption(page, page.getByTestId("sale-lines").getByLabel(`${itemName}: نوع تعديل السعر`), "مبلغ");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-error")).toContainText("أدخل تعديلاً صحيحاً للسعر");
  await expect(page.getByTestId("sale-subtotal")).toContainText("3,000");
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: قيمة تعديل السعر`).fill("900");
  await chooseSelectOption(page, page.getByTestId("sale-discount-type"), "مبلغ");
  await page.getByTestId("sale-discount-value").fill("100");
  await expect(page.getByTestId("sale-subtotal")).toContainText("2,700");
  await expect(page.getByTestId("sale-total")).toContainText("2,600");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");

  // Start a second sale to exercise percentage line and invoice discounts.
  await page.getByTestId("sale-saved").getByRole("button", { name: "بيع جديد" }).click();
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(secondName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("300");
  await page.getByLabel("سعر البيع (دج)").fill("500");
  await page.getByTestId("sale-quick-barcode").fill(`SALE2-${stamp}`);
  await page.getByTestId("sale-quick-stock").fill("2");
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName: secondName,
    quantityLabel: "الكمية",
  });
  await expect(page.getByTestId("sale-lines")).toContainText(secondName);
  await chooseSelectOption(page, page.getByTestId("sale-lines").getByLabel(`${secondName}: نوع تعديل السعر`), "نسبة %");
  await page.getByTestId("sale-lines").getByLabel(`${secondName}: قيمة تعديل السعر`).fill("80");
  await chooseSelectOption(page, page.getByTestId("sale-discount-type"), "نسبة مئوية");
  await page.getByTestId("sale-discount-value").fill("10");
  await expect(page.getByTestId("sale-subtotal")).toContainText("400");
  await expect(page.getByTestId("sale-total")).toContainText("360");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");

  // Add only one unit of a fresh item, request two, and verify oversell is
  // rejected while the cart remains rendered for correction.
  await page.getByTestId("sale-saved").getByRole("button", { name: "بيع جديد" }).click();
  await page.getByTestId("sale-quick-add").click();
  await page.getByTestId("sale-quick-name").fill(`بيع-تجاوز-${stamp}`);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("100");
  await page.getByLabel("سعر البيع (دج)").fill("200");
  await page.getByTestId("sale-quick-stock").fill("1");
  const oversellName = `بيع-تجاوز-${stamp}`;
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName: oversellName,
    quantityLabel: "الكمية",
  });
  const oversellQty = page.getByTestId("sale-lines").getByLabel(`${oversellName}: الكمية`);
  await oversellQty.fill("2");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-error")).toContainText("الكمية غير متوفرة");
  await expect(oversellQty).toHaveValue("2");

  // A cleared quantity field must STAY cleared (the draft is not a controlled
  // number that snaps back), and saving with an empty/invalid quantity is
  // refused without corrupting the cart.
  await oversellQty.fill("");
  await expect(oversellQty).toHaveValue("");
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-error")).toContainText("أدخل كمية صحيحة");
  await expect(page.getByTestId("sale-lines")).toContainText(oversellName);
  // typing a fresh value after the cleared draft still works
  await oversellQty.fill("1");
  await expect(oversellQty).toHaveValue("1");
});

test("sale checkout: Arabic-Indic digits price the line and the discount like ASCII (#210)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `بيع-هندي-تصنيف-${stamp}`;
  const itemName = `بيع-هندي-${stamp}`;
  const barcode = `SALE-AR-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create-stock").click();
  await expect(page.getByTestId("sale-quick-form")).toBeVisible();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("sale-quick-stock").fill("5");
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });

  // Every money field typed with Arabic-Indic digits, the owner's keyboard
  // default: 5 × 900 = 4500, amount discount 100, total 4400.
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`).fill("٥");
  await chooseSelectOption(page, page.getByTestId("sale-lines").getByLabel(`${itemName}: نوع تعديل السعر`), "مبلغ");
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: قيمة تعديل السعر`).fill("٩٠٠");
  await chooseSelectOption(page, page.getByTestId("sale-discount-type"), "مبلغ");
  await page.getByTestId("sale-discount-value").fill("١٠٠");
  await expect(page.getByTestId("sale-subtotal")).toContainText("4,500");
  await expect(page.getByTestId("sale-total")).toContainText("4,400");

  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
});

test("sale checkout: a pasted bidi-marked Arabic-Indic draft reads like the typed one (#227)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `بيع-لصق-تصنيف-${stamp}`;
  const itemName = `بيع-لصق-${stamp}`;
  const barcode = `SALE-BIDI-${stamp}`;

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.keyboard.type(barcode, { delay: 8 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("unknown-scan-dialog")).toBeVisible();
  await page.getByTestId("scan-create-stock").click();
  await expect(page.getByTestId("sale-quick-form")).toBeVisible();
  await page.getByTestId("sale-quick-name").fill(itemName);
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByLabel("سعر الشراء (دج)").fill("400");
  await page.getByLabel("سعر البيع (دج)").fill("1000");
  await page.getByTestId("sale-quick-stock").fill("5");
  await saveQuickAdd(page, {
    procedure: "itemsCreateWithStock",
    save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
    error: page.getByTestId("sale-error"),
    lines: page.getByTestId("sale-lines"),
    itemName,
    quantityLabel: "الكمية",
  });

  // The paste shape: the invisible RIGHT-TO-LEFT MARK (U+200F) glued to the
  // front of Arabic-Indic digits, as the clipboard delivers a copy out of RTL
  // text. `fill` sets the value in one shot, the way a paste does. 5 × 900 =
  // 4500, amount discount 100, total 4400 — the numbers the typed #210 draft
  // gives, so a paste must not be refused where typing is accepted.
  const rlm = "\u200f";
  const quantity = page.getByTestId("sale-lines").getByLabel(`${itemName}: الكمية`);
  await quantity.fill(`${rlm}٥`);
  // the field really holds the invisible mark, so the pin cannot pass by
  // normalising the value before the parser ever sees it
  await expect(quantity).toHaveValue(`${rlm}٥`);
  await chooseSelectOption(page, page.getByTestId("sale-lines").getByLabel(`${itemName}: نوع تعديل السعر`), "مبلغ");
  const overrideValue = page.getByTestId("sale-lines").getByLabel(`${itemName}: قيمة تعديل السعر`);
  await overrideValue.fill(`${rlm}٩٠٠`);
  await expect(overrideValue).toHaveValue(`${rlm}٩٠٠`);
  await chooseSelectOption(page, page.getByTestId("sale-discount-type"), "مبلغ");
  const discountValue = page.getByTestId("sale-discount-value");
  await discountValue.fill(`${rlm}١٠٠`);
  await expect(discountValue).toHaveValue(`${rlm}١٠٠`);
  await expect(page.getByTestId("sale-subtotal")).toContainText("4,500");
  await expect(page.getByTestId("sale-total")).toContainText("4,400");

  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
});

test("sale checkout: a mark-only payment draft is blank, not a refusal (#238)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `دفع-تصنيف-${stamp}`;
  const amountItem = `دفع-مبلغ-${stamp}`;
  const percentageItem = `دفع-نسبة-${stamp}`;
  const rlm = "\u200f";

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  async function quickAdd(name: string, sell: string) {
    await page.getByTestId("sale-quick-add").click();
    await page.getByTestId("sale-quick-name").fill(name);
    await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
    await page.getByLabel("سعر الشراء (دج)").fill("400");
    await page.getByLabel("سعر البيع (دج)").fill(sell);
    await page.getByTestId("sale-quick-stock").fill("5");
    await saveQuickAdd(page, {
      procedure: "itemsCreateWithStock",
      save: page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }),
      error: page.getByTestId("sale-error"),
      lines: page.getByTestId("sale-lines"),
      itemName: name,
      quantityLabel: "الكمية",
    });
    await expect(page.getByTestId("sale-lines")).toContainText(name);
  }

  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();

  // A mark-only AMOUNT on the pair, the shape left after deleting the digits of
  // a pasted value. Before #238 the raw-trim guard read the invisible mark as a
  // chosen value and refused the save as «invalid payment»; the one shared
  // predicate reads it as blank = «nothing paid now», so the invoice saves with
  // the whole 1000 as debt.
  await quickAdd(amountItem, "1000");
  const paid = page.getByTestId("sale-paid");
  await paid.fill(rlm);
  // the field really holds the invisible mark, so the pin cannot pass by the
  // browser normalising it before the guard sees it
  await expect(paid).toHaveValue(rlm);
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  await expect(page.getByTestId("sale-saved-debt")).toContainText("1,000");

  // A mark-only PERCENTAGE is the same «not chosen» on the other side of the
  // pair: the amount clears and the save is recorded as unpaid, not refused by
  // the percentage guard.
  await page.getByTestId("sale-new").click();
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await quickAdd(percentageItem, "1000");
  const paidPercentage = page.getByTestId("sale-paid-percentage");
  await paidPercentage.fill(rlm);
  await expect(paidPercentage).toHaveValue(rlm);
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
  await expect(page.getByTestId("sale-saved-debt")).toContainText("1,000");
});
