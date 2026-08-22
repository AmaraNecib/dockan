import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { localDateTime, localDate } from "../lib/logger";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

/**
 * Store-seam tests (spec: Testing Decisions — seam 2).
 * Persistence behavior is verified through StorePort against sqlite, never SQL.
 */
let dir: string;
let conn: Connection;
let store: StorePort;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-store-"));
  conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
  store = createDrizzleStore(conn);
  await store.setup();
});

afterAll(() => {
  conn.close();
  // bun:sqlite can keep the file handle open a beat after close on Windows
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

const stamp = () => localDateTime();

describe("setup + seed", () => {
  it("creates tables and seeds the default category and settings", async () => {
    const cats = await store.listCategories();
    expect(cats.some((c) => c.name === "عام")).toBe(true);
    const settings = await store.getSettings();
    expect(settings.storeName).toBe("Dokan");
  });
  it("better-auth tables exist (schema from ADR/ticket 02 wiring)", async () => {
    // SAFETY: sqlite_master name column is TEXT; the query returns the table list verbatim
    const tables = (await conn.db.all(`SELECT name FROM sqlite_master WHERE type='table'`)) as Array<{ name: string }>;
    for (const t of ["user", "session", "account", "verification"]) {
      expect(tables.some((r) => r.name === t)).toBe(true);
    }
  });
});

describe("categories", () => {
  it("creates and lists categories (camelCase fields)", async () => {
    const created = await store.createCategory({ name: "زيوت" });
    expect(created.name).toBe("زيوت");
    expect(created.id).toBeTruthy();
    const all = await store.listCategories();
    expect(all.some((c) => c.id === created.id && c.name === "زيوت")).toBe(true);
  });
});

describe("items", () => {
  it("creates with stock 0 and default threshold, updates, low-stock list", async () => {
    const cats = await store.listCategories();
    const categoryId = cats[0]!.id;
    const item = await store.createItem({
      name: "بطارية",
      categoryId,
      costPrice: 200,
      sellingPrice: 350,
    });
    expect(item.stockOnHand).toBe(0);
    expect(item.lowStockThreshold).toBe(5);
    expect(item.costPrice).toBe(200);

    await store.setItemStockAndCost(item.id, 3, 200);
    const low = await store.listLowStockItems();
    expect(low.some((i) => i.id === item.id)).toBe(true);

    const updated = await store.updateItem(item.id, { id: item.id, name: "بطارية 60ah", sellingPrice: 400 });
    expect(updated?.name).toBe("بطارية 60ah");
    expect(updated?.sellingPrice).toBe(400);

    const byIds = await store.getItemsByIds([item.id, "00000000-0000-4000-8000-000000000000"]);
    expect(byIds.size).toBe(1);
    expect(byIds.get(item.id)?.name).toBe("بطارية 60ah");
  });
});

describe("parties", () => {
  it("creates and lists customers and suppliers", async () => {
    const c = await store.createCustomer({ name: "يوسف", phone: "0550123123" });
    const s = await store.createSupplier({ name: "مخزن الحاج" });
    const customers = await store.listCustomers();
    const suppliers = await store.listSuppliers();
    expect(customers.some((x) => x.id === c.id && x.phone === "0550123123")).toBe(true);
    expect(suppliers.some((x) => x.id === s.id && s.name === "مخزن الحاج")).toBe(true);
  });
});

describe("invoices core", () => {
  it("inserts invoice + line + payment and reads detail", async () => {
    const invoice = await store.insertInvoice({
      invoiceNumber: "INV-0001",
      kind: "PURCHASE",
      counterpartyId: null,
      counterpartyName: "مخزن الحاج",
      invoiceDate: localDate(),
      totalAmount: 30_000,
      paidAmount: 5_000,
      remainingAmount: 25_000,
      notes: null,
    });
    await store.insertInvoiceLine({
      invoiceId: invoice.id,
      itemId: null,
      description: "زيوت 100 قطعة",
      quantity: 100,
      unitPrice: 300,
      costAtSale: 300,
      total: 30_000,
    });
    await store.insertPayment({
      invoiceId: invoice.id,
      amount: 5_000,
      method: "CASH",
      note: null,
      paidAt: stamp(),
    });

    const detail = await store.getInvoiceDetail(invoice.id);
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0]?.total).toBe(30_000);
    expect(detail?.payments).toHaveLength(1);
    expect(detail?.payments[0]?.amount).toBe(5_000);

    expect(await store.lastInvoiceNumber()).toBe("INV-0001");
  });

  it("lists with kind + derived status filters", async () => {
    const invoice = await store.insertInvoice({
      invoiceNumber: "INV-0002",
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "يوسف",
      invoiceDate: localDate(),
      totalAmount: 4_000,
      paidAmount: 1_000,
      remainingAmount: 3_000,
      notes: null,
    });
    const purchases = await store.listInvoices({ kind: "PURCHASE" });
    expect(purchases.items.some((i) => i.invoiceNumber === "INV-0001")).toBe(true);

    const partial = await store.listInvoices({ status: "PARTIAL" });
    expect(partial.items.some((i) => i.id === invoice.id)).toBe(true);

    await store.setInvoicePaidAmounts(invoice.id, 4_000, 0);
    const paid = await store.listInvoices({ status: "PAID" });
    expect(paid.items.some((i) => i.id === invoice.id)).toBe(true);
  });

  it("groups debts by person in both directions", async () => {
    const sale = await store.insertInvoice({
      invoiceNumber: "INV-0003",
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "يوسف",
      invoiceDate: localDate(),
      totalAmount: 1_500,
      paidAmount: 0,
      remainingAmount: 1_500,
      notes: null,
    });
    const sums = await store.debtSummaries();
    const owedToUs = sums.filter((d) => d.kind === "SALE");
    const weOwe = sums.filter((d) => d.kind === "PURCHASE");

    // يوسف appears once — INV-0002 was paid off in the previous test, so his
    // only unpaid SALE is INV-0003 (1500).
    const yusef = owedToUs.filter((d) => d.counterpartyName === "يوسف");
    expect(yusef).toHaveLength(1);
    expect(yusef[0]?.remainingTotal).toBe(1_500);
    expect(yusef[0]?.invoiceCount).toBe(1);
  });

  it("never merges an id-backed party with a same-named free-form party", async () => {
    const idBacked = await store.insertInvoice({
      invoiceNumber: "INV-0100",
      kind: "SALE",
      counterpartyId: "00000000-0000-4000-8000-000000000001",
      counterpartyName: "يوسف",
      invoiceDate: localDate(),
      totalAmount: 1_000,
      paidAmount: 0,
      remainingAmount: 1_000,
      notes: null,
    });
    const freeForm = await store.insertInvoice({
      invoiceNumber: "INV-0101",
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "يوسف",
      invoiceDate: localDate(),
      totalAmount: 500,
      paidAmount: 0,
      remainingAmount: 500,
      notes: null,
    });
    const rows = (await store.debtSummaries()).filter(
      (d) => d.counterpartyName === "يوسف" && d.kind === "SALE" && (d.counterpartyId === null || d.counterpartyId === "00000000-0000-4000-8000-000000000001"),
    );
    expect(rows).toHaveLength(2);
    const byId = rows.find((r) => r.counterpartyId !== null);
    const byName = rows.find((r) => r.counterpartyId === null);
    expect(byId?.remainingTotal).toBe(1_000);
    expect(byName?.remainingTotal).toBe(500);
    expect(idBacked.id).toBeTruthy();
    expect(freeForm.id).toBeTruthy();
  });
});

