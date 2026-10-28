import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { assertSchemaVersionSupported, readSchemaVersion, UnsupportedSchemaVersionError } from "../lib/schema-version";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

let dir: string;
let conn: Connection;
let store: StorePort;
let expenseId: string;
let categoryId: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-expense-correction-migration-"));
  const config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: path.join(dir, "test.db"),
  });
  conn = openConnection(config);
  categoryId = randomUUID();
  expenseId = randomUUID();
  conn.raw.exec(`
    CREATE TABLE expense_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_owner_withdrawal INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO expense_categories (id, name, created_at, updated_at)
    VALUES ('${categoryId}', 'Legacy category', '2019-12-01T00:00:00', '2019-12-01T00:00:00');
    CREATE TABLE expenses (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES expense_categories(id),
      amount INTEGER NOT NULL CHECK (amount > 0),
      note TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO expenses (id, category_id, amount, note, occurred_at, created_at)
    VALUES ('${expenseId}', '${categoryId}', 1000, 'legacy row', '2019-12-15T10:00:00', '2019-12-16T11:00:00');
    PRAGMA user_version = 7;
  `);
  store = createDrizzleStore(conn);
  await store.setup();
}, 30_000);

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

describe("expense correction storage (#408)", () => {
  it("upgrades v7 without inventing legacy actor facts or rewriting expense dates", async () => {
    expect(readSchemaVersion(conn.raw)).toBe(8);
    const original = (await store.listExpenseRecords({})).find((row) => row.id === expenseId);
    expect(original).toMatchObject({
      amount: 1_000,
      occurredAt: "2019-12-15T10:00:00",
      createdAt: "2019-12-16T11:00:00",
      actorId: null,
      actorName: null,
    });
    // SAFETY: SQLite PRAGMA table_info returns a row with `name` for each column; this test reads those names to pin the migration.
    const columns = conn.raw.query("PRAGMA table_info(expenses)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain("actor_id");
    expect(columns.map(({ name }) => name)).toContain("actor_name");
    expect(() => assertSchemaVersionSupported(conn.raw, 7)).toThrow(UnsupportedSchemaVersionError);
    await store.setup();
    expect(readSchemaVersion(conn.raw)).toBe(8);
    expect((await store.getExpenseCorrectionHistory(expenseId))?.corrections).toEqual([]);
  });

  it("appends a linked signed row inside an immediate transaction and refuses stale or unlocked writes", async () => {
    expect(readSchemaVersion(conn.raw)).toBe(8);
    const first = await store.withTransactionImmediate((tx) =>
      tx.insertExpenseCorrection({
        expenseId,
        effectiveAt: "2019-12-15T10:00:00",
        recordedAt: "2026-10-28T13:34:56",
        beforeAmount: 1_000,
        afterAmount: 800,
        difference: -200,
        actorId: null,
        actorName: null,
        reason: "legacy amount corrected",
        reversesCorrectionId: null,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(first).toMatchObject({ beforeAmount: 1_000, afterAmount: 800, difference: -200, actorId: null, actorName: null });
    const history = await store.getExpenseCorrectionHistory(expenseId);
    expect(history).toMatchObject({ original: { amount: 1_000 }, effectiveAmount: 800 });
    expect(history?.corrections).toHaveLength(1);

    await expect(
      store.insertExpenseCorrection({
        expenseId,
        effectiveAt: "2019-12-15T10:00:00",
        recordedAt: "2026-10-28T13:35:00",
        beforeAmount: 800,
        afterAmount: 700,
        difference: -100,
        actorId: null,
        actorName: null,
        reason: null,
        reversesCorrectionId: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("immediate transaction");
    await expect(
      store.withTransactionImmediate((tx) =>
        tx.insertExpenseCorrection({
          expenseId,
          effectiveAt: "2019-12-15T10:00:00",
          recordedAt: "2026-10-28T13:35:00",
          beforeAmount: 700,
          afterAmount: 600,
          difference: -100,
          actorId: null,
          actorName: null,
          reason: null,
          reversesCorrectionId: null,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow("current expense state");
    expect((await store.getExpenseCorrectionHistory(expenseId))?.effectiveAmount).toBe(800);
  });
});
