import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { assertSchemaVersionSupported, CURRENT_SCHEMA_VERSION, readSchemaVersion, UnsupportedSchemaVersionError } from "../lib/schema-version";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

let dir: string;
let conn: Connection;
let store: StorePort;
const expenseId = randomUUID();
const categoryId = randomUUID();
const correctionId = randomUUID();
const actorId = randomUUID();
const legacyCorrectionKey = randomUUID();
let legacyCorrectionRows: unknown[];
const configFor = () => createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") });
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-refund-v8-"));
  conn = openConnection(configFor());
  // A real v8 expense/correction fixture; migration must not rewrite its audit facts.
  conn.raw.exec(`
    CREATE TABLE expense_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_owner_withdrawal INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE expenses (id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES expense_categories(id), amount INTEGER NOT NULL, note TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT);
    CREATE TABLE expense_corrections (id TEXT PRIMARY KEY, expense_id TEXT NOT NULL REFERENCES expenses(id), effective_at TEXT NOT NULL, recorded_at TEXT NOT NULL, before_amount INTEGER NOT NULL, after_amount INTEGER NOT NULL, difference INTEGER NOT NULL, actor_id TEXT, actor_name TEXT, reason TEXT, idempotency_key TEXT NOT NULL, reverses_correction_id TEXT);
    INSERT INTO expense_categories VALUES ('${categoryId}', 'v8 rent', 0, '2019-01-01T00:00:00', '2019-01-01T00:00:00');
    INSERT INTO expenses VALUES ('${expenseId}', '${categoryId}', 1000, 'legacy', '2019-01-15T10:00:00', '2019-01-16T11:00:00', NULL, NULL);
    INSERT INTO expense_corrections VALUES ('${correctionId}', '${expenseId}', '2019-01-15T10:00:00', '2026-10-28T13:00:00', 1000, 800, -200, '${actorId}', 'Owner', 'legacy reason', '${legacyCorrectionKey}', NULL);
    PRAGMA user_version = 8;
  `);
  legacyCorrectionRows = conn.raw.query("SELECT * FROM expense_corrections").all();
  store = createDrizzleStore(conn);
  await store.setup();
});
afterAll(() => {
  conn.close();
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Bun.sleepSync(50); }
  }
});

