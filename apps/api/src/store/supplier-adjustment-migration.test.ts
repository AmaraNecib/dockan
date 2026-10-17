import { Database } from "bun:sqlite";
import { afterEach, describe, expect } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { assertSchemaVersionSupported, CURRENT_SCHEMA_VERSION, readSchemaVersion, UnsupportedSchemaVersionError } from "../lib/schema-version";
import { adjustmentDedupKey } from "../lib/supplier-ledger";
import { createDrizzleStore } from "./drizzle-store";

/**
 * Issue 176 (+ 181 + 260) — the BLOCKING supplier-adjustment + sign-convention
 * migration tests.
 *
 * The manual adjustment (تسوية) is additive: a new `ADJUSTMENT` kind plus a
 * `supplier_account_entries.direction` column (v3), then a `dedup_key` column +
 * partial unique index (v4, issue 181), and then the #260 sign-convention flip
 * (v5, no DDL — the stored rows are unchanged). An older (version-2) build has
 * no ADJUSTMENT branch in its sign SQL, so it would read a «نسالوه» adjustment
 * as a decrement and show a wrong balance; a version-3 build has no `dedup_key`
 * and would write rows that escape the new dedup; a version-4 build signs the
 * OPPOSITE balance from the same rows (#260), so it too must refuse the file.
 * The first sequence proves:
 *
 *   1. a version-2 database (no direction column) opens with the new build;
 *   2. the forward migration adds both columns, PRESERVES every existing row, and
 *      stamps the current version (5);
 *   3. an older build refuses the merged database;
 *   4. re-opening is idempotent — no error, version 5, no duplicated rows.
 *
 * The second describe proves the v3 -> v5 `dedup_key` migration in the same
 * shape (backfill, legacy-duplicate exemption, index, version refusal, re-open).
 */
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-supplier-v3-"));
  cleanups.push(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });
  return dir;
}

function closeLater(conn: Connection): Connection {
  cleanups.push(() => conn.close());
  return conn;
}

/**
 * The exact shape a version-2 build wrote for the supplier account: no
 * `direction` column, `PRAGMA user_version = 2`. Everything else in the
 * database is created by the new build's DDL, which is what an upgrade looks
 * like on a real install.
 */
function seedVersion2Database(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL)");
  db.exec(
    "CREATE TABLE supplier_account_entries (id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id), kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), invoice_id TEXT, method TEXT, note TEXT, ref TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
  db.query("INSERT INTO suppliers (id, name, phone, created_at) VALUES (?, ?, NULL, ?)").run("sup-1", "مورد قديم", "2026-01-01T10:00:00");
  db.query(
    "INSERT INTO supplier_account_entries (id, supplier_id, kind, amount, invoice_id, method, note, ref, occurred_at, created_at) VALUES (?, ?, 'PURCHASE', ?, NULL, NULL, NULL, NULL, ?, ?)",
  ).run("entry-1", "sup-1", 5000, "2026-01-01T10:00:00", "2026-01-01T10:00:00");
  db.exec("PRAGMA user_version = 2");
  db.close();
}

describe("v2 -> current supplier-adjustment + sign-convention migration (issues 176 + 181 + 260, blocking)", () => {
  itHeavy("adds the direction + dedup_key columns, preserves rows, stamps the current version, refuses a v2/v4 build, and re-opens idempotently", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "v2.db");
    seedVersion2Database(dbPath);

    // 1. the new build opens the old database and migrates it forward
    const conn = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    await createDrizzleStore(conn).setup();
    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);

    // the additive columns landed; the pre-existing row is untouched and its
    // direction is null (correct for every non-ADJUSTMENT kind)
    // SAFETY: PRAGMA table_info returns one object with a string name per column
    const columns = conn.raw.query("PRAGMA table_info(supplier_account_entries)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "direction")).toBe(true);
    expect(columns.some((column) => column.name === "dedup_key")).toBe(true);
    // SAFETY: the SELECT names kind/amount/direction, so the single row has
    // exactly those columns (kind/amount INTEGER or TEXT, direction nullable)
    const preserved = conn.raw
      .query("SELECT kind, amount, direction FROM supplier_account_entries WHERE id = 'entry-1'")
      .get() as { kind: string; amount: number; direction: string | null };
    expect(preserved).toEqual({ kind: "PURCHASE", amount: 5000, direction: null });

    // 2. an older build cannot read this format: it would mis-sign adjustments
    expect(() => assertSchemaVersionSupported(conn.raw, 2)).toThrow(UnsupportedSchemaVersionError);
    // ... and a version-4 build is also refused (#260): it computes the OPPOSITE
    // balance from the same rows, so accepting the file would invert every
    // balances surface silently.
    expect(() => assertSchemaVersionSupported(conn.raw, 4)).toThrow(UnsupportedSchemaVersionError);

    // 3. a new ADJUSTMENT row round-trips with its direction through the store
    const store = createDrizzleStore(conn);
    await store.insertSupplierEntry({
      supplierId: "sup-1",
      kind: "ADJUSTMENT",
      direction: "WE_OWE",
      amount: 800,
      invoiceId: null,
      note: "رصيد افتتاحي",
      occurredAt: "2026-10-13T12:00:00",
    });
    const entries = await store.listSupplierEntries("sup-1");
    expect(entries.find((entry) => entry.kind === "ADJUSTMENT")?.direction).toBe("WE_OWE");
    await conn.close();

    // 4. re-opening runs the (idempotent) migrations again: no error, the
    //    version stays 5 and no row is duplicated
    const again = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    await createDrizzleStore(again).setup();
    expect(readSchemaVersion(again.raw)).toBe(CURRENT_SCHEMA_VERSION);
    // SAFETY: COUNT(*) returns one numeric row
    const count = again.raw.query("SELECT COUNT(*) AS count FROM supplier_account_entries").get() as { count: number };
    expect(count.count).toBe(2);
  });
});

