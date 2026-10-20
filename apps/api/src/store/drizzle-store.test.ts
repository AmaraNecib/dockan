import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { HEAVY_TEST_TIMEOUT_MS, setHeavyDefaultTimeout } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { localDateTime, localDate } from "../lib/logger";
import { supplierBalance, UnsignableSupplierEntryError } from "../lib/supplier-ledger";
import { createDrizzleStore, backfillReturnDebtApplications, seedExpenseCategories } from "./drizzle-store";
import type { StorePort } from "./port";

// The whole file is store-seam work against a real SQLite database, including
// legacy-database fixtures in individual tests; every test takes the budget.
setHeavyDefaultTimeout();

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
      createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }),
    );
  store = createDrizzleStore(conn);
  await store.setup();
}, HEAVY_TEST_TIMEOUT_MS);

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

/** bun:sqlite can keep the file handle open a beat after close on Windows;
 * retry the temp-dir removal instead of failing the test on EBUSY. */
const removeTempDirRetry = (dir: string): void => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
};

describe("setup + seed", () => {
  it("creates tables and seeds the default category and settings", async () => {
    const cats = await store.listCategories();
    expect(cats.some((c) => c.name === "عام")).toBe(true);
    const settings = await store.getSettings();
    expect(settings.storeName).toBe("Dokan");
  });

  it("seeds expense categories with one distinct owner-withdrawal category, idempotently", async () => {
    const first = await store.listExpenseCategories();
    expect(first.some((row) => row.isOwnerWithdrawal)).toBe(true);
    const withdrawal = first.filter((row) => row.isOwnerWithdrawal);
    expect(withdrawal).toHaveLength(1);
    expect(withdrawal[0]!.name).toBe("سحوبات المالك");
    expect(first.some((row) => row.name === "كراء المحل")).toBe(true);
    // the seeded rows round-trip the boolean through the integer column
    expect(first.find((row) => row.name === "سحوبات المالك")!.isOwnerWithdrawal).toBe(true);
    expect(first.find((row) => row.name === "كراء المحل")!.isOwnerWithdrawal).toBe(false);
    // a second setup() must never duplicate the defaults
    await store.setup();
    const second = await store.listExpenseCategories();
    expect(second).toEqual(first);
  });

  it("rejects a duplicate category name at the store seam and round-trips the flag", async () => {
    const { isOwnerWithdrawal } = await store.createExpenseCategory({ name: "تصنيف مخصص", isOwnerWithdrawal: true });
    expect(isOwnerWithdrawal).toBe(true);
    await expect(store.createExpenseCategory({ name: "تصنيف مخصص" })).rejects.toThrow();
    // a later setup() never removes or duplicates owner-created categories
    await store.setup();
    const names = (await store.listExpenseCategories()).map((row) => row.name);
    expect(names.filter((name) => name === "تصنيف مخصص")).toHaveLength(1);
  });

  it("self-heals an interrupted default-category seed exactly once (greptile round)", async () => {
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-exp-seed-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: seedDir, DOKAN_DB_PATH: path.join(seedDir, "seed.db") }),
    );
    const legacyStore = createDrizzleStore(legacy);
    await legacyStore.setup(); // full atomic seed + marker
    // simulate the pre-fix crash state: a few defaults committed, count
    // nonzero, the owner-withdrawal category missing, marker absent
    legacy.raw.exec("DELETE FROM settings WHERE key = 'seed.expenseCategoriesV1'");
    legacy.raw.exec("DELETE FROM expense_categories WHERE name IN ('سحوبات المالك', 'صيانة وتصليح')");
    const degraded = await legacyStore.listExpenseCategories();
    expect(degraded.some((row) => row.name === "سحوبات المالك")).toBe(false);
    expect(degraded).toHaveLength(5);
    // the next boot completes the set exactly once (no duplicates, flag intact)
    await legacyStore.setup();
    const healed = await legacyStore.listExpenseCategories();
    expect(healed).toHaveLength(7);
    expect(healed.find((row) => row.name === "سحوبات المالك")?.isOwnerWithdrawal).toBe(true);
    expect(healed.filter((row) => row.name === "سحوبات المالك")).toHaveLength(1);
    // a third setup is a no-op (marker present)
    await legacyStore.setup();
    expect(await legacyStore.listExpenseCategories()).toHaveLength(7);
    legacy.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(seedDir, { recursive: true, force: true });
        return;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });

  it("keeps the defaults-only-when-empty policy: owner tables are never reseeded (greptile round)", async () => {
    const ownerDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-exp-owner-"));
    const ownerConn = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: ownerDir, DOKAN_DB_PATH: path.join(ownerDir, "owner.db") }),
    );
    const ownerStore = createDrizzleStore(ownerConn);
    await ownerStore.setup();
    // degrade into a hypothetical legacy owner table: no marker, one
    // owner-created category, no defaults at all
    ownerConn.raw.exec("DELETE FROM settings WHERE key = 'seed.expenseCategoriesV1'");
    ownerConn.raw.exec("DELETE FROM expense_categories");
    ownerConn.raw.exec("INSERT INTO expense_categories (id, name, is_owner_withdrawal, created_at, updated_at) VALUES ('owner-1', 'تصنيفي الخاص', 0, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
    // setup() must NOT inject defaults into an owner-populated table
    await ownerStore.setup();
    expect((await ownerStore.listExpenseCategories()).map((row) => row.name)).toEqual(["تصنيفي الخاص"]);
    ownerConn.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(ownerDir, { recursive: true, force: true });
        return;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });

  it("enforces the money CHECK constraints at the database level", async () => {
    const categories = await store.listExpenseCategories();
    const op = categories.find((row) => !row.isOwnerWithdrawal)!;
    // the router validates via zod; the store must ALSO reject raw negatives
    await expect(
      store.insertExpense({ categoryId: op.id, amount: -5, note: null, occurredAt: "2026-02-10T12:00:00" }),
    ).rejects.toThrow();
  });

  // Regression for the greptile round at ab5e585: two processes racing boot
  // on a partially-seeded database used to BOTH read under a deferred
  // snapshot; the loser's read-to-write upgrade then failed with
  // SQLITE_BUSY_SNAPSHOT — a raw crash during startup.
  //
  // Lock-first unit proof (deterministic, no timing): hold the write lock on
  // a second connection, shrink busy_timeout, and record every SQL statement
  // the seed issues. The fixed unit fails AT ITS BEGIN IMMEDIATE without
  // having read anything; a deferred begin would read rows+marker first and
  // only die later at its first INSERT. Full setup() cannot host this race:
  // its earlier invoice_number_sequence conditional INSERT queues on the same
  // lock first (single autocommit statement — no stale-snapshot risk), so it
  // absorbs any contention before the seed is ever reached.
  it("expense seed takes the write lock BEFORE its marker/rows read", async () => {
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-exp-lockfirst-"));
    const seedConn = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: seedDir, DOKAN_DB_PATH: path.join(seedDir, "seed.db") }),
    );
    const seedStore = createDrizzleStore(seedConn);
    await seedStore.setup();
    // partial-seed state: the unit will genuinely want to write when it runs
    seedConn.raw.exec("DELETE FROM settings WHERE key = 'seed.expenseCategoriesV1'");
    seedConn.raw.exec("DELETE FROM expense_categories WHERE name IN ('سحوبات المالك', 'صيانة وتصليح')");

    // second connection holds the write lock for the whole attempt
    const holder = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: seedDir, DOKAN_DB_PATH: path.join(seedDir, "seed.db") }),
    );
    holder.raw.exec("BEGIN IMMEDIATE");
    holder.raw.exec("INSERT INTO settings (key, value) VALUES ('lock.probe', 'held') ON CONFLICT(key) DO UPDATE SET value = 'held'");
    seedConn.raw.exec("PRAGMA busy_timeout = 250;");

    // record the seed's statement order. Pass-through spies bound to the same
    // driver methods; signatures are preserved verbatim so production call
    // sites inside the seed keep their exact types.
    const calls: string[] = [];
    const driver = seedConn.raw;
    const head = (statement: string): string => {
      const parts = statement.trimStart().split(/\s+/);
      return parts[0]! + " " + (parts[1] ?? "");
    };
    const origExec = driver.exec.bind(driver);
    const origQuery = driver.query.bind(driver);
    const spiedExec: typeof origExec = (statement) => {
      calls.push(head(statement));
      return origExec(statement);
    };
    const spiedQuery: typeof origQuery = (statement, ...rest) => {
      calls.push(statement.trimStart().split(/[\s;]/)[0]!);
      // SAFETY: rest is the bound query's own parameter list forwarded verbatim
      return origQuery(statement, ...rest);
    };
    driver.exec = spiedExec;
    driver.query = spiedQuery;

    try {
      // the unit must refuse to read while another writer holds the lock:
      // BEGIN IMMEDIATE itself is what blocks and throws
      await expect(Promise.resolve().then(() => seedExpenseCategories(seedConn))).rejects.toThrow(/locked|busy/i);
      // FIRST statement is the immediate begin; NOTHING was read after it —
      // a deferred begin would show the expense/settings SELECTs here
      expect(calls[0]).toBe("BEGIN IMMEDIATE");
      expect(calls).toHaveLength(1);
    } finally {
      driver.exec = origExec;
      driver.query = origQuery;
      holder.raw.exec("ROLLBACK");
      holder.close();
      // self-heal still works once the lock is gone: the deflated database
      // completes to exactly the seven defaults through the normal unit
      seedConn.raw.exec("PRAGMA busy_timeout = 5000;");
      seedExpenseCategories(seedConn);
      const healed = await seedStore.listExpenseCategories();
      expect(healed).toHaveLength(7);
      expect(healed.find((row) => row.name === "سحوبات المالك")?.isOwnerWithdrawal).toBe(true);
      // SAFETY: the literal SELECT reads one known settings row
      const markerRows = seedConn.raw.query("SELECT value FROM settings WHERE key = 'seed.expenseCategoriesV1'").all() as Array<{ value: string }>;
      expect(markerRows).toHaveLength(1);
      seedConn.close();
      removeTempDirRetry(seedDir);
    }
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
  it("listItems carries the category name next to categoryId (issue 67)", async () => {
    const category = await store.createCategory({ name: "سوائل محركات" });
    const item = await store.createItem({
      name: "زيت مكينة 5w30",
      categoryId: category.id,
      costPrice: 500,
      sellingPrice: 600,
    });
    const listed = (await store.listItems()).items;
    const row = listed.find((i) => i.id === item.id)!;
    expect(row.categoryName).toBe("سوائل محركات");
    expect(row.categoryId).toBe(category.id);
  });

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
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
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
      const listed = (await legacyStore.listItems()).items;
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
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
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

  it("migrates a pre-#68 returns table: adds debt_applied and marks legacy rows fully applied", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-returns-legacy-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
    );
    try {
      // the pre-#68 shape: settles the debt at creation, has cash_paid_out /
      // debt_offset but no debt_applied — a PENDING return with a 5000 offset
      // that was ALREADY applied to the invoice by the old code
      legacy.raw.exec(
        "CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      legacy.raw.exec(
        "CREATE TABLE returns (id TEXT PRIMARY KEY, return_number TEXT NOT NULL UNIQUE, invoice_id TEXT NOT NULL, refund_amount INTEGER NOT NULL, cash_paid_out INTEGER NOT NULL, debt_offset INTEGER NOT NULL, payout_method TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      legacy.raw.exec(
        "INSERT INTO invoices VALUES ('legacy-inv', 'INV-LEGACY', 'SALE', NULL, 'قديم', '2026-01-01', 10000, 5000, 5000, NULL, '2026-01-01T00:00:00', '2026-01-01T00:00:00')",
      );
      legacy.raw.exec(
        "INSERT INTO returns VALUES ('legacy-ret', 'RTN-LEGACY', 'legacy-inv', 10000, 5000, 5000, 'CASH', NULL, 'PENDING_REVIEW', '2026-01-01T10:00:00', '2026-01-01T10:00:00', '2026-01-01T10:00:00')",
      );

      const legacyStore = createDrizzleStore(legacy);
      await legacyStore.setup();

      // SAFETY: PRAGMA table_info returns rows shaped { name, type, ... }
      const cols = legacy.raw.query("PRAGMA table_info(returns)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("debt_applied");
      // the backfill marks the legacy row as fully applied, so the new accept
      // path (debtOffset − debtApplied) can never double-relieve the invoice
      const migrated = await legacyStore.getReturnDetail("legacy-ret");
      expect(migrated?.debtOffset).toBe(5_000);
      expect(migrated?.debtApplied).toBe(5_000);

      // re-running setup is idempotent (ALTER + backfill do not fire again)
      await legacyStore.setup();
      const again = await legacyStore.getReturnDetail("legacy-ret");
      expect(again?.debtApplied).toBe(5_000);
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

  it("migrates a v5 returns table: adds spreads_across_invoices and defaults every legacy row to own-invoice-only", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-returns-spread-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
    );
    try {
      // the version-5 shape: debt_applied exists (round 2's column) and the
      // allocation rule does not. EVERY row in it was written before the
      // tab-wide default existed, so the new column must read 0.
      legacy.raw.exec(
        "CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      legacy.raw.exec(
        "CREATE TABLE returns (id TEXT PRIMARY KEY, return_number TEXT NOT NULL UNIQUE, invoice_id TEXT NOT NULL, refund_amount INTEGER NOT NULL, cash_paid_out INTEGER NOT NULL, debt_offset INTEGER NOT NULL, debt_applied INTEGER NOT NULL DEFAULT 0, payout_method TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      legacy.raw.exec(
        "INSERT INTO invoices VALUES ('legacy-inv', 'INV-SPREAD', 'SALE', NULL, 'زبون', '2026-01-01', 1000, 600, 400, NULL, '2026-01-01T00:00:00', '2026-01-01T00:00:00')",
      );
      legacy.raw.exec(
        "INSERT INTO returns VALUES ('legacy-ret', 'RTN-SPREAD', 'legacy-inv', 400, 0, 400, 0, 'CASH', NULL, 'PENDING_REVIEW', '2026-01-01T10:00:00', '2026-01-01T10:00:00', '2026-01-01T10:00:00')",
      );

      const legacyStore = createDrizzleStore(legacy);
      await legacyStore.setup();

      // SAFETY: PRAGMA table_info returns rows shaped { name, type, ... }
      const cols = legacy.raw.query("PRAGMA table_info(returns)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("spreads_across_invoices");
      // the legacy promise was made under the own-invoice-only rule, so the
      // DEFAULT must not turn it into a tab-wide one — that would let an old
      // promise relieve invoices the owner never named
      expect((await legacyStore.getReturnDetail("legacy-ret"))?.spreadsAcrossInvoices).toBe(false);

      // the DEFAULT is what an OLDER build (one that does not know the column)
      // writes on a v6 database: own-invoice-only, the rule it honoured
      legacy.raw.exec(
        "INSERT INTO returns (id, return_number, invoice_id, refund_amount, cash_paid_out, debt_offset, debt_applied, payout_method, status, occurred_at, created_at, updated_at) VALUES ('old-build-ret', 'RTN-OLDBUILD', 'legacy-inv', 100, 100, 0, 0, 'CASH', 'PENDING_REVIEW', '2026-01-02T10:00:00', '2026-01-02T10:00:00', '2026-01-02T10:00:00')",
      );
      expect((await legacyStore.getReturnDetail("old-build-ret"))?.spreadsAcrossInvoices).toBe(false);

      // and a row THIS build records keeps what the caller asked for, so the
      // column is not merely a constant
      const scripted = await legacyStore.insertReturn({
        returnNumber: "RTN-SPREAD-2",
        invoiceId: "legacy-inv",
        refundAmount: 100,
        cashPaidOut: 0,
        debtOffset: 100,
        spreadsAcrossInvoices: true,
        payoutMethod: "CASH",
        reason: null,
        status: "PENDING_REVIEW",
        occurredAt: "2026-01-03T10:00:00",
      });
      expect((await legacyStore.getReturnDetail(scripted.id))?.spreadsAcrossInvoices).toBe(true);

      // re-running setup is idempotent (the ALTER does not fire again)
      await legacyStore.setup();
      expect((await legacyStore.getReturnDetail("legacy-ret"))?.spreadsAcrossInvoices).toBe(false);
      expect((await legacyStore.getReturnDetail(scripted.id))?.spreadsAcrossInvoices).toBe(true);
    } finally {
      legacy.close();
      removeTempDirRetry(legacyDir);
    }
  });

  it("heals an interrupted sale-column migration on the next setup (schema present, backfill not applied)", async () => {
    const interruptedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-sales-interrupted-"));
    const interrupted = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: interruptedDir, DOKAN_DB_PATH: path.join(interruptedDir, "interrupted.db") }),
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
      // (The table now carries cogs_exact, appended by the first setup; the
      // value 1×100 is the true layer sum for this 1-unit line.)
      interrupted.raw.exec("INSERT INTO invoices VALUES ('modern-invoice', 'INV-MODERN', 'SALE', NULL, NULL, '2026-02-01', 700, 'PERCENTAGE', 100, 700, 0, 0, 0, NULL, '2026-02-01T00:00:00', '2026-02-01T00:00:00')");
      interrupted.raw.exec("INSERT INTO invoice_lines VALUES ('modern-line', 'modern-invoice', NULL, 'منتج مجاني الافتراضي', 1, 0, 700, 100, 700, 700, 0, 100)");
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
      createAppConfig({ DOKAN_DATA_DIR: staleDir, DOKAN_DB_PATH: path.join(staleDir, "stale.db") }),
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
      // modern purchase with a zero cost basis bought at an explicit price —
      // default (item cost 0) legitimately differs from the actual unit price
      stale.raw.exec("INSERT INTO invoices VALUES ('modern-purchase', 'INV-PURCHASE', 'PURCHASE', NULL, NULL, '2026-02-03', 700, NULL, NULL, 0, 700, 700, 0, NULL, '2026-02-03T00:00:00', '2026-02-03T00:00:00')");
      stale.raw.exec("INSERT INTO invoice_lines VALUES ('modern-purchase-line', 'modern-purchase', NULL, 'شراء بسعر صريح', 1, 0, 700, 700, 700, 0, 700)");
      // pre-migration line the interrupted backfill never reached
      stale.raw.exec("INSERT INTO invoices VALUES ('legacy-late', 'INV-LATE', 'SALE', NULL, NULL, '2026-01-01', 0, NULL, NULL, 0, 200, 0, 200, NULL, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      stale.raw.exec("INSERT INTO invoice_lines VALUES ('legacy-late-line', 'legacy-late', NULL, 'منتج قديم', 1, 0, 200, 100, 200, 0, 0)");

      // byte-identical proof: the modern rows' full PRE-EXISTING column state
      // before setup() must survive setup() untouched; only the marker lands
      // (the cogs_exact column is ADDITIVE — a database created before it gets
      // the backfill quantity × cost_at_sale, exactly like the discount
      // columns did, so those rows are listed explicitly and the new column
      // is excluded from the byte-identity check)
      const legacyCols =
        "SELECT id, invoice_id, item_id, description, quantity, default_unit_price, unit_price, cost_at_sale, total, discount_allocated, net_total FROM invoice_lines WHERE id = ?";
      const modernRows = ["modern-plain-line", "modern-free-line", "modern-purchase-line"] as const;
      const before = modernRows.map((id) => stale.raw.query(legacyCols).all(id));

      const staleStore = createDrizzleStore(stale);
      await staleStore.setup();

      for (const [index, id] of modernRows.entries()) {
        expect(stale.raw.query(legacyCols).all(id)).toEqual(before[index]!);
      }

      // the modern zero-default snapshots survive untouched…
      const plain = await staleStore.getInvoiceDetail("modern-plain");
      expect(plain?.lines[0]).toMatchObject({ defaultUnitPrice: 0, unitPrice: 700, discountAllocated: 0, netTotal: 700 });
      const free = await staleStore.getInvoiceDetail("modern-free");
      expect(free?.lines[0]).toMatchObject({ defaultUnitPrice: 0, unitPrice: 700, discountAllocated: 700, netTotal: 0 });
      const purchased = await staleStore.getInvoiceDetail("modern-purchase");
      expect(purchased?.lines[0]).toMatchObject({ defaultUnitPrice: 0, unitPrice: 700, discountAllocated: 0, netTotal: 700 });
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

  it("adds cogs_exact to pre-column databases, backfills legacy rows, and marks the run", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-cogs-legacy-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
    );
    try {
      // a database created before the exact-COGS column existed: invoices +
      // invoice_lines already carry the discount columns, but no cogs_exact
      legacy.raw.exec("CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      legacy.raw.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL, cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL, stock_on_hand INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      legacy.raw.exec("CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, subtotal_amount INTEGER NOT NULL DEFAULT 0, discount_type TEXT, discount_value INTEGER, discount_amount INTEGER NOT NULL DEFAULT 0, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      legacy.raw.exec("CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, item_id TEXT, description TEXT NOT NULL, quantity INTEGER NOT NULL, default_unit_price INTEGER NOT NULL DEFAULT 0, unit_price INTEGER NOT NULL, cost_at_sale INTEGER NOT NULL, total INTEGER NOT NULL, discount_allocated INTEGER NOT NULL DEFAULT 0, net_total INTEGER NOT NULL DEFAULT 0)");
      legacy.raw.exec("INSERT INTO categories VALUES ('cogs-cat', 'قديم', '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      legacy.raw.exec("INSERT INTO items VALUES ('cogs-item', 'منتج قديم', 'cogs-cat', 100, 200, 5, 1, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      // a pre-#30 PURCHASE line (cost = unit basis) and a legacy SALE line
      legacy.raw.exec("INSERT INTO invoices VALUES ('cogs-purchase', 'INV-COGS-P', 'PURCHASE', NULL, NULL, '2026-01-01', 600, NULL, NULL, 0, 600, 600, 0, NULL, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
      legacy.raw.exec("INSERT INTO invoice_lines VALUES ('cogs-purchase-line', 'cogs-purchase', NULL, 'شراء قديم', 3, 0, 200, 200, 600, 0, 600)");
      legacy.raw.exec("INSERT INTO invoices VALUES ('cogs-sale', 'INV-COGS-S', 'SALE', NULL, NULL, '2026-01-02', 0, NULL, NULL, 0, 500, 0, 500, NULL, '2026-01-02T00:00:00', '2026-01-02T00:00:00')");
      legacy.raw.exec("INSERT INTO invoice_lines VALUES ('cogs-sale-line', 'cogs-sale', NULL, 'بيع قديم', 5, 0, 500, 117, 500, 0, 500)");

      const legacyStore = createDrizzleStore(legacy);
      await legacyStore.setup();

      // the write seam exposes the backfilled DTO (exact for the PURCHASE
      // line, the documented quantity × cost_at_sale approximation for the
      // legacy SALE line) and the marker is durable
      const purchase = await legacyStore.getInvoiceDetail("cogs-purchase");
      expect(purchase?.lines[0]).toMatchObject({ costAtSale: 200, cogsExact: 600 });
      const sale = await legacyStore.getInvoiceDetail("cogs-sale");
      expect(sale?.lines[0]).toMatchObject({ costAtSale: 117, cogsExact: 5 * 117 });
      expect(await legacyStore.getSetting("migration.cogsExactV1")).toBe("done");

      // a second setup is a no-op: the marker gating keeps the backfill from
      // overwriting values (the column exists, the marker is set)
      legacy.raw.exec("UPDATE invoice_lines SET cogs_exact = 42 WHERE id = 'cogs-purchase-line'");
      await legacyStore.setup();
      expect((await legacyStore.getInvoiceDetail("cogs-purchase"))?.lines[0]?.cogsExact).toBe(42);

      // the self-healing repair is NOT marker-gated: a row that somehow
      // carries DEFAULT 0 while its cost snapshot is positive (e.g. written
      // by a build that predates this column) heals on the next boot even
      // though the marker is present
      legacy.raw.exec("UPDATE invoice_lines SET cogs_exact = 0 WHERE id = 'cogs-sale-line'");
      await legacyStore.setup();
      expect((await legacyStore.getInvoiceDetail("cogs-sale"))?.lines[0]?.cogsExact).toBe(5 * 117);
      // …and a genuine zero-cost line is never rewritten
      legacy.raw.exec("UPDATE invoice_lines SET cogs_exact = 0, cost_at_sale = 0 WHERE id = 'cogs-sale-line'");
      await legacyStore.setup();
      expect((await legacyStore.getInvoiceDetail("cogs-sale"))?.lines[0]?.cogsExact).toBe(0);

      // the write seam's fallback: a caller that omits cogsExact (older
      // adapters/migration tests) gets the documented quantity × cost_at_sale
      // approximation instead of a schema break
      const viaSeam = await legacyStore.withTransaction((tx) =>
        tx.insertInvoiceLine({ invoiceId: "cogs-purchase", itemId: null, description: "بدون قيمة دقيقة", quantity: 2, unitPrice: 50, costAtSale: 50, total: 100 }),
      );
      expect(viaSeam.cogsExact).toBe(100);
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
});

describe("parties", () => {
  it("creates and lists customers and suppliers", async () => {
    const c = await store.createParty("customer", { name: "يوسف", phone: "0550123123" });
    const s = await store.createParty("supplier", { name: "مخزن الحاج" });
    const customers = await store.listParties("customer");
    const suppliers = await store.listParties("supplier");
    expect(customers.some((x) => x.id === c.id && x.phone === "+213550123123")).toBe(true);
    expect(suppliers.some((x) => x.id === s.id && x.name === "مخزن الحاج")).toBe(true);
  });

  it("reads names-only party identities and a lean supplier account summary (#183)", async () => {
    const supplier = await store.createParty("supplier", { name: "مورد-الأسماء" });
    const netZero = await store.createParty("supplier", { name: "مورد-صفر" });
    await store.createParty("customer", { name: "عميل-الأسماء" });

    // the conflict-check seam returns identity only: no invoice aggregate, no phone
    const supplierNames = await store.listPartyNames("supplier");
    const nameRow = supplierNames.find((row) => row.id === supplier.id);
    expect(nameRow?.name).toBe("مورد-الأسماء");
    expect(Object.keys(nameRow!).sort()).toEqual(["id", "name"]);
    // same order as the list seam (ORDER BY name), so paging/permutation cannot drift
    expect(supplierNames.map((row) => row.name)).toEqual((await store.listParties("supplier")).map((row) => row.name));
    // customers are a separate identity space
    expect((await store.listPartyNames("customer")).some((row) => row.name === "عميل-الأسماء")).toBe(true);

    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 500, invoiceId: null, occurredAt: localDateTime() });
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PAYMENT", amount: 200, invoiceId: null, method: "CASH", occurredAt: localDateTime() });
    // a NET-ZERO account still carries an entry count: the confirmation gate must
    // key on the count, never on a non-zero balance
    await store.insertSupplierEntry({ supplierId: netZero.id, kind: "PURCHASE", amount: 400, invoiceId: null, occurredAt: localDateTime() });
    await store.insertSupplierEntry({ supplierId: netZero.id, kind: "PAYMENT", amount: 400, invoiceId: null, method: "CASH", occurredAt: localDateTime() });

    const summary = (await store.listSupplierAccountSummaries()).find((row) => row.id === supplier.id);
    expect(summary).toMatchObject({ accountBalance: -300, accountEntryCount: 2 });
    expect((await store.listSupplierAccountSummaries()).find((row) => row.id === netZero.id)).toMatchObject({ accountBalance: 0, accountEntryCount: 2 });
    // the same sign expression as the list seam, so the two cannot disagree
    const listRow = (await store.listParties("supplier")).find((party) => party.id === supplier.id);
    expect(listRow?.accountBalance).toBe(summary?.accountBalance);
    expect(listRow?.accountEntryCount).toBe(summary?.accountEntryCount);
  });
});

describe("parties (issue 120): identity, delete rule, detail, backfill", () => {
  it("treats phone as identity: unique when present, NULLs distinct, update moves it", async () => {
    const first = await store.createParty("customer", { name: "هوية-١", phone: "0560123456" });
    expect(first.phone).toBe("+213560123456");
    // the same number in another spelling is the same identity
    await expect(store.createParty("customer", { name: "هوية-٢", phone: "+213 560 123 456" })).rejects.toMatchObject({ code: "PHONE_EXISTS" });
    // NULL phones never collide (SQLite keeps NULLs distinct)
    await store.createParty("customer", { name: "بدون-هاتف-١" });
    await store.createParty("customer", { name: "بدون-هاتف-٢" });
    // updating onto a taken phone refuses...
    const third = await store.createParty("customer", { name: "هوية-٣" });
    await expect(store.updateParty("customer", third.id, { phone: "0560123456" })).rejects.toMatchObject({ code: "PHONE_EXISTS" });
    // ...updating the owner with a reformatted same number is fine...
    const same = await store.updateParty("customer", first.id, { phone: "0560 123 456" });
    expect(same?.phone).toBe("+213560123456");
    // ...and clearing the holder's phone frees it for a new record
    await store.updateParty("customer", first.id, { phone: null });
    const freed = await store.createParty("customer", { name: "هوية-٤", phone: "0560123456" });
    expect(freed.phone).toBe("+213560123456");
    // suppliers are a separate identity space
    const supplier = await store.createParty("supplier", { name: "مورد-هوية", phone: "0560123456" });
    expect(supplier.phone).toBe("+213560123456");
    // updating a missing party reports absence, not a phone refusal
    expect(await store.updateParty("customer", "00000000-0000-4000-8000-000000000000", { name: "لا أحد" })).toBeUndefined();
  });

  it("clears separator-only and invisible-only phones to null and strips bidi marks", async () => {
    const dotted = await store.createParty("customer", { name: "نقاط-١", phone: "..." });
    const dashed = await store.createParty("customer", { name: "نقاط-٢", phone: " - " });
    // both clean away to nothing: an unset phone, never an "" identity that
    // the second walk-in would collide on
    expect(dotted.phone).toBeNull();
    expect(dashed.phone).toBeNull();
    // a bidi mark pasted from WhatsApp must not create a phantom identity
    const marked = await store.createParty("customer", { name: "علامة-خفيّة", phone: "\u200F0550999888" });
    expect(marked.phone).toBe("+213550999888");
    // a landline keeps its digits with separators stripped
    const landline = await store.createParty("customer", { name: "هاتف-ثابت", phone: "023 55 12 34" });
    expect(landline.phone).toBe("023551234");
  });

  it("folds Arabic-Indic digits so the same number is one identity", async () => {
    const arabic = await store.createParty("customer", { name: "أرقام-عربية", phone: "٠٥٦٧٦٥٤٣٢١" });
    expect(arabic.phone).toBe("+213567654321");
    // the ASCII spelling of the same number collides
    await expect(store.createParty("customer", { name: "أرقام-لاتينية", phone: "0567654321" })).rejects.toMatchObject({ code: "PHONE_EXISTS" });
    // Extended Arabic-Indic (Persian) digits fold too
    const persian = await store.createParty("customer", { name: "أرقام-فارسية", phone: "۰۵۶۸۷۶۵۴۳۲" });
    expect(persian.phone).toBe("+213568765432");
  });

  it("keeps the partial unique phone index as the cross-process backstop", async () => {
    // bypasses the store rule on purpose: proves the DDL index exists and
    // constrains present phones (NULLs stay distinct by the partial predicate)
    conn.raw.query("INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)").run(crypto.randomUUID(), "سباق-١", "+213555000111", localDateTime());
    expect(() =>
      conn.raw.query("INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)").run(crypto.randomUUID(), "سباق-٢", "+213555000111", localDateTime()),
    ).toThrow(/UNIQUE/);
    // a second NULL phone is always fine
    conn.raw.query("INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, NULL, ?)").run(crypto.randomUUID(), "بدون-سباق-١", localDateTime());
    conn.raw.query("INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, NULL, ?)").run(crypto.randomUUID(), "بدون-سباق-٢", localDateTime());
  });

  it("refuses a canonical phone that a raw non-canonical row already owns", async () => {
    // an import/adapter that writes a raw spelling must not escape the identity
    // rule: the store check re-normalizes every stored row before comparing
    conn.raw.query("INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)").run(crypto.randomUUID(), "خام-١", "0550 12 34 56", localDateTime());
    await expect(store.createParty("customer", { name: "خام-٢", phone: "0550123456" })).rejects.toMatchObject({ code: "PHONE_EXISTS" });
  });

  it("rejects non-numeric phone text as an identity (issue 129)", async () => {
    await expect(store.createParty("customer", { name: "هاتف-نص", phone: "abc" })).rejects.toMatchObject({ code: "INVALID_PHONE" });
    await expect(store.createParty("customer", { name: "هاتف-مختلط", phone: "12a34" })).rejects.toMatchObject({ code: "INVALID_PHONE" });
    await expect(store.createParty("supplier", { name: "مورد-نص", phone: "هاتف" })).rejects.toMatchObject({ code: "INVALID_PHONE" });
    // the refused record was not created
    expect((await store.listParties("customer")).some((c) => c.name === "هاتف-نص")).toBe(false);

    // an update is refused the same way; a name-only edit and a clear still work
    const party = await store.createParty("customer", { name: "هاتف-سليم", phone: "0550111222" });
    await expect(store.updateParty("customer", party.id, { phone: "abc" })).rejects.toMatchObject({ code: "INVALID_PHONE" });
    const renamed = await store.updateParty("customer", party.id, { name: "هاتف-سليم-٢" });
    expect(renamed?.phone).toBe("+213550111222");
    expect((await store.updateParty("customer", party.id, { phone: null }))?.phone).toBeNull();

    // Arabic-Indic digits are accepted and normalise to the one canonical identity
    const arabic = await store.createParty("customer", { name: "هاتف-عربي", phone: "٠٥٥٠٩٨٧٦٥٤" });
    expect(arabic.phone).toBe("+213550987654");
    await expect(store.createParty("customer", { name: "هاتف-لاتيني", phone: "0550987654" })).rejects.toMatchObject({ code: "PHONE_EXISTS" });
  });

  it("hard-deletes only a party with zero invoices (the delete rule)", async () => {
    const empty = await store.createParty("customer", { name: `حذف-${stamp()}` });
    expect(await store.deleteParty("customer", empty.id)).toBe("DELETED");
    expect(await store.getParty("customer", empty.id)).toBeUndefined();

    const kept = await store.createParty("supplier", { name: `مورد-محفوظ-${stamp()}` });
    await store.insertInvoice({
      invoiceNumber: `INV-DEL-${Date.now()}`,
      kind: "PURCHASE",
      counterpartyId: kept.id,
      counterpartyName: kept.name,
      invoiceDate: localDate(),
      subtotalAmount: 1_000,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: 1_000,
      paidAmount: 0,
      remainingAmount: 1_000,
      notes: null,
    });
    expect(await store.deleteParty("supplier", kept.id)).toBe("HAS_INVOICES");
    expect(await store.getParty("supplier", kept.id)).toBeDefined();
    expect(await store.deleteParty("customer", "00000000-0000-4000-8000-000000000000")).toBe("NOT_FOUND");
  });

  it("lists kind-scoped aggregates and returns the detail payload", async () => {
    const customer = await store.createParty("customer", { name: `تفاصيل-${stamp()}` });
    const other = await store.createParty("supplier", { name: `تفاصيل-مورد-${stamp()}` });
    const zeroRow = (await store.listParties("customer")).find((row) => row.id === customer.id);
    expect(zeroRow?.stats).toEqual({ invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 });

    const base = {
      kind: "SALE" as const,
      counterpartyId: customer.id,
      counterpartyName: customer.name,
      invoiceDate: localDate(),
      subtotalAmount: 0,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      notes: null,
    };
    const first = await store.insertInvoice({ ...base, invoiceNumber: `INV-DET-${Date.now()}-1`, totalAmount: 1_000, paidAmount: 400, remainingAmount: 600 });
    const second = await store.insertInvoice({ ...base, invoiceNumber: `INV-DET-${Date.now()}-2`, totalAmount: 500, paidAmount: 500, remainingAmount: 0 });
    // a PURCHASE on the same party must not leak into the customer detail
    await store.insertInvoice({ ...base, kind: "PURCHASE", counterpartyId: other.id, counterpartyName: other.name, invoiceNumber: `INV-DET-${Date.now()}-3`, totalAmount: 700, paidAmount: 0, remainingAmount: 700 });
    await store.insertPayment({ invoiceId: first.id, amount: 400, method: "CASH", note: null, paidAt: localDateTime() });
    await store.insertPayment({ invoiceId: second.id, amount: 500, method: "CASH", note: null, paidAt: localDateTime() });

    const row = (await store.listParties("customer")).find((r) => r.id === customer.id);
    expect(row?.stats).toEqual({ invoiceCount: 2, totalAmount: 1_500, paidAmount: 900, remainingAmount: 600 });

    const detail = await store.partyDetail("customer", customer.id);
    expect(detail?.party.name).toBe(customer.name);
    expect(detail?.stats).toEqual({ invoiceCount: 2, totalAmount: 1_500, paidAmount: 900, remainingAmount: 600 });
    expect(detail?.invoices.map((i) => i.id).sort()).toEqual([first.id, second.id].sort());
    expect(detail?.payments).toHaveLength(2);
    expect(detail?.payments.map((p) => p.invoiceNumber).sort()).toEqual([first.invoiceNumber, second.invoiceNumber].sort());
    // table scoping: a supplier id is not a customer, and vice versa
    expect(await store.partyDetail("customer", other.id)).toBeUndefined();
    expect((await store.partyDetail("supplier", other.id))?.stats.invoiceCount).toBe(1);
    expect(await store.partyDetail("customer", "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("treats an empty update patch as a no-op and clamps legacy aggregate values", async () => {
    const party = await store.createParty("customer", { name: `تحديث-فارغ-${stamp()}` });
    expect(await store.updateParty("customer", party.id, {})).toMatchObject({ id: party.id, name: party.name });
    // a legacy invoice with a malformed stored remaining must not blank the
    // whole list/detail page through contract output validation
    await store.insertInvoice({
      invoiceNumber: `INV-NEG-${Date.now()}`,
      kind: "SALE",
      counterpartyId: party.id,
      counterpartyName: party.name,
      invoiceDate: localDate(),
      subtotalAmount: 100,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: 100,
      paidAmount: 105,
      remainingAmount: -5,
      notes: null,
    });
    expect((await store.listParties("customer")).find((row) => row.id === party.id)?.stats.remainingAmount).toBe(0);
    expect((await store.partyDetail("customer", party.id))?.stats.remainingAmount).toBe(0);
    expect((await store.partyDetail("customer", party.id))?.invoices).toHaveLength(1);
    // the high end is clamped too: an aggregate above MAX_SAFE_INTEGER would
    // otherwise fail dinarsSchema's max and blank the same surfaces
    const huge = await store.createParty("customer", { name: `حد-أقصى-${stamp()}` });
    await store.insertInvoice({
      invoiceNumber: `INV-HUGE-${Date.now()}`,
      kind: "SALE",
      counterpartyId: huge.id,
      counterpartyName: huge.name,
      invoiceDate: localDate(),
      subtotalAmount: 0,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: Number.MAX_SAFE_INTEGER + 10,
      paidAmount: 0,
      remainingAmount: Number.MAX_SAFE_INTEGER + 10,
      notes: null,
    });
    expect((await store.partyDetail("customer", huge.id))?.stats.remainingAmount).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("labels an id-backed debt group with the party's current name", async () => {
    const originalName = `قبل-التعديل-${stamp()}`;
    const renamed = `بعد-التعديل-${stamp()}`;
    const party = await store.createParty("customer", { name: originalName });
    const invoiceNumber = `INV-RENAME-${Date.now()}`;
    await store.insertInvoice({
      invoiceNumber,
      kind: "SALE",
      counterpartyId: party.id,
      counterpartyName: originalName,
      invoiceDate: localDate(),
      subtotalAmount: 0,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: 5_000,
      paidAmount: 0,
      remainingAmount: 5_000,
      notes: null,
    });
    await store.updateParty("customer", party.id, { name: renamed });

    // the debts screen shows the CURRENT name for the id-backed group...
    expect((await store.debtSummaries()).find((row) => row.counterpartyId === party.id)?.counterpartyName).toBe(renamed);
    // ...while the invoice keeps its historical snapshot (history not rewritten)
    expect((await store.listInvoices({})).items.find((row) => row.invoiceNumber === invoiceNumber)?.counterpartyName).toBe(originalName);
  });

  it("backfills one party per distinct typed name and points the five live invoices at it", async () => {
    const backfillDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-backfill-"));
    const conn = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: backfillDir, DOKAN_DB_PATH: path.join(backfillDir, "legacy.db") }),
    );
    try {
      const legacy = createDrizzleStore(conn);
      await legacy.setup();
      const base = { invoiceDate: localDate(), subtotalAmount: 0, discountType: null, discountValue: null, discountAmount: 0, notes: null };
      let n = 0;
      const seed = (kind: "SALE" | "PURCHASE", name: string, total: number) =>
        legacy.insertInvoice({
          ...base,
          invoiceNumber: `INV-LEGACY-${++n}`,
          kind,
          counterpartyId: null,
          counterpartyName: name,
          totalAmount: total,
          paidAmount: 0,
          remainingAmount: total,
        });
      await seed("SALE", "عماره", 12_000);
      await seed("SALE", "محمد بنين", 40_000);
      await seed("SALE", "علي علي", 230_000);
      await seed("SALE", "  علي علي ", 40_000); // padded same name → one record
      await seed("PURCHASE", "صالح بن علي", 34_000);
      await seed("PURCHASE", "ماني", 9_000);
      // a whitespace-only typed name must never become an invisible party
      await seed("SALE", "\u00A0", 7_000);
      // simulate the pre-upgrade database: invoices exist, the marker does not
      conn.raw.exec("DELETE FROM settings WHERE key = 'migration.counterpartyBackfillV1'");
      await legacy.setup();

      const customers = await legacy.listParties("customer");
      const suppliers = await legacy.listParties("supplier");
      expect(customers.map((c) => c.name).sort()).toEqual(["علي علي", "عماره", "محمد بنين"].sort());
      expect(suppliers.map((s) => s.name).sort()).toEqual(["صالح بن علي", "ماني"].sort());
      // two «علي علي» invoices share one record and aggregate together
      expect(customers.find((c) => c.name === "علي علي")?.stats).toMatchObject({ invoiceCount: 2, totalAmount: 270_000, remainingAmount: 270_000 });
      expect(customers.find((c) => c.name === "محمد بنين")?.stats.invoiceCount).toBe(1);

      const invoices = (await legacy.listInvoices({})).items;
      const linked = invoices.filter((i) => i.counterpartyId !== null);
      expect(linked).toHaveLength(6);
      // the whitespace-only name stayed unlinked (no invisible debtor)
      const blank = invoices.find((i) => i.invoiceNumber === "INV-LEGACY-7");
      expect(blank?.counterpartyId).toBeNull();
      // the typed name is preserved verbatim (display/history unchanged)
      const padded = invoices.find((i) => i.invoiceNumber === "INV-LEGACY-4");
      expect(padded?.counterpartyName).toBe("  علي علي ");
      expect(padded?.counterpartyId).toBe(customers.find((c) => c.name === "علي علي")?.id);

      // a second setup is a no-op (marker + reuse-by-name)
      await legacy.setup();
      expect(await legacy.listParties("customer")).toHaveLength(3);
      expect(await legacy.listParties("supplier")).toHaveLength(2);

      // the marker is one-shot: an invoice typed after the backfill keeps its
      // null id (typed-only invoices are a supported contract path), and no
      // later boot reopens the migration
      await seed("SALE", "بعد-الترحيل", 3_000);
      await legacy.setup();
      const post = (await legacy.listInvoices({})).items.find((i) => i.invoiceNumber === "INV-LEGACY-8");
      expect(post?.counterpartyId).toBeNull();
      expect(await legacy.listParties("customer")).toHaveLength(3);
    } finally {
      conn.close();
      removeTempDirRetry(backfillDir);
    }
  });

  it("collapses whitespace and diacritic name variants into one backfilled party", async () => {
    const variantsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-backfill-variants-"));
    const conn = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: variantsDir, DOKAN_DB_PATH: path.join(variantsDir, "legacy.db") }),
    );
    try {
      const legacy = createDrizzleStore(conn);
      await legacy.setup();
      const base = { invoiceDate: localDate(), subtotalAmount: 0, discountType: null, discountValue: null, discountAmount: 0, notes: null };
      let n = 0;
      const seed = (name: string, total: number) =>
        legacy.insertInvoice({ ...base, invoiceNumber: `INV-VAR-${++n}`, kind: "SALE", counterpartyId: null, counterpartyName: name, totalAmount: total, paidAmount: 0, remainingAmount: total });
      await seed("علي علي", 10_000);
      await seed("علي  علي", 20_000); // double inner space
      await seed("عَلِي عَلِي", 30_000); // diacritics
      conn.raw.exec("DELETE FROM settings WHERE key = 'migration.counterpartyBackfillV1'");
      await legacy.setup();

      const customers = await legacy.listParties("customer");
      expect(customers).toHaveLength(1);
      expect(customers[0]?.stats).toMatchObject({ invoiceCount: 3, totalAmount: 60_000, remainingAmount: 60_000 });
      const ids = (await legacy.listInvoices({})).items.map((i) => i.counterpartyId);
      expect(new Set(ids).size).toBe(1);
      expect(ids.every((id) => id === customers[0]?.id)).toBe(true);
    } finally {
      conn.close();
      removeTempDirRetry(variantsDir);
    }
  });

  it("groups a legacy name carrying a bidi mark with its clean spelling", async () => {
    const bidiDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-backfill-bidi-"));
    const conn = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: bidiDir, DOKAN_DB_PATH: path.join(bidiDir, "legacy.db") }),
    );
    try {
      const legacy = createDrizzleStore(conn);
      await legacy.setup();
      const base = { invoiceDate: localDate(), subtotalAmount: 0, discountType: null, discountValue: null, discountAmount: 0, notes: null };
      let n = 0;
      const seed = (name: string, total: number) =>
        legacy.insertInvoice({ ...base, invoiceNumber: `INV-BIDI-${++n}`, kind: "SALE", counterpartyId: null, counterpartyName: name, totalAmount: total, paidAmount: 0, remainingAmount: total });
      await seed("علي", 10_000);
      await seed("علي\u200F", 20_000); // trailing RLM, the usual copy/paste artifact
      await seed("علي\u061C", 30_000); // Arabic letter mark (Greptile P1.5)
      conn.raw.exec("DELETE FROM settings WHERE key = 'migration.counterpartyBackfillV1'");
      await legacy.setup();

      const customers = await legacy.listParties("customer");
      expect(customers).toHaveLength(1);
      expect(customers[0]?.stats).toMatchObject({ invoiceCount: 3, totalAmount: 60_000 });
      const ids = (await legacy.listInvoices({})).items.map((i) => i.counterpartyId);
      expect(new Set(ids).size).toBe(1);
    } finally {
      conn.close();
      removeTempDirRetry(bidiDir);
    }
  });

  it("backfill reuses an existing same-named party instead of duplicating a debtor", async () => {
    const reuseDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-backfill-reuse-"));
    const conn = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: reuseDir, DOKAN_DB_PATH: path.join(reuseDir, "legacy.db") }),
    );
    try {
      const legacy = createDrizzleStore(conn);
      await legacy.setup();
      const existing = await legacy.createParty("customer", { name: "عماره", phone: "0550111222" });
      await legacy.insertInvoice({
        invoiceNumber: "INV-REUSE-1",
        kind: "SALE",
        counterpartyId: null,
        counterpartyName: "عماره",
        invoiceDate: localDate(),
        subtotalAmount: 0,
        discountType: null,
        discountValue: null,
        discountAmount: 0,
        totalAmount: 5_000,
        paidAmount: 0,
        remainingAmount: 5_000,
        notes: null,
      });
      conn.raw.exec("DELETE FROM settings WHERE key = 'migration.counterpartyBackfillV1'");
      await legacy.setup();

      const customers = await legacy.listParties("customer");
      expect(customers.filter((c) => c.name === "عماره")).toHaveLength(1);
      expect(customers.find((c) => c.name === "عماره")?.id).toBe(existing.id);
      expect(customers.find((c) => c.name === "عماره")?.phone).toBe("+213550111222");
      expect((await legacy.listInvoices({})).items.find((i) => i.invoiceNumber === "INV-REUSE-1")?.counterpartyId).toBe(existing.id);
    } finally {
      conn.close();
      removeTempDirRetry(reuseDir);
    }
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

  it("reads the last number across prefixes and ignores a display-only label (#258)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-last-number-"));
    const connection = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "last.db") }));
    const tempStore = createDrizzleStore(connection);
    try {
      await tempStore.setup();
      const base = { counterpartyId: null, counterpartyName: null, invoiceDate: "2026-08-25", totalAmount: 0, paidAmount: 0, remainingAmount: 0, notes: null };
      await tempStore.insertInvoice({ ...base, invoiceNumber: "INV-0004", kind: "SALE" });
      // the number decides, not the prefix: a purchase can be the latest
      await tempStore.insertInvoice({ ...base, invoiceNumber: "SUP-0009", kind: "PURCHASE" });
      // a display-only label must not win on its timestamp suffix
      await tempStore.insertInvoice({ ...base, invoiceNumber: "INV-RENAME-1792235400275", kind: "SALE" });
      expect(await tempStore.lastInvoiceNumber()).toBe("SUP-0009");
    } finally {
      connection.close();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          Bun.sleepSync(50);
        }
      }
    }
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

