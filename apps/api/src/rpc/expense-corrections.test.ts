import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { AUTH_REFUSAL, type DokanClient } from "@dokan/contracts";

import { createApp } from "../app";
import { createAuth, type BetterAuthInstance } from "../auth/auth";
import { createAppConfig, type AppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { AppLogger } from "../lib/logger";
import { ensureSessionSecret } from "../lib/session-secret";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";
import { createRpcRouter } from "./router";

let dir: string;
let conn: Connection;
let store: StorePort;
let config: AppConfig;
let logger: AppLogger;
let auth: BetterAuthInstance;
let client: DokanClient;
let anonymousClient: DokanClient;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-expense-correction-"));
  config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: path.join(dir, "test.db"),
  });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
  logger = new AppLogger(dir);
  auth = createAuth(conn.db, config, await ensureSessionSecret(store));
  const app = createApp({
    config,
    logger,
    auth,
    rpcRouter: createRpcRouter({ db: conn.db, config, logger, store, auth, now: () => new Date("2026-10-28T12:34:56Z") }),
  });

  const linkWith = (cookieToSend: string) =>
    new RPCLink({
      url: () => `http://127.0.0.1:${config.port}/api/rpc`,
      fetch: (request) => {
        const headers = Object.fromEntries(request.headers.entries());
        if (cookieToSend !== "") headers.cookie = cookieToSend;
        return Promise.resolve(app.fetch(new Request(request, { headers })));
      },
    });

  const setupClient: DokanClient = createORPCClient(linkWith(""));
  await setupClient.firstTimeSetup({
    ownerName: "مالك التصحيحات",
    phoneNumber: "0550123123",
    password: "dokan-1234",
    storeName: "متجر التصحيحات",
  });
  const login = await auth.handler(
    new Request("http://localhost/api/auth/sign-in/username", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "213550123123", password: "dokan-1234" }),
    }),
  );
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie") ?? "";
  client = createORPCClient(linkWith(cookie));
  anonymousClient = createORPCClient(linkWith(""));
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

