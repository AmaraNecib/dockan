import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { eq } from "drizzle-orm";
import type { DokanClient, InvoiceDetail } from "@dokan/contracts";
import { createApp } from "../app";
import { createAuth, type BetterAuthInstance } from "../auth/auth";
import { createAppConfig, type AppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { accounts, stockMovements, users } from "../db/schema";
import { AppLogger } from "../lib/logger";
import { projectLedger } from "../lib/stock-ledger";
import { ensureSessionSecret } from "../lib/session-secret";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";
import { createRpcRouter } from "./router";

// Each case owns a real on-disk database. Reopening must exercise setup, auth
// and the same public RPC, not a copied in-memory projection.
let dir: string;
let config: AppConfig;
let conn: Connection;
let store: StorePort;
let auth: BetterAuthInstance;
let client: DokanClient;
let cookie: string;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected persisted fixture row");
  return value;
}

async function closeDatabase(): Promise<void> {
  // Drizzle prepares uncached statements. Strict close finalizes them before
  // Windows removes the file, including handles from pre-reopen connections.
  conn.raw.close(true);
  await conn.close();
}

async function connect(): Promise<void> {
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
  auth = createAuth(conn.db, config, await ensureSessionSecret(store));
}

function wire(sessionCookie: string): DokanClient {
  const app = createApp({ config, logger: new AppLogger(dir), auth, rpcRouter: createRpcRouter({ db: conn.db, config, logger: new AppLogger(dir), store, auth }) });
  return createORPCClient(new RPCLink({
    url: "http://127.0.0.1:4317/api/rpc",
    fetch: (request) => {
      const headers = new Headers(request.headers);
      if (sessionCookie !== "") headers.set("cookie", sessionCookie);
      return Promise.resolve(app.fetch(new Request(request, { headers })));
    },
  }));
}

async function login(username: string): Promise<string> {
  const response = await auth.handler(new Request("http://localhost/api/auth/sign-in/username", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "dokan-1234" }),
  }));
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-receipt-cost-"));
  config = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "receipt.db") });
  await connect();
  await wire("").firstTimeSetup({ ownerName: "Owner", phoneNumber: "0550123123", password: "dokan-1234", storeName: "Receipt proofs" });
  cookie = await login("213550123123");
  client = wire(cookie);
});

afterEach(async () => {
  await closeDatabase();
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await Bun.sleep(50);
    }
  }
});

const period = (day: string) => ({ preset: "CUSTOM" as const, customFrom: `${day}T00:00:00`, customTo: `${day}T23:59:59` });
const report = (day = "2026-01-11") => client.reportsProfit(period(day));
const resolve = (movementId: string, unitCost = 100, reason = "supplier invoice found") => client.receiptCostsResolve({ movementId, unitCost, reason });

async function item(name = "Receipt item") {
  const categories = await client.categoriesList();
  return client.itemsCreate({ name, categoryId: required(categories.items[0]).id, costPrice: 0, sellingPrice: 200, lowStockThreshold: 0 });
}

async function receipt(itemId: string, quantity = 5, unitCost?: number, occurredAt = "2026-01-10T10:00:00") {
  await client.stockAddManual({ itemId, kind: "PURCHASE", delta: quantity, ...(unitCost === undefined ? { costPending: true } : { unitCost }), occurredAt });
  return required((await store.listStockMovements(itemId)).at(-1));
}

const sell = (itemId: string, quantity = 2, invoiceDate = "2026-01-11") => client.invoicesCreate({ kind: "SALE", invoiceDate, lines: [{ itemId, quantity }] });

async function saved(itemId: string) {
  const catalog = required((await client.itemsAll()).items.find((row) => row.id === itemId));
  const cache = required((await store.getItemsByIds([itemId])).get(itemId));
  const movements = await store.listStockMovements(itemId);
  const projection = projectLedger(movements, { fallbackUnitCost: cache.costPrice });
  return { catalog, cache, movements, projection };
}

async function assertStock(itemId: string, quantity: number, fifoValue: number, average: number, pending = false) {
  const state = await saved(itemId);
  expect(state.catalog).toMatchObject({ stockOnHand: quantity, costPrice: average, costPending: pending });
  expect(state.cache).toMatchObject({ stockOnHand: quantity, costPrice: average });
  expect(state.projection.stockOnHand).toBe(quantity);
  expect(state.projection.layers.reduce((sum, layer) => sum + layer.quantity * (layer.unitCost ?? 0), 0)).toBe(fifoValue);
  expect(state.projection.layers.some((layer) => layer.costPending === true)).toBe(pending);
  expect((await client.itemsHistory({ itemId })).stockOnHand).toBe(quantity);
}

async function resolutionActivities(movementId: string) {
  return (await client.activitiesList({ limit: 500 })).items.filter((row) => row.type === "RECEIPT_COST_RESOLVED" && row.ref === movementId);
}

async function assertOriginal(sale: InvoiceDetail) {
  const byId = (lines: InvoiceDetail["lines"]) => [...lines].sort((a, b) => a.id.localeCompare(b.id));
  expect(byId((await client.invoicesGet({ id: sale.id })).lines)).toEqual(byId(sale.lines));
}