describe("debts drill-down (ticket 9)", () => {
  const insertDebt = async (seed: {
    invoiceNumber: string;
    kind: "SALE" | "PURCHASE";
    counterpartyId?: string | null;
    counterpartyName?: string | null;
    totalAmount: number;
    paidAmount: number;
    invoiceDate?: string;
  }) =>
    store.insertInvoice({
      invoiceNumber: seed.invoiceNumber,
      kind: seed.kind,
      counterpartyId: seed.counterpartyId ?? null,
      counterpartyName: seed.counterpartyName ?? null,
      invoiceDate: seed.invoiceDate ?? localDate(),
      subtotalAmount: seed.totalAmount,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: seed.totalAmount,
      paidAmount: seed.paidAmount,
      remainingAmount: seed.totalAmount - seed.paidAmount,
      notes: null,
    });

  it("returns a typed-only party's unpaid invoices and matches its debtSummary total", async () => {
    await insertDebt({ invoiceNumber: "INV-0201", kind: "SALE", counterpartyName: "زبون مدين", totalAmount: 2_000, paidAmount: 500 });
    await insertDebt({ invoiceNumber: "INV-0202", kind: "SALE", counterpartyName: "زبون مدين", totalAmount: 1_000, paidAmount: 0 });
    // fully paid → owes nothing
    await insertDebt({ invoiceNumber: "INV-0203", kind: "SALE", counterpartyName: "زبون مدين", totalAmount: 4_000, paidAmount: 4_000 });

    const invoices = await store.listUnpaidInvoicesByParty("SALE", null, "زبون مدين");
    const numbers = invoices.map((i) => i.invoiceNumber).sort();
    expect(numbers).toEqual(["INV-0201", "INV-0202"]);
    for (const invoice of invoices) {
      expect(invoice.remainingAmount).toBeGreaterThan(0);
    }

    // acceptance: the group total is the sum of its unpaid invoices' remaining
    const sum = invoices.reduce((total, i) => total + i.remainingAmount, 0);
    expect(sum).toBe(2_500);
    const summary = (await store.debtSummaries()).find((d) => d.kind === "SALE" && d.counterpartyId === null && d.counterpartyName === "زبون مدين");
    expect(summary?.remainingTotal).toBe(sum);
    expect(summary?.invoiceCount).toBe(invoices.length);
  });

  it("never mixes an id-backed party with a same-named typed-only party", async () => {
    const ID_PARTY = "00000000-0000-4000-8000-0000000000ab";
    const sharedName = "مزدوج-ت09";
    await insertDebt({ invoiceNumber: "INV-0211", kind: "SALE", counterpartyId: ID_PARTY, counterpartyName: sharedName, totalAmount: 1_500, paidAmount: 0 });
    await insertDebt({ invoiceNumber: "INV-0212", kind: "SALE", counterpartyName: sharedName, totalAmount: 800, paidAmount: 0 });

    const byId = await store.listUnpaidInvoicesByParty("SALE", ID_PARTY, sharedName);
    expect(byId.map((i) => i.invoiceNumber)).toEqual(["INV-0211"]);

    const byName = await store.listUnpaidInvoicesByParty("SALE", null, sharedName);
    expect(byName.map((i) => i.invoiceNumber)).toEqual(["INV-0212"]);
  });

  it("keeps purchase debts out of a sale drill-down and vice versa", async () => {
    await insertDebt({ invoiceNumber: "INV-0221", kind: "PURCHASE", counterpartyName: "مورد دائن", totalAmount: 3_000, paidAmount: 800 });

    const saleSide = await store.listUnpaidInvoicesByParty("SALE", null, "مورد دائن");
    expect(saleSide).toHaveLength(0);

    const purchaseSide = await store.listUnpaidInvoicesByParty("PURCHASE", null, "مورد دائن");
    expect(purchaseSide.map((i) => i.invoiceNumber)).toEqual(["INV-0221"]);
    const summary = (await store.debtSummaries()).find((d) => d.kind === "PURCHASE" && d.counterpartyName === "مورد دائن");
    expect(summary?.kind).toBe("PURCHASE");
    expect(summary?.remainingTotal).toBe(2_200);
  });

  it("returns an empty list for parties that owe nothing or are unknown", async () => {
    await insertDebt({ invoiceNumber: "INV-0231", kind: "SALE", counterpartyName: "مسدد بالكامل", totalAmount: 900, paidAmount: 900 });
    expect(await store.listUnpaidInvoicesByParty("SALE", null, "مسدد بالكامل")).toHaveLength(0);
    expect(await store.listUnpaidInvoicesByParty("SALE", null, "اسم غير موجود")).toHaveLength(0);
  });

  it("keeps summary and drill-down consistent for padded typed names (test-audit E1)", async () => {
    await insertDebt({ invoiceNumber: "INV-0241", kind: "SALE", counterpartyName: "زبون بحواشي ", totalAmount: 500, paidAmount: 0 });
    // the summary row groups by the raw stored name; the drill-down matches on
    // the trimmed name so a padded store-seam insert stays openable in both
    // spellings (the trimmed query also covers earlier unpadded "زبون مدين"
    // rows, hence a dedicated name here)
    expect((await store.debtSummaries()).find((d) => d.counterpartyName === "زبون بحواشي ")?.invoiceCount).toBe(1);
    expect(await store.listUnpaidInvoicesByParty("SALE", null, "زبون بحواشي ")).toHaveLength(1);
    expect(await store.listUnpaidInvoicesByParty("SALE", null, "زبون بحواشي")).toHaveLength(1);
  });

  it("keeps a same-named party's debts scoped per direction (test-audit E2)", async () => {
    await insertDebt({ invoiceNumber: "INV-0251", kind: "SALE", counterpartyName: "الطرف المشترك", totalAmount: 1_000, paidAmount: 0 });
    await insertDebt({ invoiceNumber: "INV-0252", kind: "PURCHASE", counterpartyName: "الطرف المشترك", totalAmount: 2_000, paidAmount: 500 });

    const summaries = await store.debtSummaries();
    const saleSummary = summaries.find((d) => d.kind === "SALE" && d.counterpartyName === "الطرف المشترك");
    const purchaseSummary = summaries.find((d) => d.kind === "PURCHASE" && d.counterpartyName === "الطرف المشترك");
    expect(saleSummary?.remainingTotal).toBe(1_000);
    expect(saleSummary?.invoiceCount).toBe(1);
    expect(purchaseSummary?.remainingTotal).toBe(1_500);
    expect(purchaseSummary?.invoiceCount).toBe(1);

    expect((await store.listUnpaidInvoicesByParty("SALE", null, "الطرف المشترك")).map((i) => i.invoiceNumber)).toEqual(["INV-0251"]);
    expect((await store.listUnpaidInvoicesByParty("PURCHASE", null, "الطرف المشترك")).map((i) => i.invoiceNumber)).toEqual(["INV-0252"]);
  });

  it("excludes overpaid invoices from summaries and drill-down (test-audit E5)", async () => {
    await insertDebt({ invoiceNumber: "INV-0261", kind: "SALE", counterpartyName: "دفع زائد", totalAmount: 1_000, paidAmount: 1_200 });
    expect(await store.listUnpaidInvoicesByParty("SALE", null, "دفع زائد")).toHaveLength(0);
    expect((await store.debtSummaries()).some((d) => d.counterpartyName === "دفع زائد")).toBe(false);
  });

  it("orders a party's drill-down newest invoice date first (test-audit ordering)", async () => {
    await insertDebt({ invoiceNumber: "INV-0271", kind: "SALE", counterpartyName: "زبون متسلسل", totalAmount: 100, paidAmount: 0, invoiceDate: "2026-07-01" });
    await insertDebt({ invoiceNumber: "INV-0272", kind: "SALE", counterpartyName: "زبون متسلسل", totalAmount: 200, paidAmount: 0, invoiceDate: "2026-07-03" });
    await insertDebt({ invoiceNumber: "INV-0273", kind: "SALE", counterpartyName: "زبون متسلسل", totalAmount: 300, paidAmount: 0, invoiceDate: "2026-07-02" });

    const invoices = await store.listUnpaidInvoicesByParty("SALE", null, "زبون متسلسل");
    expect(invoices.map((i) => i.invoiceNumber)).toEqual(["INV-0272", "INV-0273", "INV-0271"]);
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
    expect(farFuture.total).toBe(0);
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
    expect((await store.listActivities({ limit: 10 })).items.some((a) => a.ref === created.id)).toBe(true);
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
      createAppConfig({ DOKAN_DATA_DIR: sharedDir, DOKAN_DB_PATH: dbPath }),
    );
    const secondConnection = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: sharedDir, DOKAN_DB_PATH: dbPath }),
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
        firstStore.allocateInvoiceNumber("SALE"),
        secondStore.allocateInvoiceNumber("SALE"),
      ]);
      expect(new Set([first, second])).toEqual(new Set(["INV-0001", "INV-0002"]));
      // #258 — each kind owns its own counter, so the two sale allocations
      // above must not advance the purchase series: a purchase starts at its
      // own SUP-0001 (a global counter would hand it 0003 here).
      expect(await firstStore.allocateInvoiceNumber("PURCHASE")).toBe("SUP-0001");

      // The same allocator is safe inside the transaction seam used by the
      // router, and the reservation is committed alongside the invoice row.
      const persisted = await firstStore.withTransaction(async (tx) => {
        const invoiceNumber = await tx.allocateInvoiceNumber("PURCHASE");
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
      expect(persisted.invoiceNumber).toBe("SUP-0002");

      // A failed transaction must not burn a number, because the sequence
      // update is part of the same atomic unit as the invoice insert.
      await expect(
        firstStore.withTransaction(async (tx) => {
          await tx.allocateInvoiceNumber("SALE");
          throw new Error("rollback-number");
        }),
      ).rejects.toThrow("rollback-number");
      // the rolled-back SALE reservation burned nothing: the counter still
      // holds 3
      expect(await firstStore.allocateInvoiceNumber("SALE")).toBe("INV-0003");

      // A pre-existing manually assigned number must also advance the next
      // suggestion; this protects setup/migration databases with old invoices.
      // It carries an INV- number on a PURCHASE row, exactly like every
      // pre-#258 row.
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
      expect(await firstStore.allocateInvoiceNumber("SALE")).toBe("INV-0043");
      // …and the manual legacy INV- row must NOT consume a SUP number: the
      // purchase counter is untouched by it and continues from SUP-0002.
      expect(await firstStore.allocateInvoiceNumber("PURCHASE")).toBe("SUP-0003");

      // The scan is per prefix in both directions: a hand-inserted SUP row moves
      // only the purchase counter, and a hand-inserted INV row only the sale one.
      await firstStore.insertInvoice({
        invoiceNumber: "SUP-0100",
        kind: "PURCHASE",
        counterpartyId: null,
        counterpartyName: "رقم شراء قديم",
        invoiceDate: "2026-08-25",
        totalAmount: 0,
        paidAmount: 0,
        remainingAmount: 0,
        notes: null,
      });
      expect(await firstStore.allocateInvoiceNumber("PURCHASE")).toBe("SUP-0101");
      expect(await firstStore.allocateInvoiceNumber("SALE")).toBe("INV-0044");

      // Four digits is a floor: the GLOB and the substr offset must keep working
      // once the number grows past 9999 (the SQL path, not just the formatter).
      await firstStore.insertInvoice({
        invoiceNumber: "INV-9999",
        kind: "SALE",
        counterpartyId: null,
        counterpartyName: "رقم كبير",
        invoiceDate: "2026-08-25",
        totalAmount: 0,
        paidAmount: 0,
        remainingAmount: 0,
        notes: null,
      });
      expect(await firstStore.allocateInvoiceNumber("SALE")).toBe("INV-10000");

      // A kind that reached the store through a cast must refuse, not mint a
      // prefix-less number — and must not leave a counter row behind.
      // SAFETY: the cast is the case under test: a kind the enum does not carry
      await expect(firstStore.allocateInvoiceNumber("REFUND" as never)).rejects.toThrow(/unknown invoice kind/u);
      // SAFETY: the literal SELECT returns one row per counter, shaped { kind, next_number }
      const counters = firstConnection.raw.query("SELECT kind FROM invoice_number_counters").all() as Array<{ kind: string }>;
      expect(counters.map((row) => row.kind).sort()).toEqual(["PURCHASE", "SALE"]);
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
    const list = (await store.listActivities({ limit: 10 })).items;
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
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
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

    const backupConn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dest }));
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
describe("payments history (ticket 8)", () => {
  it("accumulates instalments and returns history in insertion order even within one second", async () => {
    const stamp = localDateTime();
    const invoice = await store.insertInvoice({
      invoiceNumber: "INV-9101",
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "زبون التسديد",
      invoiceDate: localDate(),
      totalAmount: 1_000,
      paidAmount: 0,
      remainingAmount: 1_000,
      notes: null,
    });
    // same paidAt on purpose: the ordering tiebreak must be insertion order
    // (rowid), never the random payment id — otherwise history shuffles when
    // two instalments land within the same second
    for (const amount of [200, 300]) {
      await store.insertPayment({ invoiceId: invoice.id, amount, method: "CASH", note: null, paidAt: stamp });
    }

    // header recompute through the same seam invoicesPay uses
    await store.setInvoicePaidAmounts(invoice.id, 500, 500);
    const detail = await store.getInvoiceDetail(invoice.id);
    expect(detail?.paidAmount).toBe(500);
    expect(detail?.remainingAmount).toBe(500);
    expect(detail?.payments.map((p) => p.amount)).toEqual([200, 300]);
  });
});

