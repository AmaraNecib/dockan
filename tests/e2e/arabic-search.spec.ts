import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";
import { actAndAck } from "./rpc-helpers";

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
  const categoryName = `ك-بحث-${stamp}`;
  const lyousItem = `ليوز-${stamp}`;
  const ahmedItem = `أحمد-${stamp}`;
  const mustafaItem = `مصطفى-${stamp}`;
  const batteryItem = `بطاريه-${stamp}`;
  const articleItem = `البطاريه-${stamp}`;
  const unrelatedItem = `مفتاح-${stamp}`;
  const lyousParty = `ليوز-زبون-${stamp}`;
  const articleParty = `الهاتف-${stamp}`;
  const unrelatedParty = `مفتاح-زبون-${stamp}`;

  // 1. seed a category + four items; three differ in spelling from their query
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  for (const name of [lyousItem, ahmedItem, mustafaItem, batteryItem, articleItem, unrelatedItem]) {
    await openItemsTab(page, "add");
    await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
    await page.getByTestId("item-name").fill(name);
    await page.getByLabel("سعر الشراء (دج)").fill("100");
    await page.getByLabel("سعر البيع (دج)").fill("150");
    // await the server ack before searching: a search that races its own create
    // legitimately matches nothing and flickers the empty state (issue 179)
    await actAndAck(page, "itemsCreate", () => page.getByTestId("item-save").click());
    await openItemsTab(page, "products");
  }

  // 2. the owner's case: «اليوز» finds «ليوز» (article + bare alef), and the
  //    unrelated item is not dragged in. The catalog search is a server read,
  //    so every fill awaits its response too: a slow read under CI load must
  //    not be mistaken for a missing match (issue 179).
  const search = page.getByTestId("catalog-search");
  const results = page.getByTestId("search-results");
  /** This spec's own result row; another spec's catalog can never satisfy or
   * break an assertion meant for the stamped item (issue 179). */
  const resultRow = (name: string) => results.getByText(name, { exact: true });

  await actAndAck(page, "catalogSearch", () => search.fill("اليوز"));
  await expect(resultRow(lyousItem)).toBeVisible();
  await expect(resultRow(unrelatedItem)).toHaveCount(0);

  // 3. «احمد» finds «أحمد»; «مصطفي» finds «مصطفى»
  await actAndAck(page, "catalogSearch", () => search.fill("احمد"));
  await expect(resultRow(ahmedItem)).toBeVisible();
  await actAndAck(page, "catalogSearch", () => search.fill("مصطفي"));
  await expect(resultRow(mustafaItem)).toBeVisible();

  // 3b. typo tolerance is only a fallback: a one-letter slip still finds it
  await actAndAck(page, "catalogSearch", () => search.fill("بطلرية"));
  await expect(resultRow(batteryItem)).toBeVisible();

  // 3c. a short article-prefixed query still finds the article-prefixed name
  //     (Greptile round 1: the stem guard used to hide it). `batteryItem` is a
  //     fuzzy hit of the previous query and NOT a hit of «الب», so its absence
  //     proves the list belongs to the new query and not a stale render.
  await actAndAck(page, "catalogSearch", () => search.fill("الب"));
  await expect(resultRow(articleItem)).toBeVisible();
  await expect(resultRow(batteryItem)).toHaveCount(0);
  await expect(resultRow(unrelatedItem)).toHaveCount(0);

  // 4. the customers list uses the same fold: «اليوز» finds «ليوز…» only
  await page.getByRole("link", { name: "الزبائن", exact: true }).first().click();
  await expect(page.getByTestId("parties-page-customer")).toBeVisible();
  for (const name of [lyousParty, articleParty, unrelatedParty]) {
    await page.getByTestId("party-new").click();
    await page.getByTestId("party-form-name").fill(name);
    await actAndAck(page, "customersCreate", () => page.getByTestId("party-form-save").click());
    await expect(page.getByTestId("parties-notice")).toContainText("تم الحفظ");
  }

  await page.getByTestId("parties-search").fill("اليوز");
  await expect(page.getByTestId("party-row").filter({ hasText: lyousParty })).toBeVisible();
  await expect(page.getByTestId("party-row").filter({ hasText: unrelatedParty })).toHaveCount(0);

  // a short article-prefixed query still finds the article-prefixed party
  await page.getByTestId("parties-search").fill("اله");
  await expect(page.getByTestId("party-row").filter({ hasText: articleParty })).toBeVisible();
  await expect(page.getByTestId("party-row").filter({ hasText: unrelatedParty })).toHaveCount(0);

  // typed exactly as stored, the same row is still the only match
  await page.getByTestId("parties-search").fill("ليوز");
  await expect(page.getByTestId("party-row").filter({ hasText: lyousParty })).toBeVisible();
  await expect(page.getByTestId("party-row").filter({ hasText: unrelatedParty })).toHaveCount(0);
});
