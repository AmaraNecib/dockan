import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { localDate, localDateTime } from "../lib/logger";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

/**
 * Issue 163 — server-side pagination at the store seam. One envelope for every
 * flat list: `{ limit, offset }` in, `{ items, total }` out. These tests pin
 * the LIMIT/OFFSET window and, crucially, that `total` is the whole filtered
 * count and never the page size.
 */
let dir: string;
let conn: Connection;
let store: StorePort;
let categoryId: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-page-"));
  conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
  store = createDrizzleStore(conn);
  await store.setup();
  // the seeded default category every test item files under
  categoryId = (await store.listCategories())[0]!.id;
});

afterAll(() => {
  conn.close();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

async function makeItems(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = await store.createItem({
      // zero-padded so the name order is stable and the first page is known
      name: `عنصر ${String(i).padStart(3, "0")}`,
      categoryId,
      costPrice: 100,
      sellingPrice: 150,
      lowStockThreshold: 1,
    });
    ids.push(item.id);
  }
  return ids;
}

async function makeInvoice(number: number): Promise<string> {
  const invoice = await store.insertInvoice({
    invoiceNumber: `INV-PAGE-${String(number).padStart(4, "0")}`,
    kind: "SALE",
    counterpartyId: null,
    counterpartyName: "زبون ترقيم",
    invoiceDate: localDate(),
    totalAmount: 1_000,
    paidAmount: 0,
    remainingAmount: 1_000,
    notes: null,
  });
  return invoice.id;
}

describe("store pagination (issue 163)", () => {
  it("pages items by LIMIT/OFFSET and reports the whole count", async () => {
    const ids = await makeItems(12);

    const first = await store.listItems({ limit: 10, offset: 0 });
    expect(first.items).toHaveLength(10);
    expect(first.total).toBeGreaterThanOrEqual(12);

    const second = await store.listItems({ limit: 10, offset: 10 });
    expect(second.items).toHaveLength(2);
    expect(second.total).toBe(first.total);

    // the two pages do not overlap and together cover the created rows
    const seen = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);

    // past the end is an empty page, not an error, and still carries the total
    const past = await store.listItems({ limit: 10, offset: 10_000 });
    expect(past.items).toHaveLength(0);
    expect(past.total).toBe(first.total);
  });

  it("returns every item when no pagination is asked (internal full reads)", async () => {
    const all = await store.listItems();
    expect(all.total).toBe(all.items.length);
    expect(all.items.length).toBeGreaterThanOrEqual(12);
  });

  it("pages invoices and keeps total independent of the page", async () => {
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await makeInvoice(i));

    const first = await store.listInvoices({ kind: "SALE", limit: 10, offset: 0 });
    expect(first.items).toHaveLength(10);
    expect(first.total).toBeGreaterThanOrEqual(12);

    const second = await store.listInvoices({ kind: "SALE", limit: 10, offset: 10 });
    expect(second.items.length).toBe(first.total - 10);
    expect(second.total).toBe(first.total);

    const seen = [...first.items, ...second.items].map((invoice) => invoice.id);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);

    // a full read (no page keys) still returns everything
    const all = await store.listInvoices({ kind: "SALE" });
    expect(all.items.length).toBe(all.total);
  });

  it("pages activities newest-first and counts the whole log", async () => {
    for (let i = 0; i < 15; i++) {
      await store.insertActivity({ type: "ITEM_CREATED", summary: `ITEM_CREATED صفحة ${i}` });
    }
    const first = await store.listActivities({ limit: 10, offset: 0 });
    const second = await store.listActivities({ limit: 10, offset: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.total).toBeGreaterThanOrEqual(15);
    expect(second.total).toBe(first.total);
    expect(second.items.length).toBe(first.total - 10);
    // newest first: the two pages together are strictly ordered by `at` desc
    // (equal timestamps fall back to rowid); the newest row leads page one
    expect(new Date(first.items[0]!.at).getTime()).toBeGreaterThanOrEqual(new Date(first.items[9]!.at).getTime());
  });

  it("pages customer returns and keeps total independent of the page", async () => {
    const invoiceId = await makeInvoice(900);
    for (let i = 0; i < 3; i++) {
      await store.insertReturn({
        returnNumber: await store.allocateReturnNumber(),
        invoiceId,
        refundAmount: 100,
        cashPaidOut: 100,
        debtOffset: 0,
        payoutMethod: "CASH",
        reason: null,
        status: "PENDING_REVIEW",
        occurredAt: localDateTime(),
      });
    }
    const scoped = await store.listReturns({ invoiceId }, { limit: 2, offset: 0 });
    expect(scoped.items).toHaveLength(2);
    expect(scoped.total).toBe(3);
    const rest = await store.listReturns({ invoiceId }, { limit: 2, offset: 2 });
    expect(rest.items).toHaveLength(1);
    expect(rest.total).toBe(3);

    // no pagination keeps the full internal read
    const all = await store.listReturns({ invoiceId });
    expect(all.items).toHaveLength(3);
    expect(all.total).toBe(3);
  });

  it("pages supplier returns and reports the whole count", async () => {
    const supplier = await store.createParty("supplier", { name: "مورّد ترقيم" });
    for (let i = 0; i < 3; i++) {
      await store.insertSupplierReturn({
        returnNumber: `PRT-PAGE-${i}`,
        supplierId: supplier.id,
        invoiceId: null,
        kind: "FREE_STANDING",
        amount: 10,
        debtReduction: 0,
        credit: 10,
        cashBack: 0,
        reason: null,
        occurredAt: localDateTime(),
      });
    }
    const first = await store.listSupplierReturns({ supplierId: supplier.id }, { limit: 2, offset: 0 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(3);
    const second = await store.listSupplierReturns({ supplierId: supplier.id }, { limit: 2, offset: 2 });
    expect(second.items).toHaveLength(1);
    expect(second.total).toBe(3);
  });
});
