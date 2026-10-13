import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * #165 — Arabic search folds alef/ya variants and the definite article.
 * The owner types «اليوز» (article included) and must find «ليوز…» in both the
 * catalog search and the customers list. The alef/ya cases are asserted too,
 * and an unrelated record must stay out of the results (the fold widens
 * matching, so a negative assertion is what proves it did not widen too far).
 */
test("arabic search folds alef/ya and the definite article in items and parties", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `بحث-${stamp}`;
  const lyousItem = `ليوز-${stamp}`;
  const ahmedItem = `أحمد-${stamp}`;
  const mustafaItem = `مصطفى-${stamp}`;
  const batteryItem = `بطارية-${stamp}`;
  const unrelatedItem = `مفتاح-${stamp}`;
  const lyousParty = `ليوز-زبون-${stamp}`;
  const unrelatedParty = `مفتاح-زبون-${stamp}`;

  // 1. seed a category + four items; three differ in spelling from their query
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  for (const name of [lyousItem, ahmedItem, mustafaItem, batteryItem, unrelatedItem]) {
    await openItemsTab(page, "add");
    await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
    await page.getByTestId("item-name").fill(name);
    await page.getByLabel("سعر الشراء (دج)").fill("100");
    await page.getByLabel("سعر البيع (دج)").fill("150");
    await page.getByTestId("item-save").click();
    await openItemsTab(page, "products");
  }

  // 2. the owner's case: «اليوز» finds «ليوز» (article + bare alef), and the
  //    unrelated item is not dragged in
  const search = page.getByTestId("catalog-search");
  await search.fill("اليوز");
  await expect(page.getByTestId("search-results")).toContainText(lyousItem);
  await expect(page.getByTestId("search-results")).not.toContainText(unrelatedItem);

  // 3. «احمد» finds «أحمد»; «مصطفي» finds «مصطفى»
  await search.fill("احمد");
  await expect(page.getByTestId("search-results")).toContainText(ahmedItem);
  await search.fill("مصطفي");
  await expect(page.getByTestId("search-results")).toContainText(mustafaItem);

  // 3b. typo tolerance is only a fallback: a one-letter slip still finds it
  await search.fill("بطلرية");
  await expect(page.getByTestId("search-results")).toContainText(batteryItem);

  // 4. the customers list uses the same fold: «اليوز» finds «ليوز…» only
  await page.getByRole("link", { name: "الزبائن", exact: true }).first().click();
  await expect(page.getByTestId("parties-page-customer")).toBeVisible();
  for (const name of [lyousParty, unrelatedParty]) {
    await page.getByTestId("party-new").click();
    await page.getByTestId("party-form-name").fill(name);
    await page.getByTestId("party-form-save").click();
    await expect(page.getByTestId("parties-notice")).toContainText("تم الحفظ");
  }

  await page.getByTestId("parties-search").fill("اليوز");
  await expect(page.getByTestId("party-row").filter({ hasText: lyousParty })).toBeVisible();
  await expect(page.getByTestId("party-row").filter({ hasText: unrelatedParty })).toHaveCount(0);

  // typed exactly as stored, the same row is still the only match
  await page.getByTestId("parties-search").fill("ليوز");
  await expect(page.getByTestId("party-row").filter({ hasText: lyousParty })).toBeVisible();
  await expect(page.getByTestId("party-row").filter({ hasText: unrelatedParty })).toHaveCount(0);
});