describe("applyPaymentToInvoice boundary (ticket 8)", () => {
  it("is the DB-level guard: a second connection can no longer overpay the invoice", async () => {
    const invoice = await store.insertInvoice({
      invoiceNumber: "INV-9102",
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "زبون الاتصال الثاني",
      invoiceDate: localDate(),
      totalAmount: 800,
      paidAmount: 0,
      remainingAmount: 800,
      notes: null,
    });
    // first connection applies a 600 instalment through the serialized unit
    expect(await store.withTransaction((tx) => tx.applyPaymentToInvoice(invoice.id, 600))).toBe(true);
    // a SEPARATE connection on the same file has its own queue; only the
    // conditional UPDATE can stop it from acting on the stale remaining
    const conn2 = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }),
    );
    const store2 = createDrizzleStore(conn2);
    expect(await store2.withTransaction((tx) => tx.applyPaymentToInvoice(invoice.id, 300))).toBe(false);
    conn2.close();
    const detail = await store.getInvoiceDetail(invoice.id);
    expect(detail?.paidAmount).toBe(600);
    expect(detail?.remainingAmount).toBe(200);
  });

  it("never classifies a zero-total invoice as UNPAID", async () => {
    const invoice = await store.insertInvoice({
      invoiceNumber: "INV-9103",
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "فاتورة مجانية",
      invoiceDate: localDate(),
      totalAmount: 0,
      paidAmount: 0,
      remainingAmount: 0,
      notes: null,
    });
    expect((await store.listInvoices({ status: "UNPAID" })).items.some((i) => i.id === invoice.id)).toBe(false);
    // remaining = 0 is the PAID definition; a free invoice owes nothing
    expect((await store.listInvoices({ status: "PAID" })).items.some((i) => i.id === invoice.id)).toBe(true);
  });



