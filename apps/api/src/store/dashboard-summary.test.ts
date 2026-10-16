import { afterAll, describe, expect } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { localDate, localDateTime } from "../lib/logger";
import { createDrizzleStore } from "./drizzle-store";
import type { StoreLogger, StorePort } from "./port";

/**
 * dashboardSummary store seam (issue 84). The landing screen's aggregates must
 * be computed in SQL — the server day's sales, both debt directions, low stock,
 * and the newest invoices by creation time — never by summing or re-sorting a
 * capped invoicesList page on the client. Each test runs on its own store so
 * the aggregates are exact.
 */

const tempDirs: string[] = [];
const conns: Connection[] = [];

/** bun:sqlite can keep the file handle open a beat after close on Windows. */
function removeTempDirRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
}

async function freshStoreWithConn(logger?: StoreLogger): Promise<{ store: StorePort; conn: Connection }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-dash-"));
  tempDirs.push(dir);
  const conn = openConnection(
    createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }),
  );
  conns.push(conn);
  const store = createDrizzleStore(conn, logger);
  await store.setup();
  return { store, conn };
}

async function freshStore(): Promise<StorePort> {
  return (await freshStoreWithConn()).store;
}

/** Narrow a nullable section that this fixture is expected to populate. */
function present<T>(value: T | null): T {
  if (value === null) throw new Error("expected a populated dashboard section");
  return value;
}

afterAll(() => {
  for (const conn of conns) conn.close();
  for (const dir of tempDirs) removeTempDirRetry(dir);
});

type SeedInvoice = {
  invoiceNumber: string;
  kind: "SALE" | "PURCHASE";
  invoiceDate: string;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  /** true = no counterparty (a walk-in credit sale still counts as debt) */
  unnamed?: boolean;
};

async function seedInvoice(store: StorePort, over: SeedInvoice) {
  return store.insertInvoice({
    invoiceNumber: over.invoiceNumber,
    kind: over.kind,
    counterpartyId: null,
    counterpartyName: over.unnamed === true ? null : "طرف",
    invoiceDate: over.invoiceDate,
    subtotalAmount: over.totalAmount,
    discountType: null,
    discountValue: null,
    discountAmount: 0,
    totalAmount: over.totalAmount,
    paidAmount: over.paidAmount,
    remainingAmount: over.remainingAmount,
    notes: null,
  });
}

