import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import type { InvoiceCreate, InvoiceDetail, ItemCreate, Party, PartyDetail } from "../../packages/contracts/src/core";
import { signIn } from "./auth-helpers";
import { callRpc, seedCategoryId } from "./rpc-helpers";

const evidence = process.env.DOKAN_NAV_EVIDENCE;
test.use({
  viewport: { width: 1280, height: 800 },
  video: evidence ? { mode: "on", size: { width: 1280, height: 800 } } : "off",
});

async function capture(locator: Locator, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await locator.screenshot({ path: path.join(evidence, `${name}.png`) });
}

for (const role of ["customer", "supplier"] as const) {
  test(`${role}: explicit Details and invoice links keep the saved identity and history (#407)`, async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const kind = role === "customer" ? "SALE" : "PURCHASE";
    const listPath = role === "customer" ? "/customers" : "/suppliers";
    const createProcedure = role === "customer" ? "customersCreate" : "suppliersCreate";
    const getProcedure = role === "customer" ? "customersGet" : "suppliersGet";
    const name = `${role === "customer" ? "زبون" : "مورد"} تفاصيل ${Date.now()}`;
    const categoryId = await seedCategoryId(page, `تنقل ${Date.now()}`);
    // SAFETY: the public create contract returns the saved item's stable id.
    const item = await callRpc<{ id: string }, ItemCreate & { stockOnHand: number }>(page, "itemsCreateWithStock", {
      name: `منتج ${name}`, categoryId, costPrice: 100, sellingPrice: 300, stockOnHand: 5,
    });
    // Duplicate names are allowed. Navigation must use the second record's id.
    const other = await callRpc<Party, { name: string }>(page, createProcedure, { name });
    const party = await callRpc<Party, { name: string }>(page, createProcedure, { name });
    expect(other.id).not.toBe(party.id);
    const invoices: InvoiceDetail[] = [];
    try {
      const linked = await callRpc<InvoiceDetail, InvoiceCreate>(page, "invoicesCreate", {
        kind, counterpartyId: party.id, initialPaid: 100,
        lines: [{ itemId: item.id, quantity: 1, unitPrice: 300 }],
      });
      invoices.push(linked);
      const legacy = await callRpc<InvoiceDetail, InvoiceCreate>(page, "invoicesCreate", {
        kind, counterpartyName: name, initialPaid: 100,
        lines: [{ itemId: item.id, quantity: 1, unitPrice: 300 }],
      });
      invoices.push(legacy);
      const stored = await callRpc<InvoiceDetail, { id: string }>(page, "invoicesGet", { id: linked.id });
      const storedLegacy = await callRpc<InvoiceDetail, { id: string }>(page, "invoicesGet", { id: legacy.id });
      expect(stored.counterpartyId).toBe(party.id);
      expect(stored.payments).toEqual(expect.arrayContaining([expect.objectContaining({ amount: 100 })]));
      expect(storedLegacy.counterpartyId).toBeNull();

      await page.goto(`/invoices/${legacy.id}`);
      await expect(page.getByTestId("invoice-party")).toHaveText(name);
      await expect(page.getByTestId("invoice-party").getByRole("link")).toHaveCount(0);
      await page.goto(`/invoices/${linked.id}`);
      await expect(page.getByTestId("invoice-party")).toHaveText(name);
      await capture(page.getByTestId("invoice-party").locator(".."), `${role}-invoice`);
      await page.goto("/debts");
      const group = page.getByTestId(role === "customer" ? "debts-group-owed" : "debts-group-weowe");
      await expect(group.getByTestId("debts-person").filter({ hasText: name })).toHaveCount(2);
      await capture(group, `${role}-debts`);
      await page.goto(listPath);
      const row = page.getByTestId("party-row").filter({ has: page.locator(`a[href="${listPath}/${party.id}"]`) });
      await expect(row).toBeVisible();
      await capture(row, `${role}-list`);

      const details = row.getByRole("link", { name: `تفاصيل ${name}`, exact: true });
      await expect(details).toBeVisible();
      await expect(details).toHaveText("تفاصيل");
      await expect(details).toHaveAttribute("href", `${listPath}/${party.id}`);
      const placement = await row.evaluate((element) => {
        const nameLink = element.querySelector('[data-testid="party-row-link"]');
        const detailsLink = element.querySelector('[data-testid="party-row-details"]');
        return { name: nameLink?.getBoundingClientRect().x, details: detailsLink?.getBoundingClientRect().x };
      });
      expect(placement.details).toBeLessThan(placement.name ?? 0);

      // Cancel the existing edit without saving; focus returns to its trigger.
      const edit = row.getByTestId("party-row-edit");
      await edit.click();
      await page.getByTestId("party-form-name").fill("اسم لن يحفظ");
      await page.getByTestId("party-form-cancel").click();
      await expect(edit).toBeFocused();
      const unchanged = await callRpc<PartyDetail, { id: string }>(page, getProcedure, { id: party.id });
      expect(unchanged.party.name).toBe(name);
      await details.focus();
      await expect(details).toBeFocused();
      await details.press("Enter");
      await expect(page).toHaveURL(`${listPath}/${party.id}`);
      await expect(page.getByTestId("party-detail-name")).toHaveText(name);
      await expect(page.getByTestId("party-invoice-row")).toHaveCount(1);
      await expect(page.getByTestId("party-invoices")).toContainText(linked.invoiceNumber);
      await page.getByTestId("party-tab-payments").click();
      const history = page.getByTestId(role === "customer" ? "party-payments" : "supplier-account-entries");
      await expect(history).toContainText("100");
      await page.getByTestId("party-tab-invoices").click();
      await page.getByTestId("party-invoices").getByRole("link", { name: linked.invoiceNumber, exact: true }).click();
      await expect(page.getByTestId("invoice-page")).toBeVisible();
      const account = page.getByTestId("invoice-party").getByRole("link", { name, exact: true });
      await expect(account).toHaveAttribute("href", `${listPath}/${party.id}`);
      await account.focus();
      await account.press("Enter");
      await expect(page.getByTestId("party-detail-name")).toHaveText(name);
      await expect(page).toHaveURL(`${listPath}/${party.id}`);

      await page.goto("/debts");
      const debtDetails = group.getByRole("link", { name: `تفاصيل ${name}`, exact: true });
      await expect(debtDetails).toHaveCount(1);
      const debtRow = group.getByRole("listitem").filter({ has: page.locator(`a[href="${listPath}/${party.id}"]`) });
      const expand = debtRow.getByTestId("debts-person");
      await expect(expand).toHaveAttribute("aria-expanded", "false");
      const geometry = await debtRow.evaluate((element) => {
        const button = element.querySelector("button");
        const link = element.querySelector("a");
        return { button: button?.getBoundingClientRect().x, link: link?.getBoundingClientRect().x };
      });
      expect(geometry.link).toBeLessThan(geometry.button ?? 0);
      await expand.click();
      await expect(debtRow.getByTestId("debts-invoices")).toContainText(linked.invoiceNumber);
      await expect(expand).toHaveAttribute("aria-expanded", "true");
      await debtDetails.focus();
      await debtDetails.press("Enter");
      await expect(page).toHaveURL(`${listPath}/${party.id}`);
      await expect(page.getByTestId("party-detail-name")).toHaveText(name);

      // A failed account read leaves a route back; retry uses the same id.
      await page.goto(listPath);
      await expect(details).toBeVisible();
      await page.route(`**/api/rpc/${getProcedure}`, (route) => route.abort("failed"));
      await details.click();
      await expect(page.getByTestId("party-detail-error")).toBeVisible({ timeout: 20_000 });
      await page.unroute(`**/api/rpc/${getProcedure}`);
      await page.getByTestId("party-detail-back").click();
      await expect(details).toBeVisible();
      await details.click();
      await expect(page.getByTestId("party-detail-name")).toHaveText(name);

      // The existing purchase draft guard still holds a native Link navigation.
      if (role === "supplier") {
        await page.goto("/purchase");
        const supplierInput = page.getByTestId("purchase-supplier");
        await supplierInput.fill(name);
        await page.getByRole("link", { name: "الموردون", exact: true }).first().click();
        await expect(page.getByTestId("purchase-discard-stay")).toBeVisible();
        await page.getByTestId("purchase-discard-stay").click();
        await expect(supplierInput).toHaveValue(name);
        await expect(supplierInput).toBeFocused();
        await page.getByRole("link", { name: "الموردون", exact: true }).first().click();
        await page.getByTestId("purchase-discard-confirm").click();
        await details.click();
        await expect(page).toHaveURL(`${listPath}/${party.id}`);
      }
    } finally {
      // Restore the shared suite's debt totals even when a UI assertion fails.
      for (const invoice of invoices) {
        const current = await callRpc<InvoiceDetail, { id: string }>(page, "invoicesGet", { id: invoice.id });
        if (current.remainingAmount > 0) {
          await callRpc<InvoiceDetail, { invoiceId: string; amount: number }>(page, "invoicesPay", {
            invoiceId: current.id, amount: current.remainingAmount,
          });
        }
        const settled = await callRpc<InvoiceDetail, { id: string }>(page, "invoicesGet", { id: invoice.id });
        expect(settled.remainingAmount).toBe(0);
      }
    }
  });
}