// Regression for PR #48: two REAL processes paying the same invoice
  // concurrently. With a deferred BEGIN each process takes a WAL read snapshot;
  // the loser's read-to-write upgrade then fails with SQLITE_BUSY_SNAPSHOT —
  // a raw "database is locked" instead of the refusal. BEGIN IMMEDIATE makes
  // the loser wait (busy_timeout) in its own process, then read the post-commit
  // state, so the conditional UPDATE refuses cleanly. Subprocesses are used
  // because bun is single-threaded: an in-process second connection's
  // synchronous busy-wait would starve the winner's async continuation.
  it("two processes paying concurrently yield exactly one applied instalment and one refusal, never a raw SQLite error", async () => {
    const invoice = await store.insertInvoice({
      invoiceNumber: "INV-9104",
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "عملية مزدوجة",
      invoiceDate: localDate(),
      totalAmount: 800,
      paidAmount: 0,
      remainingAmount: 800,
      notes: null,
    });
    // self-contained worker: opens the shared file, waits for the go flag so
    // both processes genuinely overlap, then runs the write-first payment unit
    const worker = path.join(dir, "pay-race-worker.ts");
    fs.writeFileSync(
      worker,
      `import { Database } from "bun:sqlite";
import fs from "node:fs";

const [dbp, invoiceId, goFile] = [process.argv[2]!, process.argv[3]!, process.argv[4]!];
const conn = new Database(dbp, { create: true });
conn.exec("PRAGMA journal_mode = WAL;");
conn.exec("PRAGMA busy_timeout = 5000;");
while (!fs.existsSync(goFile)) await Bun.sleep(5);
try {
  conn.exec("BEGIN IMMEDIATE");
  // hold the write lock briefly so the other process really contends
  await Bun.sleep(150);
  const result = conn.query(
    "UPDATE invoices SET paid_amount = paid_amount + ?, remaining_amount = remaining_amount - ?, updated_at = datetime('now') WHERE id = ? AND remaining_amount >= ?",
  ).run(600, 600, invoiceId, 600);
  conn.exec("COMMIT");
  console.log(result.changes > 0 ? "APPLIED" : "REFUSED");
} catch (err) {
  try { conn.exec("ROLLBACK"); } catch {}
  console.log("ERROR " + String(err));
}
`,
    );
    const goFlag = path.join(dir, "pay-race-go.flag");
    fs.rmSync(goFlag, { force: true });
    const dbPath = path.join(dir, "test.db");
    const spawnWorker = () => Bun.spawn(["bun", "run", worker, dbPath, invoice.id, goFlag]);
    try {
      const [p1, p2] = await Promise.all([spawnWorker(), spawnWorker()]);
      await Bun.sleep(600);
      fs.writeFileSync(goFlag, "go");
      const [c1, c2] = await Promise.all([p1.exited, p2.exited]);
      const [o1, o2] = await Promise.all([new Response(p1.stdout).text(), new Response(p2.stdout).text()]);
      expect([c1, c2]).toEqual([0, 0]);
      const outcomes = [o1.trim(), o2.trim()];
      expect(outcomes.filter((o) => o === "APPLIED")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "REFUSED")).toHaveLength(1);
      expect(outcomes.some((o) => o.startsWith("ERROR"))).toBe(false);
    } finally {
      fs.rmSync(goFlag, { force: true });
    }
    const detail = await store.getInvoiceDetail(invoice.id);
    expect(detail?.paidAmount).toBe(600);
    expect(detail?.remainingAmount).toBe(200);
  });
});

