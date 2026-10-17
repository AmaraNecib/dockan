import { expect, test } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { expectSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/**
 * E2E smoke: real flows (category + item creation) land entries in
 * the activity log screen, newest first, in Arabic.
 * Unique names per the parallel-specs shared-DB rule (wisdom 2026-08-24).
 */
test("activity log lists real-flow entries newest first", async ({ page }) => {
  // sign in (first-run setup on a clean room, login afterwards)
  await signIn(page);

  // real flow: create a category then an item
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill("سجل-تصنيف-12");
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText("سجل-تصنيف-12", { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await expectSelectOption(page, page.getByLabel("التصنيف"), "سجل-تصنيف-12");
  await page.getByLabel("الاسم", { exact: true }).fill("سجل-منتج-12");
  await page.getByLabel("سعر الشراء (دج)").fill("300");
  await page.getByLabel("سعر البيع (دج)").fill("500");
  await page.getByRole("button", { name: "حفظ" }).click();
  await openItemsTab(page, "products");
  await expect(page.getByRole("row", { name: /سجل-منتج-12/ })).toBeVisible();

  // the log shows both events, newest (the item) first
  await page.goto("/activity");
  const rows = page.getByTestId("activity-table").locator("tbody tr");
  await expect(rows.first()).toContainText("إنشاء منتج");
  await expect(rows.first()).toContainText("سجل-منتج-12");
  // the item creation carries its related item id as a ref, and the ref is a
  // link to the record (#253) rather than a bare id
  await expect(rows.nth(1)).toContainText("إنشاء تصنيف");
  await expect(rows.first().getByTestId("activity-ref")).not.toHaveText("—");
  const ref = rows.first().getByTestId("activity-ref-link");
  await expect(ref).toBeVisible();
  await ref.click();
  await expect(page).toHaveURL(/\/items\/.+\/history/);
});

/**
 * #253 — the raw-key rows. The acceptance sentence (`SUPPLIER_OPENING_BALANCE
 * THEY_OWE 100000 <name>` → an Arabic sentence naming the supplier) is pinned by
 * `activity.test.tsx` (exact string, both directions) and by the before/after
 * screenshots in `.scratch/reviews/253/`, NOT by an e2e seed here: an opening
 * balance adds a supplier account to the shared e2e database, which changes the
 * global /debts totals that `debts.spec.ts` (`1200 دج`, count 1) and
 * `supplier-adjustment.spec.ts` (net-credit group) assert. The suite's own
 * pre-existing opening-balance rows already prove the flow end to end.
 */