describe("edge cases", () => {
  it("derives UNPAID status and date filters", async () => {
    const unpaid = await store.listInvoices({ status: "UNPAID" });
    const numbers = unpaid.items.map((i) => i.invoiceNumber);
    expect(numbers).toContain("INV-0003"); // 1500 of 1500 paid → nothing paid
    expect(numbers).not.toContain("INV-0002"); // paid off in the earlier test

    const farFuture = await store.listInvoices({ fromDate: "2099-01-01" });
    expect(farFuture.items).toHaveLength(0);
    expect(farFuture.totalCount).toBe(0);
  });

  it("returns undefined for missing rows", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(await store.updateItem(missing, { id: missing, name: "ن" })).toBeUndefined();
    expect(await store.getInvoiceDetail(missing)).toBeUndefined();
  });

  it("rejects an item pointing at a missing category (foreign key)", async () => {
    await expect(
      store.createItem({ name: "خارج التصنيف", categoryId: "00000000-0000-4000-8000-000000000000", costPrice: 100, sellingPrice: 150 }),
    ).rejects.toThrow();
  });
});

describe("activities + settings", () => {
  it("records and lists activities newest-first", async () => {
    await store.insertActivity({ type: "SALE_CREATED", summary: "بيع INV-0002", ref: "INV-0002" });
    await store.insertActivity({ type: "ITEM_CREATED", summary: "إنشاء منتج بطارية" });
    const list = await store.listActivities(10);
    expect(list[0]?.type).toBe("ITEM_CREATED");
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("updates settings", async () => {
    const updated = await store.updateSettings({ storeName: "متجر السيارات", storePhone: "0661234567" });
    expect(updated.storeName).toBe("متجر السيارات");
    expect(updated.storePhone).toBe("0661234567");
    expect((await store.getSettings()).storeName).toBe("متجر السيارات");
  });
});

describe("auth column migration", () => {
  it("rebuilds a ticket-01 auth table (snake columns) into the current schema", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-auth-legacy-"));
    const legacy = openConnection(createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }));
    // the account/session tables ticket 01 left behind: snake_case, NOT NULL
    legacy.raw.exec("CREATE TABLE account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, userId TEXT NOT NULL)");
    legacy.raw.exec("CREATE TABLE session (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL)");
    const legacyStore = createDrizzleStore(legacy);
    await legacyStore.setup();
    // SAFETY: PRAGMA table_info returns rows shaped { name }
    const accountRows = legacy.raw.query("PRAGMA table_info(account)").all() as Array<{ name: string }>;
    const accountCols = accountRows.map((r) => r.name);
    expect(accountCols).toContain("issuer");
    expect(accountCols).toContain("password");
    expect(accountCols).not.toContain("account_id");
    // SAFETY: same PRAGMA row shape on the session table
    const sessionRows = legacy.raw.query("PRAGMA table_info(session)").all() as Array<{ name: string }>;
    expect(sessionRows.map((r) => r.name)).toContain("expiresAt");
    legacy.close();
    // bun:sqlite can keep the file handle open a beat after close on Windows
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });
});

describe("backup", () => {
  it("copies a consistent database file that opens standalone", async () => {
    const dest = path.join(dir, "backups", "dokan-2026-08-22.db");
    await store.copyDatabaseTo(dest);
    expect(fs.existsSync(dest)).toBe(true);

    const backupConn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dest }));
    const backupStore = createDrizzleStore(backupConn);
    const cats = await backupStore.listCategories();
    expect(cats.length).toBeGreaterThanOrEqual(1);
    backupConn.close();
  });
});