describe("returns seam (cash refunds + review marks)", () => {
  async function makeSaleFixture(name: string, unitPrice: number) {
    const category = (await store.listCategories())[0]!;
    const item = await store.createItem({ name, categoryId: category.id, costPrice: 200, sellingPrice: unitPrice });
    await store.insertStockMovement({ itemId: item.id, kind: "PURCHASE", delta: 10, unitCost: 200, reason: null, ref: null, occurredAt: stamp() });
    const invoice = await store.insertInvoice({
      invoiceNumber: `INV-${Math.floor(Math.random() * 1_000_000)}`,
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "زبون المرتجعات",
      invoiceDate: localDate(),
      totalAmount: unitPrice,
      paidAmount: unitPrice,
      remainingAmount: 0,
      notes: null,
    });
    const line = await store.insertInvoiceLine({
      invoiceId: invoice.id,
      itemId: item.id,
      description: name,
      quantity: 1,
      defaultUnitPrice: unitPrice,
      unitPrice,
      costAtSale: 200,
      total: unitPrice,
      discountAllocated: 0,
      netTotal: unitPrice,
    });
    return { item, invoice, line };
  }

  it("allocates return numbers sequentially from the seeded sequence", async () => {
    const first = await store.allocateReturnNumber();
    // #258 — the return number carries RET (was RTN)
    expect(first).toMatch(/^RET-\d{4}$/);
    const second = await store.allocateReturnNumber();
    expect(Number(second.slice(4))).toBe(Number(first.slice(4)) + 1);
  });

  it("continues a pre-#258 RTN series into RET without reissuing a number", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-return-prefix-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
    );
    const legacyStore = createDrizzleStore(legacy);
    await legacyStore.setup();
    const invoice = await legacyStore.insertInvoice({
      invoiceNumber: "INV-0001",
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "زبون قديم",
      invoiceDate: "2026-08-01",
      totalAmount: 900,
      paidAmount: 0,
      remainingAmount: 900,
      notes: null,
    });
    // a shop upgraded from #258's predecessor: seven returns, the counter at 8
    legacy.raw
      .query("INSERT INTO returns (id, return_number, invoice_id, refund_amount, cash_paid_out, debt_offset, debt_applied, payout_method, reason, status, occurred_at, created_at, updated_at) VALUES (?, 'RTN-0007', ?, 900, 900, 0, 0, 'CASH', NULL, 'PENDING_REVIEW', '2026-08-02T10:00:00', '2026-08-02T10:00:00', '2026-08-02T10:00:00')")
      .run("00000000-0000-4000-8000-0000000000aa", invoice.id);
    // the seed ran at the first setup(), when this row did not exist yet, so the
    // counter still reads 1: only scanning the legacy RTN row can lift the next
    // allocation to 0008. That scan is the regression this pins — a RET-only
    // GLOB would answer RET-0001 here.
    await legacyStore.setup();
    expect(await legacyStore.allocateReturnNumber()).toBe("RET-0008");
    // the historical document keeps its own number, and a re-run of the upgrade
    // does not reset the used counter back to 1
    expect(legacy.raw.query("SELECT return_number FROM returns WHERE return_number = 'RTN-0007'").all()).toHaveLength(1);
    await legacyStore.setup();
    expect(await legacyStore.allocateReturnNumber()).toBe("RET-0009");
    legacy.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });

  it("persists a return with lines and reads the full detail (invoice identity joined)", async () => {
    const { invoice, line } = await makeSaleFixture("مرجوع-متجر", 900);
    const { id } = await store.insertReturn({
      returnNumber: await store.allocateReturnNumber(),
      invoiceId: invoice.id,
      refundAmount: 900,
      cashPaidOut: 900,
      debtOffset: 0,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: "الزبون غير راضٍ",
      status: "PENDING_REVIEW",
      occurredAt: stamp(),
    });
    await store.insertReturnLine({
      returnId: id,
      invoiceLineId: line.id,
      itemId: line.itemId,
      description: line.description,
      quantity: 1,
      refundUnitPrice: 900,
      refundAmount: 900,
    });

    const detail = await store.getReturnDetail(id);
    expect(detail?.returnNumber).toMatch(/^RET-/);
    expect(detail?.invoiceId).toBe(invoice.id);
    expect(detail?.invoiceNumber).toBe(invoice.invoiceNumber);
    expect(detail?.counterpartyName).toBe("زبون المرتجعات");
    expect(detail?.refundAmount).toBe(900);
    expect(detail?.payoutMethod).toBe("CASH");
    expect(detail?.status).toBe("PENDING_REVIEW");
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0]).toMatchObject({ invoiceLineId: line.id, quantity: 1, refundUnitPrice: 900, refundAmount: 900 });
  });

  it("lists returns scoped to one invoice and sums returned quantities per line", async () => {
    const a = await makeSaleFixture("مرجوع-أ", 100);
    const b = await makeSaleFixture("مرجوع-ب", 200);
    const firstId = (await store.insertReturn({
      returnNumber: await store.allocateReturnNumber(),
      invoiceId: a.invoice.id,
      refundAmount: 100,
      cashPaidOut: 100,
      debtOffset: 0,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "PENDING_REVIEW",
      occurredAt: stamp(),
    })).id;
    await store.insertReturnLine({
      returnId: firstId,
      invoiceLineId: a.line.id,
      itemId: a.line.itemId,
      description: a.line.description,
      quantity: 1,
      refundUnitPrice: 100,
      refundAmount: 100,
    });
    await store.insertReturn({
      returnNumber: await store.allocateReturnNumber(),
      invoiceId: b.invoice.id,
      refundAmount: 200,
      cashPaidOut: 200,
      debtOffset: 0,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "PENDING_REVIEW",
      occurredAt: stamp(),
    });

    const scoped = (await store.listReturns({ invoiceId: a.invoice.id })).items;
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.invoiceId).toBe(a.invoice.id);
    // earlier tests in this file also insert returns — only the scoped count is exact
    expect((await store.listReturns({})).items.length).toBeGreaterThanOrEqual(2);

    const totals = await store.returnedByLine(a.invoice.id);
    expect(totals.get(a.line.id)?.quantity).toBe(1);
    expect(totals.get(a.line.id)?.refundAmount).toBe(100);
  });

  it("counts only PENDING_REVIEW returns (issue #118)", async () => {
    const { invoice } = await makeSaleFixture("مرجوع-عدّ", 300);
    const before = await store.pendingReturnsCount();
    const { id } = await store.insertReturn({
      returnNumber: await store.allocateReturnNumber(),
      invoiceId: invoice.id,
      refundAmount: 300,
      cashPaidOut: 300,
      debtOffset: 0,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "PENDING_REVIEW",
      occurredAt: stamp(),
    });
    expect(await store.pendingReturnsCount()).toBe(before + 1);
    // once reviewed it no longer awaits the owner
    expect(await store.transitionReturnStatus(id, "ACCEPTED")).toBe(true);
    expect(await store.pendingReturnsCount()).toBe(before);
  });

  it("transitions status exactly once (conditional guard) and consumes the pending marks", async () => {
    const { invoice, line } = await makeSaleFixture("مرجوع-مراجعة", 500);
    const { id: returnId } = await store.insertReturn({
      returnNumber: await store.allocateReturnNumber(),
      invoiceId: invoice.id,
      refundAmount: 500,
      cashPaidOut: 500,
      debtOffset: 0,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "PENDING_REVIEW",
      occurredAt: stamp(),
    });
    const movement = await store.insertStockMovement({
      itemId: line.itemId!,
      kind: "SALE",
      delta: 1,
      unitCost: 200,
      reason: null,
      ref: returnId,
      returnMark: "PENDING",
      occurredAt: stamp(),
    });
    expect(movement.returnMark).toBe("PENDING");

    // the conditional transition refuses a second review
    expect(await store.transitionReturnStatus(returnId, "ACCEPTED")).toBe(true);
    expect(await store.transitionReturnStatus(returnId, "ACCEPTED")).toBe(false);
    expect((await store.getReturnDetail(returnId))?.status).toBe("ACCEPTED");

    await store.setReturnMarks(returnId, "ACCEPTED");
    expect((await store.getReturnDetail(returnId))?.status).toBe("ACCEPTED");
    // the movement's flat facts are untouched; only the review tag moved
    const listed = (await store.listStockMovements(line.itemId!)).find((movement) => movement.returnMark !== null);
    expect(listed?.delta).toBe(1);
    expect(listed?.kind).toBe("SALE");
    expect(listed?.returnMark).toBe("ACCEPTED");

    // an already-consumed return can never be rejected
    expect(await store.transitionReturnStatus(returnId, "REJECTED_DAMAGED")).toBe(false);
  });

  it("applies a debt offset to the invoice and never lets the debt go below zero", async () => {
    const { item } = await makeSaleFixture("مرجوع-خصم-الدين", 800);
    const invoice = await store.insertInvoice({
      invoiceNumber: `INV-${Math.floor(Math.random() * 1_000_000)}`,
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "زبون الدين",
      invoiceDate: localDate(),
      totalAmount: 1_000,
      paidAmount: 200,
      remainingAmount: 800,
      notes: null,
    });
    void item;
    expect((await store.getInvoiceDetail(invoice.id))?.remainingAmount).toBe(800);
    expect(await store.applyDebtOffsetToInvoice(invoice.id, 500)).toBe(true);
    expect((await store.getInvoiceDetail(invoice.id))?.remainingAmount).toBe(300);
    expect(await store.applyDebtOffsetToInvoice(invoice.id, 301)).toBe(false); // boundary refused
    expect((await store.getInvoiceDetail(invoice.id))?.remainingAmount).toBe(300);
    expect(await store.applyDebtOffsetToInvoice(invoice.id, 300)).toBe(true); // exact settlement
    expect((await store.getInvoiceDetail(invoice.id))?.remainingAmount).toBe(0);
  });

  it("upgrades a pre-settlement returns table: adds cash_paid_out/debt_offset and backfills legacy rows as all-cash", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-returns-legacy-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "legacy.db") }),
    );
    // the pre-split returns table shape (no cash_paid_out/debt_offset), plus
    // the invoices rows setup() needs for the FK — then one legacy return row
    legacy.raw.exec(
      "CREATE TABLE returns (id TEXT PRIMARY KEY, return_number TEXT NOT NULL UNIQUE, invoice_id TEXT NOT NULL REFERENCES invoices(id), refund_amount INTEGER NOT NULL, payout_method TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    legacy.raw.exec(
      "CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, subtotal_amount INTEGER NOT NULL DEFAULT 0, discount_type TEXT, discount_value INTEGER, discount_amount INTEGER NOT NULL DEFAULT 0, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    legacy.raw
      .query("INSERT INTO invoices (id, invoice_number, kind, invoice_date, total_amount, paid_amount, remaining_amount, created_at, updated_at) VALUES (?, ?, 'SALE', '2026-08-26', 900, 0, 900, '2026-08-26T10:00:00', '2026-08-26T10:00:00')")
      .run("00000000-0000-4000-8000-0000000000ff", "INV-LEGACY");
    legacy.raw
      .query("INSERT INTO returns (id, return_number, invoice_id, refund_amount, payout_method, reason, status, occurred_at, created_at, updated_at) VALUES (?, 'RTN-0001', ?, 900, 'CASH', NULL, 'PENDING_REVIEW', '2026-08-26T10:30:00', '2026-08-26T10:30:00', '2026-08-26T10:30:00')")
      .run("00000000-0000-4000-8000-0000000000ee", "00000000-0000-4000-8000-0000000000ff");
    const legacyStore = createDrizzleStore(legacy);
    await legacyStore.setup(); // must ALTER + backfill
    // SAFETY: PRAGMA table_info returns rows shaped { name }
    // SAFETY: PRAGMA table_info returns rows shaped { name }
    const rows = legacy.raw.query("PRAGMA table_info(returns)").all() as Array<{ name: string }>;
    const cols = rows.map((r) => r.name);
    expect(cols).toContain("cash_paid_out");
    expect(cols).toContain("debt_offset");
    // the legacy row is reclassified as all-cash (cash = refund, debt 0); the
    // literal query returns one row per return with the two settlement columns
    // SAFETY: the SELECT lists fixed columns; the cast promises their exact names
    const legacyRow = legacy.raw.query("SELECT cash_paid_out, debt_offset FROM returns WHERE return_number = 'RTN-0001'").all() as Array<{ cash_paid_out: number; debt_offset: number }>;
    expect(legacyRow[0]).toEqual({ cash_paid_out: 900, debt_offset: 0 });
    // and the upgrade is idempotent: a second setup leaves the row untouched
    await legacyStore.setup();
    // SAFETY: same literal SELECT and column names as above
    const again = legacy.raw.query("SELECT cash_paid_out, debt_offset FROM returns WHERE return_number = 'RTN-0001'").all() as Array<{ cash_paid_out: number; debt_offset: number }>;
    expect(again[0]).toEqual({ cash_paid_out: 900, debt_offset: 0 });
    legacy.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });

  it("records the review annotation on the return record", async () => {
    const { invoice } = await makeSaleFixture("مرجوع-سبب", 400);
    const { id: returnId } = await store.insertReturn({
      returnNumber: await store.allocateReturnNumber(),
      invoiceId: invoice.id,
      refundAmount: 400,
      cashPaidOut: 400,
      debtOffset: 0,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: "الزبون بدل رأيه",
      status: "PENDING_REVIEW",
      occurredAt: stamp(),
    });
    expect((await store.getReturnDetail(returnId))?.reason).toBe("الزبون بدل رأيه");
    await store.setReturnReason(returnId, "الزبون بدل رأيه — كسر في العبوة");
    expect((await store.getReturnDetail(returnId))?.reason).toBe("الزبون بدل رأيه — كسر في العبوة");
    await store.setReturnReason(returnId, "ملاحظة ثانية");
    expect((await store.getReturnDetail(returnId))?.reason).toBe("ملاحظة ثانية");
  });
});

