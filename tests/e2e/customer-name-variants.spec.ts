import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { actAndAck } from "./rpc-helpers";

/**
 * #130 — the picker's duplicate-name warning folds alef/ya name variants, so a
 * record spelled slightly differently («على علي» vs «علي علي»، «احمد» vs
 * «أحمد») still warns before the owner creates a second debtor. It stays a
 * WARNING: the second record is created on request, and a name that differs by
 * a real letter is not flagged (the fold must not merge two people).
 *
 * The seeded customer has NO phone — the common walk-in — because that is the
 * case the pre-#130 rule let through silently.
 */

/** The unique party names this spec creates; afterEach returns them to zero. */
let cleanupPartyNames: string[] = [];

// Runs even when the test failed: the e2e DB is shared with later specs, so
// this spec must not leave records behind wherever it stopped.
test.afterEach(async ({ page }) => {
  const names = cleanupPartyNames;
  cleanupPartyNames = [];
  if (names.length === 0) return;
  await page.goto("/customers");
  await expect(page.getByTestId("parties-page-customer")).toBeVisible();
  for (const name of names) {
    await page.getByTestId("parties-search").fill(name);
    const row = page.getByTestId("party-row").filter({ hasText: name });
    if ((await row.count()) === 0) continue;
    await row.getByTestId("party-row-delete").click();
    await page.getByTestId("party-delete-confirm").click();
    await expect(page.getByTestId("parties-notice")).toContainText("تم الحذف");
  }
});

test("picker warns on an alef/ya name variant and still creates the second record", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const storedName = `علي علي-${stamp}`; // stored with ي
  const variantName = `على علي-${stamp}`; // typed with alef maqsura ى
  const differentName = `علا علي-${stamp}`; // one real letter different (ع vs ي)
  cleanupPartyNames = [storedName, variantName];

  // 1. seed the stored spelling from the customers page (that form has no
  //    duplicate-name warning, so the picker below is what is under test)
  await page.goto("/customers");
  await expect(page.getByTestId("parties-page-customer")).toBeVisible();
  await page.getByTestId("party-new").click();
  await page.getByTestId("party-form-name").fill(storedName);
  await actAndAck(page, "customersCreate", () => page.getByTestId("party-form-save").click());
  await expect(page.getByTestId("parties-notice")).toContainText("تم الحفظ");

  // 2. the sale picker: creating the variant spelling warns first, naming the
  //    stored record...
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(variantName);
  await page.getByTestId("sale-customer-create").click();
  const warning = page.getByTestId("sale-customer-duplicate");
  await expect(warning).toContainText(storedName);
  // the stored record has no phone, so the copy must not claim a different one
  await expect(warning).toContainText("بلا هاتف");
  // a variant spelling is not the exact-name gate: the identity refusal stays off
  await expect(page.getByTestId("sale-customer-needs-choice")).toHaveCount(0);

  // ...and does not block: the save stays enabled and the variant is created
  await expect(page.getByTestId("sale-customer-create-save")).toBeEnabled();
  await actAndAck(page, "customersCreate", () => page.getByTestId("sale-customer-create-save").click());
  await expect(page.getByTestId("sale-customer")).toHaveValue(variantName);

  // 3. both spellings now exist as two records: the warning neither merged them
  //    nor stopped the deliberate second customer
  await page.goto("/customers");
  await page.getByTestId("parties-search").fill(stamp);
  await expect(page.getByTestId("party-row").filter({ hasText: storedName })).toHaveCount(1);
  await expect(page.getByTestId("party-row").filter({ hasText: variantName })).toHaveCount(1);

  // 4. negative control: a name differing by a real letter is NOT a variant
  //    (the fold must not widen past spelling variants)
  await page.goto("/sale");
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(differentName);
  await page.getByTestId("sale-customer-create").click();
  await expect(page.getByTestId("sale-customer-duplicate")).toHaveCount(0);
  await expect(page.getByTestId("sale-customer-create-save")).toBeEnabled();
});
