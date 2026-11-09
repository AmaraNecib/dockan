import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection } from "../db/connection";
import { assertSchemaVersionSupported, CURRENT_SCHEMA_VERSION, readSchemaVersion, UnsupportedSchemaVersionError } from "../lib/schema-version";
import { createDrizzleStore } from "./drizzle-store";

let directory: string;
afterEach(() => {
  if (!directory) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

function makeV11PendingDatabase(): string {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-pending-cost-v11-"));
  const dbPath = path.join(directory, "dokan.db");
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, barcode TEXT, category_id TEXT NOT NULL, cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL DEFAULT 5, stock_on_hand INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("INSERT INTO items (id, name, category_id, cost_price, selling_price, stock_on_hand, created_at, updated_at) VALUES ('pending-history', 'مخزون معلّق سابق', 'legacy-category', 0, 100, 0, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
  db.exec("CREATE TABLE stock_movements (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, kind TEXT NOT NULL, delta INTEGER NOT NULL, unit_cost INTEGER, cost_pending INTEGER NOT NULL DEFAULT 0, reason TEXT, ref TEXT, return_mark TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.exec("INSERT INTO stock_movements VALUES ('pending-in', 'pending-history', 'PURCHASE', 2, NULL, 1, NULL, NULL, NULL, '2026-01-02T00:00:00', '2026-01-02T00:00:00')");
  db.exec("INSERT INTO stock_movements VALUES ('pending-out', 'pending-history', 'SALE', -2, NULL, 0, NULL, NULL, NULL, '2026-01-03T00:00:00', '2026-01-03T00:00:00')");
  db.exec("PRAGMA user_version = 11");
  db.close();
  return dbPath;
}

function makeV9Database(): string {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-activity-actor-v9-"));
  const dbPath = path.join(directory, "dokan.db");
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE activities (id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT)");
  db.exec("INSERT INTO activities (id, at, type, summary, ref) VALUES ('legacy-activity', '2026-01-02T03:04:05', 'SALE_CREATED', 'SALE_CREATED INV-0001', 'INV-0001')");
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, barcode TEXT, category_id TEXT NOT NULL, cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL DEFAULT 5, stock_on_hand INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("INSERT INTO items (id, name, category_id, cost_price, selling_price, created_at, updated_at) VALUES ('legacy-cost', 'منتج قديم', 'legacy-category', 0, 100, '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
  db.exec("PRAGMA user_version = 9");
  db.close();
  return dbPath;
}

describe("activity actor snapshot migration", () => {
  it("keeps legacy caches with pending receipt history untrusted after upgrade", async () => {
    const dbPath = makeV11PendingDatabase();
    const conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: directory, DOKAN_DB_PATH: dbPath }));
    try {
      const store = createDrizzleStore(conn);
      await store.setup();
      expect((await store.getItemsByIds(["pending-history"])).get("pending-history"))
        .toMatchObject({ costPrice: 0, costPriceKnown: false });
      expect((await store.listItems()).items.find((item) => item.id === "pending-history"))
        .toMatchObject({ costPending: false, costPriceKnown: false });
      expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      conn.close();
    }
  });

  it("creates nullable snapshots on a fresh store", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-activity-actor-fresh-"));
    const dbPath = path.join(directory, "dokan.db");
    const conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: directory, DOKAN_DB_PATH: dbPath }));
    try {
      const store = createDrizzleStore(conn);
      await store.setup();
      await store.insertActivity({ type: "SALE_CREATED", summary: "SALE_CREATED INV-0001", ref: "INV-0001" });
      const activity = (await store.listActivities({ limit: 10 })).items[0];
      expect(activity).toMatchObject({ actorId: null, actorName: null });
      expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      conn.close();
    }
  });

  it("rolls back the first ALTER after an injected second-column failure, then retries setup", async () => {
    const dbPath = makeV9Database();
    const conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: directory, DOKAN_DB_PATH: dbPath }));
    try {
      const store = createDrizzleStore(conn);
      const originalExec = conn.raw.exec.bind(conn.raw);
      let injected = false;
      Object.defineProperty(conn.raw, "exec", {
        configurable: true,
        value: (query: string) => {
          if (!injected && query === "ALTER TABLE activities ADD COLUMN actor_name TEXT") {
            injected = true;
            throw new Error("injected second-column migration failure");
          }
          return originalExec(query);
        },
      });
      await expect(store.setup()).rejects.toThrow("injected second-column migration failure");
      Object.defineProperty(conn.raw, "exec", { configurable: true, value: originalExec });
      expect(injected).toBe(true);
      // The first ALTER must roll back with the injected failure on the second.
      // SAFETY: PRAGMA table_info returns one row per column with a string name.
      const failedColumns = conn.raw.query("PRAGMA table_info(activities)").all() as Array<{ name: string }>;
      expect(failedColumns.map((column) => column.name)).not.toContain("actor_id");
      expect(failedColumns.map((column) => column.name)).not.toContain("actor_name");
      // Earlier additive migrations committed; the actor-column transaction
      // rolled back and setup can retry on this head.
      expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);

      await store.setup();
      const retried = (await store.listActivities({ limit: 10 })).items.find((activity) => activity.id === "legacy-activity");
      expect(retried).toMatchObject({ actorId: null, actorName: null });
      expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      conn.close();
    }
  });

  it("rolls back actor columns when recording the schema version fails, then retries safely", async () => {
    const dbPath = makeV9Database();
    const conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: directory, DOKAN_DB_PATH: dbPath }));
    const originalExec = conn.raw.exec.bind(conn.raw);
    try {
      const store = createDrizzleStore(conn);
      Object.defineProperty(conn.raw, "exec", {
        configurable: true,
        value: (query: string) => {
          if (query === `PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`) throw new Error("injected version stamp failure");
          return originalExec(query);
        },
      });
      await expect(store.setup()).rejects.toThrow("injected version stamp failure");
      Object.defineProperty(conn.raw, "exec", { configurable: true, value: originalExec });
      // SAFETY: PRAGMA table_info returns one row per column with a string name.
      const columns = conn.raw.query("PRAGMA table_info(activities)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("actor_id");
      expect(columns.map((column) => column.name)).not.toContain("actor_name");
      expect(readSchemaVersion(conn.raw)).toBe(9);
      await store.setup();
      expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
      expect((await store.listActivities()).items.find((row) => row.id === "legacy-activity"))
        .toMatchObject({ actorId: null, actorName: null, summary: "SALE_CREATED INV-0001" });
    } finally {
      Object.defineProperty(conn.raw, "exec", { configurable: true, value: originalExec });
      conn.close();
    }
  });

  it("refuses a newer database before setup changes its schema", async () => {
    const dbPath = makeV9Database();
    const conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: directory, DOKAN_DB_PATH: dbPath }));
    try {
      conn.raw.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
      const before = conn.raw.query("SELECT sql FROM sqlite_master ORDER BY name").all();
      await expect(createDrizzleStore(conn).setup()).rejects.toThrow(UnsupportedSchemaVersionError);
      expect(conn.raw.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
      expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION + 1);
    } finally {
      conn.close();
    }
  });

  it("adds nullable snapshots without attributing old activity, stamps the current schema, refuses v9 readers, and reopens safely", async () => {
    const dbPath = makeV9Database();
    const conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: directory, DOKAN_DB_PATH: dbPath }));
    try {
      const store = createDrizzleStore(conn);
      await store.setup();
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
      expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
      expect((await store.getItemsByIds(["legacy-cost"])).get("legacy-cost"))
        .toMatchObject({ costPrice: 0, costPriceKnown: true });
      expect(() => assertSchemaVersionSupported(conn.raw, 9)).toThrow(UnsupportedSchemaVersionError);

      const row = (await store.listActivities({ limit: 10 })).items.find((activity) => activity.id === "legacy-activity");
      expect(row).toMatchObject({
        id: "legacy-activity",
        type: "SALE_CREATED",
        summary: "SALE_CREATED INV-0001",
        ref: "INV-0001",
        actorId: null,
        actorName: null,
      });

      await store.setup();
      const reopened = (await store.listActivities({ limit: 10 })).items.filter((activity) => activity.id === "legacy-activity");
      expect(reopened).toHaveLength(1);
      expect(reopened[0]?.actorId).toBeNull();
      expect(reopened[0]?.actorName).toBeNull();
    } finally {
      conn.close();
    }
  });
});
