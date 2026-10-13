import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { assertSchemaVersionSupported, readSchemaVersion, UnsupportedSchemaVersionError } from "../lib/schema-version";
import { createDrizzleStore } from "./drizzle-store";

/**
 * Issue 176 — the BLOCKING v2 → v3 migration test.
 *
 * The manual adjustment (تسوية) is additive: a new `ADJUSTMENT` kind plus a
 * `supplier_account_entries.direction` column. An older (version-2) build has
 * no ADJUSTMENT branch in its sign SQL, so it would read a «نسالوه» adjustment
 * as a decrement and show a wrong balance. The sequence this test proves:
 *
 *   1. a version-2 database (no direction column) opens with the new build;
 *   2. the forward migration adds the column, PRESERVES every existing row, and
 *      stamps version 3;
 *   3. an older build refuses the merged database;
 *   4. re-opening is idempotent — no error, version 3, no duplicated rows.
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

describe("v2 -> v3 supplier-adjustment migration (issue 176, blocking)", () => {
  it("adds the direction column, preserves rows, stamps 3, refuses a v2 build, and re-opens idempotently", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "v2.db");
    seedVersion2Database(dbPath);

    // 1. the new build opens the old database and migrates it forward
    const conn = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    await createDrizzleStore(conn).setup();
    expect(readSchemaVersion(conn.raw)).toBe(3);

    // the additive column landed; the pre-existing row is untouched and its
    // direction is null (correct for every non-ADJUSTMENT kind)
    // SAFETY: PRAGMA table_info returns one object with a string name per column
    const columns = conn.raw.query("PRAGMA table_info(supplier_account_entries)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "direction")).toBe(true);
    // SAFETY: the SELECT names kind/amount/direction, so the single row has
    // exactly those columns (kind/amount INTEGER or TEXT, direction nullable)
    const preserved = conn.raw
      .query("SELECT kind, amount, direction FROM supplier_account_entries WHERE id = 'entry-1'")
      .get() as { kind: string; amount: number; direction: string | null };
    expect(preserved).toEqual({ kind: "PURCHASE", amount: 5000, direction: null });

    // 2. an older build cannot read this format: it would mis-sign adjustments
    expect(() => assertSchemaVersionSupported(conn.raw, 2)).toThrow(UnsupportedSchemaVersionError);

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
    //    version stays 3 and no row is duplicated
    const again = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    await createDrizzleStore(again).setup();
    expect(readSchemaVersion(again.raw)).toBe(3);
    // SAFETY: COUNT(*) returns one numeric row
    const count = again.raw.query("SELECT COUNT(*) AS count FROM supplier_account_entries").get() as { count: number };
    expect(count.count).toBe(2);
  });
});
