import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { createApp } from "../app";
import { createAuth } from "../auth/auth";
import { resetAdminPassword } from "../auth/admin";
import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { AppLogger } from "../lib/logger";
import { createRpcRouter } from "./router";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";

/**
 * Wire-seam tests for the merged router. The typed oRPC client calls the real
 * HTTP seam (app.fetch through RPCLink); the store sits on sqlite :memory:.
 * Ticket 02's session guard is part of the seam, so the client authenticates
 * first: provision the admin via the build secret and capture its cookie.
 */
let dir: string;
let conn: Connection;
let store: StorePort;
let client: DokanClient;
let unauthed: DokanClient;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-rpc-"));
  const config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: path.join(dir, "test.db"),
    DOKAN_AUTH_SECRET: "test-auth-secret",
    DOKAN_BUILD_SECRET: "test-build-secret-123",
  });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
  const logger = new AppLogger(dir);
  const auth = createAuth(conn.db, config);
  const app = createApp({ config, logger, auth, rpcRouter: createRpcRouter({ db: conn.db, config, logger, store, auth }) });

  await resetAdminPassword(
    { db: conn.db, auth, store, config, logger },
    { secret: "test-build-secret-123", newPassword: "dokan-1234", phoneNumber: "0550123123" },
  );

  const login = await auth.handler(
    new Request("http://localhost/api/auth/sign-in/username", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "213550123123", password: "dokan-1234" }),
    }),
  );
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie") ?? "";

  const linkWith = (cookieToSend: string) =>
    new RPCLink({
      url: () => `http://127.0.0.1:${config.port}/api/rpc`,
      // SAFETY: the link's fetch contract wants a Promise; hono's fetch returns one
      fetch: (request) => {
        const headers = Object.fromEntries(request.headers.entries());
        if (cookieToSend !== "") headers.cookie = cookieToSend;
        return Promise.resolve(app.fetch(new Request(request, { headers })));
      },
    });
  client = createORPCClient(linkWith(cookie));
  unauthed = createORPCClient(linkWith(""));
});

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

