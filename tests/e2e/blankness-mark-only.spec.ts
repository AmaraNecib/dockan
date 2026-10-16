import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * #244 — a mark-only (bidi-mark) paste in a numeric field is *blank*, not a
 * chosen-but-invalid value. The items threshold is the screen path: before the
 * conversion a raw `.trim()` gate read `"\u200f"` as a chosen threshold and then
 * the strict reader refused it (`itemsThresholdInvalid`), so the save failed.
 * After, blankness goes through `draftBlank` and the field takes its `5` default.
 * The unit ratchet holds the class; this proves the user-facing flow once.
 */
test("a mark-only threshold is blank: the item saves with the default (#244)", async ({ page }) => {
  const stamp = Date.now().toString();
  const categoryName = `حد-تصنيف-${stamp}`;
  const itemName = `حد-منتج-${stamp}`;

  await signIn(page);

  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("100");
  await page.getByLabel("سعر البيع (دج)").fill("200");
  // the bidi mark is a paste artefact, not a value: blankness must read it as
  // «nothing chosen», so the 5 default applies and the save is accepted
  await page.getByLabel("حد التنبيه").fill("\u200f");
  await page.getByTestId("item-save").click();

  // the success reset proves the save was accepted, not refused with an error
  await expect(page.getByTestId("item-name")).toHaveValue("");
  await openItemsTab(page, "products");
  await expect(page.locator("tr").filter({ has: page.getByRole("cell", { name: itemName, exact: true }) })).toBeVisible();
});
