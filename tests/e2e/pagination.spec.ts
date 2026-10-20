import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";
import { callRpc } from "./rpc-helpers";

/** The item a spec seeds. */
type ItemSeed = {
  name: string;
  categoryId: string;
  costPrice: number;
  sellingPrice: number;
  lowStockThreshold: number;
};

/** The item a spec seeds with opening stock. */
type ItemWithStockSeed = {
  name: string;
  categoryId: string;
  costPrice: number;
  sellingPrice: number;
  stockOnHand: number;
};

/** One invoice a spec seeds. */
type InvoiceSeed = {
  kind: "SALE" | "PURCHASE";
  counterpartyId: string;
  counterpartyName?: string;
  initialPaid?: number;
  lines: Array<{ itemId: string; quantity: number; unitPrice?: number }>;
};

/**
 * The category the specs below seed their item under.
 *
 * The list is empty on a fresh database: the API seeds the default category
 * once, at boot, and a reset (scripts/reset-e2e-records.mjs) clears the
 * categories again. So this spec cannot borrow a category from whatever ran
 * before it — it takes the first one there is and creates one when the list is
 * empty. Before this, the spec read `categories.items[0]` and died with a
 * TypeError on a database that had no category yet: a failure about the order
 * of the suite, not about pagination.
 */
async function seedCategoryId(page: Page, name: string): Promise<string> {
  // SAFETY: categoriesList answers { items: Array<{ id: string }> }
  const categories = await callRpc<{ items: Array<{ id: string }> }, Record<string, never>>(page, "categoriesList", {});
  const existing = categories.items[0];
  if (existing !== undefined) return existing.id;
  // SAFETY: categoriesCreate answers the created category, whose id is a string
  const created = await callRpc<{ id: string }, { name: string }>(page, "categoriesCreate", { name });
  return created.id;
}

/**
 * Issue 163 — server-side pagination on the invoices list (the prototype
 * list). The spec proves the three user-visible rules: the pager appears once
 * more than one page exists, changing the page size changes the rows, and a
 * filter change snaps the list back to page 1. Total row counts are read from
 * the api so the spec does not depend on what other specs already recorded in
 * the shared e2e database.
 */