describe("health", () => {

  it("rejects a business procedure without a session (merged auth guard)", async () => {
    await expect(unauthed.categoriesList()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("reports the service up with a version", async () => {
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.version).toBe("0.1.0");
  });
});

describe("categories", () => {
  it("creates and lists categories", async () => {
    const created = await client.categoriesCreate({ name: "زيوت" });
    expect(created.name).toBe("زيوت");
    expect(created.id).toBeTruthy();

    const list = await client.categoriesList();
    expect(list.items.some((c) => c.id === created.id && c.name === "زيوت")).toBe(true);
  });

  it("rejects a duplicate category name with a clear error", async () => {
    await expect(client.categoriesCreate({ name: "زيوت" })).rejects.toThrow(/CATEGORY_EXISTS/);
  });

  it("two concurrent creates of the same category resolve as CONFLICT, not a raw error", async () => {
    const results = await Promise.allSettled([
      client.categoriesCreate({ name: "مكرر" }),
      client.categoriesCreate({ name: "مكرر" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const rejection of rejected) {
      expect(String(rejection.reason)).toMatch(/CATEGORY_EXISTS/);
    }
  });
});

describe("items", () => {
  it("creates an item with default threshold and zero stock", async () => {
    const categories = await client.categoriesList();
    const main = categories.items[0];
    expect(main).toBeDefined();

    const item = await client.itemsCreate({
      name: "بطارية",
      categoryId: main!.id,
      costPrice: 200,
      sellingPrice: 350,
    });
    expect(item.stockOnHand).toBe(0);
    expect(item.lowStockThreshold).toBe(5);
    expect(item.sellingPrice - item.costPrice).toBe(150); // profit the UI shows
  });

  it("rejects an item whose category does not exist", async () => {
    await expect(
      client.itemsCreate({
        name: "منتج خارجي",
        categoryId: "00000000-0000-4000-8000-000000000000",
        costPrice: 100,
        sellingPrice: 150,
      }),
    ).rejects.toThrow(/category/i);
  });

  it("applies a partial update and keeps the rest", async () => {
    const categories = await client.categoriesList();
    const created = await client.itemsCreate({
      name: "زيت مكينة",
      categoryId: categories.items[0]!.id,
      costPrice: 120,
      sellingPrice: 180,
    });
    const updated = await client.itemsUpdate({ id: created.id, name: "زيت مكينة 5W30", sellingPrice: 200 });
    expect(updated?.name).toBe("زيت مكينة 5W30");
    expect(updated?.sellingPrice).toBe(200);
    expect(updated?.costPrice).toBe(120); // untouched by the partial update
  });

  it("lists items ordered by name", async () => {
    const categories = await client.categoriesList();
    const catId = categories.items[0]!.id;
    const list = await client.itemsList();
    const names = list.items.map((i) => i.name);
    if (names.length > 1) {
      const sorted = [...names].sort((a, b) => a.localeCompare(b, "ar"));
      expect(names).toEqual(sorted);
    }
    void catId;
  });

  it("reports low stock only when on-hand is at or below the threshold", async () => {
    const categories = await client.categoriesList();
    const created = await client.itemsCreate({
      name: "مساحات",
      categoryId: categories.items[0]!.id,
      costPrice: 50,
      sellingPrice: 90,
      lowStockThreshold: 4,
    });
    await store.setItemStockAndCost(created.id, 3, 50); // 3 <= 4 -> low
    let low = await client.itemsLowStock();
    expect(low.items.some((i) => i.id === created.id)).toBe(true);

    await store.setItemStockAndCost(created.id, 6, 50); // 6 > 4 -> not low
    low = await client.itemsLowStock();
    expect(low.items.some((i) => i.id === created.id)).toBe(false);
  });
});
describe("catalog search + barcodes (ticket 28)", () => {
  it("rejects catalogSearch without a session", async () => {
    await expect(unauthed.catalogSearch({ query: "بطارية" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("creates items with normalized barcodes and finds them by exact scan", async () => {
    const categories = await client.categoriesList();
    const catId = categories.items[0]!.id;
    const created = await client.itemsCreate({
      name: "حساس ضغط",
      categoryId: catId,
      costPrice: 500,
      sellingPrice: 800,
      barcode: " abc-123 ",
    });
    // boundary normalization: uppercased, spaces stripped
    expect(created.barcode).toBe("ABC-123");

    const result = await client.catalogSearch({ query: created.barcode! });
    expect(result.exact?.item.id).toBe(created.id);
    expect(result.matches).toHaveLength(0);
  });

  it("maps a duplicate barcode to CONFLICT BARCODE_EXISTS", async () => {
    const categories = await client.categoriesList();
    await expect(
      client.itemsCreate({
        name: "مكرر الكود",
        categoryId: categories.items[0]!.id,
        costPrice: 10,
        sellingPrice: 20,
        barcode: "ABC-123",
      }),
    ).rejects.toThrow(/BARCODE_EXISTS/);
  });

  it("ranks search results through the real store seam", async () => {
    const found = await client.catalogSearch({ query: "بطارية" });
    expect(found.exact).toBeNull();
    for (const match of found.matches) {
      expect(["BARCODE_PARTIAL", "NAME", "CATEGORY"]).toContain(match.matchedBy);
    }
  });

  it("honors the optional limit through schema → router → rankCatalog (ticket 34)", async () => {
    const categories = await client.categoriesList();
    const catId = categories.items[0]!.id;
    for (let i = 1; i <= 5; i++) {
      await client.itemsCreate({ name: `حد-مشترك-${i}`, categoryId: catId, costPrice: 10, sellingPrice: 20 });
    }

    const limited = await client.catalogSearch({ query: "حد-مشترك", limit: 2 });
    expect(limited.matches).toHaveLength(2);

    const unbounded = await client.catalogSearch({ query: "حد-مشترك" });
    // the shared fragment only matches the five rows created above
    expect(unbounded.matches.length).toBe(5);
    expect(unbounded.matches.length).toBeGreaterThan(limited.matches.length);
  });

  it("itemsCreateWithStock creates the item with initial stock in one unit", async () => {
    const categories = await client.categoriesList();
    const item = await client.itemsCreateWithStock({
      name: "فلتر زيت",
      categoryId: categories.items[0]!.id,
      costPrice: 400,
      sellingPrice: 650,
      barcode: "FLT-001",
      stockOnHand: 12,
    });
    expect(item.stockOnHand).toBe(12);
    const listed = await client.itemsList();
    expect(listed.items.find((i) => i.id === item.id)?.stockOnHand).toBe(12);
  });
});

describe("ticket 28 follow-ups from test audit", () => {
  it("two concurrent creates with the same barcode resolve as BARCODE_EXISTS, not a raw error", async () => {
    const categories = await client.categoriesList();
    const catId = categories.items[0]!.id;
    const results = await Promise.allSettled([
      client.itemsCreate({ name: "سباق 1", categoryId: catId, costPrice: 10, sellingPrice: 20, barcode: "RACE-1" }),
      client.itemsCreate({ name: "سباق 2", categoryId: catId, costPrice: 30, sellingPrice: 40, barcode: "RACE-1" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0]!.reason)).toMatch(/BARCODE_EXISTS/);
  });

  it("rejects catalogSearch input that violates the schema boundaries", async () => {
    await expect(client.catalogSearch({ query: "" })).rejects.toThrow();
    await expect(client.catalogSearch({ query: "x".repeat(129) })).rejects.toThrow();
  });
});

describe("stock ledger (ticket 27)", () => {
  async function makeItem(name: string, costPrice: number) {
    const categories = await client.categoriesList();
    return client.itemsCreate({
      name,
      categoryId: categories.items[0]!.id,
      costPrice,
      sellingPrice: costPrice * 2,
      lowStockThreshold: 0, // keep the shared dashboard deterministic
    });
  }

  it("rejects an oversell with STOCK_NEGATIVE and leaves the ledger untouched", async () => {
    const item = await makeItem("ledger-oversell", 100);
    const before = await client.itemsHistory({ itemId: item.id });
    expect(before.movements.length).toBe(0);

    let code = "";
    try {
      await client.stockAddManual({ itemId: item.id, delta: -5 });
    } catch (err) {
      // SAFETY: oRPC surfaces server ORPCError messages as err.message
      code = (err as Error).message;
    }
    expect(code).toContain("STOCK_NEGATIVE");

    const after = await client.itemsHistory({ itemId: item.id });
    expect(after.movements.length).toBe(0); // append-only integrity under rejection
  });

  it("defaults inflow unit cost to the item's current cost when omitted", async () => {
    const item = await makeItem("ledger-fallback-cost", 200);
    await client.stockAddManual({ itemId: item.id, delta: 4 }); // no unitCost
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements).toHaveLength(1);
    expect(history.movements[0]!.unitCost).toBe(200);
    expect(history.movements[0]!.stockAfter).toBe(4);
  });

  it("blends weighted-average cost on inflow and writes back atomically", async () => {
    const item = await makeItem("ledger-avg-blend", 500);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 500 });
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 700 });

    const list = await client.itemsList();
    const blended = list.items.find((i) => i.id === item.id)!;
    expect(blended.stockOnHand).toBe(20);
    expect(blended.costPrice).toBe(600); // ADR-0002 weighted average

    // outflow leaves the average untouched but derives remaining stock
    await client.stockAddManual({ itemId: item.id, delta: -6 });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements.at(-1)!.stockAfter).toBe(14);
    const afterSale = (await client.itemsList()).items.find((i) => i.id === item.id)!;
    expect(afterSale.costPrice).toBe(600);
    // outflow rows carry no unit cost — a meaningless fact otherwise
    expect(history.movements.at(-1)!.unitCost).toBeNull();
  });

  it("rejects out-of-range deltas before touching the store", async () => {
    const item = await makeItem("ledger-range", 100);
    let rejected = false;
    try {
      await client.stockAddManual({ itemId: item.id, delta: 2_000_000 });
    } catch {
      rejected = true; // zod input validation must refuse absurd magnitudes
    }
    expect(rejected).toBe(true);
    expect(await client.itemsHistory({ itemId: item.id })).toEqual({
      movements: [],
      stockOnHand: 0,
    });
  });
});

describe("stock ledger — backdated inflows (greptile P1)", () => {
  it("recomputes cost from ledger layers instead of blending against present holdings", async () => {
    const categories = await client.categoriesList();
    const item = await client.itemsCreate({
      name: "ledger-backdated",
      categoryId: categories.items[0]!.id,
      costPrice: 100,
      sellingPrice: 250,
      lowStockThreshold: 0,
    });

    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100 });
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 200 });
    // chronological inflow blends the ADR-0002 average
    let row = (await client.itemsList()).items.find((i) => i.id === item.id)!;
    expect(row.costPrice).toBe(150);

    // now insert an inflow BACKDATED before both existing movements
    await client.stockAddManual({
      itemId: item.id,
      delta: 5,
      unitCost: 50,
      occurredAt: "2020-01-01T08:00:00",
    });

    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements).toHaveLength(3);
    expect(history.movements[0]).toMatchObject({ unitCost: 50, stockAfter: 5 }); // sorted first
    expect(history.stockOnHand).toBe(25);

    // layers after insertion: 5@50, 10@100, 10@200 → value 3250 / qty 25 → 130
    row = (await client.itemsList()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(25);
    expect(row.costPrice).toBe(130);

  });
});

describe("backups (ticket 13)", () => {
  it("rejects backupManual without a session", async () => {
    await expect(unauthed.backupManual()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("exports a copy under dataDir/backups and logs BACKUP_CREATED", async () => {
    const result = await client.backupManual();

    // file exists under the configured data dir with the daily name shape
    expect(result.path).toContain(path.join("backups", ""));
    expect(path.basename(result.path)).toMatch(/^dokan-\d{4}-\d{2}-\d{2}\.db$/);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    // the audit entry lands after the copy succeeds (checked through the
    // store directly: activitiesList is ticket #12's seam, still a stub)
    const activities = await store.listActivities(10);
    const backupEntry = activities.find((a) => a.type === "BACKUP_CREATED");
    expect(backupEntry).toBeDefined();
    expect(backupEntry!.ref).toBe(result.path);
  });
});

describe("activity log (ticket 12)", () => {
  it("rejects activitiesList without a session", async () => {
    await expect(unauthed.activitiesList({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("lists real-flow entries newest first with a working limit clamp", async () => {
    // three distinct flows in a known order: category -> item -> stock adjustment
    const categories = await client.categoriesList();
    const created = await client.itemsCreate({
      name: "activity-log-probe",
      categoryId: categories.items[0]!.id,
      costPrice: 100,
      sellingPrice: 200,
      lowStockThreshold: 0,
    });
    await client.stockAddManual({ itemId: created.id, delta: 3 });

    const all = await client.activitiesList({});
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    // newest first: the stock adjustment is the latest entry
    expect(all.items[0]!.type).toBe("STOCK_ADJUSTED");
    expect(all.items[0]!.summary).toContain("activity-log-probe");
    // the item creation comes before the adjustment
    const typesInOrder = all.items.slice(0, 2).map((a) => a.type);
    expect(typesInOrder).toEqual(["STOCK_ADJUSTED", "ITEM_CREATED"]);
    // every row carries an Algeria-local timestamp
    for (const entry of all.items) {
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }

    // limit clamps the page size
    const limited = await client.activitiesList({ limit: 1 });
    expect(limited.items).toHaveLength(1);
    expect(limited.items[0]!.type).toBe("STOCK_ADJUSTED");

    // out-of-range limits are rejected by zod before touching the store
    await expect(client.activitiesList({ limit: 0 })).rejects.toThrow();
    await expect(client.activitiesList({ limit: 201 })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ticket 29 — purchase intake & deferred invoice linking
// ---------------------------------------------------------------------------
describe("purchase intake (ticket 29)", () => {
  async function makeItem(name: string, costPrice: number) {
    const categories = await client.categoriesList();
    return client.itemsCreate({
      name,
      categoryId: categories.items[0]!.id,
      costPrice,
      sellingPrice: costPrice * 2,
      lowStockThreshold: 0,
    });
  }

  it("rejects unauthed invoicesCreate with UNAUTHORIZED", async () => {
    await expect(
      unauthed.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: "00000000-0000-4000-8000-000000000000", quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("keeps SALE a stable stub owned by ticket #30", async () => {
    const item = await makeItem("بيع-غير-منفذ", 100);
    await expect(client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }] })).rejects.toThrow(/SALE_NOT_IMPLEMENTED/);
    // the rejection must not have written anything
    expect(await client.itemsHistory({ itemId: item.id })).toEqual({ movements: [], stockOnHand: 0 });
  });

  it("rejects an unknown line item before any write (ITEM_NOT_FOUND)", async () => {
    await expect(
      client.invoicesCreate({
        kind: "PURCHASE",
        lines: [{ itemId: "00000000-0000-4000-8000-000000000001", quantity: 2 }],
      }),
    ).rejects.toThrow(/ITEM_NOT_FOUND/);
  });

  it("rejects paid-above-total with PAID_EXCEEDS_TOTAL", async () => {
    const item = await makeItem("دفع-زائد", 100);
    await expect(
      client.invoicesCreate({
        kind: "PURCHASE",
        lines: [{ itemId: item.id, quantity: 2, unitPrice: 100 }],
        initialPaid: 201,
      }),
    ).rejects.toThrow(/PAID_EXCEEDS_TOTAL/);
  });

  it("records a multi-line PURCHASE invoice through the ledger with paid/partial math", async () => {
    const a = await makeItem("شراء-سطر-أ", 200);
    const b = await makeItem("شراء-سطر-ب", 300);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      counterpartyName: "مورد القطع",
      initialPaid: 1000,
      lines: [
        { itemId: a.id, quantity: 5, unitPrice: 200 },
        { itemId: b.id, quantity: 10, unitPrice: 300 },
      ],
    });
    expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}$/u);
    expect(invoice.totalAmount).toBe(5 * 200 + 10 * 300); // 4000
    expect(invoice.paidAmount).toBe(1000);
    expect(invoice.remainingAmount).toBe(3000);
    expect(invoice.lines).toHaveLength(2);
    // for a PURCHASE the line price IS the cost basis
    for (const line of invoice.lines) {
      expect(line.costAtSale).toBe(line.unitPrice);
    }

    // one PURCHASE movement per line, attributed to the invoice
    const historyA = await client.itemsHistory({ itemId: a.id });
    expect(historyA.movements.filter((m) => m.ref === invoice.id)).toHaveLength(1);
    expect(historyA.movements.find((m) => m.ref === invoice.id)).toMatchObject({ kind: "PURCHASE", delta: 5, unitCost: 200 });
    const historyB = await client.itemsHistory({ itemId: b.id });
    expect(historyB.movements.find((m) => m.ref === invoice.id)).toMatchObject({ kind: "PURCHASE", delta: 10, unitCost: 300 });
    expect(historyB.stockOnHand).toBe(10);

    // cached fast path follows the replay
    const listed = (await client.itemsList()).items;
    expect(listed.find((i) => i.id === a.id)!.stockOnHand).toBe(5);
    expect(listed.find((i) => i.id === b.id)!.costPrice).toBe(300);

    // invoicesGet / invoicesList round-trip
    expect((await client.invoicesGet({ id: invoice.id })).id).toBe(invoice.id);
    const list = await client.invoicesList({ kind: "PURCHASE" });
    expect(list.items.some((i) => i.id === invoice.id)).toBe(true);
  });

  it("blends the weighted average when later inflows land on an invoiced item", async () => {
    const item = await makeItem("شراء-خلط", 200);
    await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 4, unitPrice: 250 }] });
    await client.stockAddManual({ itemId: item.id, delta: 4, unitCost: 350, kind: "PURCHASE" });
    // (4×250 + 4×350) / 8 = 300
    const row = (await client.itemsList()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(8);
    expect(row.costPrice).toBe(300);
  });

  it("quick stock without an invoice lands as a PURCHASE movement (ref=null)", async () => {
    const item = await makeItem("مخزون-بدون-فاتورة", 500);
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 500, kind: "PURCHASE" });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements[0]).toMatchObject({ kind: "PURCHASE", delta: 3, unitCost: 500, ref: null });
  });

  it("rejects a PURCHASE outflow with PURCHASE_REQUIRES_INFLOW", async () => {
    const item = await makeItem("مشتريات-سالب", 100);
    let code = "";
    try {
      await client.stockAddManual({ itemId: item.id, delta: -2, kind: "PURCHASE" });
    } catch (err) {
      // SAFETY: oRPC surfaces server ORPCError messages as err.message
      code = (err as Error).message;
    }
    expect(code).toContain("PURCHASE_REQUIRES_INFLOW");
    expect(await client.itemsHistory({ itemId: item.id })).toEqual({ movements: [], stockOnHand: 0 });
  });

  it("proposes FIFO availability, links partially, and mints one remainder movement", async () => {
    const item = await makeItem("ربط-تدفق", 400);
    // goods arrived earlier without any invoice
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 500, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      lines: [{ itemId: item.id, quantity: 5, unitPrice: 450 }],
    });

    // proposal is read-only: 3 uninvoiced vs a 5-unit line
    const proposal = await client.purchasesProposal({ invoiceId: invoice.id });
    expect(proposal.invoiceId).toBe(invoice.id);
    expect(proposal.items[0]).toMatchObject({
      itemName: item.name,
      lineQuantity: 5,
      uninvoicedQty: 3,
      proposedLinkQty: 3,
      remainderQty: 2,
    });
    // read-only: no ledger rows appeared
    expect((await client.itemsHistory({ itemId: item.id })).movements).toHaveLength(2);

    const result = await client.purchasesLinkStock({
      invoiceId: invoice.id,
      allocations: [{ itemId: item.id, quantity: 5 }],
    });
    expect(result.linked).toBe(3);
    expect(result.remainderMoved).toBe(2);

    const history = await client.itemsHistory({ itemId: item.id });
    // +3 manual +5 intake +2 remainder — never double-counted
    expect(history.stockOnHand).toBe(10);
    const remainders = history.movements.filter((m) => (m.reason ?? "").includes("ربط بفاتورة"));
    expect(remainders).toHaveLength(1);
    expect(remainders[0]).toMatchObject({ kind: "PURCHASE", delta: 2, ref: invoice.id });

    // idempotent re-link: capped at what the line still misses → nothing minted
    const again = await client.purchasesLinkStock({
      invoiceId: invoice.id,
      allocations: [{ itemId: item.id, quantity: 5 }],
    });
    expect(again.linked).toBe(0);
    expect(again.remainderMoved).toBe(0);
    const after = await client.itemsHistory({ itemId: item.id });
    expect(after.movements).toHaveLength(history.movements.length);
  });

  it("rejects allocations beyond the line with LINK_EXCEEDS_LINE", async () => {
    const item = await makeItem("ربط-تجاوز", 100);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      lines: [{ itemId: item.id, quantity: 2, unitPrice: 100 }],
    });
    await expect(
      client.purchasesLinkStock({ invoiceId: invoice.id, allocations: [{ itemId: item.id, quantity: 3 }] }),
    ).rejects.toThrow(/LINK_EXCEEDS_LINE/);
  });

  it("correcting a saved purchase cost appends history and replays the weighted average", async () => {
    const item = await makeItem("تصحيح-تكلفة", 100);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      lines: [{ itemId: item.id, quantity: 10, unitPrice: 100 }],
    });
    // settled outflow keeps its original basis
    await client.stockAddManual({ itemId: item.id, delta: -4 });
    const before = await client.itemsHistory({ itemId: item.id });

    const corrected = await client.purchasesCorrectLine({
      lineId: invoice.lines[0]!.id,
      quantity: 10,
      unitCost: 300,
    });
    expect(corrected.id).toBe(invoice.id);

    const after = await client.itemsHistory({ itemId: item.id });
    expect(after.movements.length).toBe(before.movements.length + 2); // append-only pair
    // earlier rows are untouched — corrections never rewrite facts
    expect(after.movements.slice(0, before.movements.length)).toEqual(before.movements);

    // replay: +10@100, −4 sold, then correction pair (+10@300 before the −10
    // reversal) leaves 6 units whose average follows ADR-0002:
    // (100×6 + 300×10) / 16 = 225
    const row = (await client.itemsList()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(6);
    expect(row.costPrice).toBe(225);
  });

  it("rejects a correction that would oversell with STOCK_NEGATIVE and writes nothing", async () => {
    const item = await makeItem("تصحيح-سالب", 100);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      lines: [{ itemId: item.id, quantity: 5, unitPrice: 100 }],
    });
    // sell 4 of the 5 invoiced units; correcting the line down to 2 would
    // claim fewer units ever arrived than were already sold
    await client.stockAddManual({ itemId: item.id, delta: -4 });
    const before = await client.itemsHistory({ itemId: item.id });

    let code = "";
    try {
      await client.purchasesCorrectLine({ lineId: invoice.lines[0]!.id, quantity: 2, unitCost: 120 });
    } catch (err) {
      // SAFETY: oRPC surfaces server ORPCError messages as err.message
      code = (err as Error).message;
    }
    expect(code).toContain("STOCK_NEGATIVE");

    const after = await client.itemsHistory({ itemId: item.id });
    expect(after.movements).toEqual(before.movements); // ledger untouched
  });

  it("rejects corrections for unknown lines with LINE_NOT_FOUND", async () => {
    await expect(
      client.purchasesCorrectLine({ lineId: "00000000-0000-4000-8000-000000000002", quantity: 1, unitCost: 50 }),
    ).rejects.toThrow(/LINE_NOT_FOUND/);
  });
});
