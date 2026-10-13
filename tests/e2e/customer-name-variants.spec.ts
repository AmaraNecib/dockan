import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { actAndAck } from "./rpc-helpers";

/**
 * #130 — the picker's duplicate-name warning folds alef/ya name variants, so a
 * record spelled slightly differently («على علي» vs «علي علي»، «احمد» vs
 * «أحمد») still warns before the owner creates a second debtor. It stays a
 * WARNING: the second record is created on request, and a name that differs by
 * a real letter is not flagged (the fold must not merge two people).
 */
test("picker warns on an alef/ya name variant and still creates the second record", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const storedName = `علي علي-${stamp}`; // stored with ي
  const variantName = `على علي-${stamp}`; // typed with alef maqsura ى
  const differentName = `علا علي-${stamp}`; // one real letter different (ع vs ي)
  // a valid Algerian mobile, unique per run: 0567 + six stamp digits
  const phone = `0567${stamp.slice(-6)}`;

  // 1. seed the stored spelling from the customers page (that form has no
  //    duplicate-name warning, so the picker below is what is under test)
  await page.goto("/customers");
  await expect(page.getByTestId("parties-page-customer")).toBeVisible();
  await page.getByTestId("party-new").click();
  await page.getByTestId("party-form-name").fill(storedName);
  await page.getByTestId("party-form-phone").fill(phone);
  await actAndAck(page, "customersCreate", () => page.getByTestId("party-form-save").click());
  await expect(page.getByTestId("parties-notice")).toContainText("تم الحفظ");

  // 2. the sale picker: the variant spelling already offers the stored record,
  //    because the list filter folds the same way (issue 165)
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(variantName);
  await expect(page.getByTestId("sale-customer-option").first()).toContainText(storedName);

  // 3. creating anyway warns first, naming the stored spelling...
  await page.getByTestId("sale-customer-create").click();
  const warning = page.getByTestId("sale-customer-duplicate");
  await expect(warning).toContainText(storedName);
  // ...and does not block: the save stays enabled and the variant is created
  await expect(page.getByTestId("sale-customer-create-save")).toBeEnabled();
  await actAndAck(page, "customersCreate", () => page.getByTestId("sale-customer-create-save").click());
  await expect(page.getByTestId("sale-customer")).toHaveValue(variantName);

  // 4. both spellings now exist as two records with no invoices: the warning
  //    neither merged them nor stopped the deliberate second customer
  await page.goto("/customers");
  await page.getByTestId("parties-search").fill(stamp);
  await expect(page.getByTestId("party-row").filter({ hasText: storedName })).toHaveCount(1);
  await expect(page.getByTestId("party-row").filter({ hasText: variantName })).toHaveCount(1);

  // 5. negative control: a name differing by a real letter is NOT a variant
  //    (the fold must not widen past spelling variants)
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(differentName);
  await page.getByTestId("sale-customer-create").click();
  await expect(page.getByTestId("sale-customer-duplicate")).toHaveCount(0);
  await expect(page.getByTestId("sale-customer-create-save")).toBeEnabled();

  // 6. cleanup: both records have zero invoices, so both delete. The e2e DB is
  //    shared with later specs, which assert global debt totals.
  await page.goto("/customers");
  for (const name of [storedName, variantName]) {
    await page.getByTestId("parties-search").fill(name);
    const row = page.getByTestId("party-row").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await row.getByTestId("party-row-delete").click();
    await page.getByTestId("party-delete-confirm").click();
    await expect(page.getByTestId("parties-notice")).toContainText("تم الحذف");
  }
});
