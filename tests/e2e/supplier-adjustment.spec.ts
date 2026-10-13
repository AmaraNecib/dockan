import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { openItemsTab } from "./items-helpers";

/** The inputs this spec sends over the issue-184 RPC helper. */
type RpcInput =
  | { name: string }
  | { id: string }
  | { supplierId: string; direction: "WE_OWE" | "THEY_OWE"; amount: number; reason: string; occurredAt: string };

/** Call one oRPC procedure from the page and return its output (issue 184). */
async function rpc<T>(page: Page, procedure: string, json: RpcInput): Promise<T> {
  const result = await page.evaluate(
    async ({ procedure, json }) => {
      const response = await fetch(`/api/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json }),
      });
      if (!response.ok) throw new Error(`${procedure} failed with HTTP ${response.status}`);
      // SAFETY: the oRPC fetch link answers a successful procedure call with the
      // `{ json: <declared output> }` envelope
      const body = (await response.json()) as { json: unknown };
      return body.json;
    },
    { procedure, json },
  );
  // SAFETY: the caller's T names the procedure's declared output, which the
  // envelope carries
  return result as T;
}

/**
 * #176 — supplier adjustments (تسوية) and the bulk opening-balance screen
 * (رصيد افتتاحي). Records an opening balance from the bulk screen, then an
 * invoice-linked خصم on the supplier page, and checks that the account balance
 * and the invoice's remaining agree.
 */
test("supplier adjustment: a bulk رصيد افتتاحي and a linked خصم agree with the invoice", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryName = `تسوية-تصنيف-${stamp}`;
  const itemName = `تسوية-منتج-${stamp}`;
  const supplierName = `تسوية-مورد-${stamp}`;
  const openingSupplierName = `رصيد-افتتاحي-مورد-${stamp}`;

  // 1. seed a category + item (cost 1000)
  await page.goto("/categories");
  await page.getByPlaceholder("اسم تصنيف جديد").fill(categoryName);
  await page.getByRole("button", { name: "إضافة" }).click();
  await expect(page.getByText(categoryName, { exact: true })).toBeVisible();

  await page.goto("/items");
  await openItemsTab(page, "add");
  await chooseSelectOption(page, page.getByLabel("التصنيف"), categoryName);
  await page.getByTestId("item-name").fill(itemName);
  await page.getByLabel("سعر الشراء (دج)").fill("1000");
  await page.getByLabel("سعر البيع (دج)").fill("1500");
  await page.getByTestId("item-save").click();

  // 2. purchase 5 units @1000 from a NEW supplier (paid 0 → the whole 5000 owed)
  await page.getByRole("link", { name: "المشتريات" }).click();
  await expect(page.getByTestId("purchase-form")).toBeVisible();
  await page.getByTestId("purchase-supplier").fill(supplierName);
  await page.getByTestId("purchase-supplier-create").click();
  await page.getByTestId("purchase-supplier-create-name").fill(supplierName);
  await page.getByTestId("purchase-supplier-create-save").click();

  await page.getByTestId("purchase-open-picker").click();
  await page.getByTestId("picker-dialog").getByPlaceholder("ابحث بالاسم أو الباركود…").fill(itemName);
  await page.getByTestId("picker-dialog").getByRole("button", { name: new RegExp(itemName) }).first().click();
  await page.getByTestId("purchase-lines").getByLabel(`${itemName}: الكمية`).fill("5");
  await page.getByTestId("purchase-paid").fill("0");
  await page.getByTestId("purchase-save").click();
  await expect(page.getByTestId("purchase-saved-number")).toContainText("INV-");
  // SAFETY: the saved card always formats invoice numbers as INV-<digits>
  const invoiceNumber = (await page.getByTestId("purchase-saved-number").innerText()).match(/INV-\d+/)![0]!;

  // 3. the bulk رصيد افتتاحي screen: create a supplier inline with 800 نسالوه
  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-new-name").fill(openingSupplierName);
  await page.getByTestId("opening-balance-new-amount").fill("800");
  await page.getByTestId("opening-balance-save").click();

  const saved = page.getByTestId("opening-balance-saved");
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(openingSupplierName);
  await expect(saved).toContainText("800 دج");
  await page.getByTestId("opening-balance-done").click();
  await expect(page.getByTestId("parties-page-supplier")).toBeVisible();

  // 4. the new supplier exists and carries its opening balance
  await page.getByRole("link", { name: openingSupplierName }).click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("800 دج");

  // 5. the purchased supplier shows the charge
  await page.goto("/suppliers");
  await page.getByRole("link", { name: supplierName }).click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("5000 دج");

  // 6. an invoice-linked خصم of 500: the balance and the invoice both drop
  await page.getByTestId("supplier-action-adjust").click();
  await page.getByTestId("supplier-adjust-direction-they-owe").click();
  await page.getByTestId("supplier-adjust-amount").fill("500");
  await page.getByTestId("supplierAdjustPresetDiscount").click();
  await page.getByTestId("supplier-adjust-link").check();
  await chooseSelectOption(page, page.getByTestId("supplier-adjust-invoice"), invoiceNumber);
  await expect(page.getByTestId("supplier-adjust-preview-remaining")).toContainText("4500 دج");
  await page.getByTestId("supplier-adjust-confirm").click();
  await expect(page.getByTestId("supplier-balance-value")).toHaveText("4500 دج");

  // the account row names the adjustment and its direction
  await page.getByTestId("party-tab-payments").click();
  await expect(page.getByTestId("supplier-entry-kind-ADJUSTMENT").first()).toBeVisible();
  await expect(page.getByTestId("supplier-entry-direction").first()).toContainText("يسالنا");

  // 7. the invoice agrees: remaining 4500, the 500 surfaced as settled credit
  await page.getByTestId("party-tab-invoices").click();
  await page.getByTestId("party-invoices").getByRole("link", { name: invoiceNumber }).click();
  await expect(page.getByTestId("invoice-page")).toBeVisible();
  await expect(page.getByTestId("invoice-remaining")).toHaveText("4500 دج");
  await expect(page.getByTestId("invoice-returns-credit")).toHaveText("500 دج");

  // 8. #180 — a supplier whose account is net in credit shows the credit label
  // on the /debts group total, never a bare negative number
  const creditSupplierName = `رصيد-دائن-${stamp}`;
  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await page.getByTestId("opening-balance-new-name").fill(creditSupplierName);
  await chooseSelectOption(page, page.getByTestId("opening-balance-new-direction"), "يسالنا");
  await page.getByTestId("opening-balance-new-amount").fill("100000");
  await page.getByTestId("opening-balance-save").click();
  await expect(page.getByTestId("opening-balance-saved")).toBeVisible();

  await page.goto("/debts");
  await expect(page.getByTestId("debts-group-weowe-credit")).toContainText("رصيد لنا عند الموردين");
  // the amount renders as a positive figure under the credit label: the
  // currency suffix alone would also pass for a negative value
  await expect(page.getByTestId("debts-group-weowe-total")).toContainText("دج");
  await expect(page.getByTestId("debts-group-weowe-total")).not.toContainText("-");
});

/**
 * #184 — the opening-balance confirmation dialog must name the account the
 * server will write to, even when two suppliers fold to one name. The typed
 * text here has three spaces; the entry-carrying twin's stored text has two, so
 * a client-side mirror of the tie-break could not produce the named string.
 */
test("a folded opening-balance name lands on the supplier the dialog names (issue 184)", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const carriedName = `مورد  نزاع-${stamp}`; // double space: carries an entry, so the tie-break picks it
  const emptyName = `مورد نزاع-${stamp}`; // single space: folds to the same key, no entries
  const typedName = `مورد   نزاع-${stamp}`; // triple space: the owner's draft

  const carried = await rpc<{ id: string }>(page, "suppliersCreate", { name: carriedName });
  const empty = await rpc<{ id: string }>(page, "suppliersCreate", { name: emptyName });
  await rpc(page, "suppliersAdjust", { supplierId: carried.id, direction: "WE_OWE", amount: 500, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

  await page.goto("/suppliers");
  await page.getByTestId("suppliers-opening-balance").click();
  await expect(page.getByTestId("opening-balance-page")).toBeVisible();
  await page.getByTestId("opening-balance-new-name").fill(typedName);
  await page.getByTestId("opening-balance-new-amount").fill("300");
  await page.getByTestId("opening-balance-save").click();

  // the dialog names the SERVER's resolved text, not the typed string
  const dialog = page.getByTestId("opening-balance-confirm");
  await expect(dialog).toBeVisible();
  const named = await dialog.getByTestId("opening-balance-confirm-name").allTextContents();
  expect(named).toEqual([carriedName]);

  await page.getByTestId("opening-balance-confirm-save").click();
  await expect(page.getByTestId("opening-balance-saved")).toContainText(carriedName);

  // the amount landed on the account the dialog named, not its empty twin
  const landed = await rpc<{ account?: { balance: number } | null }>(page, "suppliersGet", { id: carried.id });
  const twin = await rpc<{ account?: { balance: number } | null }>(page, "suppliersGet", { id: empty.id });
  expect(landed.account?.balance).toBe(800);
  expect(twin.account?.balance).toBe(0);
});