describe("getInvoiceDetail return credit", () => {
  it("sums the debt the invoice's returns actually relieved", async () => {
    const invoice = await store.insertInvoice({
      invoiceNumber: `INV-RC-${stamp()}`,
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: "زبون نقدي",
      invoiceDate: localDate(),
      subtotalAmount: 0,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: 1_000,
      paidAmount: 400,
      remainingAmount: 600,
      notes: null,
    });
    // a first ACCEPTED return relieved 300 through the real debt-offset path …
    const first = await store.insertReturn({
      returnNumber: `RTN-RC-${stamp()}-a`,
      invoiceId: invoice.id,
      refundAmount: 300,
      cashPaidOut: 0,
      debtOffset: 300,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "ACCEPTED",
      occurredAt: localDateTime(),
    });
    await store.setDebtApplied(first.id, 300);
    expect(await store.applyDebtOffsetToInvoice(invoice.id, 300)).toBe(true);

    // … a PENDING return PROMISES 300 of debt but has applied none. This is the
    // case that separates `sum(debtApplied)` from `sum(debtOffset)`: reading the
    // promise would report 600 for an invoice that only stopped owing 300
    const pending = await store.insertReturn({
      returnNumber: `RTN-RC-${stamp()}-p`,
      invoiceId: invoice.id,
      refundAmount: 300,
      cashPaidOut: 0,
      debtOffset: 300,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "PENDING_REVIEW",
      occurredAt: localDateTime(),
    });
    expect((await store.getReturnDetail(pending.id))?.debtApplied).toBe(0);

    // … and a REJECTED return with a non-zero promise must not count either
    const rejected = await store.insertReturn({
      returnNumber: `RTN-RC-${stamp()}-b`,
      invoiceId: invoice.id,
      refundAmount: 500,
      cashPaidOut: 500,
      debtOffset: 0,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "REJECTED_DAMAGED",
      occurredAt: localDateTime(),
    });
    await store.setDebtApplied(rejected.id, 0);

    // a SECOND accepted return must AGGREGATE (300 + 200 = 500), not replace
    const second = await store.insertReturn({
      returnNumber: `RTN-RC-${stamp()}-c`,
      invoiceId: invoice.id,
      refundAmount: 200,
      cashPaidOut: 0,
      debtOffset: 200,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "ACCEPTED",
      occurredAt: localDateTime(),
    });
    await store.setDebtApplied(second.id, 200);
    expect(await store.applyDebtOffsetToInvoice(invoice.id, 200)).toBe(true);

    const detail = await store.getInvoiceDetail(invoice.id);
    expect(detail?.returnCreditAmount).toBe(500);
    expect(detail?.remainingAmount).toBe(100);
    // the header's missing term: total − paid − returns = remaining
    expect(detail!.totalAmount - detail!.paidAmount - detail!.returnCreditAmount).toBe(detail!.remainingAmount);
  });

  it("scopes the credit to its own invoice", async () => {
    const base = {
      kind: "SALE" as const,
      counterpartyId: null,
      counterpartyName: null,
      invoiceDate: localDate(),
      subtotalAmount: 0,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: 500,
      paidAmount: 100,
      remainingAmount: 400,
      notes: null,
    };
    const mine = await store.insertInvoice({ ...base, invoiceNumber: `INV-RC-${stamp()}-mine` });
    const other = await store.insertInvoice({ ...base, invoiceNumber: `INV-RC-${stamp()}-other` });
    const elsewhere = await store.insertReturn({
      returnNumber: `RTN-RC-${stamp()}-other`,
      invoiceId: other.id,
      refundAmount: 400,
      cashPaidOut: 0,
      debtOffset: 400,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "ACCEPTED",
      occurredAt: localDateTime(),
    });
    await store.setDebtApplied(elsewhere.id, 400);
    await store.applyDebtOffsetToInvoice(other.id, 400);

    expect((await store.getInvoiceDetail(mine.id))?.returnCreditAmount).toBe(0);
    expect((await store.getInvoiceDetail(other.id))?.returnCreditAmount).toBe(400);
  });

  it("reports zero credit when the invoice has no returns", async () => {
    const invoice = await store.insertInvoice({
      invoiceNumber: `INV-RC-${stamp()}-none`,
      kind: "SALE",
      counterpartyId: null,
      counterpartyName: null,
      invoiceDate: localDate(),
      subtotalAmount: 0,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: 250,
      paidAmount: 250,
      remainingAmount: 0,
      notes: null,
    });
    expect((await store.getInvoiceDetail(invoice.id))?.returnCreditAmount).toBe(0);
  });

  // #256 round 2 — one accepted return can relieve SEVERAL invoices (the
  // approved default takes the refund off the party's whole tab), so the credit
  // is no longer `SUM(returns.debt_applied)` on one invoice: it is attributed
  // per invoice, and the legacy fallback must stay out of a return that HAS
  // attribution rows or the origin invoice would claim the full promise twice.
  it("attributes one accepted offset to each invoice it actually relieved (#256 round 2)", async () => {
    const base = {
      kind: "SALE" as const,
      counterpartyId: null,
      counterpartyName: "زبون توزيع",
      invoiceDate: localDate(),
      subtotalAmount: 0,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      totalAmount: 500,
      paidAmount: 0,
      remainingAmount: 500,
      notes: null,
    };
    const older = await store.insertInvoice({ ...base, invoiceNumber: `INV-RC-${stamp()}-older` });
    const newer = await store.insertInvoice({ ...base, invoiceNumber: `INV-RC-${stamp()}-newer` });
    const origin = await store.insertInvoice({ ...base, invoiceNumber: `INV-RC-${stamp()}-origin`, paidAmount: 500, remainingAmount: 0 });
    const record = await store.insertReturn({
      returnNumber: `RTN-RC-${stamp()}-split`,
      invoiceId: origin.id,
      refundAmount: 300,
      cashPaidOut: 0,
      debtOffset: 300,
      spreadsAcrossInvoices: false,
      payoutMethod: "CASH",
      reason: null,
      status: "ACCEPTED",
      occurredAt: localDateTime(),
    });
    // the accepted return relieved 200 on the older invoice and 100 on the
    // newer one — nothing on the invoice the goods came from
    expect(await store.applyDebtOffsetToInvoice(older.id, 200)).toBe(true);
    expect(await store.applyDebtOffsetToInvoice(newer.id, 100)).toBe(true);
    await store.insertReturnDebtApplication({ returnId: record.id, invoiceId: older.id, amount: 200 });
    await store.insertReturnDebtApplication({ returnId: record.id, invoiceId: newer.id, amount: 100 });
    await store.setDebtApplied(record.id, 300);

    const olderDetail = await store.getInvoiceDetail(older.id);
    const newerDetail = await store.getInvoiceDetail(newer.id);
    const originDetail = await store.getInvoiceDetail(origin.id);
    expect(olderDetail?.returnCreditAmount).toBe(200);
    expect(newerDetail?.returnCreditAmount).toBe(100);
    // the origin invoice must NOT fall back to the return's full debt_applied
    expect(originDetail?.returnCreditAmount).toBe(0);
    expect(olderDetail!.totalAmount - olderDetail!.paidAmount - olderDetail!.returnCreditAmount).toBe(olderDetail!.remainingAmount);
    expect(newerDetail!.totalAmount - newerDetail!.paidAmount - newerDetail!.returnCreditAmount).toBe(newerDetail!.remainingAmount);
    expect(originDetail!.totalAmount - originDetail!.paidAmount - originDetail!.returnCreditAmount).toBe(originDetail!.remainingAmount);
  });

  it("backfills attribution for an already-applied return without changing the reported credit (#256 round 2)", async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-return-attr-"));
    const legacy = openConnection(
      createAppConfig({ DOKAN_DATA_DIR: legacyDir, DOKAN_DB_PATH: path.join(legacyDir, "attr.db") }),
    );
    try {
      const legacyStore = createDrizzleStore(legacy);
      await legacyStore.setup();
      // a v4-shaped database: the return's offset was applied to its own
      // invoice, and NO attribution row was ever written (the round-1 world)
      const invoice = await legacyStore.insertInvoice({
        invoiceNumber: `INV-ATTR-${stamp()}`,
        kind: "SALE",
        counterpartyId: null,
        counterpartyName: null,
        invoiceDate: localDate(),
        subtotalAmount: 0,
        discountType: null,
        discountValue: null,
        discountAmount: 0,
        totalAmount: 1_000,
        paidAmount: 600,
        remainingAmount: 400,
        notes: null,
      });
      const record = await legacyStore.insertReturn({
        returnNumber: `RTN-ATTR-${stamp()}`,
        invoiceId: invoice.id,
        refundAmount: 400,
        cashPaidOut: 0,
        debtOffset: 400,
        spreadsAcrossInvoices: false,
        payoutMethod: "CASH",
        reason: null,
        status: "ACCEPTED",
        occurredAt: localDateTime(),
      });
      await legacyStore.setDebtApplied(record.id, 400);
      expect(await legacyStore.applyDebtOffsetToInvoice(invoice.id, 400)).toBe(true);

      // PRE-backfill read: no attribution rows exist, so the legacy fallback
      // (own invoice's debt_applied) answers it
      const before = await legacyStore.getInvoiceDetail(invoice.id);
      expect(before?.returnCreditAmount).toBe(400);

      // Now reproduce the actual version-4 shape: the table did not exist when
      // those rows were written, and the marker was never written either — so
      // dropping both is what the next boot of THIS build meets
      legacy.raw.exec("DROP TABLE return_debt_applications");
      legacy.raw.exec("DELETE FROM settings WHERE key = 'migration.returnDebtApplicationsV1'");
      // SAFETY: a literal COUNT(*) yields one row with an integer column
      const rows = (r: Connection) => (r.raw.query("SELECT COUNT(*) AS count FROM return_debt_applications").get() as { count: number }).count;
      await legacyStore.setup();
      const after = await legacyStore.getInvoiceDetail(invoice.id);
      // EQUIVALENCE: the two attribution mechanisms report the same money
      expect(after?.returnCreditAmount).toBe(before?.returnCreditAmount);
      expect(after?.remainingAmount).toBe(before?.remainingAmount);
      expect(rows(legacy)).toBe(1);
      // idempotent twice over: the marker skips a second run…
      await legacyStore.setup();
      expect(rows(legacy)).toBe(1);
      // …and with the marker LOST, the NOT EXISTS guard still refuses to
      // double-count the same return
      legacy.raw.exec("DELETE FROM settings WHERE key = 'migration.returnDebtApplicationsV1'");
      backfillReturnDebtApplications(legacy);
      expect(rows(legacy)).toBe(1);
    } finally {
      legacy.close();
      removeTempDirRetry(legacyDir);
    }
  });
});

