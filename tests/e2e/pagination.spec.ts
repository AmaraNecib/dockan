import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./auth-helpers";
import { chooseSelectOption } from "./select-helpers";

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
  // oRPC fetch link posts `{json: input}` to /api/rpc/<procedure> and answers
  // `{json: output}` (StandardRPCSerializer), so the helper mirrors that.
  const seeded = await page.evaluate(async (name) => {
    type SeedRequest =
      | { procedure: "categoriesList"; input: Record<string, never> }
      | {
          procedure: "itemsCreate";
          input: { name: string; categoryId: string; costPrice: number; sellingPrice: number; lowStockThreshold: number };
        }
      | { procedure: "invoicesCreate"; input: { kind: "PURCHASE"; lines: Array<{ itemId: string; quantity: number; unitPrice: number }> } }
      | { procedure: "preferencesSet"; input: { key: string; value: string } }
      | { procedure: "invoicesList"; input: { kind?: "PURCHASE"; limit: number; offset: number } };

    async function call(request: SeedRequest): Promise<string> {
      const response = await fetch(`/api/rpc/${request.procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: request.input }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${request.procedure} failed: ${response.status} ${text}`);
      return text;
    }

    // SAFETY: categoriesList answers { json: { items: Array<{ id: string }> } }
    const categories = JSON.parse(await call({ procedure: "categoriesList", input: {} })) as {
      json: { items: Array<{ id: string }> };
    };
    // SAFETY: itemsCreate answers the created item, whose id is a string
    const item = JSON.parse(
      await call({
        procedure: "itemsCreate",
        input: { name, categoryId: categories.json.items[0]!.id, costPrice: 100, sellingPrice: 150, lowStockThreshold: 1 },
      }),
    ) as { json: { id: string } };

    for (let i = 0; i < 12; i++) {
      await call({ procedure: "invoicesCreate", input: { kind: "PURCHASE", lines: [{ itemId: item.json.id, quantity: 1, unitPrice: 100 }] } });
    }
    // deterministic start: the page size is a persisted preference
    await call({ procedure: "preferencesSet", input: { key: "ui.pageSize", value: "10" } });
    // SAFETY: invoicesList answers { json: { total: number } } in both calls
    const purchase = JSON.parse(
      await call({ procedure: "invoicesList", input: { kind: "PURCHASE", limit: 10, offset: 0 } }),
    ) as { json: { total: number } };
    // SAFETY: invoicesList answers { json: { total: number } }, unfiltered too
    const all = JSON.parse(
      await call({ procedure: "invoicesList", input: { limit: 1, offset: 0 } }),
    ) as { json: { total: number } };
    return { purchaseTotal: purchase.json.total, allTotal: all.json.total };
  }, `ترقيم-صنف-${stamp}`);

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
 */
/** The RPC calls the party-detail pagination specs seed through. */
type TabSeedRequest =
  | { procedure: "categoriesList"; input: Record<string, never> }
  | { procedure: "itemsCreate"; input: { name: string; categoryId: string; costPrice: number; sellingPrice: number; lowStockThreshold: number } }
  | { procedure: "itemsCreateWithStock"; input: { name: string; categoryId: string; costPrice: number; sellingPrice: number; stockOnHand: number } }
  | { procedure: "suppliersCreate"; input: { name: string } }
  | { procedure: "customersCreate"; input: { name: string } }
  | {
      procedure: "invoicesCreate";
      input: { kind: "SALE" | "PURCHASE"; counterpartyId: string; counterpartyName?: string; initialPaid?: number; lines: Array<{ itemId: string; quantity: number; unitPrice?: number }> };
    }
  | { procedure: "preferencesSet"; input: { key: string; value: string } }
  | { procedure: "supplierEntries"; input: { id: string; limit: number; offset: number } };

