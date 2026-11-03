import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { AUTH_REFUSAL, MAX_EXPENSE_AMOUNT, type DokanClient, type Expense } from "@dokan/contracts";

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

  // red-on-parent-waive: "undoes a non-latest correction against current effective money and reconciles SQL projections" — parent lacks the expense actor snapshot fields, so expensesCreate cannot satisfy this feature test's actorName pin before it reaches the new correction RPCs.
  it("undoes a non-latest correction against current effective money and reconciles SQL projections", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const businessWindow = { preset: "CUSTOM" as const, customFrom: "2020-03-01T00:00:00", customTo: "2020-03-31T23:59:59" };
    const recordingWindow = { preset: "CUSTOM" as const, customFrom: "2026-10-28T00:00:00", customTo: "2026-10-28T23:59:59" };
    const businessBefore = await client.reportsProfit(businessWindow);
    const recordingBefore = await client.reportsProfit(recordingWindow);
    const categoryBefore = businessBefore.byCategory.find((row) => row.categoryId === category.id);
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-03-15T12:00:00",
    });

    const verifyProjection = async (effectiveAmount: number, correctionCount: number) => {
      const rows = await client.expensesList({ ...businessWindow, limit: 500 });
      const listed = rows.items.find((row) => row.id === original.id);
      expect(listed).toMatchObject({ amount: 1_000, effectiveAmount, correctionCount });
      const report = await client.reportsProfit(businessWindow);
      expect(report.operatingExpenses - businessBefore.operatingExpenses).toBe(effectiveAmount);
      expect(report.resultAfterExpenses).toBe(report.revenue - report.cogs - report.operatingExpenses - report.ownerWithdrawals);
      expect(report.byCategory.find((row) => row.categoryId === category.id)).toMatchObject({
        total: (categoryBefore?.total ?? 0) + effectiveAmount,
        count: (categoryBefore?.count ?? 0) + 1,
      });
      expect(report.byCategory.reduce((sum, row) => sum + row.total, 0)).toBe(report.operatingExpenses + report.ownerWithdrawals);
      const recordingAfter = await client.reportsProfit(recordingWindow);
      expect(recordingAfter.operatingExpenses - recordingBefore.operatingExpenses).toBe(0);
    };

    const first = await client.expensesCorrect({ expenseId: original.id, amount: 800, idempotencyKey: randomUUID() });
    await verifyProjection(800, 1);
    await client.expensesCorrect({ expenseId: original.id, amount: 900, idempotencyKey: randomUUID() });
    await verifyProjection(900, 2);
    const undo = await client.expensesCorrectionUndo({ correctionId: first.id, idempotencyKey: randomUUID() });
    const history = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(undo).toMatchObject({ beforeAmount: 900, afterAmount: 1_100, difference: 200, reversesCorrectionId: first.id });
    expect(history.effectiveAmount).toBe(1_100);
    expect(history.corrections).toHaveLength(3);
    expect(history.corrections[0]?.reversedByCorrectionId).toBe(undo.id);
    expect(history.corrections[1]?.reversedByCorrectionId).toBeNull();
    await verifyProjection(1_100, 3);
  });

  // red-on-parent-waive: "serializes distinct concurrent corrections into one effective amount chain" — parent lacks expense actor snapshot fields, so expensesCreate cannot satisfy this feature test's actorName pin before reaching the new correction RPCs.
  it("serializes distinct concurrent corrections into one effective amount chain", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const window = { preset: "CUSTOM" as const, customFrom: "2020-08-01T00:00:00", customTo: "2020-08-31T23:59:59" };
    const reportBefore = await client.reportsProfit(window);
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-08-15T12:00:00",
    });
    const [toward800, toward900] = await Promise.all([
      client.expensesCorrect({ expenseId: original.id, amount: 800, idempotencyKey: randomUUID() }),
      client.expensesCorrect({ expenseId: original.id, amount: 900, idempotencyKey: randomUUID() }),
    ]);
    const history = await client.expenseCorrectionHistory({ expenseId: original.id });

    expect(history.corrections).toHaveLength(2);
    expect(history.corrections.map(({ id }) => id).sort()).toEqual([toward800.id, toward900.id].sort());
    const first = history.corrections.find((event) => event.beforeAmount === original.amount);
    if (first === undefined) throw new Error("concurrent corrections have no initial transition");
    const second = history.corrections.find((event) => event.beforeAmount === first.afterAmount);
    if (second === undefined) throw new Error("concurrent corrections do not form a continuous chain");
    expect([800, 900]).toContain(first.afterAmount);
    expect([800, 900]).toContain(second.afterAmount);
    expect(second.afterAmount).not.toBe(first.afterAmount);
    expect(second.afterAmount).toBe(history.effectiveAmount);

    const listed = (await client.expensesList({ ...window, limit: 500 })).items.find((row) => row.id === original.id);
    expect(listed).toMatchObject({ amount: original.amount, effectiveAmount: history.effectiveAmount, correctionCount: 2 });
    const reportAfter = await client.reportsProfit(window);
    expect(reportAfter.operatingExpenses - reportBefore.operatingExpenses).toBe(history.effectiveAmount);
  });

  // red-on-parent-waive: "refuses to undo a reversal without changing history" — parent lacks expense actor snapshot fields, so expensesCreate cannot satisfy this feature test's actorName pin before reaching the new undo/history RPCs.
  it("refuses to undo a reversal without changing history", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-09-15T12:00:00",
    });
    const correction = await client.expensesCorrect({ expenseId: original.id, amount: 800, idempotencyKey: randomUUID() });
    const reversal = await client.expensesCorrectionUndo({ correctionId: correction.id, idempotencyKey: randomUUID() });
    const before = await client.expenseCorrectionHistory({ expenseId: original.id });

    await expect(client.expensesCorrectionUndo({ correctionId: reversal.id, idempotencyKey: randomUUID() })).rejects.toThrow(
      /EXPENSE_CORRECTION_NOT_REVERSIBLE/,
    );
    expect(await client.expenseCorrectionHistory({ expenseId: original.id })).toEqual(before);
  });

  // red-on-parent-waive: "replays an undo key after a later correction without appending a reversal" — parent lacks expense actor snapshot fields, so expensesCreate cannot satisfy this feature test's actorName pin before reaching the new undo/history RPCs.
  it("replays an undo key after a later correction without appending a reversal", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-11-15T12:00:00",
    });
    const correction = await client.expensesCorrect({ expenseId: original.id, amount: 800, idempotencyKey: randomUUID() });
    const undoInput = { correctionId: correction.id, idempotencyKey: randomUUID() };
    const reversal = await client.expensesCorrectionUndo(undoInput);
    await client.expensesCorrect({ expenseId: original.id, amount: 900, idempotencyKey: randomUUID() });
    const beforeReplay = await client.expenseCorrectionHistory({ expenseId: original.id });

    expect(await client.expensesCorrectionUndo(undoInput)).toEqual(reversal);
    expect(await client.expenseCorrectionHistory({ expenseId: original.id })).toEqual(beforeReplay);
  });

  // red-on-parent-waive: "rejects invalid correction amounts without changing history" — parent lacks expense actor snapshot fields, so expensesCreate cannot satisfy this feature test's actorName pin before reaching the new correction/history RPCs.
  it("rejects invalid correction amounts without changing history", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-12-15T12:00:00",
    });
    const before = await client.expenseCorrectionHistory({ expenseId: original.id });

    for (const amount of [0, -1, 1.5, MAX_EXPENSE_AMOUNT + 1]) {
      await expect(client.expensesCorrect({ expenseId: original.id, amount, idempotencyKey: randomUUID() })).rejects.toThrow();
      expect(await client.expenseCorrectionHistory({ expenseId: original.id })).toEqual(before);
    }
  });

  // red-on-parent-waive: "rejects an undo that would cross the lower expense bound without changing history" — parent lacks expense actor snapshot fields, so expensesCreate cannot satisfy this feature test's actorName pin before reaching the new undo/history RPCs.
  it("rejects an undo that would cross the lower expense bound without changing history", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-05-15T12:00:00",
    });
    const first = await client.expensesCorrect({ expenseId: original.id, amount: 1_200, idempotencyKey: randomUUID() });
    await client.expensesCorrect({ expenseId: original.id, amount: 200, idempotencyKey: randomUUID() });
    const before = await client.expenseCorrectionHistory({ expenseId: original.id });

    await expect(client.expensesCorrectionUndo({ correctionId: first.id, idempotencyKey: randomUUID() })).rejects.toThrow(
      /EXPENSE_CORRECTION_UNDO_OUT_OF_RANGE/,
    );
    const after = await client.expenseCorrectionHistory({ expenseId: original.id });
    expect(after).toEqual(before);
    expect(after.effectiveAmount).toBe(200);
    expect(after.corrections[0]?.reversedByCorrectionId).toBeNull();
  });

  // red-on-parent-waive: "keeps corrected owner withdrawals on inclusive SQL bounds and excludes adjacent rows" — parent lacks expense actor snapshot fields, so expensesCreate cannot satisfy this feature test's actorName pin before reaching the new correction RPCs.
  it("keeps corrected owner withdrawals on inclusive SQL bounds and excludes adjacent rows", async () => {
    const withdrawal = (await client.expenseCategoriesList()).items.find((row) => row.isOwnerWithdrawal);
    if (withdrawal === undefined) throw new Error("seeded withdrawal category is missing");
    const window = { preset: "CUSTOM" as const, customFrom: "2020-04-01T00:00:00", customTo: "2020-04-30T23:59:59" };
    const recordingWindow = { preset: "CUSTOM" as const, customFrom: "2026-10-28T00:00:00", customTo: "2026-10-28T23:59:59" };
    const reportBefore = await client.reportsProfit(window);
    const recordingBefore = await client.reportsProfit(recordingWindow);
    const withdrawalBefore = reportBefore.byCategory.find((row) => row.categoryId === withdrawal.id);
    const fixtures = [
      { amount: 100, correctedAmount: 150, occurredAt: "2020-04-01T00:00:00" },
      { amount: 200, correctedAmount: 250, occurredAt: "2020-04-30T23:59:59" },
      { amount: 300, correctedAmount: 350, occurredAt: "2020-03-31T23:59:59" },
      { amount: 400, correctedAmount: 450, occurredAt: "2020-05-01T00:00:00" },
    ] as const;
    const rows: Expense[] = [];
    for (const fixture of fixtures) {
      const original = await client.expensesCreate({ categoryId: withdrawal.id, amount: fixture.amount, occurredAt: fixture.occurredAt });
      await client.expensesCorrect({ expenseId: original.id, amount: fixture.correctedAmount, idempotencyKey: randomUUID() });
      rows.push(original);
    }

    const [startBoundaryRow, endBoundaryRow, beforeBoundaryRow, afterBoundaryRow] = rows;
    if (startBoundaryRow === undefined || endBoundaryRow === undefined || beforeBoundaryRow === undefined || afterBoundaryRow === undefined) {
      throw new Error("withdrawal boundary fixture is incomplete");
    }
    const listed = await client.expensesList({ ...window, categoryIds: [withdrawal.id], sortBy: "occurredAt", sortDir: "asc", limit: 500 });
    expect(listed.items).toHaveLength(2);
    expect(listed.items.map((row) => [row.id, row.effectiveAmount])).toEqual([
      [startBoundaryRow.id, 150],
      [endBoundaryRow.id, 250],
    ]);
    expect(listed.items.some((row) => row.id === beforeBoundaryRow.id || row.id === afterBoundaryRow.id)).toBe(false);
    const report = await client.reportsProfit(window);
    expect(report.ownerWithdrawals - reportBefore.ownerWithdrawals).toBe(400);
    expect(report.byCategory.find((row) => row.categoryId === withdrawal.id)).toMatchObject({
      total: (withdrawalBefore?.total ?? 0) + 400,
      count: (withdrawalBefore?.count ?? 0) + 2,
      isOwnerWithdrawal: true,
    });
    expect(report.byCategory.reduce((sum, row) => sum + row.total, 0)).toBe(report.operatingExpenses + report.ownerWithdrawals);
    const recordingAfter = await client.reportsProfit(recordingWindow);
    expect(recordingAfter.ownerWithdrawals - recordingBefore.ownerWithdrawals).toBe(0);
  });

  // red-on-parent-waive: "refuses a correction replay whose actor differs" — parent lacks expense actor snapshot fields, so expensesCreate cannot satisfy its actorName pin before reaching the new correction/history RPCs.
  it("refuses a correction replay whose actor differs", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({ categoryId: category.id, amount: 1_000, occurredAt: "2020-06-15T12:00:00" });
    const key = randomUUID();
    await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-27T12:00:00",
      beforeAmount: 1_000,
      afterAmount: 900,
      difference: -100,
      actorId: randomUUID(),
      actorName: "سجل المالك السابق",
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: key,
    }));
    const before = await client.expenseCorrectionHistory({ expenseId: original.id });

    await expect(client.expensesCorrect({ expenseId: original.id, amount: 900, idempotencyKey: key })).rejects.toThrow(
      /EXPENSE_CORRECTION_IDEMPOTENCY_KEY_REUSED/,
    );
    expect(await client.expenseCorrectionHistory({ expenseId: original.id })).toEqual(before);
  });

  // red-on-parent-waive: "refuses an undo replay whose actor differs" — parent lacks expense actor snapshot fields and the new correction/undo/history RPCs required by this actor-replay case.
  it("refuses an undo replay whose actor differs", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({ categoryId: category.id, amount: 1_000, occurredAt: "2020-06-16T12:00:00" });
    const priorActorId = randomUUID();
    const target = await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-27T12:00:00",
      beforeAmount: 1_000,
      afterAmount: 900,
      difference: -100,
      actorId: priorActorId,
      actorName: "سجل المالك السابق",
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }));
    const key = randomUUID();
    await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-27T12:01:00",
      beforeAmount: 900,
      afterAmount: 1_000,
      difference: 100,
      actorId: priorActorId,
      actorName: "سجل المالك السابق",
      reason: null,
      reversesCorrectionId: target.id,
      idempotencyKey: key,
    }));
    const before = await client.expenseCorrectionHistory({ expenseId: original.id });

    await expect(client.expensesCorrectionUndo({ correctionId: target.id, idempotencyKey: key })).rejects.toThrow(
      /EXPENSE_CORRECTION_IDEMPOTENCY_KEY_REUSED/,
    );
    expect(await client.expenseCorrectionHistory({ expenseId: original.id })).toEqual(before);
  });

  // red-on-parent-waive: "refuses an undo idempotency key reused as a correction" — parent lacks expense actor snapshot fields, so expensesCreate cannot satisfy this feature test's actorName pin before reaching the new undo/correction/history RPCs.
  it("refuses an undo idempotency key reused as a correction", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({ categoryId: category.id, amount: 1_000, occurredAt: "2020-07-15T12:00:00" });
    const target = await client.expensesCorrect({ expenseId: original.id, amount: 800, idempotencyKey: randomUUID() });
    const key = randomUUID();
    const undo = await client.expensesCorrectionUndo({ correctionId: target.id, idempotencyKey: key });
    const before = await client.expenseCorrectionHistory({ expenseId: original.id });

    await expect(client.expensesCorrect({ expenseId: original.id, amount: undo.afterAmount, idempotencyKey: key })).rejects.toThrow(
      /EXPENSE_CORRECTION_IDEMPOTENCY_KEY_REUSED/,
    );
    expect(await client.expenseCorrectionHistory({ expenseId: original.id })).toEqual(before);
  });

  // red-on-parent-waive: "refuses anonymous correction history reads and undo writes without changing history" — parent lacks the new correction, undo and history RPC endpoints this authorization test calls.
  it("refuses anonymous correction history reads and undo writes without changing history", async () => {
    const category = (await client.expenseCategoriesList()).items.find((row) => row.name === "كراء المحل");
    if (category === undefined) throw new Error("seeded rent category is missing");
    const original = await client.expensesCreate({
      categoryId: category.id,
      amount: 1_000,
      occurredAt: "2020-02-14T12:00:00",
    });
    const correction = await client.expensesCorrect({
      expenseId: original.id,
      amount: 800,
      idempotencyKey: randomUUID(),
    });
    const historyBefore = await client.expenseCorrectionHistory({ expenseId: original.id });

    let historyRefusal: { code?: string; message?: string } | null = null;
    try {
      await anonymousClient.expenseCorrectionHistory({ expenseId: original.id });
    } catch (error) {
      // SAFETY: oRPC rejections expose the server error code and message.
      historyRefusal = error as { code?: string; message?: string };
    }
    let undoRefusal: { code?: string; message?: string } | null = null;
    try {
      await anonymousClient.expensesCorrectionUndo({ correctionId: correction.id, idempotencyKey: randomUUID() });
    } catch (error) {
      // SAFETY: oRPC rejections expose the server error code and message.
      undoRefusal = error as { code?: string; message?: string };
    }
    expect(await client.expenseCorrectionHistory({ expenseId: original.id })).toEqual(historyBefore);
    expect(historyRefusal).toMatchObject({ code: AUTH_REFUSAL.code, message: AUTH_REFUSAL.message });
    expect(undoRefusal).toMatchObject({ code: AUTH_REFUSAL.code, message: AUTH_REFUSAL.message });
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
