import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./auth-helpers";

/**
 * Issue #129 — a party phone is an identity key (ADR-0007), so text that is not
 * a phone must be refused at the boundary with clear Arabic copy, while the
 * owner's Arabic keyboard's digits (٠١٢٣…) are accepted and normalised to
 * Western. This spec creates zero-invoice records only and deletes them at the
 * end, so the shared e2e database is left as it was found (later specs assert
 * global debt totals — wisdom 2026-10-01-identity-keys-and-backfill).
 */

/** ASCII digits to Arabic-Indic (٠-٩), what the owner's Arabic keyboard emits. */
const toArabicDigits = (value: string): string =>
  value.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));

/** Delete a zero-invoice party through the customers page (the delete rule). */
async function deleteParty(page: Page, name: string): Promise<void> {
  await page.goto("/customers");
  const row = page.getByTestId("party-row").filter({ hasText: name });
  await row.getByTestId("party-row-delete").click();
  await page.getByTestId("party-delete-confirm").click();
  await expect(page.getByTestId("party-row").filter({ hasText: name })).toHaveCount(0);
}

test("phone identity: non-numeric text is refused, Arabic-Indic digits are accepted", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const refusedName = `هاتف-مرفوض-${stamp}`;
  const arabicName = `هاتف-عربي-${stamp}`;
  const pickerName = `هاتف-منتقي-${stamp}`;
  // a valid unique Algerian mobile: 0567 + six stamp digits, written with the
  // Arabic keyboard's digits and expected back as the Western local form
  const localPhone = `0567${stamp.slice(-6)}`;
  const arabicPhone = toArabicDigits(localPhone);
  // the picker needs its OWN valid number: a phone another record already owns
  // is a different refusal (party-phone-taken), not the rule under test
  const pickerArabicPhone = toArabicDigits(`0571${stamp.slice(-6)}`);

  // 1. the create dialog refuses non-numeric phone text with Arabic copy...
  await page.goto("/customers");
  await page.getByTestId("party-new").click();
  await page.getByTestId("party-form-name").fill(refusedName);
  await page.getByTestId("party-form-phone").fill("abc");
  await page.getByTestId("party-form-save").click();
  await expect(page.getByTestId("party-form-error")).toContainText("أرقام");
  // ...and writes nothing
  await page.getByTestId("party-form-cancel").click();
  await expect(page.getByTestId("party-row").filter({ hasText: refusedName })).toHaveCount(0);

  // 2. Arabic-Indic digits are accepted and normalise to the Western local form
  await page.getByTestId("party-new").click();
  await page.getByTestId("party-form-name").fill(arabicName);
  await page.getByTestId("party-form-phone").fill(arabicPhone);
  await page.getByTestId("party-form-save").click();
  const arabicRow = page.getByTestId("party-row").filter({ hasText: arabicName });
  await expect(arabicRow).toBeVisible();
  await expect(arabicRow).toContainText(localPhone);

  // 3. the edit dialog refuses the same text, keeping the stored identity
  await arabicRow.getByTestId("party-row-edit").click();
  await page.getByTestId("party-form-phone").fill("هاتف");
  await page.getByTestId("party-form-save").click();
  await expect(page.getByTestId("party-form-error")).toContainText("أرقام");
  await page.getByTestId("party-form-cancel").click();
  await expect(page.getByTestId("party-row").filter({ hasText: arabicName })).toContainText(localPhone);

  // 4. the sale picker's inline create refuses non-numeric and accepts Arabic-Indic
  await page.getByRole("link", { name: "المبيعات" }).click();
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(pickerName);
  await page.getByTestId("sale-customer-create").click();
  await page.getByTestId("sale-customer-create-phone").fill("12a34");
  await expect(page.getByTestId("sale-customer-invalid-phone")).toContainText("أرقام");
  await expect(page.getByTestId("sale-customer-create-save")).toBeDisabled();
  await page.getByTestId("sale-customer-create-phone").fill(pickerArabicPhone);
  await expect(page.getByTestId("sale-customer-invalid-phone")).toHaveCount(0);
  await page.getByTestId("sale-customer-create-save").click();
  await expect(page.getByTestId("sale-customer")).toHaveValue(pickerName);

  // cleanup: both are zero-invoice records, so the delete rule allows it
  await deleteParty(page, arabicName);
  await deleteParty(page, pickerName);
});
