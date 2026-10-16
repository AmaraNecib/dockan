import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./auth-helpers";
import { actAndAck, readRpc } from "./rpc-helpers";

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

/** The declared output of `customersList` that this spec reads. */
type CustomerListPayload = { items: Array<{ name: string; phone: string | null }> };

/**
 * Load the list route and return the server's `customersList` payload. Presence
 * and stored identity are taken from a server read, never from the DOM: the
 * list renders while the query is still pending, and a negative DOM check
 * (`toHaveCount(0)`, `toBe(false)`) can pass while that pending query would
 * still find the row — and `displayAlgerianPhone` folds the raw value at
 * render, so the DOM cannot prove normalisation either (#189, #209 review).
 */
async function readCustomers(page: Page): Promise<CustomerListPayload> {
  // Navigate first, then read the server list directly. Arming an ack around
  // the `goto` matched a `customersList` response issued by the document being
  // replaced, and Playwright discarded its body ("navigated away from") before
  // the ack could read it — the #209 CI failure. `readRpc` has no such body.
  await page.goto("/customers");
  return readRpc<CustomerListPayload>(page, "customersList");
}

/** Delete a party the currently-loaded list shows, awaiting THIS deletion's ack. */
async function removePartyRow(page: Page, name: string): Promise<void> {
  await page.getByTestId("parties-search").fill(name);
  const row = page.getByTestId("party-row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByTestId("party-row-delete").click();
  // await THIS deletion's acknowledgement: the success notice survives into the
  // next dialog, so it proves nothing about this one (#189 review)
  await actAndAck(page, "customersDelete", () => page.getByTestId("party-delete-confirm").click());
  await expect(row).toHaveCount(0);
}

/** Load the list, then delete the named zero-invoice party. */
async function deleteParty(page: Page, name: string): Promise<void> {
  await readCustomers(page);
  await removePartyRow(page, name);
}

/** The records this spec creates; afterEach returns the shared DB even on failure. */
let cleanupNames: string[] = [];

test.afterEach(async ({ page }) => {
  const names = cleanupNames;
  cleanupNames = [];
  if (names.length === 0) return;
  // Presence from the ACKED server list, not a row count that can read zero
  // while the page is still loading and skip a saved customer (#209 review).
  const before = await readCustomers(page);
  for (const name of names) {
    if (before.items.some((party) => party.name === name)) await removePartyRow(page, name);
  }
  // Prove the SERVER lost them: a fresh read must not return any name. A
  // delete that failed behind an optimistic row removal, or a name this hook
  // skipped, fails the test here instead of leaking into later specs' shared
  // database (#189 review).
  const after = await readCustomers(page);
  expect(after.items.filter((party) => names.includes(party.name)).map((party) => party.name)).toEqual([]);
});

test("phone identity: non-numeric text is refused, Arabic-Indic digits are accepted", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const refusedName = `هاتف-مرفوض-${stamp}`;
  const arabicName = `هاتف-عربي-${stamp}`;
  // the picker's query text and the record it creates are deliberately different
  // names: the combobox after saving can then only carry the created RECORD's
  // name, which a save that skipped the selection can never produce (#209).
  const pickerQuery = `هاتف-منتقي-${stamp}`;
  const pickerName = `هاتف-منتقي-محفوظ-${stamp}`;
  // a valid unique Algerian mobile: 0567 + six stamp digits, written with the
  // Arabic keyboard's digits and expected back as the Western local form
  const localPhone = `0567${stamp.slice(-6)}`;
  const arabicPhone = toArabicDigits(localPhone);
  // the canonical identity the store must persist (ADR-0007); the row renders
  // the local form either way, so only this proves normalisation happened
  const arabicCanonical = `+213${localPhone.slice(1)}`;
  // the picker needs its OWN valid number: a phone another record already owns
  // is a different refusal (party-phone-taken), not the rule under test
  const pickerLocalPhone = `0571${stamp.slice(-6)}`;
  const pickerArabicPhone = toArabicDigits(pickerLocalPhone);
  const pickerCanonical = `+213${pickerLocalPhone.slice(1)}`;
  // refusedName should never be written; tracking it means a regression that
  // DOES create it both fails the write-nothing assertion and is cleaned up
  // instead of leaking into the shared database (#209 review)
  cleanupNames = [refusedName, arabicName, pickerName];

  // 1. the create dialog refuses non-numeric phone text with Arabic copy...
  await page.goto("/customers");
  await page.getByTestId("party-new").click();
  await page.getByTestId("party-form-name").fill(refusedName);
  await page.getByTestId("party-form-phone").fill("abc");
  await page.getByTestId("party-form-save").click();
  await expect(page.getByTestId("party-form-error")).toContainText("أرقام");
  await page.getByTestId("party-form-cancel").click();
  // ...and writes nothing: a fresh SERVER read must not carry the name (a row
  // count against the un-invalidated list would pass without proving anything)
  const refused = await readCustomers(page);
  expect(refused.items.some((party) => party.name === refusedName)).toBe(false);

  // 2. Arabic-Indic digits are accepted and normalise to the canonical +213
  // form, asserted from the ACKED payload (see `readCustomers`)
  await page.getByTestId("party-new").click();
  await page.getByTestId("party-form-name").fill(arabicName);
  await page.getByTestId("party-form-phone").fill(arabicPhone);
  await actAndAck(page, "customersCreate", () => page.getByTestId("party-form-save").click());
  const created = await readCustomers(page);
  expect(created.items.find((party) => party.name === arabicName)?.phone).toBe(arabicCanonical);
  const arabicRow = page.getByTestId("party-row").filter({ hasText: arabicName });
  await expect(arabicRow).toBeVisible();

  // 3. the edit dialog refuses the same text, keeping the stored identity
  await arabicRow.getByTestId("party-row-edit").click();
  await page.getByTestId("party-form-phone").fill("هاتف");
  await page.getByTestId("party-form-save").click();
  await expect(page.getByTestId("party-form-error")).toContainText("أرقام");
  await page.getByTestId("party-form-cancel").click();
  const afterEdit = await readCustomers(page);
  expect(afterEdit.items.find((party) => party.name === arabicName)?.phone).toBe(arabicCanonical);

  // 4. the sale picker's inline create refuses non-numeric and accepts Arabic-Indic
  await page.getByRole("link", { name: "المبيعات" }).click();
  await expect(page.getByTestId("sale-form")).toBeVisible();
  await page.getByTestId("sale-customer").fill(pickerQuery);
  await page.getByTestId("sale-customer-create").click();
  await page.getByTestId("sale-customer-create-name").fill(pickerName);
  await page.getByTestId("sale-customer-create-phone").fill("12a34");
  await expect(page.getByTestId("sale-customer-invalid-phone")).toContainText("أرقام");
  await expect(page.getByTestId("sale-customer-create-save")).toBeDisabled();
  await page.getByTestId("sale-customer-create-phone").fill(pickerArabicPhone);
  await expect(page.getByTestId("sale-customer-invalid-phone")).toHaveCount(0);
  await expect(page.getByTestId("sale-customer-create-save")).toBeEnabled();
  await actAndAck(page, "customersCreate", () => page.getByTestId("sale-customer-create-save").click());
  // The selection landed: the inline panel closed AND the combobox now carries
  // the created RECORD's name, not the query text it held before saving. A bare
  // `toHaveValue(pickerQuery)` would pass before the save even finished (#209).
  await expect(page.getByTestId("sale-customer-create-panel")).toHaveCount(0);
  await expect(page.getByTestId("sale-customer")).toHaveValue(pickerName);
  // the inline create stored the Arabic-Indic number in canonical form too
  const pickerList = await readCustomers(page);
  expect(pickerList.items.find((party) => party.name === pickerName)?.phone).toBe(pickerCanonical);

  // cleanup: both are zero-invoice records, so the delete rule allows it
  await deleteParty(page, arabicName);
  await deleteParty(page, pickerName);
});