test("pagination: pager, page size, and filter reset on the invoices list", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();

  // Seed through the real RPC wire with the session cookie sign-in set. The
  // shared helper owns the app's link headers and the credentials mode, so the
  // seed is faithful on a vault-mode server; this file used to carry its own
  // copy of that fetch inside the page, without the vault header.
  const categoryId = await seedCategoryId(page, `تصنيف-ترقيم-${stamp}`);
  // SAFETY: itemsCreate answers the created item, whose id is a string
  const item = await callRpc<{ id: string }, ItemSeed>(page, "itemsCreate", {
    name: `ترقيم-صنف-${stamp}`,
    categoryId,
    costPrice: 100,
    sellingPrice: 150,
    lowStockThreshold: 1,
  });
  for (let i = 0; i < 12; i++) {
    await callRpc<unknown, { kind: "PURCHASE"; lines: Array<{ itemId: string; quantity: number; unitPrice: number }> }>(
      page,
      "invoicesCreate",
      { kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 1, unitPrice: 100 }] },
    );
  }
  // deterministic start: the page size is a persisted preference
  await callRpc<unknown, { key: string; value: string }>(page, "preferencesSet", { key: "ui.pageSize", value: "10" });
  // SAFETY: invoicesList answers { total: number } in both calls
  const purchase = await callRpc<{ total: number }, { kind: "PURCHASE"; limit: number; offset: number }>(
    page,
    "invoicesList",
    { kind: "PURCHASE", limit: 10, offset: 0 },
  );
  // SAFETY: invoicesList answers { total: number }, unfiltered too
  const all = await callRpc<{ total: number }, { limit: number; offset: number }>(page, "invoicesList", { limit: 1, offset: 0 });
  const seeded = { purchaseTotal: purchase.total, allTotal: all.total };

  expect(seeded.purchaseTotal).toBeGreaterThan(10);

  await page.goto("/invoices");
  // filter to the seeded kind so the assertions are about a known list
  await chooseSelectOption(page, page.getByTestId("invoices-kind-filter"), "المشتريات");

  // default page size 10: ten rows, and the pager is visible because the list
  // spans more than one page
  await expect(page.getByTestId("invoices-pager")).toBeVisible();
  await expect(page.getByTestId("invoice-row")).toHaveCount(10);
  await expect(page.getByTestId("invoices-pager-range")).toContainText("1");
  await expect(page.getByTestId("invoices-pager-range")).toContainText(String(seeded.purchaseTotal));
  await expect(page.getByTestId("invoices-pager-page-1")).toHaveAttribute("aria-current", "page");

  // page 2 shows the remainder and the range moves forward
  await page.getByTestId("invoices-pager-page-2").click();
  await expect(page.getByTestId("invoice-row")).toHaveCount(Math.min(10, seeded.purchaseTotal - 10));
  await expect(page.getByTestId("invoices-pager-page-2")).toHaveAttribute("aria-current", "page");

  // a filter change resets the offset to page 1 (the old offset may no longer
  // address the same rows)
  await chooseSelectOption(page, page.getByTestId("invoices-kind-filter"), "كل الفواتير");
  await chooseSelectOption(page, page.getByTestId("invoices-kind-filter"), "المشتريات");
  await expect(page.getByTestId("invoices-pager-page-1")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("invoice-row")).toHaveCount(10);

  // changing the page size changes the rows: 20 fits the whole seeded list
  await page.getByTestId("invoices-pager-size-20").click();
  const expectedAtTwenty = Math.min(20, seeded.purchaseTotal);
  await expect(page.getByTestId("invoice-row")).toHaveCount(expectedAtTwenty);
  if (seeded.purchaseTotal <= 20) {
    await expect(page.getByTestId("invoices-pager")).toHaveCount(0);
  }

  // the chosen page size persists across a reload. The reload also drops the
  // kind filter (component state), so the assertion is the page size itself:
  // the unfiltered list must render min(20, allTotal) rows.
  await page.reload();
  await expect(page.getByTestId("invoice-row")).toHaveCount(Math.min(20, seeded.allTotal));
});

/**
 * Issue 174 — the party-detail tabs page server-side while the settle/pay
 * money reads stay whole. The supplier tab proves invoices + account entries
 * page; the customer tab proves the unpaid-only filter resets to page 1.
 *
 * The seeding goes through the SHARED helper (`rpc-helpers.ts`), which owns
 * the app's link headers (`x-vault-session`) and the credentials mode. This
 * file used to carry its own copy of that fetch, and that copy had no vault
 * header — so on a vault-mode server the seed would be refused for a reason
 * that has nothing to do with pagination.
 */