/**
 * #317 — the balance has two readers (SQL and the TypeScript fold) and before
 * this the suite could not see them disagree: one test asserted the SQL number,
 * another the fold's number, and nothing compared them. These tests fold ONE
 * fixture row set through every reader and compare.
 */
describe("#317 one rule decides what a supplier balance means", () => {
  /** One row per sign the rule table defines, so a kind cannot be left out of
   * the parity fixture without deleting it here. */
  const fixture = [
    { kind: "PURCHASE" as const, amount: 1_000, sign: -1 },
    { kind: "PAYMENT" as const, amount: 250, method: "CASH" as const, sign: 1 },
    { kind: "RETURN" as const, amount: 125, sign: 1 },
    { kind: "REFUND" as const, amount: 75, sign: -1 },
    { kind: "ADJUSTMENT" as const, amount: 400, direction: "WE_OWE" as const, sign: -1 },
    { kind: "ADJUSTMENT" as const, amount: 90, direction: "THEY_OWE" as const, sign: 1 },
  ];

  const newSupplier = async (label: string) => store.createParty("supplier", { name: `مورد-توازن-${label}-${stamp()}` });

  const insertRow = async (supplierId: string, row: (typeof fixture)[number]) => {
    await store.insertSupplierEntry({
      supplierId,
      kind: row.kind,
      amount: row.amount,
      direction: "direction" in row ? row.direction : null,
      method: "method" in row ? row.method : null,
      invoiceId: null,
      occurredAt: localDateTime(),
    });
  };

  /** Every reader of one supplier's balance: the two SQL aggregates (summary and
   * list), the detail's fold, and the ledger fold over the very rows the detail
   * folds. They must agree, which is the whole point of #317. */
  const readers = async (supplierId: string) => {
    const summary = (await store.listSupplierAccountSummaries()).find((row) => row.id === supplierId);
    const listRow = (await store.listParties("supplier")).find((row) => row.id === supplierId);
    const detail = await store.partyDetail("supplier", supplierId);
    return {
      summarySql: summary?.accountBalance,
      listSql: listRow?.accountBalance,
      detailFold: detail?.account?.balance,
      ledgerFold: supplierBalance(await store.listSupplierEntries(supplierId)),
    };
  };

  /**
   * A direction-less ADJUSTMENT, written the way a MIGRATED database can hold one:
   * the ALTER path cannot add the fresh DDL's CHECK, which is why every read has
   * to be the boundary. The caller deletes the row — the store tests share one
   * database, so leaving it behind makes every later reader refuse.
   */
  const insertDirectionlessRow = (supplierId: string, amount: number): string => {
    const entryId = crypto.randomUUID();
    conn.raw.exec("PRAGMA ignore_check_constraints = ON");
    try {
      conn.raw
        .query("INSERT INTO supplier_account_entries (id, supplier_id, kind, amount, direction, invoice_id, method, note, ref, dedup_key, occurred_at, created_at) VALUES (?, ?, 'ADJUSTMENT', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)")
        .run(entryId, supplierId, amount, localDateTime(), localDateTime());
    } finally {
      conn.raw.exec("PRAGMA ignore_check_constraints = OFF");
    }
    return entryId;
  };

  /**
   * A row whose `kind` is not in the rule table at all — not a direction-less
   * ADJUSTMENT, so the reader cannot reach it through the direction arm. No PRAGMA
   * is needed: nothing constrains `kind` (the only CHECK is about ADJUSTMENT's
   * direction), which is exactly why every reader needs a NULL/refusal path for it
   * and not just for the direction case the other fixtures use.
   */
  const insertUnknownKindRow = (supplierId: string, amount: number): string => {
    const entryId = crypto.randomUUID();
    conn.raw
      .query("INSERT INTO supplier_account_entries (id, supplier_id, kind, amount, direction, invoice_id, method, note, ref, dedup_key, occurred_at, created_at) VALUES (?, ?, 'BOGUS', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)")
      .run(entryId, supplierId, amount, localDateTime(), localDateTime());
    return entryId;
  };

  /** The refusal a reader raised, or a failure naming the number it quoted instead. */
  const refusalOf = async (read: Promise<unknown>): Promise<Error> => {
    try {
      const value = await read;
      throw new Error(`expected the reader to refuse a row it cannot sign, got ${JSON.stringify(value)}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("expected the reader to refuse")) throw error;
      if (!(error instanceof Error)) throw new Error(`expected a refusal, got ${String(error)}`);
      return error;
    }
  };

  it("folds one fixture row set through every reader and agrees per kind", async () => {
    for (const row of fixture) {
      const supplier = await newSupplier(row.kind);
      await insertRow(supplier.id, row);
      const expected = row.sign * row.amount;
      // the sign the owner reads, not the SQL string and not the fold's internals
      expect({ kind: row.kind, direction: row.direction ?? null, ...(await readers(supplier.id)) }).toMatchObject({
        summarySql: expected,
        listSql: expected,
        detailFold: expected,
        ledgerFold: expected,
      });
    }
  });

  it("agrees on the total, and a payment moves it by exactly its amount", async () => {
    const supplier = await newSupplier("total");
    const total = fixture.reduce((sum, row) => sum + row.sign * row.amount, 0);
    for (const row of fixture) await insertRow(supplier.id, row);
    const before = await readers(supplier.id);
    expect(before).toEqual({ summarySql: total, listSql: total, detailFold: total, ledgerFold: total });

    // user story 3: the total after a payment is the total before, less the payment
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PAYMENT", amount: 300, method: "CASH", invoiceId: null, occurredAt: localDateTime() });
    const after = await readers(supplier.id);
    expect(after).toEqual({ summarySql: total + 300, listSql: total + 300, detailFold: total + 300, ledgerFold: total + 300 });
  });

  it("refuses the same row on every reader when a required direction is missing", async () => {
    const supplier = await newSupplier("بلا-اتجاه");
    // a migrated database can hold this row: the ALTER path cannot add the CHECK
    // the fresh DDL carries, which is why the READ has to be the boundary.
    const badEntryId = insertDirectionlessRow(supplier.id, 700);

    try {
      const entries = await store.listSupplierEntries(supplier.id);
      // the fold refuses, and names the entry, its kind and the account so the
      // data can be fixed
      let foldError: unknown;
      try {
        supplierBalance(entries, supplier.id);
      } catch (error) {
        foldError = error;
      }
      expect(foldError).toBeInstanceOf(UnsignableSupplierEntryError);
      expect(foldError).toMatchObject({ kind: "ADJUSTMENT", entryId: badEntryId, supplierId: supplier.id });

      // …and every reader refuses with the same class instead of quoting the
      // negative the old CASE silently signed. `partyDetail` goes through the
      // FOLD, which has the row in hand, so it names the entry and its kind; the
      // SQL aggregates never surfaced a row, so they name only the ACCOUNT they
      // read and invent no kind — naming the first direction-required kind (always
      // ADJUSTMENT) sent the owner to fix the wrong row.
      const readers: ReadonlyArray<[Promise<unknown>, { kind: string | null; entryId?: string | null; supplierId: string | null }]> = [
        [store.partyDetail("supplier", supplier.id), { kind: "ADJUSTMENT", entryId: badEntryId, supplierId: supplier.id }],
        [store.listSupplierAccountSummaries(), { kind: null, supplierId: supplier.id }],
        [store.listParties("supplier"), { kind: null, supplierId: supplier.id }],
        [store.debtSummaries(), { kind: null, supplierId: supplier.id }],
        // the dashboard nets EVERY account in one row, so its refusal names none of
        // them: the read that names the account is the suppliers list above
        [store.dashboardSummary(localDate()), { kind: null, supplierId: null }],
      ];
      for (const [read, observed] of readers) {
        const refusal = await refusalOf(read);
        expect(refusal).toBeInstanceOf(UnsignableSupplierEntryError);
        expect(refusal).toMatchObject(observed);
      }
    } finally {
      // never leave a row the readers refuse in the shared test database
      conn.raw.query("DELETE FROM supplier_account_entries WHERE id = ?").run(badEntryId);
    }
  });

  it("refuses the invoice-grouped /debts arm too, not only the credit-only one", async () => {
    // The /debts read has TWO arms: the invoice aggregate (a supplier with an open
    // purchase invoice) and the credit-only list (a supplier whose purchase
    // invoices are all settled). A supplier with no invoices only reaches the
    // second, so a refusal test written that way proves nothing about the first —
    // and `DebtSummary.accountBalance` is nullable, so a regression there would
    // still validate output while the page substituted the invoice debt.
    const supplier = await newSupplier("فاتورة-مفتوحة");
    await store.insertInvoice({
      invoiceNumber: `INV-DEBT-${stamp()}`,
      kind: "PURCHASE",
      counterpartyId: supplier.id,
      counterpartyName: supplier.name,
      invoiceDate: localDate(),
      totalAmount: 1_000,
      paidAmount: 0,
      remainingAmount: 1_000,
      notes: null,
    });
    const badEntryId = await insertDirectionlessRow(supplier.id, 700);

    try {
      // the invoice arm: `remaining_amount > 0` puts this supplier in the
      // aggregate, so the NULL balance beside a known counterparty is the refusal
      const refusal = await refusalOf(store.debtSummaries());
      expect(refusal).toBeInstanceOf(UnsignableSupplierEntryError);
      expect(refusal).toMatchObject({ kind: null, supplierId: supplier.id });
    } finally {
      conn.raw.query("DELETE FROM supplier_account_entries WHERE id = ?").run(badEntryId);
    }
  });

  it("refuses an unknown KIND on the SQL readers and the fold, not only a missing direction", async () => {
    // The direction-less ADJUSTMENT fixtures all reach the reader through the
    // direction arm of the generated CASE. A kind the table does not define takes
    // the ELSE-NULL arm instead, and nothing else in the suite proved the SQL side
    // of that.
    const supplier = await newSupplier("نوع-مجهول");
    const badEntryId = insertUnknownKindRow(supplier.id, 300);

    try {
      // the fold holds the row, so it names the kind and the entry it actually saw
      let foldError: unknown;
      try {
        supplierBalance(await store.listSupplierEntries(supplier.id), supplier.id);
      } catch (error) {
        foldError = error;
      }
      expect(foldError).toBeInstanceOf(UnsignableSupplierEntryError);
      expect(foldError).toMatchObject({ kind: "BOGUS", entryId: badEntryId, supplierId: supplier.id });
      // …and it does not invent a direction: this row carried none, and the fold
      // saw it, so the message says `(none)` rather than `(unread by this read)`
      // SAFETY: the toBeInstanceOf above proved this is the refusal, whose message
      // is the only field under test here
      expect((foldError as Error).message).toContain("kind BOGUS, direction (none)");

      // the SQL reads never surfaced a row: they name the account and nothing else,
      // in the fields AND in the sentence the log carries
      for (const read of [store.listParties("supplier"), store.debtSummaries()]) {
        const refusal = await refusalOf(read);
        expect(refusal).toBeInstanceOf(UnsignableSupplierEntryError);
        expect(refusal).toMatchObject({ kind: null, supplierId: supplier.id });
      }
      // `partyDetail` is the one SQL-named read that folds, so it reaches the row:
      // keep that difference honest instead of asserting one shape for both
      const detailRefusal = await refusalOf(store.partyDetail("supplier", supplier.id));
      expect(detailRefusal).toMatchObject({ kind: "BOGUS", entryId: badEntryId });
      expect(detailRefusal.message).toContain("kind BOGUS, direction (none)");

      // the SQL refusal says it did not look, instead of claiming the row carried
      // no direction — the same invented observation as naming a kind it never saw
      const sqlRefusal = await refusalOf(store.listParties("supplier"));
      expect(sqlRefusal.message).toContain("kind (unread by this read), direction (unread by this read)");
      expect(sqlRefusal.message).not.toContain("direction (none)");
    } finally {
      conn.raw.query("DELETE FROM supplier_account_entries WHERE id = ?").run(badEntryId);
    }
  });

  it("reads an account with no entries as 0 rather than a refusal", async () => {
    // `WHEN COUNT(*) = 0 THEN 0` is the aggregate's only untested arm, and its
    // failure mode is a TOTAL outage: a NULL there makes `toPartyListItem` throw
    // for every supplier with no entries, blanking the suppliers list, the
    // opening-balance screen and /debts at once.
    const empty = await newSupplier("بلا-حركات");
    const listRow = (await store.listParties("supplier")).find((row) => row.id === empty.id);
    expect(listRow).toMatchObject({ accountBalance: 0, accountEntryCount: 0 });

    // the summaries list only carries suppliers WITH entries (the caller defaults
    // a missing id to 0/0), so an empty account is absent and never a refusal
    expect((await store.listSupplierAccountSummaries()).some((row) => row.id === empty.id)).toBe(false);
    expect((await store.partyDetail("supplier", empty.id))?.account).toEqual({ balance: 0, entries: [] });

    // …and no read that spans every account refuses because one is empty
    const dashboard = await store.dashboardSummary(localDate());
    expect(dashboard.weOwe).toBeNumber();
    await store.debtSummaries();
  });
});