describe("dashboardSummary (issue 84)", () => {
  itHeavy("aggregates the day's sales, both debt directions, and low stock in SQL", async () => {
    const store = await freshStore();
    const day = localDate();
    const other = "2020-01-01";

    await seedInvoice(store, { invoiceNumber: "DASH-1", kind: "SALE", invoiceDate: day, totalAmount: 5_000, paidAmount: 3_000, remainingAmount: 2_000 });
    await seedInvoice(store, { invoiceNumber: "DASH-2", kind: "SALE", invoiceDate: day, totalAmount: 2_500, paidAmount: 2_500, remainingAmount: 0 });
    await seedInvoice(store, { invoiceNumber: "DASH-3", kind: "SALE", invoiceDate: other, totalAmount: 9_999, paidAmount: 0, remainingAmount: 9_999 });
    await seedInvoice(store, { invoiceNumber: "DASH-4", kind: "PURCHASE", invoiceDate: day, totalAmount: 3_000, paidAmount: 1_800, remainingAmount: 1_200 });
    await seedInvoice(store, { invoiceNumber: "DASH-5", kind: "PURCHASE", invoiceDate: other, totalAmount: 1_000, paidAmount: 200, remainingAmount: 800 });
    // an unnamed walk-in credit sale is NOT counted: the /debts screen cannot
    // show a party-less remainder, so the card must not claim it either
    await seedInvoice(store, { invoiceNumber: "DASH-6", kind: "SALE", invoiceDate: other, totalAmount: 400, paidAmount: 0, remainingAmount: 400, unnamed: true });

    const categoryId = (await store.listCategories())[0]!.id;
    const low = await store.createItem({ name: "منخفض", categoryId, costPrice: 10, sellingPrice: 20, lowStockThreshold: 4 });
    await store.setItemStockAndCost(low.id, 3, 10); // 3 <= 4 -> low
    const ok = await store.createItem({ name: "جيد", categoryId, costPrice: 10, sellingPrice: 20, lowStockThreshold: 4 });
    await store.setItemStockAndCost(ok.id, 10, 10); // 10 > 4 -> not low

    const result = await store.dashboardSummary(day);

    // only the two SALE invoices dated `day` count toward the day's sales
    expect(result.salesTotal).toBe(7_500);
    expect(result.salesCount).toBe(2);
    // debt is an all-time outstanding balance (not a day window) and mirrors
    // debtSummaries(): party-attributed unpaid only, so unnamed DASH-6 is out
    expect(result.owedToUs).toBe(11_999); // unpaid SALE: 2_000 + 9_999
    expect(result.weOwe).toBe(2_000); // unpaid PURCHASE: 1_200 + 800
    expect(result.lowStockCount).toBe(1);
    expect(present(result.lowStockItems).map((item) => item.id)).toEqual([low.id]);
  });

  itHeavy("agrees with debtSummaries for both debt directions", async () => {
    const store = await freshStore();
    const day = localDate();
    // named and unnamed, unpaid and paid, both kinds
    await seedInvoice(store, { invoiceNumber: "AGREE-1", kind: "SALE", invoiceDate: day, totalAmount: 5_000, paidAmount: 3_000, remainingAmount: 2_000 });
    await seedInvoice(store, { invoiceNumber: "AGREE-2", kind: "SALE", invoiceDate: day, totalAmount: 2_500, paidAmount: 0, remainingAmount: 2_500, unnamed: true }); // no party -> excluded from both
    await seedInvoice(store, { invoiceNumber: "AGREE-3", kind: "SALE", invoiceDate: day, totalAmount: 1_000, paidAmount: 1_000, remainingAmount: 0 }); // paid -> excluded
    await seedInvoice(store, { invoiceNumber: "AGREE-4", kind: "PURCHASE", invoiceDate: day, totalAmount: 3_000, paidAmount: 1_800, remainingAmount: 1_200 });
    await seedInvoice(store, { invoiceNumber: "AGREE-5", kind: "PURCHASE", invoiceDate: day, totalAmount: 1_000, paidAmount: 0, remainingAmount: 1_000, unnamed: true }); // no party -> excluded from both

    const summary = await store.dashboardSummary(day);
    const rows = await store.debtSummaries();
    const owedFromRows = rows.filter((row) => row.kind === "SALE").reduce((sum, row) => sum + row.remainingTotal, 0);
    // a supplier row shows its NET account balance when it has one (ADR-0009)
    const weOweFromRows = rows.filter((row) => row.kind === "PURCHASE").reduce((sum, row) => sum + (row.accountBalance ?? row.remainingTotal), 0);

    // the headline must equal the sum of the rows its own /debts drill-down lists
    expect(summary.owedToUs).toBe(owedFromRows);
    expect(summary.weOwe).toBe(weOweFromRows);
    expect(summary.owedToUs).toBe(2_000);
    expect(summary.weOwe).toBe(1_200);
  });

  itHeavy("returns the five newest invoices by creation time, including a just-created backdated one", async () => {
    const store = await freshStore();
    // Five older inserts, then a backdated invoice inserted LAST. The api's
    // business-date order would bury it behind future-dated rows; creation
    // order puts it first and drops the oldest insert.
    for (let i = 1; i <= 5; i++) {
      await seedInvoice(store, { invoiceNumber: `DASH-OLD-${i}`, kind: "SALE", invoiceDate: `2026-01-0${i}`, totalAmount: 100, paidAmount: 100, remainingAmount: 0 });
    }
    await seedInvoice(store, { invoiceNumber: "DASH-BACKDATED", kind: "SALE", invoiceDate: "2020-01-01", totalAmount: 500, paidAmount: 500, remainingAmount: 0 });

    const result = await store.dashboardSummary(localDate());

    expect(present(result.recentInvoices)).toHaveLength(5);
    expect(present(result.recentInvoices)[0]?.invoiceNumber).toBe("DASH-BACKDATED");
    expect(present(result.recentInvoices).some((invoice) => invoice.invoiceNumber === "DASH-OLD-1")).toBe(false);
  });

  itHeavy("keeps the money figures when one optional section cannot be read", async () => {
    const warnings: string[] = [];
    const { store, conn } = await freshStoreWithConn({
      warn: (event, message) => warnings.push(`${event}: ${message}`),
    });
    const day = localDate();
    await seedInvoice(store, { invoiceNumber: "DASH-KEEP", kind: "SALE", invoiceDate: day, totalAmount: 4_000, paidAmount: 1_000, remainingAmount: 3_000 });

    // a real failure in the optional sections only: with the items table gone
    // both low-stock reads throw, while the invoice aggregates still answer
    conn.raw.exec("DROP TABLE items");

    const result = await store.dashboardSummary(day);

    // the headline figures survive the unrelated failure
    expect(result.salesTotal).toBe(4_000);
    expect(result.salesCount).toBe(1);
    expect(result.owedToUs).toBe(3_000);
    expect(present(result.recentInvoices)).toHaveLength(1);

    // and the sections that failed say so instead of reading as zero or empty
    expect(result.lowStockCount).toBeNull();
    expect(result.lowStockItems).toBeNull();

    // a partial response still succeeds at the RPC layer, so the cause has to
    // be reported here or it is lost entirely
    expect(warnings.some((w) => w.startsWith("DASHBOARD_SECTION_FAILED") && w.includes("lowStock"))).toBe(true);
  });

  itHeavy("includes a supplier account balance in weOwe even with no invoice (issue 176 review)", async () => {
    const store = await freshStore();
    const day = localDate();
    const supplier = await store.createParty("supplier", { name: "مورد رصيد افتتاحي" });
    // an opening balance with no purchase invoice: invisible to the old
    // invoice-remainder-only aggregate, but shown on /debts
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "WE_OWE", amount: 800, invoiceId: null, occurredAt: localDateTime() });

    const result = await store.dashboardSummary(day);
    expect(result.weOwe).toBe(800);

    // the customer side is unchanged by the supplier-account aggregate
    await seedInvoice(store, { invoiceNumber: "DASH-CUST", kind: "SALE", invoiceDate: day, totalAmount: 500, paidAmount: 0, remainingAmount: 500 });
    const withCustomer = await store.dashboardSummary(day);
    expect(withCustomer.weOwe).toBe(800);
    expect(withCustomer.owedToUs).toBe(500);

    // a THEY_OWE correction reduces the same figure, matching /debts
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "THEY_OWE", amount: 300, invoiceId: null, occurredAt: localDateTime() });
    expect((await store.dashboardSummary(day)).weOwe).toBe(500);
  });

  itHeavy("matches the /debts supplier total across id-backed, typed-only and credit accounts (issue 176 review)", async () => {
    const store = await freshStore();
    const day = localDate();

    // id-backed supplier: a 1000 purchase invoice, 300 paid, a 100 THEY_OWE
    // adjustment -> net 600. The ledger already carries the charge, so adding
    // the open invoice's remainder again would double-count it.
    const supplier = await store.createParty("supplier", { name: "مورد حساب" });
    const invoice = await store.insertInvoice({
      invoiceNumber: "DASH-LEDGER-1",
      kind: "PURCHASE",
      counterpartyId: supplier.id,
      counterpartyName: supplier.name,
      invoiceDate: day,
      subtotalAmount: 1000,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: 1000,
      paidAmount: 300,
      remainingAmount: 700,
      notes: null,
    });
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 1000, invoiceId: invoice.id, occurredAt: localDateTime() });
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PAYMENT", amount: 300, invoiceId: invoice.id, occurredAt: localDateTime() });
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "THEY_OWE", amount: 100, invoiceId: null, occurredAt: localDateTime() });

    // a supplier in credit with no invoice at all
    const credit = await store.createParty("supplier", { name: "مورد دائن" });
    await store.insertSupplierEntry({ supplierId: credit.id, kind: "ADJUSTMENT", direction: "THEY_OWE", amount: 200, invoiceId: null, occurredAt: localDateTime() });

    // a typed-name purchase has no account; its unpaid remainder still counts
    await seedInvoice(store, { invoiceNumber: "DASH-TYPED", kind: "PURCHASE", invoiceDate: day, totalAmount: 500, paidAmount: 0, remainingAmount: 500 });

    const result = await store.dashboardSummary(day);
    const rows = await store.debtSummaries();
    const displayed = rows.filter((row) => row.kind === "PURCHASE").reduce((sum, row) => sum + (row.accountBalance ?? row.remainingTotal), 0);

    expect(result.weOwe).toBe(600 + 500 - 200); // 900
    expect(result.weOwe).toBe(displayed);
  });

  itHeavy("returns zeros and an empty list on an empty store", async () => {
    const store = await freshStore();

    const result = await store.dashboardSummary(localDate());

    expect(result).toEqual({
      salesTotal: 0,
      salesCount: 0,
      owedToUs: 0,
      weOwe: 0,
      lowStockCount: 0,
      lowStockItems: [],
      recentInvoices: [],
    });
  });
});