/** Seed through the authenticated RPC wire the page's session cookie carries. */
async function callRpc(page: Page, request: TabSeedRequest): Promise<string> {
  return page.evaluate(async ({ procedure: name, input: body }: TabSeedRequest) => {
    const response = await fetch(`/api/rpc/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${name} failed: ${response.status} ${text}`);
    return text;
  }, request);
}

/** The seeded owner's default category id (the first-run seed creates one). */
async function firstCategoryId(page: Page): Promise<string> {
  // SAFETY: categoriesList answers { json: { items: Array<{ id: string }> } }
  const body = JSON.parse(await callRpc(page, { procedure: "categoriesList", input: {} })) as { json: { items: Array<{ id: string }> } };
  return body.json.items[0]!.id;
}

test("pagination: a supplier's invoices and account entries page", async ({ page }) => {
  await signIn(page);

  const stamp = Date.now().toString();
  const categoryId = await firstCategoryId(page);
  // SAFETY: itemsCreate answers the created item, whose id is a string
  const item = JSON.parse(
    await callRpc(page, {
      procedure: "itemsCreate",
      input: { name: `حساب-ترقيم-${stamp}`, categoryId, costPrice: 100, sellingPrice: 150, lowStockThreshold: 1 },
    }),
  ) as { json: { id: string } };
  // SAFETY: suppliersCreate answers the created supplier, whose id is a string
  const supplier = JSON.parse(
    await callRpc(page, { procedure: "suppliersCreate", input: { name: `مورد-حساب-ترقيم-${stamp}` } }),
  ) as { json: { id: string } };
  for (let i = 0; i < 12; i++) {
    await callRpc(page, {
      procedure: "invoicesCreate",
      input: { kind: "PURCHASE", counterpartyId: supplier.json.id, lines: [{ itemId: item.json.id, quantity: 1, unitPrice: 100 }] },
    });
  }
  // deterministic start: the page size is a persisted preference
  await callRpc(page, { procedure: "preferencesSet", input: { key: "ui.pageSize", value: "10" } });
  // SAFETY: supplierEntries answers { json: { total: number } }
  const entries = JSON.parse(
    await callRpc(page, { procedure: "supplierEntries", input: { id: supplier.json.id, limit: 10, offset: 0 } }),
  ) as { json: { total: number } };
  expect(entries.json.total).toBeGreaterThan(10);

  await page.goto(`/suppliers/${supplier.json.id}`);
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
  const categoryId = await firstCategoryId(page);
  // SAFETY: itemsCreateWithStock answers the created item, whose id is a string
  const item = JSON.parse(
    await callRpc(page, {
      procedure: "itemsCreateWithStock",
      input: { name: `زبون-ترقيم-${stamp}`, categoryId, costPrice: 50, sellingPrice: 100, stockOnHand: 13 },
    }),
  ) as { json: { id: string } };
  // SAFETY: customersCreate answers the created customer, whose id and name are strings
  const customer = JSON.parse(
    await callRpc(page, { procedure: "customersCreate", input: { name: `زبون-فواتير-ترقيم-${stamp}` } }),
  ) as { json: { id: string; name: string } };
  // twelve unpaid sales + one fully paid sale: both the filtered and the full
  // list span more than one page, so the pager stays while the offset resets
  for (let i = 0; i < 12; i++) {
    await callRpc(page, {
      procedure: "invoicesCreate",
      input: { kind: "SALE", counterpartyId: customer.json.id, counterpartyName: customer.json.name, lines: [{ itemId: item.json.id, quantity: 1 }] },
    });
  }
  await callRpc(page, {
    procedure: "invoicesCreate",
    input: { kind: "SALE", counterpartyId: customer.json.id, counterpartyName: customer.json.name, initialPaid: 100, lines: [{ itemId: item.json.id, quantity: 1 }] },
  });
  await callRpc(page, { procedure: "preferencesSet", input: { key: "ui.pageSize", value: "10" } });

  await page.goto(`/customers/${customer.json.id}`);
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