/**
 * The exact shape a version-3 build wrote: the `direction` column is present,
 * `dedup_key` is not, `PRAGMA user_version = 3`. The two identical ADJUSTMENT
 * rows model a pre-#177 duplicate the backfill cannot key without breaking the
 * new unique index.
 */
function seedVersion3Database(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL)");
  db.exec(
    "CREATE TABLE supplier_account_entries (id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id), kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), direction TEXT CHECK (direction IN ('WE_OWE','THEY_OWE') OR direction IS NULL), invoice_id TEXT, method TEXT, note TEXT, ref TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, CHECK (kind <> 'ADJUSTMENT' OR direction IS NOT NULL))",
  );
  db.query("INSERT INTO suppliers (id, name, phone, created_at) VALUES (?, ?, NULL, ?)").run("sup-1", "مورد v3", "2026-01-01T10:00:00");
  const insert = db.query(
    "INSERT INTO supplier_account_entries (id, supplier_id, kind, amount, direction, invoice_id, method, note, ref, occurred_at, created_at) VALUES (?, 'sup-1', ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)",
  );
  insert.run("entry-1", "PURCHASE", 5000, null, null, "2026-01-01T10:00:00", "2026-01-01T10:00:00");
  insert.run("entry-2", "ADJUSTMENT", 800, "WE_OWE", "رصيد افتتاحي", "2026-01-02T10:00:00", "2026-01-02T10:00:00");
  // a pre-#177 duplicate of entry-2 (identical signature)
  insert.run("entry-3", "ADJUSTMENT", 800, "WE_OWE", "رصيد افتتاحي", "2026-01-02T10:00:00", "2026-01-02T10:00:00");
  insert.run("entry-4", "ADJUSTMENT", 300, "THEY_OWE", null, "2026-01-03T10:00:00", "2026-01-03T10:00:00");
  db.exec("PRAGMA user_version = 3");
  db.close();
}

/**
 * A half-migrated version-3 database: the `dedup_key` column exists (the v4
 * ALTER committed) but every key is NULL and `user_version` is still 3 (the
 * stamp never happened), and a downgraded writer added a NULL-keyed row.
 */
function seedHalfMigratedDatabase(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL)");
  db.exec(
    "CREATE TABLE supplier_account_entries (id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id), kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), direction TEXT CHECK (direction IN ('WE_OWE','THEY_OWE') OR direction IS NULL), invoice_id TEXT, method TEXT, note TEXT, ref TEXT, dedup_key TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, CHECK (kind <> 'ADJUSTMENT' OR direction IS NOT NULL))",
  );
  db.query("INSERT INTO suppliers (id, name, phone, created_at) VALUES (?, ?, NULL, ?)").run("sup-1", "مورد نصف ترحيل", "2026-01-01T10:00:00");
  db.query(
    "INSERT INTO supplier_account_entries (id, supplier_id, kind, amount, direction, invoice_id, method, note, ref, dedup_key, occurred_at, created_at) VALUES ('entry-1', 'sup-1', 'ADJUSTMENT', 800, 'WE_OWE', NULL, NULL, 'رصيد افتتاحي', NULL, NULL, '2026-01-02T10:00:00', '2026-01-02T10:00:00')",
  ).run();
  db.exec("PRAGMA user_version = 3");
  db.close();
}

