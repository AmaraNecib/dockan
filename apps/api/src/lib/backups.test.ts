import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";
import { backupDirFor, backupFileNameFor, backupFilePath, createBackup, ensureDailyBackup } from "./backups";

/**
 * Ticket 13 unit seams: naming policy, once-per-day idempotency, and the
 * guarantee that a copied file opens standalone with the committed data.
 */
let dir: string;
let conn: Connection;
let store: StorePort;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-backups-"));
  const config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: path.join(dir, "live.db"),
    DOKAN_AUTH_SECRET: "test-auth-secret",
  });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
});

afterAll(() => {
  conn.close();
  // best-effort cleanup: Windows can hold the copied file briefly after
  // close, and a leftover tmpdir harms nothing
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleaner */
  }
});

describe("backup file naming", () => {
  it("names files dokan-YYYY-MM-DD.db under <dataDir>/backups", () => {
    expect(backupFileNameFor("2026-08-25")).toBe("dokan-2026-08-25.db");
    expect(backupFilePath("/data", "2026-08-25")).toBe(path.join("/data", "backups", "dokan-2026-08-25.db"));
    expect(backupDirFor("/data")).toBe(path.join("/data", "backups"));
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(() => backupFileNameFor("25-08-2026")).toThrow();
    expect(() => backupFileNameFor("")).toThrow();
  });
});

describe("manual export copy", () => {
  it("writes a file that opens standalone with the committed rows", async () => {
    await store.createCategory({ name: "تصنيف النسخ" });
    const result = await createBackup({ store, dataDir: dir });

    expect(result.path).toBe(backupFilePath(dir));
    // createdAt matches the Algeria-local contract shape
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    // the copy is a real database: open it fresh and read committed data
    const copy = new Database(result.path, { readonly: true });
    try {
      // SAFETY: categories.name is TEXT in every row of this table (schema.ts)
      const names = copy.query("SELECT name FROM categories").all() as Array<{ name: string }>;
      expect(names.some((r) => r.name === "تصنيف النسخ")).toBe(true);
    } finally {
      copy.close();
    }
  });
});

describe("daily startup backup", () => {
  it("creates today's file once; a second call on the same day is a no-op", async () => {
    const first = await ensureDailyBackup({ store, dataDir: dir, today: "2026-08-25" });
    expect(first.created).toBe(true);
    expect(first.path).toBe(backupFilePath(dir, "2026-08-25"));

    // mutate after the first copy — the retained daily copy must not change
    await store.createCategory({ name: "بعد النسخة" });
    const second = await ensureDailyBackup({ store, dataDir: dir, today: "2026-08-25" });
    expect(second.created).toBe(false);

    // SAFETY: backup names are exactly "dokan-<date>.db" (backupFileNameFor);
    // a strict match also proves validation leaves no -wal/-shm sidecars behind
    const files = fs.readdirSync(backupDirFor(dir)).filter((f) => /^dokan-2026-08-25\.db$/.test(f));
    expect(files).toEqual(["dokan-2026-08-25.db"]);

    // the retained copy predates the later category
    const copy = new Database(first.path, { readonly: true });
    try {
      // SAFETY: categories.name is TEXT in every row of this table (schema.ts)
      const names = copy.query("SELECT name FROM categories").all() as Array<{ name: string }>;
      expect(names.some((r) => r.name === "بعد النسخة")).toBe(false);
    } finally {
      copy.close();
    }
  });

  it("rebuilds today's file when a truncated copy is on disk (review fix)", async () => {
    const day = "2026-08-28";
    const dest = backupFilePath(dir, day);

    // simulate a half-written backup: a few bytes, no SQLite magic header
    fs.writeFileSync(dest, Buffer.from("truncated garbage"));

    const result = await ensureDailyBackup({ store, dataDir: dir, today: day });
    expect(result.created).toBe(true);

    // the rebuilt file is a real database holding committed rows
    const copy = new Database(dest, { readonly: true });
    try {
      // SAFETY: categories.name is TEXT in every row of this table (schema.ts)
      const names = copy.query("SELECT name FROM categories").all() as Array<{ name: string }>;
      expect(names.length).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
  });

  it("rebuilds a header-valid file whose tail pages were truncated (greptile P1)", async () => {
    const day = "2026-08-30";

    // force a multi-page db so a mid-file cut keeps the header but loses pages
    for (let i = 0; i < 400; i++) {
      await store.createCategory({ name: `امتلاء-${i}` });
    }
    await ensureDailyBackup({ store, dataDir: dir, today: day });
    const dest = backupFilePath(dir, day);
    const fullSize = fs.statSync(dest).size;
    expect(fullSize).toBeGreaterThan(8192); // more than two 4096-byte pages

    // cut the tail: header (first 100 bytes) survives, later pages are gone
    fs.truncateSync(dest, Math.floor(fullSize / 2));

    const result = await ensureDailyBackup({ store, dataDir: dir, today: day });
    expect(result.created).toBe(true);
    expect(fs.statSync(dest).size).toBe(fullSize); // rebuilt from the live db

    const copy = new Database(dest, { readonly: true });
    try {
      expect(copy.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      copy.close();
    }
  });

  it("never leaves a .partial file behind after a failed copy", async () => {
    const day = "2026-08-29";
    const failingStore: StorePort = {
      ...store,
      copyDatabaseTo: async () => {
        throw new Error("disk full");
      },
    };

    await expect(ensureDailyBackup({ store: failingStore, dataDir: dir, today: day })).rejects.toThrow("disk full");

    const leftovers = fs.readdirSync(backupDirFor(dir)).filter((f) => f.includes(".partial"));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(backupFilePath(dir, day))).toBe(false);
  });

  it("keeps one file per distinct day", async () => {
    await ensureDailyBackup({ store, dataDir: dir, today: "2026-08-26" });
    await ensureDailyBackup({ store, dataDir: dir, today: "2026-08-27" });
    const days = fs.readdirSync(backupDirFor(dir)).filter((f) => /^dokan-2026-08-2[67]\.db$/.test(f));
    expect(days.sort()).toEqual(["dokan-2026-08-26.db", "dokan-2026-08-27.db"]);
  });
});
