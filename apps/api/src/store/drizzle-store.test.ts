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
  conn = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db"), DOKAN_BUILD_SECRET: "test-build-secret-123" }),
    );
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

describe("barcodes (ticket 28)", () => {
  it("round-trips a barcode; uncoded items stay valid (null)", async () => {
    const cats = await store.listCategories();
    const categoryId = cats[0]!.id;
    const coded = await store.createItem({ name: "كوددار", categoryId, costPrice: 100, sellingPrice: 150, barcode: "6291111111113" });
    expect(coded.barcode).toBe("6291111111113");
    const uncoded = await store.createItem({ name: "بلا كود", categoryId, costPrice: 50, sellingPrice: 80 });
    expect(uncoded.barcode).toBeNull();

    const found = await store.getItemByBarcode("6291111111113");
    expect(found?.id).toBe(coded.id);
    expect(await store.getItemByBarcode("0000000000000")).toBeUndefined();

    // update can set and clear the barcode
    await store.updateItem(uncoded.id, { id: uncoded.id, barcode: "BC-1" });
    expect((await store.getItemByBarcode("BC-1"))?.id).toBe(uncoded.id);
    await store.updateItem(uncoded.id, { id: uncoded.id, barcode: null });
    expect((await store.getItemByBarcode("BC-1"))?.id).toBeUndefined();
  });

  it("rejects a duplicate barcode with a UNIQUE violation", async () => {
    const cats = await store.listCategories();
    const categoryId = cats[0]!.id;
    await store.createItem({ name: "أول", categoryId, costPrice: 10, sellingPrice: 20, barcode: "DUP-1" });
    await expect(
      store.createItem({ name: "ثاني", categoryId, costPrice: 30, sellingPrice: 40, barcode: "DUP-1" }),
    ).rejects.toThrow(/unique/i);
  });

  it("migrates a legacy items table (no barcode column) on setup", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-items-legacy-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db"), DOKAN_BUILD_SECRET: "test-build-secret-123" }),
    );
    try {
      // the pre-ticket-28 items shape: no barcode column, plus a row to prove data survives
      legacy.raw.exec(
        "CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      legacy.raw.exec(
        "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id), cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL DEFAULT 5, stock_on_hand INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      legacy.raw.exec("INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-l', 'قديم', '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      legacy.raw.exec(
        "INSERT INTO items (id, name, category_id, cost_price, selling_price, low_stock_threshold, stock_on_hand, created_at, updated_at) VALUES ('item-l', 'منتج قديم', 'cat-l', 10, 20, 5, 2, '2026-01-01T00:00:00', '2026-01-01T00:00:00')",
      );

      const legacyStore = createDrizzleStore(legacy);
      await legacyStore.setup();

      // SAFETY: PRAGMA table_info returns rows shaped { name }
      const rows = legacy.raw.query("PRAGMA table_info(items)").all() as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toContain("barcode");

      const migrated = await legacyStore.getItemByBarcode("NEW-1");
      expect(migrated).toBeUndefined();
      const updated = await legacyStore.updateItem("item-l", { id: "item-l", barcode: "NEW-1" });
      expect(updated?.barcode).toBe("NEW-1");
      const listed = await legacyStore.listItems();
      expect(listed.find((i) => i.id === "item-l")?.name).toBe("منتج قديم");
    } finally {
      legacy.close();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(legacyDir, { recursive: true, force: true });
          break;
        } catch {
          Bun.sleepSync(50);
        }
      }
    }
  });

  it("backfills sale fields when an existing invoice schema predates discounts", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-sales-legacy-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db"), DOKAN_BUILD_SECRET: "test-build-secret-123" }),
    );
    try {
      legacy.raw.exec("CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      legacy.raw.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL, cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL, stock_on_hand INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      legacy.raw.exec("CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      legacy.raw.exec("CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, item_id TEXT, description TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL, cost_at_sale INTEGER NOT NULL, total INTEGER NOT NULL)");
      legacy.raw.exec("INSERT INTO categories VALUES ('legacy-cat', 'قديم', '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      legacy.raw.exec("INSERT INTO items VALUES ('legacy-item', 'منتج قديم', 'legacy-cat', 100, 200, 5, 1, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      legacy.raw.exec("INSERT INTO invoices VALUES ('legacy-invoice', 'INV-LEGACY', 'SALE', NULL, NULL, '2026-01-01', 200, 0, 200, NULL, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      legacy.raw.exec("INSERT INTO invoice_lines VALUES ('legacy-line', 'legacy-invoice', 'legacy-item', 'منتج قديم', 1, 200, 100, 200)");

      const legacyStore = createDrizzleStore(legacy);
      await legacyStore.setup();
      const detail = await legacyStore.getInvoiceDetail("legacy-invoice");
      expect(detail).toMatchObject({ subtotalAmount: 200, discountType: null, discountValue: null, discountAmount: 0 });
      expect(detail?.lines[0]).toMatchObject({ defaultUnitPrice: 200, discountAllocated: 0, netTotal: 200 });
    } finally {
      legacy.close();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(legacyDir, { recursive: true, force: true });
          break;
        } catch {
          Bun.sleepSync(50);
        }
      }
    }
  });

  it("heals an interrupted sale-column migration on the next setup (schema present, backfill not applied)", async () => {
    const interruptedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-sales-interrupted-"));
    const interrupted = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: interruptedDir, DOKAN_DB_PATH: path.join(interruptedDir, "interrupted.db"), DOKAN_BUILD_SECRET: "test-build-secret-123" }),
    );
    try {
      // The interrupted state: the ALTERs from a previous boot committed (all
      // NEW columns exist) but the historical backfill never ran and no
      // completion marker was written — rows still carry the legacy defaults.
      interrupted.raw.exec("CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      interrupted.raw.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL, cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL, stock_on_hand INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      interrupted.raw.exec("CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, subtotal_amount INTEGER NOT NULL DEFAULT 0, discount_type TEXT, discount_value INTEGER, discount_amount INTEGER NOT NULL DEFAULT 0, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      interrupted.raw.exec("CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, item_id TEXT, description TEXT NOT NULL, quantity INTEGER NOT NULL, default_unit_price INTEGER NOT NULL DEFAULT 0, unit_price INTEGER NOT NULL, cost_at_sale INTEGER NOT NULL, total INTEGER NOT NULL, discount_allocated INTEGER NOT NULL DEFAULT 0, net_total INTEGER NOT NULL DEFAULT 0)");
      interrupted.raw.exec("INSERT INTO categories VALUES ('interrupted-cat', 'قديم', '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      interrupted.raw.exec("INSERT INTO items VALUES ('interrupted-item', 'منتج قديم', 'interrupted-cat', 100, 200, 5, 1, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      interrupted.raw.exec("INSERT INTO invoices VALUES ('interrupted-invoice', 'INV-INTERRUPTED', 'SALE', NULL, NULL, '2026-01-01', 0, NULL, NULL, 0, 200, 0, 200, NULL, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      interrupted.raw.exec("INSERT INTO invoice_lines VALUES ('interrupted-line', 'interrupted-invoice', NULL, 'منتج قديم', 1, 0, 200, 100, 200, 0, 0)");

      const interruptedStore = createDrizzleStore(interrupted);
      await interruptedStore.setup();

      // the next setup completes the backfill even though the schema already
      // had the columns (the marker, not column presence, gates the UPDATEs)
      const healed = await interruptedStore.getInvoiceDetail("interrupted-invoice");
      expect(healed).toMatchObject({ subtotalAmount: 200, discountType: null, discountValue: null, discountAmount: 0 });
      expect(healed?.lines[0]).toMatchObject({ defaultUnitPrice: 200, discountAllocated: 0, netTotal: 200 });
      expect(await interruptedStore.getSetting("migration.saleColumnsV1")).toBe("done");

      // post-heal modern rows must survive later setup calls: a zero default
      // price is real for the item, and a fully discounted line's net zero is
      // real too — the restricted WHERE clauses and the marker keep them.
      interrupted.raw.exec("INSERT INTO invoices VALUES ('modern-invoice', 'INV-MODERN', 'SALE', NULL, NULL, '2026-02-01', 700, 'PERCENTAGE', 100, 700, 0, 0, 0, NULL, '2026-02-01T00:00:00', '2026-02-01T00:00:00')");
      interrupted.raw.exec("INSERT INTO invoice_lines VALUES ('modern-line', 'modern-invoice', NULL, 'منتج مجاني الافتراضي', 1, 0, 700, 100, 700, 700, 0)");
      await interruptedStore.setup();
      const modern = await interruptedStore.getInvoiceDetail("modern-invoice");
      expect(modern?.lines[0]).toMatchObject({ defaultUnitPrice: 0, unitPrice: 700, discountAllocated: 700, netTotal: 0 });
    } finally {
      interrupted.close();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(interruptedDir, { recursive: true, force: true });
          break;
        } catch {
          Bun.sleepSync(50);
        }
      }
    }
  });

  it("never rewrites legitimate zero-default sale lines in a markerless database", async () => {
    const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-sales-stale-"));
    const stale = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: staleDir, DOKAN_DB_PATH: path.join(staleDir, "stale.db"), DOKAN_BUILD_SECRET: "test-build-secret-123" }),
    );
    try {
      // A database upgraded from the PRE-marker implementation: the columns
      // exist, the old backfill already ran there, no marker was ever written —
      // and it holds legitimate modern sale lines whose default price is 0
      // (an item with zero selling price sold at a negotiated price) plus one
      // not-yet-healed pre-migration line.
      stale.raw.exec("CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      stale.raw.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL, cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL, stock_on_hand INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      stale.raw.exec("CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, subtotal_amount INTEGER NOT NULL DEFAULT 0, discount_type TEXT, discount_value INTEGER, discount_amount INTEGER NOT NULL DEFAULT 0, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      stale.raw.exec("CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, item_id TEXT, description TEXT NOT NULL, quantity INTEGER NOT NULL, default_unit_price INTEGER NOT NULL DEFAULT 0, unit_price INTEGER NOT NULL, cost_at_sale INTEGER NOT NULL, total INTEGER NOT NULL, discount_allocated INTEGER NOT NULL DEFAULT 0, net_total INTEGER NOT NULL DEFAULT 0)");
      stale.raw.exec("INSERT INTO categories VALUES ('stale-cat', 'قديم', '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      stale.raw.exec("INSERT INTO items VALUES ('stale-item', 'منتج قديم', 'stale-cat', 100, 200, 5, 1, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      // modern, undiscounted: zero default price, negotiated 700, net 700
      stale.raw.exec("INSERT INTO invoices VALUES ('modern-plain', 'INV-PLAIN', 'SALE', NULL, NULL, '2026-02-01', 700, NULL, NULL, 0, 700, 0, 700, NULL, '2026-02-01T00:00:00', '2026-02-01T00:00:00')");
      stale.raw.exec("INSERT INTO invoice_lines VALUES ('modern-plain-line', 'modern-plain', NULL, 'منتج بدون سعر افتراضي', 1, 0, 700, 100, 700, 0, 700)");
      // modern, fully discounted: zero default, negotiated 700, net 0
      stale.raw.exec("INSERT INTO invoices VALUES ('modern-free', 'INV-FREE', 'SALE', NULL, NULL, '2026-02-02', 700, 'PERCENTAGE', 100, 700, 0, 0, 0, NULL, '2026-02-02T00:00:00', '2026-02-02T00:00:00')");
      stale.raw.exec("INSERT INTO invoice_lines VALUES ('modern-free-line', 'modern-free', NULL, 'منتج بدون سعر افتراضي', 1, 0, 700, 100, 700, 700, 0)");
      // pre-migration line the interrupted backfill never reached
      stale.raw.exec("INSERT INTO invoices VALUES ('legacy-late', 'INV-LATE', 'SALE', NULL, NULL, '2026-01-01', 0, NULL, NULL, 0, 200, 0, 200, NULL, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      stale.raw.exec("INSERT INTO invoice_lines VALUES ('legacy-late-line', 'legacy-late', NULL, 'منتج قديم', 1, 0, 200, 100, 200, 0, 0)");

      const staleStore = createDrizzleStore(stale);
      await staleStore.setup();

      // the two modern zero-default snapshots survive untouched…
      const plain = await staleStore.getInvoiceDetail("modern-plain");
      expect(plain?.lines[0]).toMatchObject({ defaultUnitPrice: 0, unitPrice: 700, discountAllocated: 0, netTotal: 700 });
      const free = await staleStore.getInvoiceDetail("modern-free");
      expect(free?.lines[0]).toMatchObject({ defaultUnitPrice: 0, unitPrice: 700, discountAllocated: 700, netTotal: 0 });
      // …while the invariant-consistent pre-migration line still heals
      const late = await staleStore.getInvoiceDetail("legacy-late");
      expect(late).toMatchObject({ subtotalAmount: 200 });
      expect(late?.lines[0]).toMatchObject({ defaultUnitPrice: 200, netTotal: 200 });
      expect(await staleStore.getSetting("migration.saleColumnsV1")).toBe("done");

      // a later setup with the marker present changes nothing
      await staleStore.setup();
      expect((await staleStore.getInvoiceDetail("modern-plain"))?.lines[0]).toMatchObject({ defaultUnitPrice: 0, netTotal: 700 });
      expect((await staleStore.getInvoiceDetail("modern-free"))?.lines[0]).toMatchObject({ defaultUnitPrice: 0, netTotal: 0 });
    } finally {
      stale.close();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(staleDir, { recursive: true, force: true });
          break;
        } catch {
          Bun.sleepSync(50);
        }
      }
    }
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
      subtotalAmount: 30_000,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
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
      defaultUnitPrice: 300,
      unitPrice: 300,
      costAtSale: 300,
      total: 30_000,
      discountAllocated: 0,
      netTotal: 30_000,
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
    expect(detail?.lines[0]?.defaultUnitPrice).toBe(300);
    expect(detail?.lines[0]?.netTotal).toBe(30_000);
    expect(detail?.subtotalAmount).toBe(30_000);
    expect(detail?.discountAmount).toBe(0);
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
    await store.insertInvoice({
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
      counterpartyName: "زبون مزدوج",
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
      counterpartyName: "زبون مزدوج",
      invoiceDate: localDate(),
      totalAmount: 500,
      paidAmount: 0,
      remainingAmount: 500,
      notes: null,
    });
    const rows = (await store.debtSummaries()).filter(
      (d) => d.counterpartyName === "زبون مزدوج" && d.kind === "SALE" && (d.counterpartyId === null || d.counterpartyId === "00000000-0000-4000-8000-000000000001"),
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

describe("transactions", () => {
  it("rolls the whole unit back when the callback throws (audit + mutation stay atomic)", async () => {
    const before = (await store.listCategories()).length;
    await expect(
      store.withTransaction(async (tx) => {
        await tx.createCategory({ name: "غير قابل للحفظ" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = (await store.listCategories()).length;
    expect(after).toBe(before);
    const names = (await store.listCategories()).map((c) => c.name);
    expect(names).not.toContain("غير قابل للحفظ");
  });

  it("commits everything inside the unit on success", async () => {
    const created = await store.withTransaction(async (tx) => {
      const category = await tx.createCategory({ name: "يُحفظ معاً" });
      await tx.insertActivity({ type: "CATEGORY_CREATED", summary: category.name, ref: category.id });
      return category;
    });
    expect((await store.listCategories()).some((c) => c.id === created.id)).toBe(true);
    expect((await store.listActivities(10)).some((a) => a.ref === created.id)).toBe(true);
  });

  it("serializes concurrent units without nested BEGIN collisions", async () => {
    const [a, b] = await Promise.all([
      store.withTransaction(async (tx) => tx.createCategory({ name: "ألف" })),
      store.withTransaction(async (tx) => tx.createCategory({ name: "باء" })),
    ]);
    const names = (await store.listCategories()).map((c) => c.name);
    expect(names).toContain("ألف");
    expect(names).toContain("باء");
    expect(a.id).not.toBe(b.id);
  });

  it("serializes plain operations against open transactions (no interleave, no deadlock)", async () => {
    // a transaction that holds its slot open while a plain read arrives
    const hold = new Promise<void>((resolve) => setTimeout(resolve, 30));
    const txRun = store.withTransaction(async (tx) => {
      await tx.createCategory({ name: "أثناء المعاملة" });
      await hold;
      return "done";
    });
    const plainRun = store.listCategories();
    const [txResult, list] = await Promise.all([txRun, plainRun]);
    expect(txResult).toBe("done");
    // the plain read ran AFTER the transaction committed, not inside it
    expect(list.some((c) => c.name === "أثناء المعاملة")).toBe(true);
  });

  it("plain operations never inherit another transaction's rollback", async () => {
    const rollingBack = store.withTransaction(async (tx) => {
      await tx.createCategory({ name: "سَترتبط" });
      throw new Error("rollback");
    });
    const plainOp = store.createCategory({ name: "خارج التصحيح" });
    await expect(rollingBack).rejects.toThrow("rollback");
    await plainOp;
    const names = (await store.listCategories()).map((c) => c.name);
    expect(names).not.toContain("سَترتبط"); // the unit rolled back only its own writes
    expect(names).toContain("خارج التصحيح"); // the plain op ran afterwards, unharmed
  });

  it("keeps one unit's failure from breaking the next unit's commit", async () => {
    const bad = store.withTransaction(async (tx) => {
      await tx.createCategory({ name: "يفشل" });
      throw new Error("boom-two");
    });
    const good = store.withTransaction(async (tx) => tx.createCategory({ name: "ينجح رغم ذلك" }));
    await expect(bad).rejects.toThrow("boom-two");
    await good;
    const names = (await store.listCategories()).map((c) => c.name);
    expect(names).toContain("ينجح رغم ذلك");
    expect(names).not.toContain("يفشل");
  });

  it("allocates invoice numbers atomically across independent connections", async () => {
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-invoice-sequence-"));
    const dbPath = path.join(sharedDir, "shared.db");
    const firstConnection = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: sharedDir, DOKAN_DB_PATH: dbPath, DOKAN_BUILD_SECRET: "test-build-secret-123" }),
    );
    const secondConnection = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: sharedDir, DOKAN_DB_PATH: dbPath, DOKAN_BUILD_SECRET: "test-build-secret-123" }),
    );
    const firstStore = createDrizzleStore(firstConnection);
    const secondStore = createDrizzleStore(secondConnection);
    try {
      await firstStore.setup();
      await secondStore.setup();

      // These are separate store instances (and therefore separate SQLite
      // connections); the database UPDATE, not either store's queue, owns the
      // uniqueness boundary.
      const [first, second] = await Promise.all([
        firstStore.allocateInvoiceNumber(),
        secondStore.allocateInvoiceNumber(),
      ]);
      expect(new Set([first, second])).toEqual(new Set(["INV-0001", "INV-0002"]));

      // The same allocator is safe inside the transaction seam used by the
      // router, and the reservation is committed alongside the invoice row.
      const persisted = await firstStore.withTransaction(async (tx) => {
        const invoiceNumber = await tx.allocateInvoiceNumber();
        return tx.insertInvoice({
          invoiceNumber,
          kind: "PURCHASE",
          counterpartyId: null,
          counterpartyName: "عملية محفوظة",
          invoiceDate: "2026-08-25",
          totalAmount: 0,
          paidAmount: 0,
          remainingAmount: 0,
          notes: null,
        });
      });
      expect(persisted.invoiceNumber).toBe("INV-0003");

      // A failed transaction must not burn a number, because the sequence
      // update is part of the same atomic unit as the invoice insert.
      await expect(
        firstStore.withTransaction(async (tx) => {
          await tx.allocateInvoiceNumber();
          throw new Error("rollback-number");
        }),
      ).rejects.toThrow("rollback-number");
      expect(await firstStore.allocateInvoiceNumber()).toBe("INV-0004");

      // A pre-existing manually assigned number must also advance the next
      // suggestion; this protects setup/migration databases with old invoices.
      await firstStore.insertInvoice({
        invoiceNumber: "INV-0042",
        kind: "PURCHASE",
        counterpartyId: null,
        counterpartyName: "رقم قديم",
        invoiceDate: "2026-08-25",
        totalAmount: 0,
        paidAmount: 0,
        remainingAmount: 0,
        notes: null,
      });
      expect(await firstStore.allocateInvoiceNumber()).toBe("INV-0043");
    } finally {
      firstConnection.close();
      secondConnection.close();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(sharedDir, { recursive: true, force: true });
          break;
        } catch {
          Bun.sleepSync(50);
        }
      }
    }
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
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db"), DOKAN_BUILD_SECRET: "test-build-secret-123" }),
    );
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

  it("refuses to drop non-empty legacy auth tables", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-auth-nonempty-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
    );
    legacy.raw.exec("CREATE TABLE account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, userId TEXT NOT NULL)");
    legacy.raw.exec("INSERT INTO account (id, account_id, provider_id, userId) VALUES ('account-1', 'user-1', 'credential', 'user-1')");
    const legacyStore = createDrizzleStore(legacy);
    await expect(legacyStore.setup()).rejects.toThrow("non-empty legacy auth tables: account");
    // SAFETY: the inserted row is queried from the table we just created
    const rows = legacy.raw.query("SELECT id FROM account").all() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["account-1"]);
    legacy.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });
});