describe("expense refund storage (#409)", () => {
  const request = () => ({ expenseId, difference: -300, occurredAt: "2019-02-12T10:00:00", recordedAt: "2026-10-28T13:34:56", actorId, actorName: "Owner", reason: null, reversesRefundId: null, idempotencyKey: randomUUID() });

  it("migrates v8 without changing corrections and preserves refund identities across reopen", async () => {
    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => assertSchemaVersionSupported(conn.raw, 8)).toThrow(UnsupportedSchemaVersionError);
    const before = await store.getExpenseCorrectionHistory(expenseId);
    expect(before).toMatchObject({ original: { amount: 1000, actorId: null, actorName: null, occurredAt: "2019-01-15T10:00:00", createdAt: "2019-01-16T11:00:00" }, effectiveAmount: 800 });
    expect(conn.raw.query("SELECT * FROM expense_corrections").all()).toEqual(legacyCorrectionRows);
    expect(before?.corrections[0]).toEqual({
      id: correctionId, expenseId, effectiveAt: "2019-01-15T10:00:00", recordedAt: "2026-10-28T13:00:00",
      beforeAmount: 1000, afterAmount: 800, difference: -200, actorId, actorName: "Owner",
      reason: "legacy reason", reversesCorrectionId: null, reversedByCorrectionId: null,
    });
    const legacyRetry = await store.findExpenseCorrectionByIdempotencyKey(expenseId, legacyCorrectionKey);
    expect(legacyRetry).toMatchObject({ id: correctionId, reason: "legacy reason", actorId });
    const input = request();
    const refund = await store.withTransactionImmediate((tx) => tx.insertExpenseRefund(input));
    const history = await store.getExpenseRefundHistory(expenseId);
    expect(history?.refundableAmount).toBe(500);
    expect(history?.expense).toEqual(before);
    expect(await store.listExpenseReportEntries({ from: "2019-02-01T00:00:00", to: "2019-02-28T23:59:59" })).toEqual([{ categoryId, amount: -300, occurredAt: input.occurredAt, expenseCount: 0 }]);
    conn.close();
    conn = openConnection(configFor());
    store = createDrizzleStore(conn);
    await store.setup();
    await store.setup();
    expect(await store.getExpenseRefundHistory(expenseId)).toEqual(history);
    expect(await store.findExpenseRefundByIdempotencyKey(expenseId, input.idempotencyKey)).toEqual(refund);
    expect(await store.getExpenseCorrectionHistory(expenseId)).toEqual(before);
    expect(conn.raw.query("SELECT * FROM expense_corrections").all()).toEqual(legacyCorrectionRows);
    expect(await store.findExpenseCorrectionByIdempotencyKey(expenseId, legacyCorrectionKey)).toEqual(legacyRetry);
  });

  it("limits competing refunds across independent database connections", async () => {
    const original = await store.insertExpense({ categoryId, amount: 1000, occurredAt: "2019-06-01T10:00:00" });
    const program = `
      import { createAppConfig } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../config.ts")).href)};
      import { openConnection } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../db/connection.ts")).href)};
      import { createDrizzleStore } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "./drizzle-store.ts")).href)};
      const conn = openConnection(createAppConfig(${JSON.stringify({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") })}));
      const store = createDrizzleStore(conn);
      try {
        await store.withTransactionImmediate(async (tx) => {
          await Bun.sleep(150);
          await tx.insertExpenseRefund(${JSON.stringify({ ...request(), expenseId: original.id, difference: -700 })});
        });
        console.log("saved");
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      } finally { conn.close(); }
    `;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", program], { stdout: "pipe", stderr: "pipe" }));
    const outcomes = await Promise.all(children.map(async (child) => {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      return stdout.trim();
    }));
    expect(outcomes.sort()).toEqual(["EXPENSE_REFUND_EXCEEDS_BALANCE", "saved"]);
    const history = await store.getExpenseRefundHistory(original.id);
    expect(history?.refundableAmount).toBe(300);
    expect(history?.refunds).toHaveLength(1);
  });

  it("refuses unlocked, excessive, malformed and cross-expense compensation writes atomically", async () => {
    const original = await store.insertExpense({ categoryId, amount: 800, occurredAt: "2019-01-01T00:00:00" });
    expect(store).toHaveProperty("insertExpenseRefund", expect.any(Function));
    const ownRequest = () => ({ ...request(), expenseId: original.id });
    const prior = await store.withTransactionImmediate((tx) => tx.insertExpenseRefund(ownRequest()));
    const before = await store.getExpenseRefundHistory(original.id);
    expect(before?.refundableAmount).toBe(500);
    await expect(store.insertExpenseRefund(ownRequest())).rejects.toThrow("require an immediate transaction");
    for (const change of [{ difference: -501 }, { difference: 1 }, { difference: 0 }, { difference: -1.5 }, { occurredAt: "2019-02-31T00:00:00" }, { reversesRefundId: randomUUID(), difference: 300 }]) {
      await expect(store.withTransactionImmediate((tx) => tx.insertExpenseRefund({ ...ownRequest(), ...change }))).rejects.toThrow();
      expect(await store.getExpenseRefundHistory(original.id)).toEqual(before);
    }
    const other = await store.insertExpense({ categoryId, amount: 1000, occurredAt: "2019-01-01T00:00:00" });
    await store.withTransactionImmediate((tx) => tx.insertExpenseRefund({ ...request(), expenseId: other.id }));
    const otherBefore = await store.getExpenseRefundHistory(other.id);
    expect(otherBefore?.refundableAmount).toBe(700);
    // Positive 300 fits this balance; only the foreign reversal link must reject it.
    await expect(store.withTransactionImmediate((tx) => tx.insertExpenseRefund({ ...request(), expenseId: other.id, difference: 300, reversesRefundId: prior.id }))).rejects.toThrow("invalid expense refund reversal link");
    expect(await store.getExpenseRefundHistory(original.id)).toEqual(before);
    expect(await store.getExpenseRefundHistory(other.id)).toEqual(otherBefore);
    await expect(store.withTransactionImmediate(async (tx) => {
      await tx.insertExpenseRefund(ownRequest());
      throw new Error("simulated failure after insertion");
    })).rejects.toThrow("simulated failure");
    expect(await store.getExpenseRefundHistory(original.id)).toEqual(before);
  });
});