describe("persisted no-return receipt cost resolution", () => {
  it("refuses an authenticated non-owner directly at receiptCostsResolve", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const ownerId = await store.getSetting("adminUserId");
    const otherId = randomUUID();
    const [account] = await conn.db.select().from(accounts);
    await conn.db.insert(users).values({ id: otherId, name: "Not owner", username: "213660123123", createdAt: new Date(), updatedAt: new Date() });
    await conn.db.insert(accounts).values({ id: randomUUID(), userId: otherId, accountId: otherId, providerId: "credential", password: required(account).password, createdAt: new Date(), updatedAt: new Date() });
    const otherCookie = await login("213660123123");
    const session = await auth.api.getSession({ headers: new Headers({ cookie: otherCookie }) });
    expect(session?.user.id).toBe(otherId);
    expect(session?.user.id).not.toBe(ownerId);
    const before = await saved(product.id);
    await expect(wire(otherCookie).receiptCostsResolve({ movementId: source.id, unitCost: 100, reason: "not authorized" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(wire("").receiptCostsResolve({ movementId: source.id, unitCost: 100, reason: "no session" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await saved(product.id)).toEqual(before);
    expect(await resolutionActivities(source.id)).toEqual([]);
    expect((await resolve(source.id)).created).toBe(true);
  });

  it("refuses missing or known receipts, invalid costs and blank reasons without writes", async () => {
    const product = await item();
    const known = await receipt(product.id, 1, 0);
    const pending = await receipt(product.id);
    const before = await saved(product.id);
    await expect(resolve(randomUUID())).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RECEIPT_NOT_PENDING" });
    await expect(resolve(known.id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RECEIPT_NOT_PENDING" });
    for (const unitCost of [-1, 0.5, 1_000_000_001]) {
      await expect(resolve(pending.id, unitCost)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    for (const reason of ["", " \t\n ", "x".repeat(1001)]) {
      await expect(resolve(pending.id, 100, reason)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await saved(product.id)).toEqual(before);
    expect(await resolutionActivities(pending.id)).toEqual([]);
    expect((await resolve(pending.id, 100, "  invoice found  ")).reason).toBe("invoice found");
  });

  it("books exactly 200 in the original sale period and 300 remaining FIFO without changing invoice facts", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    const debts = await client.reportsDebts();
    const originalMovements = await store.listStockMovements(product.id);
    const originalReceipt = await conn.db.select().from(stockMovements).where(eq(stockMovements.id, source.id));
    expect(await report()).toMatchObject({ revenue: 400, cogs: 0, grossProfit: 400, provisional: true });
    const result = await resolve(source.id);
    expect(result.adjustments).toEqual([{ invoiceLineId: required(sale.lines[0]).id, amount: 200 }]);
    expect(await report()).toMatchObject({ revenue: 400, cogs: 200, grossProfit: 200, provisional: false });
    expect(await report(result.recordedAt.slice(0, 10))).toMatchObject({ revenue: 0, cogs: 0, grossProfit: 0, provisional: false });
    await assertStock(product.id, 3, 300, 100);
    await assertOriginal(sale);
    expect(await conn.db.select().from(stockMovements).where(eq(stockMovements.id, source.id))).toEqual(originalReceipt);
    expect(await client.reportsDebts()).toEqual(debts);
    expect((await store.listStockMovements(product.id)).map(({ unitCost: _unitCost, costPending: _costPending, receiptOriginalUnitCost: _receiptOriginalUnitCost, receiptOriginalCostPending: _receiptOriginalCostPending, receiptResolution: _receiptResolution, ...fact }) => fact)).toEqual(originalMovements.map(({ unitCost: _unitCost, costPending: _costPending, receiptOriginalUnitCost: _receiptOriginalUnitCost, receiptOriginalCostPending: _receiptOriginalCostPending, receiptResolution: _receiptResolution, ...fact }) => fact));
    const activities = await resolutionActivities(source.id);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ actorId: await store.getSetting("adminUserId"), actorName: "Owner" });
    const history = await client.itemsHistory({ itemId: product.id });
    expect(history.movements.find((movement) => movement.id === source.id)).toMatchObject({
      occurredAt: source.occurredAt,
      createdAt: source.createdAt,
      unitCost: 100,
      costPending: false,
      details: {
        receiptOriginalCost: { unitCost: null, costPending: true },
        receiptResolution: { unitCost: 100, reason: "supplier invoice found", actorName: "Owner", recordedAt: result.recordedAt },
      },
    });
  });

  it("resolves full consumption with no phantom stock or resolution-period COGS", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id, 5);
    const result = await resolve(source.id);
    expect(await report()).toMatchObject({ revenue: 1000, cogs: 500, grossProfit: 500, provisional: false });
    expect(await report(result.recordedAt.slice(0, 10))).toMatchObject({ cogs: 0, revenue: 0 });
    await assertStock(product.id, 0, 0, 100);
    await assertOriginal(sale);
  });

  it("treats confirmed zero as final across retry and reopen", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    const result = await resolve(source.id, 0, "genuine free receipt");
    expect(result.adjustments).toEqual([{ invoiceLineId: required(sale.lines[0]).id, amount: 0 }]);
    expect(await report()).toMatchObject({ cogs: 0, grossProfit: 400, provisional: false });
    await assertStock(product.id, 3, 0, 0);
    expect((await saved(product.id)).cache.costPriceKnown).toBe(true);
    await closeDatabase();
    await connect();
    client = wire(cookie);
    expect(await resolve(source.id, 0, "genuine free receipt")).toEqual({ ...result, created: false });
    expect(await report()).toMatchObject({ cogs: 0, provisional: false });
    await assertStock(product.id, 3, 0, 0);
    expect((await saved(product.id)).catalog.costPriceKnown).toBe(true);
    const later = await sell(product.id, 1, "2026-02-01");
    expect(later.lines[0]).toMatchObject({ cogsExact: 0, costAtSale: 0, costPending: false });
    await assertOriginal(sale);
  });

  it("adds exact mixed-layer deltas successively and becomes final only after the last pending source", async () => {
    const product = await item();
    await receipt(product.id, 2, 11, "2026-01-08T10:00:00");
    const first = await receipt(product.id, 2, undefined, "2026-01-09T10:00:00");
    const second = await receipt(product.id, 3);
    const sale = await sell(product.id, 6);
    expect(sale.lines[0]).toMatchObject({ cogsExact: 22, costAtSale: 4, costPending: true });
    expect(await report()).toMatchObject({ cogs: 22, provisional: true });
    expect((await resolve(first.id)).adjustments).toEqual([{ invoiceLineId: required(sale.lines[0]).id, amount: 200 }]);
    expect(await report()).toMatchObject({ revenue: 1200, cogs: 222, grossProfit: 978, provisional: true });
    expect((await saved(product.id)).catalog.costPending).toBe(true);
    expect((await resolve(second.id, 70)).adjustments).toEqual([{ invoiceLineId: required(sale.lines[0]).id, amount: 140 }]);
    expect(await report()).toMatchObject({ revenue: 1200, cogs: 362, grossProfit: 838, provisional: false });
    await assertStock(product.id, 1, 70, 62);
    await assertOriginal(sale);
  });

  it("corrects each duplicate-item invoice line by its persisted source quantity", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await client.invoicesCreate({ kind: "SALE", invoiceDate: "2026-01-11", lines: [{ itemId: product.id, quantity: 1 }, { itemId: product.id, quantity: 2 }] });
    expect((await store.listStockLinksByItem(product.id)).map((row) => ({ line: row.invoiceLineId, quantity: row.quantity }))).toEqual([{ line: required(sale.lines[0]).id, quantity: 1 }, { line: required(sale.lines[1]).id, quantity: 2 }]);
    expect((await resolve(source.id)).adjustments).toEqual([{ invoiceLineId: required(sale.lines[0]).id, amount: 100 }, { invoiceLineId: required(sale.lines[1]).id, amount: 200 }]);
    expect((await store.listSaleLinesForProfit("2026-01-11", "2026-01-11")).map((row) => row.cogsExact).sort((a, b) => a - b)).toEqual([100, 200]);
    expect(await report()).toMatchObject({ cogs: 300, grossProfit: 300, provisional: false });
    await assertStock(product.id, 2, 200, 100);
    await assertOriginal(sale);
  });

  it("preserves mixed source splits across duplicate-item lines and a later backdate", async () => {
    const product = await item();
    await receipt(product.id, 1, 11, "2026-01-09T10:00:00");
    const source = await receipt(product.id, 4);
    const sale = await client.invoicesCreate({ kind: "SALE", invoiceDate: "2026-01-11", lines: [{ itemId: product.id, quantity: 2 }, { itemId: product.id, quantity: 1 }] });
    expect(sale.lines.map((line) => line.cogsExact)).toEqual([11, 0]);
    await receipt(product.id, 1, 3, "2026-01-08T10:00:00");
    expect((await resolve(source.id)).adjustments).toEqual([{ invoiceLineId: required(sale.lines[0]).id, amount: 100 }, { invoiceLineId: required(sale.lines[1]).id, amount: 100 }]);
    expect(await report()).toMatchObject({ revenue: 600, cogs: 211, grossProfit: 389, provisional: false });
    // The weighted-average cache replays business dates independently of FIFO.
    await assertStock(product.id, 3, 203, 69);
    const later = await sell(product.id, 2, "2026-02-01");
    expect(later.lines[0]).toMatchObject({ cogsExact: 103, costAtSale: 52, costPending: false });
    await assertStock(product.id, 1, 100, 69);
    await assertOriginal(sale);
  });

  it("preserves unrelated sales and posting-time provenance after a backdated inflow", async () => {
    const product = await item();
    await receipt(product.id, 2, 40, "2026-01-08T10:00:00");
    const unrelated = await sell(product.id, 2, "2026-01-09");
    const source = await receipt(product.id);
    const affected = await sell(product.id);
    const links = await store.listStockLinksByItem(product.id);
    await receipt(product.id, 2, 7, "2026-01-07T10:00:00");
    const before = await saved(product.id);
    const result = await resolve(source.id);
    expect(result.adjustments).toEqual([{ invoiceLineId: required(affected.lines[0]).id, amount: 200 }]);
    expect(await report("2026-01-09")).toMatchObject({ cogs: 80, grossProfit: 320, provisional: false });
    expect(await report()).toMatchObject({ cogs: 200, grossProfit: 200, provisional: false });
    expect(await store.listStockLinksByItem(product.id)).toEqual(links);
    expect((await saved(product.id)).movements.map((row) => ({ id: row.id, occurredAt: row.occurredAt, delta: row.delta }))).toEqual(before.movements.map((row) => ({ id: row.id, occurredAt: row.occurredAt, delta: row.delta })));
    // Saved allocations consumed the original 2@40 and 2 pending units.
    // The later backdated 2@7 remain alongside the resolved 3@100.
    await assertStock(product.id, 5, 314, 78);
    const later = await sell(product.id, 3, "2026-02-01");
    expect(later.lines[0]).toMatchObject({ cogsExact: 114, costAtSale: 38, costPending: false });
    expect(await report("2026-02-01")).toMatchObject({ cogs: 114, provisional: false });
    await assertStock(product.id, 2, 200, 78);
    await assertOriginal(unrelated);
    await assertOriginal(affected);
  });

  it("makes identical retries inert and refuses cost-only and reason-only conflicts atomically", async () => {
    const product = await item();
    const source = await receipt(product.id);
    await sell(product.id);
    const result = await resolve(source.id);
    const state = await saved(product.id);
    const profit = await report();
    const activity = await resolutionActivities(source.id);
    expect(await resolve(source.id)).toEqual({ ...result, created: false });
    for (const [cost, reason] of [[101, "supplier invoice found"], [100, "changed reason"]] as const) {
      await expect(resolve(source.id, cost, reason)).rejects.toMatchObject({ code: "CONFLICT", message: "RECEIPT_RESOLUTION_CONFLICT" });
    }
    expect(await report()).toEqual(profit);
    expect(await saved(product.id)).toEqual(state);
    expect(await resolutionActivities(source.id)).toEqual(activity);
    expect(activity).toHaveLength(1);
  });

  it("rolls resolution, COGS, cache and activity back when the final audit insert fails", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    const state = await saved(product.id);
    const profit = await report();
    conn.raw.exec("CREATE TEMP TRIGGER fail_receipt_activity BEFORE INSERT ON activities WHEN NEW.type = 'RECEIPT_COST_RESOLVED' BEGIN SELECT RAISE(ABORT, 'injected receipt audit failure'); END");
    try {
      await expect(resolve(source.id)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(await saved(product.id)).toEqual(state);
      expect(await report()).toEqual(profit);
      expect(await resolutionActivities(source.id)).toEqual([]);
      await assertOriginal(sale);
    } finally {
      conn.raw.exec("DROP TRIGGER fail_receipt_activity");
    }
    expect((await resolve(source.id)).created).toBe(true);
    expect(await report()).toMatchObject({ cogs: 200, provisional: false });
    await assertStock(product.id, 3, 300, 100);
    expect(await resolutionActivities(source.id)).toHaveLength(1);
  });

  it("retains effective outcomes on reopen and snapshots resolved FIFO for the next sale", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    const result = await resolve(source.id);
    const state = await saved(product.id);
    const profit = await report();
    const activity = await resolutionActivities(source.id);
    await closeDatabase();
    await connect();
    client = wire(cookie);
    expect(await saved(product.id)).toEqual(state);
    expect(await report()).toEqual(profit);
    expect(await resolutionActivities(source.id)).toEqual(activity);
    expect(await resolve(source.id)).toEqual({ ...result, created: false });
    const later = await sell(product.id, 1, "2026-02-01");
    expect(later.lines[0]).toMatchObject({ cogsExact: 100, costAtSale: 100, costPending: false });
    expect(await report("2026-02-01")).toMatchObject({ revenue: 200, cogs: 100, grossProfit: 100, provisional: false });
    expect(await report()).toEqual(profit);
    await assertStock(product.id, 2, 200, 100);
    await assertOriginal(sale);
  });

  it("keeps legacy zero and null distinct from explicit pending cost across setup", async () => {
    const product = await item();
    const zero = await receipt(product.id, 1, 0);
    const legacyNull = await store.insertStockMovement({ itemId: product.id, kind: "PURCHASE", delta: 1, unitCost: null, reason: "legacy", ref: null, occurredAt: "2026-01-10T11:00:00" });
    await store.setItemStockAndCost(product.id, 2, 0, true);
    await closeDatabase();
    await connect();
    client = wire(cookie);
    const before = await saved(product.id);
    for (const source of [zero, legacyNull]) {
      await expect(resolve(source.id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RECEIPT_NOT_PENDING" });
      expect(await resolutionActivities(source.id)).toEqual([]);
    }
    expect(await saved(product.id)).toEqual(before);
    await assertStock(product.id, 2, 0, 0);
  });

  it("resolves a pending source through an attributed return and values the remaining layer once", async () => {
    const product = await item();
    const source = await receipt(product.id, 5);
    const sale = await sell(product.id, 2);
    await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: required(sale.lines[0]).id, quantity: 1 }] });
    const original = required(sale.lines[0]);
    const result = await resolve(source.id, 100);
    expect(result.adjustments).toEqual([{ invoiceLineId: original.id, amount: 100 }]);
    expect(await report()).toMatchObject({ revenue: 200, cogs: 100, grossProfit: 100, provisional: false });
    await assertStock(product.id, 4, 400, 100);
    await assertOriginal(sale);
  });

  it("uses selected source cost instead of proportional COGS for a mixed-source return", async () => {
    const product = await item();
    const known = await receipt(product.id, 1, 40);
    const pending = await receipt(product.id, 1, undefined, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 2);
    const lineId = required(sale.lines[0]).id;
    const sources = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId });
    await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 1,
      sourceAllocations: [{ stockLinkId: required(sources.sources.find((row) => row.movementId === known.id)).stockLinkId, quantity: 1 }] }] });
    await resolve(pending.id, 100);
    expect(await report()).toMatchObject({ cogs: 100, provisional: false });
  });

  it("reverses resolved COGS by the selected source when the return happens later", async () => {
    const product = await item();
    const source = await receipt(product.id, 5);
    const sale = await sell(product.id, 2);
    const resolved = await resolve(source.id, 100);
    expect(await report()).toMatchObject({ cogs: 200, provisional: false });
    await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: required(sale.lines[0]).id, quantity: 1 }] });
    expect(await report()).toMatchObject({ cogs: 100, provisional: false });
    expect(await resolve(source.id, 100)).toEqual({ ...resolved, created: false });
    await assertStock(product.id, 4, 400, 100);
    await assertOriginal(sale);
  });

  it("keeps mixed known and pending source returns in separate valued layers", async () => {
    const product = await item();
    const known = await receipt(product.id, 1, 40);
    const pending = await receipt(product.id, 1, undefined, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 2);
    const lineId = required(sale.lines[0]).id;
    const sources = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId });
    await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 2, sourceAllocations: [
      { stockLinkId: required(sources.sources.find((row) => row.movementId === known.id)).stockLinkId, quantity: 1 },
      { stockLinkId: required(sources.sources.find((row) => row.movementId === pending.id)).stockLinkId, quantity: 1 },
    ] }] });
    const returnedLayers = (await store.listStockMovements(product.id)).filter((movement) => movement.reason === "RETURN_RECORDED");
    expect(returnedLayers).toHaveLength(2);
    expect(returnedLayers.map((movement) => [movement.delta, movement.costPending])).toEqual([[1, false], [1, true]]);
    await resolve(pending.id, 100);
    const valued = (await store.listStockMovements(product.id)).filter((movement) => movement.reason === "RETURN_RECORDED");
    expect(valued.map((movement) => [movement.unitCost, movement.costPending])).toEqual([[required(returnedLayers[0]).unitCost, false], [100, false]]);
    expect(await report()).toMatchObject({ cogs: 0, provisional: false });
  });

  it("moves resolved source cost from the original sale to a returned-layer resale", async () => {
    const product = await item();
    const source = await receipt(product.id, 5);
    const originalSale = await sell(product.id, 5);
    await client.returnsCreate({ invoiceId: originalSale.id, lines: [{ invoiceLineId: required(originalSale.lines[0]).id, quantity: 1 }] });
    const resale = await sell(product.id, 1, "2026-01-12");
    const result = await resolve(source.id, 100);
    expect(result.adjustments).toEqual([
      { invoiceLineId: required(originalSale.lines[0]).id, amount: 400 },
      { invoiceLineId: required(resale.lines[0]).id, amount: 100 },
    ]);
    expect(await report("2026-01-11")).toMatchObject({ cogs: 400, provisional: false });
    expect(await report("2026-01-12")).toMatchObject({ cogs: 100, provisional: false });
    await assertStock(product.id, 0, 0, 100);
    await assertOriginal(originalSale);
    await assertOriginal(resale);
  });

  it("snapshots exact cost on a sale made after resolving a returned layer", async () => {
    const product = await item();
    const source = await receipt(product.id, 5);
    const original = await sell(product.id, 5);
    await client.returnsCreate({ invoiceId: original.id, lines: [{ invoiceLineId: required(original.lines[0]).id, quantity: 1 }] });
    await resolve(source.id, 100);
    const resale = await sell(product.id, 1, "2026-01-12");
    expect(resale.lines[0]).toMatchObject({ cogsExact: 100, costAtSale: 100, costPending: false });
    expect(await report("2026-01-11")).toMatchObject({ cogs: 400, provisional: false });
    expect(await report("2026-01-12")).toMatchObject({ cogs: 100, provisional: false });
    await assertStock(product.id, 0, 0, 100);
    await assertOriginal(original);
  });

  it("finishes rejection after returned stock was resold without scrapping unrelated stock", async () => {
    const product = await item();
    const source = await receipt(product.id, 5);
    const original = await sell(product.id, 5);
    const returned = await client.returnsCreate({ invoiceId: original.id, lines: [{ invoiceLineId: required(original.lines[0]).id, quantity: 1 }] });
    await resolve(source.id, 100);
    const resale = await sell(product.id, 1, "2026-01-12");
    const before = await report("2026-01-12");
    await client.returnsReject({ returnId: returned.id, reason: "inspection refused" });
    expect(await report("2026-01-11")).toMatchObject({ cogs: 400, provisional: false });
    expect(await report("2026-01-12")).toMatchObject({ cogs: 100, provisional: false });
    expect(await report("2026-01-12")).toMatchObject({ revenue: before.revenue });
    await assertStock(product.id, 0, 0, 100);
    await assertOriginal(original);
    await assertOriginal(resale);
  });

  it("keeps original COGS when a rejected return was consumed by an unlinked stock outflow", async () => {
    const product = await item();
    const source = await receipt(product.id, 5);
    const original = await sell(product.id, 5);
    await resolve(source.id, 100);
    const returned = await client.returnsCreate({ invoiceId: original.id, lines: [{ invoiceLineId: required(original.lines[0]).id, quantity: 1 }] });
    const returnMovement = (await store.listStockMovements(product.id)).find((movement) => movement.reason === "RETURN_RECORDED");
    await store.insertStockMovement({ itemId: product.id, kind: "MANUAL_ADJUSTMENT", delta: -1, unitCost: null, reason: "unlinked stock outflow", ref: null, occurredAt: required(returnMovement).occurredAt });
    await client.returnsReject({ returnId: returned.id, reason: "inspection refused" });
    expect(await report()).toMatchObject({ cogs: 500, provisional: false });
    expect((await saved(product.id)).projection.stockOnHand).toBe(0);
  });

  it("resolves a returned source after rejection and resale", async () => {
    const product = await item();
    const source = await receipt(product.id, 5);
    const original = await sell(product.id, 5);
    const returned = await client.returnsCreate({ invoiceId: original.id, lines: [{ invoiceLineId: required(original.lines[0]).id, quantity: 1 }] });
    const resale = await sell(product.id, 1, "2026-01-12");
    await client.returnsReject({ returnId: returned.id, reason: "inspection refused" });
    const result = await resolve(source.id, 100);
    expect(result.adjustments).toEqual([
      { invoiceLineId: required(original.lines[0]).id, amount: 400 },
      { invoiceLineId: required(resale.lines[0]).id, amount: 100 },
    ]);
    expect(await report("2026-01-11")).toMatchObject({ cogs: 400, provisional: false });
    expect(await report("2026-01-12")).toMatchObject({ cogs: 100, provisional: false });
  });

  it("keeps ancestry through a return-resale-return chain", async () => {
    const product = await item();
    const source = await receipt(product.id, 5);
    const original = await sell(product.id, 5);
    await client.returnsCreate({ invoiceId: original.id, lines: [{ invoiceLineId: required(original.lines[0]).id, quantity: 1 }] });
    const resale = await sell(product.id, 1, "2026-01-12");
    await client.returnsCreate({ invoiceId: resale.id, lines: [{ invoiceLineId: required(resale.lines[0]).id, quantity: 1 }] });
    const result = await resolve(source.id, 100);
    expect(result.adjustments).toEqual([{ invoiceLineId: required(original.lines[0]).id, amount: 400 }]);
    expect(await report("2026-01-11")).toMatchObject({ cogs: 400, provisional: false });
    expect(await report("2026-01-12")).toMatchObject({ cogs: 0, provisional: false });
    await assertStock(product.id, 1, 100, 100);
  });

  it("accepts only unambiguous complete legacy line links on reopen", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    conn.raw.query("UPDATE stock_links SET invoice_line_id = NULL WHERE invoice_id = ?").run(sale.id);
    await closeDatabase();
    await connect();
    client = wire(cookie);
    expect((await store.listStockLinksByItem(product.id)).map((row) => ({ line: row.invoiceLineId, quantity: row.quantity }))).toEqual([{ line: required(sale.lines[0]).id, quantity: 2 }]);
    expect((await resolve(source.id)).adjustments).toEqual([{ invoiceLineId: required(sale.lines[0]).id, amount: 200 }]);
    expect(await report()).toMatchObject({ cogs: 200, provisional: false });
    await assertStock(product.id, 3, 300, 100);
    await assertOriginal(sale);
  });

  it.each([0, -1, 1.5, 3])("refuses an invalid persisted source quantity %s without partial writes", async (quantity) => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    conn.raw.query("UPDATE stock_links SET quantity = ? WHERE invoice_id = ?").run(quantity, sale.id);
    const before = await saved(product.id);
    const profit = await report();
    await expect(resolve(source.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await saved(product.id)).toEqual(before);
    expect(await report()).toEqual(profit);
    expect(await resolutionActivities(source.id)).toEqual([]);
  });

  it("refuses incomplete legacy provenance even when no sale link survives", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    conn.raw.query("DELETE FROM stock_links WHERE invoice_id = ?").run(sale.id);
    await closeDatabase();
    await connect();
    client = wire(cookie);
    const before = await saved(product.id);
    const profit = await report();
    await expect(resolve(source.id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RECEIPT_PROVENANCE_AMBIGUOUS" });
    expect(await saved(product.id)).toEqual(before);
    expect(await report()).toEqual(profit);
    expect(await resolutionActivities(source.id)).toEqual([]);
    await assertOriginal(sale);
  });

  it("refuses a linked line owned by another invoice and item instead of correcting its profit", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    const other = await item("Other item");
    await receipt(other.id, 2, 50);
    const unrelated = await sell(other.id);
    conn.raw.query("UPDATE stock_links SET invoice_line_id = ? WHERE invoice_id = ?").run(required(unrelated.lines[0]).id, sale.id);
    const before = await saved(product.id);
    const profit = await report();
    await expect(resolve(source.id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RECEIPT_PROVENANCE_INVALID" });
    expect(await saved(product.id)).toEqual(before);
    expect(await report()).toEqual(profit);
    expect(await resolutionActivities(source.id)).toEqual([]);
    await assertOriginal(sale);
    await assertOriginal(unrelated);
  });

  it("refuses ambiguous legacy duplicate-line attribution after reopen without inventing allocations", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await client.invoicesCreate({ kind: "SALE", invoiceDate: "2026-01-11", lines: [{ itemId: product.id, quantity: 1 }, { itemId: product.id, quantity: 2 }] });
    conn.raw.query("UPDATE stock_links SET invoice_line_id = NULL WHERE invoice_id = ?").run(sale.id);
    await closeDatabase();
    await connect();
    client = wire(cookie);
    expect((await store.listStockLinksByItem(product.id)).map((row) => row.invoiceLineId)).toEqual([null, null]);
    const before = await saved(product.id);
    await expect(resolve(source.id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RECEIPT_PROVENANCE_AMBIGUOUS" });
    expect(await saved(product.id)).toEqual(before);
    expect(await report()).toMatchObject({ cogs: 0, provisional: true });
    expect(await resolutionActivities(source.id)).toEqual([]);
    await assertOriginal(sale);
  });
});

describe("persisted return source choices", () => {
  it("offers only original-sale sources and asks when cost or pending status differs", async () => {
    const product = await item();
    const known = await receipt(product.id, 2, 40);
    const pending = await receipt(product.id, 3, undefined, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 4);
    await receipt(product.id, 5, 999, "2026-01-12T10:00:00");
    const output = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: required(sale.lines[0]).id });
    expect(output).toMatchObject({ provenanceComplete: true, selectionRequired: true });
    expect(output.sources).toHaveLength(2);
    expect(output.sources).toMatchObject([
      { movementId: known.id, unitCost: 40, costPending: false, quantityAvailable: 2, occurredAt: known.occurredAt },
      { movementId: pending.id, unitCost: null, costPending: true, quantityAvailable: 2, occurredAt: pending.occurredAt },
    ]);
    expect(new Set(output.sources.map((source) => source.stockLinkId)).size).toBe(2);
  });

  it("does not ask when all sources have identical known or pending cost", async () => {
    for (const cost of [40, undefined]) {
      const product = await item();
      await receipt(product.id, 2, cost);
      await receipt(product.id, 2, cost, "2026-01-10T11:00:00");
      const sale = await sell(product.id, 4);
      const output = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: required(sale.lines[0]).id });
      expect(output).toMatchObject({ provenanceComplete: true, selectionRequired: false });
      expect(output.sources.map((source) => source.quantityAvailable)).toEqual([2, 2]);
    }
  });

  it("compares effective resolved costs rather than immutable pending markers", async () => {
    const product = await item();
    await receipt(product.id, 2, 40);
    const pending = await receipt(product.id, 2, undefined, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 4);
    await resolve(pending.id, 40);
    const output = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: required(sale.lines[0]).id });
    expect(output).toMatchObject({ provenanceComplete: true, selectionRequired: false });
    expect(output.sources.map((source) => [source.unitCost, source.costPending])).toEqual([[40, false], [40, false]]);
  });

  it("refuses unauthenticated and foreign-line source reads", async () => {
    const product = await item();
    await receipt(product.id);
    const first = await sell(product.id);
    const second = await sell(product.id);
    await expect(wire("").returnsSources({ invoiceId: first.id, invoiceLineId: required(first.lines[0]).id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.returnsSources({ invoiceId: first.id, invoiceLineId: required(second.lines[0]).id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "LINE_NOT_ON_INVOICE" });
  });

  it("persists selected mixed-source splits and subtracts exact caps after reopen", async () => {
    const product = await item();
    const known = await receipt(product.id, 2, 40);
    await receipt(product.id, 2, undefined, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 4);
    const lineId = required(sale.lines[0]).id;
    const sources = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId });
    const result = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 3, sourceAllocations: [
      { stockLinkId: required(sources.sources[0]).stockLinkId, quantity: 1 },
      { stockLinkId: required(sources.sources[1]).stockLinkId, quantity: 2 },
    ] }] });
    expect(result.lines[0]).toMatchObject({ quantity: 3, sourceAttribution: "SELECTED", sourceAllocations: [
      { stockLinkId: required(sources.sources[0]).stockLinkId, quantity: 1 },
      { stockLinkId: required(sources.sources[1]).stockLinkId, quantity: 2 },
    ] });
    expect(await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId })).toMatchObject({
      provenanceComplete: true,
      sources: [{ movementId: known.id, quantityAvailable: 1 }],
    });
    await closeDatabase();
    await connect();
    client = wire(cookie);
    expect((await client.returnsForInvoice({ invoiceId: sale.id })).items[0]?.lines[0]).toMatchObject({ quantity: 3, sourceAttribution: "SELECTED", sourceAllocations: [
      { stockLinkId: required(sources.sources[0]).stockLinkId, quantity: 1 },
      { stockLinkId: required(sources.sources[1]).stockLinkId, quantity: 2 },
    ] });
    expect(await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId })).toMatchObject({ provenanceComplete: true, sources: [{ movementId: known.id, quantityAvailable: 1 }] });
  });

  it("requires explicit choice for mixed sources and rejects forged or duplicate selections atomically", async () => {
    const product = await item();
    await receipt(product.id, 2, 40);
    await receipt(product.id, 2, undefined, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 4);
    const lineId = required(sale.lines[0]).id;
    const sources = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId });
    await expect(client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 1 }] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETURN_SOURCE_SELECTION_REQUIRED" });
    const forged = "00000000-0000-4000-8000-000000000001";
    for (const sourceAllocations of [
      [{ stockLinkId: forged, quantity: 1 }],
      [{ stockLinkId: required(sources.sources[0]).stockLinkId, quantity: 1 }, { stockLinkId: required(sources.sources[0]).stockLinkId, quantity: 1 }],
    ]) {
      await expect(client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 1, sourceAllocations }] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETURN_SOURCE_ALLOCATION_INVALID" });
    }
    expect((await client.returnsForInvoice({ invoiceId: sale.id })).items).toHaveLength(0);
  });

  it("automatically allocates homogeneous sources without asking", async () => {
    const product = await item();
    await receipt(product.id, 2, 40);
    const second = await receipt(product.id, 2, 40, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 4);
    const lineId = required(sale.lines[0]).id;
    const sourceSet = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId });
    expect(sourceSet.selectionRequired).toBe(false);
    const result = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 3 }] });
    expect(result.lines[0]).toMatchObject({ sourceAttribution: "AUTO", sourceAllocations: [
      { stockLinkId: required(sourceSet.sources[0]).stockLinkId, quantity: 2 },
      { stockLinkId: required(sourceSet.sources[1]).stockLinkId, quantity: 1 },
    ] });
    expect(await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId })).toMatchObject({ sources: [{ movementId: second.id, quantityAvailable: 1 }] });
  });

  it("persists explicit UNKNOWN mode by oldest eligible original source", async () => {
    const product = await item();
    await receipt(product.id, 2, 40);
    const next = await receipt(product.id, 2, 60, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 4);
    const lineId = required(sale.lines[0]).id;
    const sources = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId });
    const result = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 3, sourceMode: "UNKNOWN" }] });
    expect(result.lines[0]).toMatchObject({ quantity: 3, sourceAttribution: "UNKNOWN", sourceAllocations: [
      { stockLinkId: required(sources.sources[0]).stockLinkId, quantity: 2 },
      { stockLinkId: required(sources.sources[1]).stockLinkId, quantity: 1 },
    ] });
    expect(await client.returnsSources({ invoiceId: sale.id, invoiceLineId: lineId })).toMatchObject({ provenanceComplete: true, sources: [{ movementId: next.id, quantityAvailable: 1 }] });
  });

  it("safely keeps homogeneous known-cost legacy returns available", async () => {
    const product = await item();
    await receipt(product.id, 2, 40);
    const laterReceipt = await receipt(product.id, 2, 40, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 4);
    const line = required(sale.lines[0]);
    const first = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: line.id });
    const returned = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: line.id, quantity: 1 }] });
    conn.raw.query(`DELETE FROM return_source_allocations WHERE return_line_id IN (SELECT id FROM return_lines WHERE return_id = ?)`).run(returned.id);
    const remaining = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: line.id });
    expect(remaining).toMatchObject({ provenanceComplete: true, selectionRequired: false,
      sources: [{ quantityAvailable: 1 }, { quantityAvailable: 2 }] });
    await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: line.id, quantity: 1 }] });
    expect((await client.returnsSources({ invoiceId: sale.id, invoiceLineId: line.id })).sources).toMatchObject([
      { movementId: laterReceipt.id, quantityAvailable: 2 },
    ]);
    expect(first.provenanceComplete).toBe(true);
  });

  it("does not invent per-source caps for a legacy unattributed return", async () => {
    const product = await item();
    await receipt(product.id, 2, 40);
    await receipt(product.id, 2, undefined, "2026-01-10T11:00:00");
    const sale = await sell(product.id, 4);
    const line = required(sale.lines[0]);
    const choices = await client.returnsSources({ invoiceId: sale.id, invoiceLineId: line.id });
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: line.id, quantity: 1,
      sourceAllocations: [{ stockLinkId: required(choices.sources[0]).stockLinkId, quantity: 1 }] }] });
    // Simulate a pre-allocation legacy row: preserve the return and returned
    // movement, but remove its source attribution record.
    conn.raw.query(`DELETE FROM return_source_allocations WHERE return_line_id IN (SELECT id FROM return_lines WHERE return_id = ?)`)
      .run(created.id);
    expect(await client.returnsSources({ invoiceId: sale.id, invoiceLineId: line.id })).toEqual({ provenanceComplete: false, selectionRequired: false, sources: [] });
  });
});
