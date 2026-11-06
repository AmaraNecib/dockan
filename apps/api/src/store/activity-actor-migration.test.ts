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

function makeV7Database(): string {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-activity-actor-v7-"));
  const dbPath = path.join(directory, "dokan.db");
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE activities (id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT)");
  db.exec("INSERT INTO activities (id, at, type, summary, ref) VALUES ('legacy-activity', '2026-01-02T03:04:05', 'SALE_CREATED', 'SALE_CREATED INV-0001', 'INV-0001')");
  db.exec("PRAGMA user_version = 7");
  db.close();
  return dbPath;
}

describe("activity actor snapshot migration", () => {
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
      expect(readSchemaVersion(conn.raw)).toBe(8);
    } finally {
      conn.close();
    }
  });

  it("rolls back the first ALTER after an injected second-column failure, then retries setup", async () => {
    const dbPath = makeV7Database();
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
      expect(readSchemaVersion(conn.raw)).toBe(7);

      await store.setup();
      const retried = (await store.listActivities({ limit: 10 })).items.find((activity) => activity.id === "legacy-activity");
      expect(retried).toMatchObject({ actorId: null, actorName: null });
      expect(readSchemaVersion(conn.raw)).toBe(8);
    } finally {
      conn.close();
    }
  });

  it("adds nullable snapshots without attributing old activity, stamps v8, refuses v7 readers, and reopens safely", async () => {
    const dbPath = makeV7Database();
    const conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: directory, DOKAN_DB_PATH: dbPath }));
    try {
      const store = createDrizzleStore(conn);
      await store.setup();
      expect(CURRENT_SCHEMA_VERSION).toBe(8);
      expect(readSchemaVersion(conn.raw)).toBe(8);
      expect(() => assertSchemaVersionSupported(conn.raw, 7)).toThrow(UnsupportedSchemaVersionError);

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