describe("expense corrections (#408)", () => {
  it("appends a signed correction without changing the original expense", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const businessWindow = { preset: "CUSTOM" as const, customFrom: "2020-01-01T00:00:00", customTo: "2020-01-31T23:59:59" };
    const recordingWindow = { preset: "CUSTOM" as const, customFrom: "2026-10-28T00:00:00", customTo: "2026-10-28T23:59:59" };
    const businessBefore = await client.reportsProfit(businessWindow);
    const recordingBefore = await client.reportsProfit(recordingWindow);
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-01-15T12:00:00",
      note: "تصحيح-408",
    });
    expect(original).toMatchObject({ amount: 1_000, occurredAt: "2020-01-15T12:00:00", actorName: "مالك التصحيحات" });
    expect(original.createdAt).not.toBe(original.occurredAt);
    expect(original.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u);

    const firstInput = {
      expenseId: original.id,
      amount: 800,
      idempotencyKey: "40800000-0000-4000-8000-000000000001",
      reason: "المبلغ الأصلي غير صحيح",
    };
    const first = await client.expensesCorrect(firstInput);
    const secondInput = {
      expenseId: original.id,
      amount: 900,
      idempotencyKey: "40800000-0000-4000-8000-000000000002",
      reason: "تعديل ثانٍ",
    };
    const [second, duplicateSecond] = await Promise.all([
      client.expensesCorrect(secondInput),
      client.expensesCorrect(secondInput),
    ]);

    expect(first).toMatchObject({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: original.actorId,
      actorName: "مالك التصحيحات",
      reason: "المبلغ الأصلي غير صحيح",
      reversesCorrectionId: null,
    });
    expect(second).toMatchObject({ beforeAmount: 800, afterAmount: 900, difference: 100 });
    expect(duplicateSecond.id).toBe(second.id);
    const replayedFirst = await client.expensesCorrect(firstInput);
    expect(replayedFirst.id).toBe(first.id);
    await expect(client.expensesCorrect({ ...secondInput, amount: 850 })).rejects.toThrow(
      /EXPENSE_CORRECTION_IDEMPOTENCY_KEY_REUSED/,
    );
    await expect(client.expensesCorrect({ ...secondInput, reason: "سبب مختلف" })).rejects.toThrow(
      /EXPENSE_CORRECTION_IDEMPOTENCY_KEY_REUSED/,
    );
    const afterMismatchedCorrectionReplay = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(afterMismatchedCorrectionReplay.corrections).toHaveLength(2);
    expect(afterMismatchedCorrectionReplay.corrections.map(({ id }) => id)).toEqual([first.id, second.id]);

    const undoInput = { correctionId: second.id, idempotencyKey: "40800000-0000-4000-8000-000000000003" };
    const undo = await client.expensesCorrectionUndo(undoInput);
    const duplicateUndo = await client.expensesCorrectionUndo(undoInput);
    expect(duplicateUndo.id).toBe(undo.id);
    const beforeUndoKeyMismatches = await client.expenseCorrectionHistory({ expenseId: original.id });
    await expect(client.expensesCorrectionUndo({ correctionId: first.id, idempotencyKey: undoInput.idempotencyKey })).rejects.toThrow(
      /EXPENSE_CORRECTION_IDEMPOTENCY_KEY_REUSED/,
    );
    await expect(client.expensesCorrectionUndo({ correctionId: first.id, idempotencyKey: firstInput.idempotencyKey })).rejects.toThrow(
      /EXPENSE_CORRECTION_IDEMPOTENCY_KEY_REUSED/,
    );
    const afterUndoKeyMismatches = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(afterUndoKeyMismatches.corrections).toEqual(beforeUndoKeyMismatches.corrections);
    expect(undo).toMatchObject({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      beforeAmount: 900,
      afterAmount: 800,
      difference: -100,
      reversesCorrectionId: second.id,
      actorId: original.actorId,
      actorName: "مالك التصحيحات",
    });

    const history = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(history.original.amount).toBe(1_000);
    expect(history.effectiveAmount).toBe(800);
    expect(history.corrections.map(({ beforeAmount, afterAmount, difference }) => ({ beforeAmount, afterAmount, difference }))).toEqual([
      { beforeAmount: 1_000, afterAmount: 800, difference: -200 },
      { beforeAmount: 800, afterAmount: 900, difference: 100 },
      { beforeAmount: 900, afterAmount: 800, difference: -100 },
    ]);
    expect(history.corrections[1]?.reversedByCorrectionId).toBe(undo.id);
    expect(history.corrections[0]?.recordedAt).toBe("2026-10-28T13:34:56");
    expect(history.corrections[0]?.effectiveAt).toBe(original.occurredAt);

    const expenseRows = await client.expensesList({ ...businessWindow, limit: 500 });
    const listedExpense = expenseRows.items.find((row) => row.id === original.id);
    expect(listedExpense).toMatchObject({ amount: 1_000, effectiveAmount: 800, correctionCount: 3 });
    const businessAfter = await client.reportsProfit(businessWindow);
    const recordingAfter = await client.reportsProfit(recordingWindow);
    expect(businessAfter.operatingExpenses - businessBefore.operatingExpenses).toBe(800);
    const countBefore = businessBefore.byCategory.find((row) => row.categoryId === category.id)?.count ?? 0;
    const countAfter = businessAfter.byCategory.find((row) => row.categoryId === category.id)?.count ?? 0;
    expect(countAfter - countBefore).toBe(1);
    expect(recordingAfter.operatingExpenses - recordingBefore.operatingExpenses).toBe(0);
  });

  it("undoes a non-latest correction against current effective money", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-03-15T12:00:00",
    });
    const first = await client.expensesCorrect({ expenseId: original.id, amount: 800, idempotencyKey: randomUUID() });
    await client.expensesCorrect({ expenseId: original.id, amount: 900, idempotencyKey: randomUUID() });

    const undo = await client.expensesCorrectionUndo({ correctionId: first.id, idempotencyKey: randomUUID() });
    const history = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(undo).toMatchObject({ beforeAmount: 900, afterAmount: 1_100, difference: 200, reversesCorrectionId: first.id });
    expect(history.effectiveAmount).toBe(1_100);
    expect(history.corrections).toHaveLength(3);
    expect(history.corrections[0]?.reversedByCorrectionId).toBe(undo.id);
    expect(history.corrections[1]?.reversedByCorrectionId).toBeNull();
  });

  it("refuses no-op, unauthenticated, reused, and out-of-range corrections without losing history", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-02-15T12:00:00",
    });

    await expect(
      anonymousClient.expensesCorrect({ expenseId: original.id, amount: 800, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(AUTH_REFUSAL.message);
    await expect(client.expensesCorrect({ expenseId: original.id, amount: 1_000, idempotencyKey: randomUUID() })).rejects.toThrow(
      /EXPENSE_CORRECTION_NO_CHANGE/,
    );
    await expect(client.expensesCorrectionUndo({ correctionId: randomUUID(), idempotencyKey: randomUUID() })).rejects.toThrow(
      /EXPENSE_CORRECTION_NOT_FOUND/,
    );

    const first = await client.expensesCorrect({
      expenseId: original.id,
      amount: 1,
      idempotencyKey: randomUUID(),
    });
    const second = await client.expensesCorrect({
      expenseId: original.id,
      amount: 1_000_000_000_000,
      idempotencyKey: randomUUID(),
    });
    const historyBeforeOverflowUndo = await client.expenseCorrectionHistory({ expenseId: original.id });
    await expect(client.expensesCorrectionUndo({ correctionId: first.id, idempotencyKey: randomUUID() })).rejects.toThrow(
      /EXPENSE_CORRECTION_UNDO_OUT_OF_RANGE/,
    );
    const historyAfterOverflowUndo = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(historyAfterOverflowUndo.effectiveAmount).toBe(historyBeforeOverflowUndo.effectiveAmount);
    expect(historyAfterOverflowUndo.corrections).toEqual(historyBeforeOverflowUndo.corrections);

    const historyBeforeValidUndo = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(historyBeforeValidUndo.corrections).toHaveLength(2);
    expect(historyBeforeValidUndo.effectiveAmount).toBe(1_000_000_000_000);

    const undoInput = { correctionId: second.id, idempotencyKey: randomUUID() };
    const undo = await client.expensesCorrectionUndo(undoInput);
    await expect(
      client.expensesCorrectionUndo({ correctionId: second.id, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/EXPENSE_CORRECTION_ALREADY_REVERSED/);
    expect(undo.afterAmount).toBe(1);
    const finalHistory = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(finalHistory.corrections).toHaveLength(3);
    expect(finalHistory.corrections[0]?.reversedByCorrectionId).toBeNull();
    expect(finalHistory.corrections[1]?.reversedByCorrectionId).toBe(undo.id);
  });
});