describe("backup", () => {
  it("copies a consistent database file that opens standalone", async () => {
    const dest = path.join(dir, "backups", "dokan-2026-08-22.db");
    await store.copyDatabaseTo(dest);
    expect(fs.existsSync(dest)).toBe(true);

    const backupConn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dest, DOKAN_BUILD_SECRET: "test-build-secret-123" }));
    const backupStore = createDrizzleStore(backupConn);
    const cats = await backupStore.listCategories();
    expect(cats.length).toBeGreaterThanOrEqual(1);
    backupConn.close();
  });
});
describe("barcode update collisions (test audit)", () => {
  it("updateItem onto another item's barcode hits the same UNIQUE constraint", async () => {
    const cats = await store.listCategories();
    const categoryId = cats[0]!.id;
    const a = await store.createItem({ name: "عناصر أ", categoryId, costPrice: 10, sellingPrice: 20, barcode: "UPD-A" });
    const b = await store.createItem({ name: "عناصر ب", categoryId, costPrice: 30, sellingPrice: 40, barcode: "UPD-B" });
    await expect(store.updateItem(b.id, { id: b.id, barcode: "UPD-A" })).rejects.toThrow(/unique/i);
    // clearing A's barcode frees the code for B
    await store.updateItem(a.id, { id: a.id, barcode: null });
    const moved = await store.updateItem(b.id, { id: b.id, barcode: "UPD-A" });
    expect(moved?.barcode).toBe("UPD-A");
  });
});

