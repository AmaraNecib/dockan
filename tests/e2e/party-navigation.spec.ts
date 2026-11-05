import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import type { InvoiceCreate, InvoiceDetail, ItemCreate, Party, PartyDetail } from "../../packages/contracts/src/core";
import { signIn } from "./auth-helpers";
import { callRpc, seedCategoryId } from "./rpc-helpers";

const evidence = process.env.DOKAN_NAV_EVIDENCE;
test.use({
  viewport: evidence ? { width: 1920, height: 1080 } : { width: 1280, height: 800 },
  video: evidence ? { mode: "on", size: { width: 1920, height: 1080 } } : "off",
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
    const name = `${role === "customer" ? "زبون" : "مورد"} تفاصيل Mixed account ${Date.now()}`;
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
      // Legacy expansion keeps the whole row target; only linked rows reserve Details space.
      const debtRows = group.getByRole("listitem").filter({ hasText: name });
      const legacyRow = debtRows.filter({ hasNot: page.getByTestId("debts-person-details") });
      const linkedRow = debtRows.filter({ has: page.locator(`a[href="${listPath}/${party.id}"]`) });
      await expect(legacyRow).toHaveCount(1);
      await expect(linkedRow).toHaveCount(1);
      const savedViewport = page.viewportSize();
      const measurements = [];
      for (const width of [1920, 1280, 390]) {
        await page.setViewportSize({ width, height: 1080 });
        for (const [identity, measuredRow] of [["legacy", legacyRow], ["linked", linkedRow]] as const) {
          const boxes = await measuredRow.evaluate((element) => {
            const rect = (target: Element) => {
              const box = target.getBoundingClientRect();
              return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
            };
            const button = element.querySelector("button");
            if (!button) throw new Error("debt expansion missing");
            const link = element.querySelector("a");
            const style = getComputedStyle(element);
            return {
              row: rect(element), button: rect(button), link: link ? rect(link) : null,
              insetLeft: Number.parseFloat(style.paddingLeft), insetRight: Number.parseFloat(style.paddingRight),
              children: Array.from(button.children, rect),
            };
          });
          measurements.push({ width, identity, ...boxes });
        }
      }
      const geometryPath = test.info().outputPath(`${role}-debt-geometry.json`);
      writeFileSync(geometryPath, JSON.stringify(measurements, null, 2));
      await test.info().attach(`${role}-debt-geometry`, { path: geometryPath, contentType: "application/json" });
      for (const boxes of measurements) {
        if (boxes.identity === "legacy") {
          expect(boxes.button.left).toBeCloseTo(boxes.row.left + boxes.insetLeft, 0);
          expect(boxes.button.right).toBeCloseTo(boxes.row.right - boxes.insetRight, 0);
        } else {
          if (!boxes.link) throw new Error("debt Details missing");
          expect(boxes.link.right).toBeLessThanOrEqual(boxes.button.left);
        }
        for (const child of boxes.children) {
          expect(child.left).toBeGreaterThanOrEqual(boxes.button.left);
          expect(child.right).toBeLessThanOrEqual(boxes.button.right);
          expect(child.bottom).toBeLessThanOrEqual(boxes.button.bottom);
        }
      }
      if (savedViewport) await page.setViewportSize(savedViewport);
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
      await page.keyboard.press("Shift+Tab");
      await expect(details).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(row.getByTestId("party-row-link")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(details).toBeFocused();
      const popupPromise = page.context().waitForEvent("page", { timeout: 10_000 });
      void popupPromise.catch(() => undefined);
      await details.click({ modifiers: ["ControlOrMeta"] });
      const popup = await popupPromise;
      try {
        await expect(popup).toHaveURL(`${listPath}/${party.id}`);
        await expect(popup.getByTestId("party-detail-name")).toHaveText(name);
        await expect(page).toHaveURL(listPath);
      } finally {
        await popup.close();
      }
      await details.press("Enter");
      await expect(page).toHaveURL(`${listPath}/${party.id}`);
      await expect(page.getByTestId("party-detail-name")).toHaveText(name);
      await expect(page.getByTestId("party-invoice-row")).toHaveCount(1);
      await expect(page.getByTestId("party-invoices")).toContainText(linked.invoiceNumber);
      await page.getByTestId("party-tab-payments").click();
      const history = page.getByTestId(role === "customer" ? "party-payments" : "supplier-account-entries");
      const linkedRows = history.getByRole("row").filter({ has: page.locator(`a[href="/invoices/${linked.id}"]`) });
      if (role === "customer") {
        await expect(linkedRows).toHaveCount(1);
        await expect(linkedRows.getByRole("cell").nth(2)).toHaveText("100 دج");
        await expect(linkedRows.getByRole("cell").nth(3)).toHaveText("نقداً");
      } else {
        const payment = linkedRows.filter({ has: page.getByTestId("supplier-entry-kind-PAYMENT") });
        await expect(payment).toHaveCount(1);
        await expect(payment.getByTestId("supplier-entry-kind-PAYMENT")).toHaveText("دفعة");
        await expect(payment.getByTestId("supplier-entry-amount")).toHaveText("+ 100 دج");
      }
      await expect(history.locator(`a[href="/invoices/${legacy.id}"]`)).toHaveCount(0);
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
      await expand.focus();
      await page.keyboard.press("Enter");
      await expect(debtRow.getByTestId("debts-invoices")).toContainText(linked.invoiceNumber);
      await expect(expand).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Tab");
      await expect(debtDetails).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(expand).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(debtDetails).toBeFocused();
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

      // Existing guard regression via the sidebar Link, not the new Details control.
      // Details is reachable only after the draft has been discarded.
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

      const originalViewport = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(listPath);
      await details.scrollIntoViewIfNeeded();
      await expect(details).toBeInViewport();
      await expect(edit).toBeInViewport();
      const narrowPlacement = await row.evaluate((element) => {
        const detailsLink = element.querySelector('[data-testid="party-row-details"]');
        const editButton = element.querySelector('[data-testid="party-row-edit"]');
        if (!detailsLink || !editButton) throw new Error("party actions missing");
        const detailsBox = detailsLink.getBoundingClientRect();
        const editBox = editButton.getBoundingClientRect();
        return { editRight: editBox.right, detailsLeft: detailsBox.left };
      });
      expect(narrowPlacement.editRight).toBeLessThanOrEqual(narrowPlacement.detailsLeft);
      await details.click();
      await expect(page).toHaveURL(`${listPath}/${party.id}`);
      await page.goto("/debts");
      await debtDetails.scrollIntoViewIfNeeded();
      await expect(debtDetails).toBeInViewport();
      await expect(expand).toBeInViewport();
      await debtDetails.click();
      await expect(page).toHaveURL(`${listPath}/${party.id}`);
      if (originalViewport) await page.setViewportSize(originalViewport);
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