test("pagination: a supplier's invoices and account entries page", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryId = await seedCategoryId(page, `تصنيف-مورد-${stamp}`);
  // SAFETY: itemsCreate answers the created item, whose id is a string
  const item = await callRpc<{ id: string }, ItemSeed>(page, "itemsCreate", {
    name: `حساب-ترقيم-${stamp}`,
    categoryId,
    costPrice: 100,
    sellingPrice: 150,
    lowStockThreshold: 1,
  });
  // SAFETY: suppliersCreate answers the created supplier, whose id is a string
  const supplier = await callRpc<{ id: string; name: string }, { name: string }>(page, "suppliersCreate", {
    name: `مورد-حساب-ترقيم-${stamp}`,
  });
  for (let i = 0; i < 12; i++) {
    await callRpc<unknown, InvoiceSeed>(page, "invoicesCreate", {
      kind: "PURCHASE",
      counterpartyId: supplier.id,
      lines: [{ itemId: item.id, quantity: 1, unitPrice: 100 }],
    });
  }
  // deterministic start: the page size is a persisted preference
  await callRpc<unknown, { key: string; value: string }>(page, "preferencesSet", { key: "ui.pageSize", value: "10" });
  // SAFETY: supplierEntries answers { total: number }
  const entries = await callRpc<{ total: number }, { id: string; limit: number; offset: number }>(
    page,
    "supplierEntries",
    { id: supplier.id, limit: 10, offset: 0 },
  );
  expect(entries.total).toBeGreaterThan(10);

  await page.goto(`/suppliers/${supplier.id}`);
  await expect(page.getByTestId("party-detail-supplier")).toBeVisible();

  // invoices tab: ten rows, the pager appears, page 2 shows the remainder
  await expect(page.getByTestId("party-invoice-row")).toHaveCount(10);
  await expect(page.getByTestId("party-invoices-pager")).toBeVisible();
  await expect(page.getByTestId("party-invoices-pager-page-1")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("party-invoices-pager-page-2").click();
  await expect(page.getByTestId("party-invoices-pager-page-2")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("party-invoice-row")).toHaveCount(2);

  // payments tab: the supplier account ledger pages the same way
  await page.getByTestId("party-tab-payments").click();
  await expect(page.getByTestId("supplier-account-row")).toHaveCount(10);
  await expect(page.getByTestId("supplier-entries-pager")).toBeVisible();
  await page.getByTestId("supplier-entries-pager-page-2").click();
  await expect(page.getByTestId("supplier-account-row")).toHaveCount(2);
});

test("pagination: a customer's unpaid-only filter resets to page 1", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryId = await seedCategoryId(page, `تصنيف-زبون-${stamp}`);
  // SAFETY: itemsCreateWithStock answers the created item, whose id is a string
  const item = await callRpc<{ id: string }, ItemWithStockSeed>(page, "itemsCreateWithStock", {
    name: `زبون-ترقيم-${stamp}`,
    categoryId,
    costPrice: 50,
    sellingPrice: 100,
    stockOnHand: 13,
  });
  // SAFETY: customersCreate answers the created customer, whose id and name are strings
  const customer = await callRpc<{ id: string; name: string }, { name: string }>(page, "customersCreate", {
    name: `زبون-فواتير-ترقيم-${stamp}`,
  });
  // twelve unpaid sales + one fully paid sale: both the filtered and the full
  // list span more than one page, so the pager stays while the offset resets
  for (let i = 0; i < 12; i++) {
    await callRpc<unknown, InvoiceSeed>(page, "invoicesCreate", {
      kind: "SALE",
      counterpartyId: customer.id,
      counterpartyName: customer.name,
      lines: [{ itemId: item.id, quantity: 1 }],
    });
  }
  await callRpc<unknown, InvoiceSeed>(page, "invoicesCreate", {
    kind: "SALE",
    counterpartyId: customer.id,
    counterpartyName: customer.name,
    initialPaid: 100,
    lines: [{ itemId: item.id, quantity: 1 }],
  });
  await callRpc<unknown, { key: string; value: string }>(page, "preferencesSet", { key: "ui.pageSize", value: "10" });

  await page.goto(`/customers/${customer.id}`);
  await expect(page.getByTestId("party-detail-customer")).toBeVisible();
  await expect(page.getByTestId("party-unpaid-filter")).toBeChecked();
  await expect(page.getByTestId("party-invoice-row")).toHaveCount(10);

  await page.getByTestId("party-invoices-pager-page-2").click();
  await expect(page.getByTestId("party-invoices-pager-page-2")).toHaveAttribute("aria-current", "page");

  // clearing the filter changes the list and snaps back to page 1
  await page.getByTestId("party-unpaid-filter").uncheck();
  await expect(page.getByTestId("party-invoices-pager-page-1")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("party-invoice-row")).toHaveCount(10);
});
