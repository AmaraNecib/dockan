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
    expect((await store.listStockMovements(product.id)).map(({ unitCost: _unitCost, costPending: _costPending, ...fact }) => fact)).toEqual(originalMovements.map(({ unitCost: _unitCost, costPending: _costPending, ...fact }) => fact));
    const activities = await resolutionActivities(source.id);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ actorId: await store.getSetting("adminUserId"), actorName: "Owner" });
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

  it("keeps the explicit return-provenance refusal atomic", async () => {
    const product = await item();
    const source = await receipt(product.id);
    const sale = await sell(product.id);
    await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: required(sale.lines[0]).id, quantity: 1 }] });
    const before = await saved(product.id);
    const profit = await report();
    await expect(resolve(source.id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RECEIPT_RETURN_PROVENANCE_UNSUPPORTED" });
    expect(await saved(product.id)).toEqual(before);
    expect(await report()).toEqual(profit);
    expect(await resolutionActivities(source.id)).toEqual([]);
    await assertOriginal(sale);
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
