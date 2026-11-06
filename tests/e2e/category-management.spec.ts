import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { actAndAck } from "./rpc-helpers";

test("searches all categories, preserves assignments on rename, and confirms safe deletion", async ({ page }) => {
  const stamp = Date.now();
  const categories = Array.from({ length: 2 }, (_, index) => `بحث شامل ${stamp} ${index}`);
  const target = categories.at(-1);
  if (target === undefined) throw new Error("category fixture is empty");
  const renamed = `تصنيف بعد التعديل ${stamp}`;
  const itemName = `منتج التصنيف ${stamp}`;
  await signIn(page);

  await page.goto("/categories");
  for (const name of categories) {
    await page.getByPlaceholder("اسم تصنيف جديد").fill(name);
    await actAndAck(page, "categoriesCreate", () => page.getByRole("button", { name: "إضافة" }).click());
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }

  await page.getByRole("searchbox", { name: "ابحث في التصنيفات…" }).fill(target);
  const targetRow = page.locator("li").filter({ hasText: target });
  await expect(targetRow).toBeVisible();
  await expect(page.locator("section ul > li")).toHaveCount(1);

  await page.goto("/items");
  await openItemsTab(page, "add");
  await page.getByLabel("الاسم", { exact: true }).fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("10");
  await page.getByLabel("سعر البيع (دج)").fill("20");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), target);
  await actAndAck(page, "itemsCreate", () => page.getByRole("button", { name: "حفظ" }).click());

  await page.goto("/categories");
  await page.getByRole("searchbox", { name: "ابحث في التصنيفات…" }).fill(target);
  const editRow = page.locator("li").filter({ hasText: target });
  await editRow.getByRole("button", { name: "تعديل الاسم" }).click();
  await page.getByRole("textbox", { name: `اسم التصنيف ${target}` }).fill(renamed);
  await actAndAck(page, "categoriesRename", () => page.getByRole("button", { name: "حفظ" }).click());
  await page.getByRole("searchbox", { name: "ابحث في التصنيفات…" }).fill(renamed);
  await expect(page.getByText(renamed, { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "products");
  const itemRow = page.getByRole("row", { name: new RegExp(itemName) });
  await expect(itemRow).toContainText(renamed);

  await page.goto("/categories");
  const unused = categories[0];
  if (unused === undefined) throw new Error("category fixture is empty");
  await page.getByRole("searchbox", { name: "ابحث في التصنيفات…" }).fill(unused);
  const unusedRow = page.locator("li").filter({ hasText: unused });
  await unusedRow.getByRole("button", { name: "حذف" }).click();
  await expect(unusedRow).toContainText(`حذف «${unused}»؟`);
  await unusedRow.getByRole("button", { name: "إلغاء" }).click();
  await expect(unusedRow).toBeVisible();
  await unusedRow.getByRole("button", { name: "حذف" }).click();
  await actAndAck(page, "categoriesDelete", () => unusedRow.getByRole("button", { name: "تأكيد الحذف" }).click());
  await expect(page.getByText(unused, { exact: true })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "ابحث في التصنيفات…" }).fill(renamed);
  const usedRow = page.locator("li").filter({ hasText: renamed });
  await usedRow.getByRole("button", { name: "حذف" }).click();
  await actAndAck(page, "categoriesDelete", () => usedRow.getByRole("button", { name: "تأكيد الحذف" }).click());
  await expect(page.getByRole("alert")).toContainText("مرتبط بـ 1 منتج");
  await expect(usedRow).toBeVisible();
  await page.goto("/items");
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: new RegExp(itemName) })).toContainText(renamed);
});
