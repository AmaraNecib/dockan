import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";

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
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  await expect(page.getByTestId("sale-lines")).toContainText(itemName);

  // and that stock is real: the sale against it passes the stock check
  await page.getByTestId("sale-save").click();
  await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
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
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
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
  await expect(page.getByTestId("sale-subtotal")).toContainText("3000");
  await page.getByTestId("sale-lines").getByLabel(`${itemName}: قيمة تعديل السعر`).fill("900");
  await chooseSelectOption(page, page.getByTestId("sale-discount-type"), "مبلغ");
  await page.getByTestId("sale-discount-value").fill("100");
  await expect(page.getByTestId("sale-subtotal")).toContainText("2700");
  await expect(page.getByTestId("sale-total")).toContainText("2600");
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
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
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
  await page.getByTestId("sale-quick-form").getByRole("button", { name: "حفظ المنتج وإضافته" }).click();
  const oversellName = `بيع-تجاوز-${stamp}`;
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
