import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { type DokanClient } from "@dokan/contracts";

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


describe("expense refunds (#409)", () => {
  async function originalExpense(amount = 1000) {
    const category = (await client.expenseCategoriesList()).items.find((row) => !row.isOwnerWithdrawal);
    if (category === undefined) throw new Error("missing operating category");
    return client.expensesCreate({ categoryId: category.id, amount, occurredAt: "2018-01-15T12:00:00" });
  }

  it("counts original expenses, not refund or compensation entries, including refunds-only withdrawal periods", async () => {
    const categories = (await client.expenseCategoriesList()).items;
    for (const withdrawal of [false, true]) {
      const category = categories.find((row) => row.isOwnerWithdrawal === withdrawal);
      if (category === undefined) throw new Error("missing category");
      const original = await client.expensesCreate({ categoryId: category.id, amount: 1000, occurredAt: "2016-01-15T12:00:00" });
      const refund = await client.expensesRefund({ expenseId: original.id, amount: 300, occurredAt: "2016-02-12T10:00:00", idempotencyKey: randomUUID() });
      const refundPeriod = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2016-02-01T00:00:00", customTo: "2016-02-29T23:59:59" });
      expect(refundPeriod.byCategory.find((row) => row.categoryId === category.id)).toMatchObject({ total: -300, count: 0 });
      await client.expensesRefundUndo({ refundId: refund.id, idempotencyKey: randomUUID() });
      const combined = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2016-01-01T00:00:00", customTo: "2016-02-29T23:59:59" });
      expect(combined.byCategory.find((row) => row.categoryId === category.id)).toMatchObject({ total: 1000, count: 1 });
    }
  });

  it("serializes competing refunds and deduplicates identical concurrent retries", async () => {
    const original = await originalExpense();
    const input = { expenseId: original.id, amount: 700, occurredAt: "2018-02-01T09:00:00", idempotencyKey: randomUUID() };
    const [first, retry] = await Promise.all([client.expensesRefund(input), client.expensesRefund(input)]);
    expect(first).toEqual(retry);
    const attempts = await Promise.allSettled([200, 200].map((amount) => client.expensesRefund({ ...input, amount, idempotencyKey: randomUUID() })));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const history = await client.expenseRefundHistory({ expenseId: original.id });
    expect(history.refundableAmount).toBe(100);
    expect(history.refunds).toHaveLength(2);
    await expect(client.expensesRefund({ ...input, amount: 101, idempotencyKey: randomUUID() })).rejects.toThrow("EXPENSE_REFUND_EXCEEDS_BALANCE");
    expect(await client.expenseRefundHistory({ expenseId: original.id })).toEqual(history);
    for (const change of [{ amount: 701 }, { occurredAt: "2018-02-02T09:00:00" }, { reason: "different" }]) {
      await expect(client.expensesRefund({ ...input, ...change })).rejects.toThrow("EXPENSE_REFUND_KEY_REUSED");
    }
    expect(await client.expenseRefundHistory({ expenseId: original.id })).toEqual(history);
  });

  it("preserves compensation chains and refuses corrections below outstanding recoveries", async () => {
    const original = await originalExpense();
    const correction = await client.expensesCorrect({ expenseId: original.id, amount: 1200, idempotencyKey: randomUUID() });
    const refund = await client.expensesRefund({ expenseId: original.id, amount: 1100, occurredAt: "2018-03-15T09:00:00", idempotencyKey: randomUUID() });
    await expect(client.expensesCorrect({ expenseId: original.id, amount: 1099, idempotencyKey: randomUUID() })).rejects.toThrow("EXPENSE_CORRECTION_BELOW_REFUNDED");
    await expect(client.expensesCorrectionUndo({ correctionId: correction.id, idempotencyKey: randomUUID() })).rejects.toThrow("EXPENSE_CORRECTION_BELOW_REFUNDED");
    const undoInput = { refundId: refund.id, idempotencyKey: randomUUID() };
    const [compensation, retried] = await Promise.all([client.expensesRefundUndo(undoInput), client.expensesRefundUndo(undoInput)]);
    expect(retried).toEqual(compensation);
    expect(compensation).toMatchObject({ reversesRefundId: refund.id, difference: 1100, occurredAt: refund.occurredAt });
    await expect(client.expensesRefundUndo({ ...undoInput, idempotencyKey: randomUUID() })).rejects.toThrow("EXPENSE_REFUND_ALREADY_REVERSED");
    const redo = await client.expensesRefundUndo({ refundId: compensation.id, idempotencyKey: randomUUID() });
    expect(redo).toMatchObject({ reversesRefundId: compensation.id, difference: -1100 });
    const history = await client.expenseRefundHistory({ expenseId: original.id });
    expect(history.refundableAmount).toBe(100);
    expect(history.refunds.map((row) => [row.id, row.reversedByRefundId])).toEqual([[refund.id, compensation.id], [compensation.id, redo.id], [redo.id, null]]);
    expect(history.expense.original).toEqual(original);
    expect(history.expense.corrections).toHaveLength(1);
    const period = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2018-03-01T00:00:00", customTo: "2018-03-31T23:59:59" });
    expect(period.operatingExpenses).toBe(-1100);
  });

  it("refuses redo when later refunds exhausted the balance and persists no partial entry", async () => {
    const original = await originalExpense();
    const refund = await client.expensesRefund({ expenseId: original.id, amount: 1000, occurredAt: "2018-04-01T09:00:00", idempotencyKey: randomUUID() });
    const compensation = await client.expensesRefundUndo({ refundId: refund.id, idempotencyKey: randomUUID() });
    await client.expensesRefund({ expenseId: original.id, amount: 1, occurredAt: "2018-04-02T09:00:00", idempotencyKey: randomUUID() });
    const before = await client.expenseRefundHistory({ expenseId: original.id });
    await expect(client.expensesRefundUndo({ refundId: compensation.id, idempotencyKey: randomUUID() })).rejects.toThrow("EXPENSE_REFUND_EXCEEDS_BALANCE");
    expect(await client.expenseRefundHistory({ expenseId: original.id })).toEqual(before);
  });

  it("rejects unauthenticated writes/reads and invalid inputs without adding records", async () => {
    const original = await originalExpense();
    const input = { expenseId: original.id, amount: 200, occurredAt: "2018-05-01T09:00:00", idempotencyKey: randomUUID() };
    const before = await client.expenseRefundHistory({ expenseId: original.id });
    await expect(anonymousClient.expensesRefund(input)).rejects.toThrow();
    await expect(anonymousClient.expenseRefundHistory({ expenseId: original.id })).rejects.toThrow();
    await expect(anonymousClient.expensesRefundUndo({ refundId: randomUUID(), idempotencyKey: randomUUID() })).rejects.toThrow();
    for (const amount of [0, -1, 1.5, 1000000000001]) await expect(client.expensesRefund({ ...input, amount })).rejects.toThrow();
    await expect(client.expensesRefund({ ...input, occurredAt: "2018-02-31T09:00:00" })).rejects.toThrow();
    await expect(client.expensesRefund({ ...input, expenseId: randomUUID() })).rejects.toThrow("EXPENSE_NOT_FOUND");
    expect(await client.expenseRefundHistory({ expenseId: original.id })).toEqual(before);
  });

  it("posts an immutable cash recovery after corrections, on its cash date, once", async () => {
    const category = (await client.expenseCategoriesList()).items[0];
    if (category === undefined) throw new Error("missing seeded category");
    const original = await client.expensesCreate({ categoryId: category.id, amount: 1000, occurredAt: "2020-01-15T12:00:00" });
    await client.expensesCorrect({ expenseId: original.id, amount: 800, idempotencyKey: randomUUID() });
    await client.expensesCorrect({ expenseId: original.id, amount: 900, idempotencyKey: randomUUID() });
    const input = { expenseId: original.id, amount: 300, occurredAt: "2020-02-12T10:00:00", reason: "cash returned", idempotencyKey: randomUUID() };
    const refund = await client.expensesRefund(input);
    expect(refund).toMatchObject({ expenseId: original.id, difference: -300, occurredAt: input.occurredAt, recordedAt: "2026-10-28T13:34:56", actorId: original.actorId, actorName: original.actorName, reason: "cash returned", reversesRefundId: null });
    expect(await client.expensesRefund(input)).toEqual(refund);
    const history = await client.expenseRefundHistory({ expenseId: original.id });
    expect(history).toMatchObject({ expense: { original, effectiveAmount: 900 }, refundableAmount: 600 });
    expect(history.expense.corrections).toHaveLength(2);
    expect(history.refunds).toHaveLength(1);
    const feb = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-02-01T00:00:00", customTo: "2020-02-29T23:59:59" });
    expect(feb.operatingExpenses).toBe(-300);
    expect(feb.resultAfterExpenses).toBe(300);
    await client.expensesRefund({ ...input, amount: 600, idempotencyKey: randomUUID() });
    const finalHistory = await client.expenseRefundHistory({ expenseId: original.id });
    expect(finalHistory.refundableAmount).toBe(0);
    expect(finalHistory.refunds).toHaveLength(2);
    expect(finalHistory.expense).toEqual(history.expense);
    const jan = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-01-01T00:00:00", customTo: "2020-01-31T23:59:59" });
    expect(jan.operatingExpenses).toBe(900);
    const recovered = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-02-01T00:00:00", customTo: "2020-02-29T23:59:59" });
    expect(recovered.operatingExpenses).toBe(-900);
    expect(recovered.byCategory.find((row) => row.categoryId === category.id)?.count).toBe(0);
  });
});