// --- ticket 29 — purchase linkage -----------------------------------------
describe("stock links + invoice line lookup (ticket 29)", () => {
  it("round-trips attribution records and filters them per item", async () => {
    const cats = await store.listCategories();
    const categoryId = cats[0]!.id;
    const a = await store.createItem({ name: "ربط-أ", categoryId, costPrice: 100, sellingPrice: 150 });
    const b = await store.createItem({ name: "ربط-ب", categoryId, costPrice: 200, sellingPrice: 300 });
    const invoice = await store.insertInvoice({
      invoiceNumber: "INV-9001",
      kind: "PURCHASE",
      counterpartyId: null,
      counterpartyName: "مورد المخزن",
      invoiceDate: localDate(),
      totalAmount: 800,
      paidAmount: 0,
      remainingAmount: 800,
      notes: null,
    });
    const movementA = await store.insertStockMovement({ itemId: a.id, kind: "PURCHASE", delta: 4, unitCost: 100, reason: null, ref: null, occurredAt: stamp() });
    // an uninvoiced movement on ANOTHER item must never leak into A's links
    await store.insertStockMovement({ itemId: b.id, kind: "PURCHASE", delta: 2, unitCost: 200, reason: null, ref: null, occurredAt: stamp() });

    const link = await store.insertStockLink({ invoiceId: invoice.id, movementId: movementA.id, quantity: 4 });
    expect(link.id).toBeTruthy();
    expect(link).toMatchObject({ invoiceId: invoice.id, movementId: movementA.id, quantity: 4 });

    const linksA = await store.listStockLinksByItem(a.id);
    expect(linksA).toHaveLength(1);
    expect(linksA[0]).toMatchObject({ movementId: movementA.id, quantity: 4 });
    expect(await store.listStockLinksByItem(b.id)).toEqual([]);
  });

  it("getInvoiceLine returns a single line or undefined", async () => {
    const cats = await store.listCategories();
    const categoryId = cats[0]!.id;
    const item = await store.createItem({ name: "سطر-بحث", categoryId, costPrice: 50, sellingPrice: 90 });
    const invoice = await store.insertInvoice({
      invoiceNumber: "INV-9002",
      kind: "PURCHASE",
      counterpartyId: null,
      counterpartyName: null,
      invoiceDate: localDate(),
      totalAmount: 500,
      paidAmount: 0,
      remainingAmount: 500,
      notes: null,
    });
    const line = await store.insertInvoiceLine({
      invoiceId: invoice.id,
      itemId: item.id,
      description: item.name,
      quantity: 10,
      unitPrice: 50,
      costAtSale: 50,
      total: 500,
    });
    const found = await store.getInvoiceLine(line.id);
    expect(found).toMatchObject({ id: line.id, itemId: item.id, quantity: 10, costAtSale: 50 });
    expect(await store.getInvoiceLine("00000000-0000-4000-8000-000000000009")).toBeUndefined();
  });
});