describe("v3 -> current adjustment dedup_key + sign-convention migration (issue 181 + 260, blocking)", () => {
  itHeavy("keys existing adjustments, exempts a legacy duplicate, creates the unique index, stamps the current version, refuses a v3 build, and re-opens idempotently", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "v3.db");
    seedVersion3Database(dbPath);

    // 1. the new build opens the old database and migrates it forward
    const conn = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    await createDrizzleStore(conn).setup();
    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);

    // SAFETY: PRAGMA table_info returns one object with a string name per column
    const columns = conn.raw.query("PRAGMA table_info(supplier_account_entries)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "dedup_key")).toBe(true);

    // 2. every row is preserved and keyed by its time-inclusive signature; the
    //    pre-#177 duplicate is left NULL because the index must stay creatable
    // SAFETY: the SELECT names id/kind/dedup_key, so each row has those columns
    const rows = conn.raw.query("SELECT id, kind, dedup_key AS dedupKey FROM supplier_account_entries ORDER BY rowid").all() as Array<{ id: string; kind: string; dedupKey: string | null }>;
    expect(rows.map((row) => row.id)).toEqual(["entry-1", "entry-2", "entry-3", "entry-4"]);
    const expectedKey = adjustmentDedupKey({
      supplierId: "sup-1",
      direction: "WE_OWE",
      amount: 800,
      reason: "رصيد افتتاحي",
      occurredAt: "2026-01-02T10:00:00",
      invoiceId: null,
      serverStamped: false,
    });
    expect(rows.find((row) => row.id === "entry-1")?.dedupKey).toBeNull();
    expect(rows.find((row) => row.id === "entry-2")?.dedupKey).toBe(expectedKey);
    expect(rows.find((row) => row.id === "entry-3")?.dedupKey).toBeNull();
    expect(rows.find((row) => row.id === "entry-4")?.dedupKey).not.toBeNull();

    // the guard still finds a new identical request even when the duplicate is
    // unkeyed (the #177 signature arm), so the upgrade loses no dedup
    const store = createDrizzleStore(conn);
    expect(
      await store.hasSupplierAdjustment({
        supplierId: "sup-1",
        direction: "WE_OWE",
        amount: 800,
        reason: "رصيد افتتاحي",
        occurredAt: "2026-01-02T10:00:00",
        invoiceId: null,
      }),
    ).toBe(true);

    // 3. the partial unique index exists on the key column
    // SAFETY: PRAGMA index_list returns one object per index with these fields
    const indexes = conn.raw.query("PRAGMA index_list(supplier_account_entries)").all() as Array<{ name: string; unique: number; partial: number }>;
    const dedupIndex = indexes.find((index) => index.name === "idx_supplier_entries_dedup");
    expect(dedupIndex?.unique).toBe(1);
    expect(dedupIndex?.partial).toBe(1);
    // SAFETY: PRAGMA index_info returns one object per column with a name
    const indexColumns = conn.raw.query("PRAGMA index_info(idx_supplier_entries_dedup)").all() as Array<{ name: string }>;
    expect(indexColumns.map((column) => column.name)).toEqual(["dedup_key"]);

    // 4. the DB itself refuses a duplicate key, even when it bypasses the store
    expect(() =>
      conn.raw
        .query(
          "INSERT INTO supplier_account_entries (id, supplier_id, kind, amount, direction, invoice_id, method, note, ref, dedup_key, occurred_at, created_at) VALUES ('entry-5', 'sup-1', 'ADJUSTMENT', 800, 'WE_OWE', NULL, NULL, 'رصيد افتتاحي', NULL, ?, '2026-01-02T10:00:00', '2026-01-02T10:00:00')",
        )
        .run(expectedKey),
    ).toThrow(/UNIQUE constraint failed/);

    // 5. an older build cannot read this format: it has no dedup_key and would
    //    write NULL-keyed adjustments that escape the new dedup
    expect(() => assertSchemaVersionSupported(conn.raw, 3)).toThrow(UnsupportedSchemaVersionError);
    await conn.close();

    // 6. re-opening runs the (idempotent) migrations again: no error, the
    //    version stays current, no row is duplicated and no key changes
    const again = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    await createDrizzleStore(again).setup();
    expect(readSchemaVersion(again.raw)).toBe(CURRENT_SCHEMA_VERSION);
    // SAFETY: the SELECT names id/dedup_key, so each row has those columns
    const after = again.raw.query("SELECT id, dedup_key AS dedupKey FROM supplier_account_entries ORDER BY rowid").all() as Array<{ id: string; dedupKey: string | null }>;
    expect(after).toEqual(rows.map((row) => ({ id: row.id, dedupKey: row.dedupKey })));
  });

  itHeavy("self-heals a half-migrated database: column present, keys null, version 3 (issue 181)", async () => {
    // models the crash window where the v4 ALTER committed but the version
    // stamp did not, and a v3 build then wrote NULL-keyed adjustments
    const dir = tempDir();
    const dbPath = path.join(dir, "half.db");
    seedHalfMigratedDatabase(dbPath);

    const conn = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    await createDrizzleStore(conn).setup();

    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    // SAFETY: the SELECT names dedup_key, so the row has that nullable column
    const row = conn.raw.query("SELECT dedup_key AS dedupKey FROM supplier_account_entries WHERE id = 'entry-1'").get() as { dedupKey: string | null };
    // the self-healing backfill keyed the row instead of skipping it forever
    expect(row.dedupKey).toBe(
      adjustmentDedupKey({
        supplierId: "sup-1",
        direction: "WE_OWE",
        amount: 800,
        reason: "رصيد افتتاحي",
        occurredAt: "2026-01-02T10:00:00",
        invoiceId: null,
        serverStamped: false,
      }),
    );
  });
});
