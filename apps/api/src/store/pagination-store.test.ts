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

describe("party-detail tab pagination (issue 174)", () => {
  // the store is shared across this file, so invoice numbers must be unique
  let invoiceSeq = 0;
  async function makePartyInvoices(partyId: string, partyName: string, count: number, remaining: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const invoice = await store.insertInvoice({
        invoiceNumber: `INV-PARTY-${String(invoiceSeq++).padStart(4, "0")}`,
        kind: "SALE",
        counterpartyId: partyId,
        counterpartyName: partyName,
        invoiceDate: localDate(),
        totalAmount: remaining === 0 ? 1_000 : remaining,
        paidAmount: remaining === 0 ? 1_000 : 0,
        remainingAmount: remaining,
        notes: null,
      });
      ids.push(invoice.id);
    }
    return ids;
  }

  it("pages a party's invoices and keeps total independent of the page", async () => {
    const party = await store.createParty("customer", { name: "زبون ترقيم المتجر" });
    const ids = await makePartyInvoices(party.id, party.name, 12, 1_000);

    const first = await store.partyInvoices("customer", party.id, {}, { limit: 10, offset: 0 });
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(12);
    const second = await store.partyInvoices("customer", party.id, {}, { limit: 10, offset: 10 });
    expect(second.items).toHaveLength(2);
    expect(second.total).toBe(12);
    // pages never overlap and together cover the created rows (the rowid tie
    // break keeps same-second rows from repeating across the page boundary)
    const seen = [...first.items, ...second.items].map((invoice) => invoice.id);
    expect(new Set(seen).size).toBe(12);
    for (const id of ids) expect(seen).toContain(id);

    const past = await store.partyInvoices("customer", party.id, {}, { limit: 10, offset: 10_000 });
    expect(past.items).toHaveLength(0);
    expect(past.total).toBe(12);

    // a large limit still reads the whole set in one page
    const all = await store.partyInvoices("customer", party.id, {}, { limit: 100, offset: 0 });
    expect(all.items).toHaveLength(12);
    expect(all.total).toBe(12);
  });

  it("filters party invoices to unpaid rows and counts only those", async () => {
    const party = await store.createParty("customer", { name: "زبون ترقيم غير مدفوع" });
    await makePartyInvoices(party.id, party.name, 8, 1_000);
    await makePartyInvoices(party.id, party.name, 4, 0);

    const unpaid = await store.partyInvoices("customer", party.id, { unpaidOnly: true }, { limit: 5, offset: 0 });
    expect(unpaid.total).toBe(8);
    expect(unpaid.items).toHaveLength(5);
    expect(unpaid.items.every((invoice) => invoice.remainingAmount > 0)).toBe(true);

    const all = await store.partyInvoices("customer", party.id, {}, { limit: 100, offset: 0 });
    expect(all.total).toBe(12);
    expect(all.items).toHaveLength(12);
  });

  it("pages a party's payments with a stable total", async () => {
    const party = await store.createParty("customer", { name: "زبون ترقيم الدفعات المتجر" });
    const invoiceId = (await makePartyInvoices(party.id, party.name, 1, 12_000))[0];
    if (invoiceId === undefined) throw new Error("expected an invoice");
    for (let i = 0; i < 12; i++) {
      await store.insertPayment({ invoiceId, amount: 100, method: "CASH", note: null, paidAt: localDateTime() });
    }
    const first = await store.partyPayments(party.id, { limit: 5, offset: 0 });
    expect(first.items).toHaveLength(5);
    expect(first.total).toBe(12);
    const second = await store.partyPayments(party.id, { limit: 5, offset: 5 });
    expect(second.items).toHaveLength(5);
    expect(second.total).toBe(12);
    const seen = [...first.items, ...second.items].map((payment) => payment.id);
    expect(new Set(seen).size).toBe(10);
    expect(second.items.every((payment) => payment.invoiceNumber.length > 0)).toBe(true);
  });

  it("pages supplier account entries with a stable total", async () => {
    const supplier = await store.createParty("supplier", { name: "مورد ترقيم الحساب المتجر" });
    for (let i = 0; i < 12; i++) {
      await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 100, invoiceId: null, occurredAt: localDateTime() });
    }
    const first = await store.supplierEntries(supplier.id, { limit: 10, offset: 0 });
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(12);
    const second = await store.supplierEntries(supplier.id, { limit: 10, offset: 10 });
    expect(second.items).toHaveLength(2);
    expect(second.total).toBe(12);
    const seen = [...first.items, ...second.items].map((entry) => entry.id);
    expect(new Set(seen).size).toBe(12);

    // the money read still returns every entry; the tab read pages
    expect(await store.listSupplierEntries(supplier.id)).toHaveLength(12);
    expect((await store.supplierEntries(supplier.id, { limit: 100, offset: 0 })).items).toHaveLength(12);
  });

  it("still returns every party invoice and account entry from partyDetail (money read untouched)", async () => {
    const customer = await store.createParty("customer", { name: "زبون ترقيم الكامل" });
    await makePartyInvoices(customer.id, customer.name, 12, 1_000);
    const detail = await store.partyDetail("customer", customer.id);
    expect(detail?.invoices).toHaveLength(12);
    expect(detail?.stats.invoiceCount).toBe(12);

    const supplier = await store.createParty("supplier", { name: "مورد ترقيم الكامل" });
    for (let i = 0; i < 12; i++) {
      await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 100, invoiceId: null, occurredAt: localDateTime() });
    }
    const supplierDetail = await store.partyDetail("supplier", supplier.id);
    expect(supplierDetail?.account?.entries).toHaveLength(12);
    expect(supplierDetail?.account?.balance).toBe(1200);
  });

  it("returns an empty page for a party with no rows and never crosses roles", async () => {
    const customer = await store.createParty("customer", { name: "زبون بلا فواتير" });
    expect(await store.partyInvoices("customer", customer.id, { unpaidOnly: true }, { limit: 10, offset: 0 })).toEqual({ items: [], total: 0 });
    expect(await store.partyPayments(customer.id, { limit: 10, offset: 0 })).toEqual({ items: [], total: 0 });
    const supplier = await store.createParty("supplier", { name: "مورد بلا حركات" });
    expect(await store.supplierEntries(supplier.id, { limit: 10, offset: 0 })).toEqual({ items: [], total: 0 });
    // the role picks the invoice kind: a supplier read of a customer id is empty
    expect((await store.partyInvoices("supplier", customer.id, {}, { limit: 10, offset: 0 })).total).toBe(0);
  });
});
