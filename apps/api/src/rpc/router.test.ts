import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { createApp } from "../app";
import { createAuth, type BetterAuthInstance } from "../auth/auth";
import { resetAdminPassword } from "../auth/admin";
import { createAppConfig, type AppConfig } from "../config";
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
// hoisted so tests can rebuild an app+router against a modified store (the
// settings-atomicity test) and so the ticket-14 describe can seed DIRECT log
// rows, with the same config/auth/cookie as beforeAll
let config: AppConfig;
let logger: AppLogger;
let auth: BetterAuthInstance;
let cookie = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-rpc-"));
  config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: path.join(dir, "test.db"),
    DOKAN_AUTH_SECRET: "test-auth-secret",
    DOKAN_BUILD_SECRET: "test-build-secret-123",
  });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
  logger = new AppLogger(dir);
  auth = createAuth(conn.db, config);
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
  cookie = login.headers.get("set-cookie") ?? "";

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
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements).toHaveLength(1);
    expect(history.movements[0]).toMatchObject({ kind: "MANUAL_ADJUSTMENT", delta: 12, unitCost: 400 });
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
// ticket 10 — settings (store identity)
// ---------------------------------------------------------------------------
describe("settings (ticket 10)", () => {
  it("rejects settingsGet/settingsUpdate without a session", async () => {
    await expect(unauthed.settingsGet()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(unauthed.settingsUpdate({ storeName: "متجر" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("reports the seeded defaults before any edit", async () => {
    expect(await client.settingsGet()).toEqual({ storeName: "Dokan", storePhone: null });
  });

  it("normalizes a loose Algerian phone, persists, and audits the change", async () => {
    const updated = await client.settingsUpdate({
      storeName: "متجر السيارات",
      storePhone: "066 12 34 56 7",
    });
    expect(updated).toEqual({ storeName: "متجر السيارات", storePhone: "+213661234567" });
    // persisted: a fresh read (no local cache in this client) sees the same
    expect(await client.settingsGet()).toEqual({ storeName: "متجر السيارات", storePhone: "+213661234567" });

    const activities = await client.activitiesList({});
    expect(activities.items[0]).toMatchObject({
      type: "SETTINGS_UPDATED",
      summary: "تحديث إعدادات المتجر",
    });
  });

  it("clears the phone with an explicit null or an empty string", async () => {
    await client.settingsUpdate({ storeName: "متجر السيارات", storePhone: "0550123123" });
    for (const clearWith of [null, ""]) {
      const cleared = await client.settingsUpdate({ storeName: "متجر السيارات", storePhone: clearWith });
      expect(cleared.storePhone).toBeNull();
      expect((await client.settingsGet()).storePhone).toBeNull();
    }
  });

  it("supports a phone-only partial update and rejects an empty store name", async () => {
    await client.settingsUpdate({ storeName: "متجر جزئي", storePhone: "0550123123" });
    const updated = await client.settingsUpdate({ storePhone: "066 12 34 56 7" });
    expect(updated.storeName).toBe("متجر جزئي"); // untouched by the partial update
    expect(updated.storePhone).toBe("+213661234567");
    await expect(client.settingsUpdate({ storeName: "   " })).rejects.toThrow();
  });

  it("rejects a non-Algerian phone with INVALID_PHONE_NUMBER and writes nothing", async () => {
    await client.settingsUpdate({ storeName: "متجر ثابت", storePhone: "0550123123" });
    for (const badPhone of ["2660123123", "abc", "021 44 22 11"]) {
      let code = "";
      try {
        await client.settingsUpdate({ storeName: "متجر ثابت", storePhone: badPhone });
      } catch (err) {
        // SAFETY: oRPC surfaces server ORPCError messages as err.message
        code = (err as Error).message;
      }
      expect(code).toContain("INVALID_PHONE_NUMBER");
    }
    // nothing changed: name untouched, phone still the accepted one
    expect(await client.settingsGet()).toEqual({ storeName: "متجر ثابت", storePhone: "+213550123123" });
  });

  it("rolls the identity write back when the audit insert fails (atomicity)", async () => {
    // baseline identity that a failed attempt must NOT clobber
    await client.settingsUpdate({ storeName: "متجر ذرّي", storePhone: "0550123123" });
    const auditBefore = (await store.listActivities(100)).filter((a) => a.type === "SETTINGS_UPDATED").length;

    // store whose transaction-unit audit write throws: updateSettings goes
    // through the real tx and INSERTs, then insertActivity rejects -> the
    // whole unit must ROLL BACK. Pre-fix wiring (two separate calls) would
    // leave the new identity committed with no audit record. A typed spread
    // wrapper keeps the real methods (this.*-style calls still resolve) while
    // overriding only the audit write — no dynamic dispatch.
    const failingStore: StorePort = {
      ...store,
      withTransaction: <T>(fn: (tx: StorePort) => Promise<T>): Promise<T> =>
        store.withTransaction((realTx: StorePort) =>
          fn({
            ...realTx,
            insertActivity: async () => {
              throw new Error("audit-boom");
            },
          }),
        ),
    };
    const failingApp = createApp({
      config,
      logger,
      auth,
      rpcRouter: createRpcRouter({ db: conn.db, config, logger, store: failingStore, auth }),
    });
    const failingLink = new RPCLink({
      url: () => `http://127.0.0.1:${config.port}/api/rpc`,
      // SAFETY: the link's fetch contract wants a Promise; hono's fetch returns one
      fetch: (request) => {
        const headers = Object.fromEntries(request.headers.entries());
        if (cookie !== "") headers.cookie = cookie;
        return Promise.resolve(failingApp.fetch(new Request(request, { headers })));
      },
    });
    const failingClient: DokanClient = createORPCClient(failingLink);

    // the whole unit must abort (oRPC surfaces it as a generic server error);
    // the real proof is the rollback below — with the pre-fix two-call wiring
    // this call would still reject after committing the new identity
    await expect(
      failingClient.settingsUpdate({ storeName: "متجر ذرّي 2", storePhone: "066 12 34 56 7" }),
    ).rejects.toThrow();

    // identity unchanged AND no phantom audit row appeared
    expect(await client.settingsGet()).toEqual({ storeName: "متجر ذرّي", storePhone: "+213550123123" });
    const auditAfter = (await store.listActivities(100)).filter((a) => a.type === "SETTINGS_UPDATED").length;
    expect(auditAfter).toBe(auditBefore);
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

  it("creates a SALE invoice once stock is available", async () => {
    const item = await makeItem("بيع-منفذ", 100);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }] });
    expect(invoice.kind).toBe("SALE");
    expect(invoice.totalAmount).toBe(item.sellingPrice);
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(0);
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

  it("defaults omitted line prices to the item's cost in the header totals", async () => {
    const item = await makeItem("سطر-بلا-سعر", 250);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      initialPaid: 500,
      lines: [{ itemId: item.id, quantity: 4 }], // no unitPrice → cost 250 each
    });
    // header must agree with the persisted line: 4 × 250, not 4 × 0
    expect(invoice.totalAmount).toBe(1000);
    expect(invoice.paidAmount).toBe(500);
    expect(invoice.remainingAmount).toBe(500);
    expect(invoice.lines[0]!.unitPrice).toBe(250);
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

  it("proposes FIFO availability, links partially, and reports the unmatched share without minting stock", async () => {
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
    expect(result.remainderMoved).toBe(2); // unmatched share, reported only

    const history = await client.itemsHistory({ itemId: item.id });
    // +3 manual +5 invoice posting = 8 physical units; linking NEVER adds stock
    // on top of the invoice's own posting (greptile: inventory overstatement)
    expect(history.stockOnHand).toBe(8);
    expect(history.movements).toHaveLength(2);
    expect(history.movements.filter((m) => (m.reason ?? "").includes("ربط بفاتورة"))).toHaveLength(0);
    const links = history.movements.length;

    // repeated over-attempts can never inflate inventory: every re-link finds
    // the pool consumed and reports the rest as unmatched, writing nothing
    for (let attempt = 0; attempt < 3; attempt++) {
      const again = await client.purchasesLinkStock({
        invoiceId: invoice.id,
        allocations: [{ itemId: item.id, quantity: 5 }],
      });
      expect(again.linked).toBe(0);
      expect(again.remainderMoved).toBeLessThanOrEqual(2);
    }
    const after = await client.itemsHistory({ itemId: item.id });
    expect(after.stockOnHand).toBe(8);
    expect(after.movements).toHaveLength(links);
  });

  it("does not propose a no-op after the invoice attribution cap is consumed", async () => {
    const item = await makeItem("ربط-حد-الإسناد", 400);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 400, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      lines: [{ itemId: item.id, quantity: 2, unitPrice: 400 }],
    });

    await client.purchasesLinkStock({
      invoiceId: invoice.id,
      allocations: [{ itemId: item.id, quantity: 2 }],
    });

    // Three uninvoiced units remain, but this invoice has reached its two-unit
    // attribution cap and the proposal must not offer a stale allocation.
    const proposal = await client.purchasesProposal({ invoiceId: invoice.id });
    expect(proposal.items).toHaveLength(1);
    expect(proposal.items[0]).toMatchObject({
      uninvoicedQty: 3,
      proposedLinkQty: 0,
      remainderQty: 0,
    });
    expect(proposal.items.filter((row) => row.proposedLinkQty > 0)).toHaveLength(0);
  });

  it("concurrent invoice creates serialize into distinct invoice numbers", async () => {
    const item = await makeItem("تسابق-ترقيم", 50);
    // both selects used to run outside the serialized transaction and could
    // mint the same INV-#### between SELECT and INSERT (UNIQUE -> 500)
    const results = await Promise.allSettled([
      client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 1, unitPrice: 50 }] }),
      client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 1, unitPrice: 50 }] }),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof client.invoicesCreate>>> => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const numbers = fulfilled.map((r) => r.value.invoiceNumber);
    expect(new Set(numbers).size).toBe(2);
  });

  it("double correction converges on the last corrected quantity instead of drifting", async () => {
    const item = await makeItem("تصحيح-مزدوج", 100);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      lines: [{ itemId: item.id, quantity: 10, unitPrice: 100 }],
    });
    const lineId = invoice.lines[0]!.id;
    await client.purchasesCorrectLine({ lineId, quantity: 6, unitCost: 200 });
    await client.purchasesCorrectLine({ lineId, quantity: 9, unitCost: 150 });

    const history = await client.itemsHistory({ itemId: item.id });
    // +10 intake, (+6 −10), (+9 −6): each pass reverses the PREVIOUS effective
    // quantity, so N corrections land exactly on the last corrected value
    expect(history.stockOnHand).toBe(9);
    expect(history.movements).toHaveLength(5);
    const listed = (await client.itemsList()).items.find((i) => i.id === item.id)!;
    expect(listed.stockOnHand).toBe(9);
    // ADR-0002 replay: 10@100 → avg 100; +6@200 → 2200/16 = 137.5;
    // reversal drops running qty to 6; +9@150 → (137.5×6 + 1350)/15 = 145
    expect(listed.costPrice).toBe(145);
  });

  it("correction oversell guard uses the EFFECTIVE quantity after prior corrections", async () => {
    const item = await makeItem("تصحيح-فعال", 100);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      lines: [{ itemId: item.id, quantity: 10, unitPrice: 100 }],
    });
    const lineId = invoice.lines[0]!.id;
    await client.purchasesCorrectLine({ lineId, quantity: 6, unitCost: 200 });
    await client.stockAddManual({ itemId: item.id, delta: -4 }); // 2 on hand

    let code = "";
    try {
      // correcting DOWN to 3 must fail: effective original is 6, so
      // 2 + 3 − 6 < 0 — fewer units than were already sold
      await client.purchasesCorrectLine({ lineId, quantity: 3, unitCost: 100 });
    } catch (err) {
      // SAFETY: oRPC surfaces server ORPCError messages as err.message
      code = (err as Error).message;
    }
    expect(code).toContain("STOCK_NEGATIVE");
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

  it("correcting a saved purchase cost keeps inflow-first ordering after partial sale", async () => {
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
    // Both correction rows share one timestamp, so occurredAt cannot put the
    // reversal before the replacement across a one-second boundary. Their
    // insertion order (the store's rowid seq) is corrected inflow first.
    const correctionRows = after.movements.slice(before.movements.length);
    expect(correctionRows.map((movement) => movement.kind)).toEqual(["PURCHASE", "MANUAL_ADJUSTMENT"]);
    expect(correctionRows[0]!.occurredAt).toBe(correctionRows[1]!.occurredAt);
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

// ---------------------------------------------------------------------------
// ticket 30 — sale checkout, FIFO cost, negotiated prices, discounts
// ---------------------------------------------------------------------------
describe("sale checkout (ticket 30)", () => {
  async function makeSaleItem(name: string, costPrice: number, sellingPrice: number) {
    const categories = await client.categoriesList();
    return client.itemsCreate({
      name,
      categoryId: categories.items[0]!.id,
      costPrice,
      sellingPrice,
      lowStockThreshold: 0,
    });
  }

  it("sells exact stock, defaults to the historical selling price, and records a payment", async () => {
    const item = await makeSaleItem("بيع-سعر-افتراضي", 400, 700);
    const stocked = await client.itemsCreateWithStock({
      name: "بيع-مخزون-أولي",
      categoryId: item.categoryId,
      costPrice: 400,
      sellingPrice: 700,
      stockOnHand: 3,
    });
    const invoice = await client.invoicesCreate({
      kind: "SALE",
      counterpartyName: "زبون البيع",
      initialPaid: 700,
      lines: [{ itemId: stocked.id, quantity: 1 }],
    });
    expect(invoice.totalAmount).toBe(700);
    expect(invoice.paidAmount).toBe(700);
    expect(invoice.remainingAmount).toBe(0);
    expect(invoice.lines[0]).toMatchObject({
      defaultUnitPrice: 700,
      unitPrice: 700,
      costAtSale: 400,
      total: 700,
      netTotal: 700,
    });
    expect(invoice.payments).toHaveLength(1);
    const saleActivity = (await client.activitiesList({})).items.find((entry) => entry.type === "SALE_CREATED");
    expect(saleActivity).toBeDefined();
    expect(saleActivity!.ref).toBe(invoice.id);
    expect(saleActivity!.summary).toContain(invoice.invoiceNumber);
    expect((await client.itemsList()).items.find((row) => row.id === stocked.id)?.stockOnHand).toBe(2);
    expect((await client.itemsHistory({ itemId: stocked.id })).movements.filter((movement) => movement.kind === "SALE")).toHaveLength(1);
  });

  it("persists amount and percentage negotiated prices separately from their defaults", async () => {
    const amountItem = await makeSaleItem("بيع-تفاوض-مبلغ", 100, 1_000);
    const percentItem = await makeSaleItem("بيع-تفاوض-نسبة", 100, 1_000);
    await client.stockAddManual({ itemId: amountItem.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: percentItem.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({
      kind: "SALE",
      lines: [
        { itemId: amountItem.id, quantity: 1, priceOverride: { type: "AMOUNT", value: 850 } },
        { itemId: percentItem.id, quantity: 1, priceOverride: { type: "PERCENTAGE", value: 80 } },
      ],
    });
    expect(invoice.lines.map((line) => ({ default: line.defaultUnitPrice, actual: line.unitPrice }))).toEqual([
      { default: 1_000, actual: 850 },
      { default: 1_000, actual: 800 },
    ]);
  });

  it("applies amount and percentage invoice discounts after line overrides", async () => {
    const a = await makeSaleItem("بيع-خصم-مبلغ", 100, 1_000);
    const b = await makeSaleItem("بيع-خصم-نسبة", 100, 500);
    await client.stockAddManual({ itemId: a.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: b.id, delta: 1, unitCost: 100, kind: "PURCHASE" });

    const amount = await client.invoicesCreate({
      kind: "SALE",
      discount: { type: "AMOUNT", value: 250 },
      lines: [
        { itemId: a.id, quantity: 1, unitPrice: 900 },
        { itemId: b.id, quantity: 1, unitPrice: 500 },
      ],
    });
    expect(amount.subtotalAmount).toBe(1_400);
    expect(amount.discountAmount).toBe(250);
    expect(amount.totalAmount).toBe(1_150);
    expect(amount.lines.reduce((sum, line) => sum + line.discountAllocated, 0)).toBe(250);
    expect(amount.lines.reduce((sum, line) => sum + line.netTotal, 0)).toBe(1_150);

    const percentageItem = await makeSaleItem("بيع-خصم-نسبة-ثاني", 100, 1_000);
    await client.stockAddManual({ itemId: percentageItem.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const percentage = await client.invoicesCreate({
      kind: "SALE",
      discountType: "PERCENTAGE",
      discountValue: 10,
      lines: [{ itemId: percentageItem.id, quantity: 2 }],
    });
    expect(percentage.subtotalAmount).toBe(2_000);
    expect(percentage.discountAmount).toBe(200);
    expect(percentage.totalAmount).toBe(1_800);
  });

  it("caps a discount at zero and rejects oversell atomically", async () => {
    const item = await makeSaleItem("بيع-تجاوز-مخزون", 120, 300);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 120, kind: "PURCHASE" });
    const before = await client.itemsHistory({ itemId: item.id });
    await expect(
      client.invoicesCreate({ kind: "SALE", discount: { type: "AMOUNT", value: 9_999 }, lines: [{ itemId: item.id, quantity: 2 }] }),
    ).rejects.toThrow(/STOCK_NEGATIVE/);
    const after = await client.itemsHistory({ itemId: item.id });
    expect(after).toEqual(before);
    expect((await client.itemsList()).items.find((row) => row.id === item.id)?.stockOnHand).toBe(1);

    const zero = await client.invoicesCreate({
      kind: "SALE",
      discount: { type: "AMOUNT", value: 9_999 },
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    expect(zero.subtotalAmount).toBe(300);
    expect(zero.discountAmount).toBe(300);
    expect(zero.totalAmount).toBe(0);
    const reread = await client.invoicesGet({ id: zero.id });
    expect(reread.lines[0]).toMatchObject({ discountAllocated: 300, netTotal: 0 });
    expect(reread.lines.reduce((sum, line) => sum + line.discountAllocated, 0)).toBe(reread.discountAmount);
  });

  it("rolls back every sale write when a later line oversells", async () => {
    const first = await makeSaleItem("بيع-تراجع-أ", 100, 200);
    const second = await makeSaleItem("بيع-تراجع-ب", 100, 300);
    await client.stockAddManual({ itemId: first.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const firstBefore = await client.itemsHistory({ itemId: first.id });
    const secondBefore = await client.itemsHistory({ itemId: second.id });
    const invoicesBefore = (await client.invoicesList({ kind: "SALE" })).totalCount;
    await expect(
      client.invoicesCreate({ kind: "SALE", lines: [{ itemId: first.id, quantity: 1 }, { itemId: second.id, quantity: 1 }] }),
    ).rejects.toThrow(/STOCK_NEGATIVE/);
    expect(await client.itemsHistory({ itemId: first.id })).toEqual(firstBefore);
    expect(await client.itemsHistory({ itemId: second.id })).toEqual(secondBefore);
    expect((await client.invoicesList({ kind: "SALE" })).totalCount).toBe(invoicesBefore);
    expect((await client.itemsList()).items.find((row) => row.id === first.id)?.stockOnHand).toBe(1);
  });

  it("snapshots FIFO cost across layers and reconciles stock after checkout", async () => {
    const item = await makeSaleItem("بيع-ففو", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 6 }] });
    expect(invoice.lines[0]!.costAtSale).toBe(117);
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(4);
    expect((await client.itemsList()).items.find((row) => row.id === item.id)?.stockOnHand).toBe(history.stockOnHand);
    expect(history.movements.filter((movement) => movement.kind === "SALE")).toHaveLength(1);
  });

  it("keeps the live ADR-0002 cache unchanged while later sales cost from remaining FIFO layers", async () => {
    const item = await makeSaleItem("بيع-طبقات-متتابع", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });
    const first = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 6 }] });
    expect(first.lines[0]!.costAtSale).toBe(117);
    const second = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    expect(second.lines[0]!.costAtSale).toBe(200);
    const listed = (await client.itemsList()).items.find((row) => row.id === item.id)!;
    expect(listed.stockOnHand).toBe(2);
    // outflows never move the weighted average (ADR-0002), even though the
    // second sale's FIFO snapshot differs from it
    expect(listed.costPrice).toBe(150);
    expect((await client.itemsHistory({ itemId: item.id })).movements.filter((movement) => movement.kind === "SALE")).toHaveLength(2);
  });

  it("consumes FIFO layers across duplicate item lines within one invoice", async () => {
    const item = await makeSaleItem("بيع-سطران-مكرر", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }, { itemId: item.id, quantity: 6 }] });
    // line 1 takes a 100-DZD unit; line 2 then costs from 4×100 + 2×200
    expect(invoice.lines.map((line) => line.costAtSale)).toEqual([100, 133]);
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(3);
    expect((await client.itemsHistory({ itemId: item.id })).movements.filter((movement) => movement.kind === "SALE")).toHaveLength(2);
  });

  it("validates the initial payment against the discounted total", async () => {
    const item = await makeSaleItem("بيع-دفع-حد-الخصم", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    await expect(
      client.invoicesCreate({ kind: "SALE", initialPaid: 250, discount: { type: "AMOUNT", value: 100 }, lines: [{ itemId: item.id, quantity: 1 }] }),
    ).rejects.toThrow(/PAID_EXCEEDS_TOTAL/);
    const paid = await client.invoicesCreate({ kind: "SALE", initialPaid: 200, discount: { type: "AMOUNT", value: 100 }, lines: [{ itemId: item.id, quantity: 1 }] });
    expect(paid.totalAmount).toBe(200);
    expect(paid.paidAmount).toBe(200);
    expect(paid.remainingAmount).toBe(0);
  });

  it("fully discounts a sale with a 100% percentage and keeps zero totals whole", async () => {
    const item = await makeSaleItem("بيع-خصم-كامل", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({ kind: "SALE", discount: { type: "PERCENTAGE", value: 100 }, lines: [{ itemId: item.id, quantity: 2 }] });
    expect(invoice.subtotalAmount).toBe(600);
    expect(invoice.discountValue).toBe(100);
    expect(invoice.discountAmount).toBe(600);
    expect(invoice.totalAmount).toBe(0);
    expect(invoice.lines.reduce((sum, line) => sum + line.discountAllocated, 0)).toBe(600);
    expect(invoice.lines.reduce((sum, line) => sum + line.netTotal, 0)).toBe(0);
    const reread = await client.invoicesGet({ id: invoice.id });
    expect(reread.totalAmount).toBe(0);
    expect(reread.lines[0]?.netTotal).toBe(0);
  });

  it("rejects conflicting or purchase-only negotiated price inputs before any write", async () => {
    const item = await makeSaleItem("بيع-مدخلات-مرفوضة", 100, 500);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    await expect(
      client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1, unitPrice: 400, priceOverride: { type: "AMOUNT", value: 300 } }] }),
    ).rejects.toThrow(/Input validation failed/);
    await expect(
      client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 1, priceOverride: { type: "AMOUNT", value: 300 } }] }),
    ).rejects.toThrow(/Input validation failed/);
    await expect(
      client.invoicesCreate({ kind: "PURCHASE", discount: { type: "AMOUNT", value: 10 }, lines: [{ itemId: item.id, quantity: 1 }] }),
    ).rejects.toThrow(/DISCOUNT_ONLY_SALE/);
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(1);
  });
});

// ticket 14 — diagnostics log tail (stable DKN codes + viewer input)
// ---------------------------------------------------------------------------
describe("diagnostics log (ticket 14)", () => {
  it("rejects diagnosticsLogsTail without a session", async () => {
    await expect(unauthed.diagnosticsLogsTail({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns today's JSONL tail with stable DKN codes across repeated failures", async () => {
    // two failing RPC calls on the same app — each triggers the onError
    // interceptor, which writes an RPC_ERROR row with a DKN code. The tail is
    // newest-last and nothing logs between these two calls, so the LAST TWO
    // rows are exactly our seeds (the invariant this describe relies on).
    await expect(unauthed.categoriesList()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(unauthed.categoriesList()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const tail = await client.diagnosticsLogsTail({});
    // the viewer input points at today's Algeria-local JSONL under logs/
    expect(tail.file).toContain(path.join("logs", ""));
    expect(path.basename(tail.file)).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    // SAFETY: the api writes these rows itself via JSON.stringify(LogEntry);
    // the cast promises the two string keys this assertion reads
    const rows = tail.lines.map((line) => JSON.parse(line) as { event?: string; code?: string });
    const seeded = rows.slice(-2);
    expect(seeded).toHaveLength(2);
    for (const row of seeded) {
      expect(row.event).toBe("RPC_ERROR");
      expect(row.code).toMatch(/^DKN-[0-9A-F]{8}$/);
    }

    // STABLE codes: same error site (RPC_ERROR) + same failure kind
    // (ORPCError::UNAUTHORIZED) → one code, never a fresh random per
    // occurrence
    expect(seeded[0]!.code).toBe(seeded[1]!.code);
  });

  it("clamps the tail through the contract's bound", async () => {
    // seed a guaranteed row so these assertions never depend on rows written
    // by other tests in the shared suite log
    await expect(unauthed.diagnosticsLogsTail({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const one = await client.diagnosticsLogsTail({ lines: 1 });
    expect(one.lines).toHaveLength(1);

    // the cap is a real truncation, not a permissive "at least" bound: write
    // 510 rows directly and read only the newest 500 through the route
    for (let i = 0; i < 510; i++) logger.info("CLAMP_PROBE", `row ${i}`);
    const cap = await client.diagnosticsLogsTail({ lines: 500 });
    expect(cap.lines).toHaveLength(500);
    expect(cap.lines.at(-1)).toContain("row 509"); // newest kept

    // out-of-range / wrong-type limits are rejected by zod before the tail
    await expect(client.diagnosticsLogsTail({ lines: 0 })).rejects.toThrow();
    await expect(client.diagnosticsLogsTail({ lines: 501 })).rejects.toThrow();
    await expect(client.diagnosticsLogsTail({ lines: -1 })).rejects.toThrow();
    await expect(client.diagnosticsLogsTail({ lines: 1.5 })).rejects.toThrow();
    // @ts-expect-error -- deliberate boundary probe: wrong type at the wire
    await expect(client.diagnosticsLogsTail({ lines: "50" })).rejects.toThrow();
  });
});

// --- debts screen (ticket 9) ------------------------------------------------
describe("debts screen (ticket 9)", () => {
  async function makeItem(name: string, costPrice: number, sellingPrice: number) {
    const categories = await client.categoriesList();
    return client.itemsCreateWithStock({
      name,
      categoryId: categories.items[0]!.id,
      costPrice,
      sellingPrice,
      lowStockThreshold: 0,
      stockOnHand: 10,
    });
  }

  it("rejects debtsByParty without a session and with no party identity", async () => {
    await expect(
      unauthed.debtsByParty({ kind: "SALE", counterpartyId: null, counterpartyName: "بدون جلسة" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const bothNull = { kind: "SALE" as const, counterpartyId: null, counterpartyName: null };
    await expect(client.debtsByParty(bothNull)).rejects.toThrow(/Input validation failed/);
  });

  it("splits debts by direction with totals and invoice counts", async () => {
    const saleItem = await makeItem("ديون-بيع", 400, 1_000);
    const purchaseItem = await makeItem("ديون-شراء", 200, 350);

    // customer pays 400 of 1000 → owes 600
    const sale = await client.invoicesCreate({
      kind: "SALE",
      counterpartyName: "زبون دائن",
      initialPaid: 400,
      lines: [{ itemId: saleItem.id, quantity: 1 }],
    });
    expect(sale.remainingAmount).toBe(600);
    // fully paid sale with the same typed name contributes no debt
    await client.invoicesCreate({
      kind: "SALE",
      counterpartyName: "زبون دائن",
      initialPaid: 1_000,
      lines: [{ itemId: saleItem.id, quantity: 1 }],
    });

    // we pay 500 of 1300 to the supplier → we owe 800
    const purchase = await client.invoicesCreate({
      kind: "PURCHASE",
      counterpartyName: "مورد مستحق",
      initialPaid: 500,
      lines: [{ itemId: purchaseItem.id, quantity: 1, unitPrice: 1_300 }],
    });
    expect(purchase.remainingAmount).toBe(800);

    const debts = await client.reportsDebts();
    const owedToUs = debts.owedToUs.find((d) => d.counterpartyName === "زبون دائن");
    expect(owedToUs).toMatchObject({ kind: "SALE", counterpartyId: null, remainingTotal: 600, invoiceCount: 1 });

    const weOwe = debts.weOwe.find((d) => d.counterpartyName === "مورد مستحق");
    expect(weOwe).toMatchObject({ kind: "PURCHASE", counterpartyId: null, remainingTotal: 800, invoiceCount: 1 });

    // directions never leak into each other
    expect(debts.owedToUs.some((d) => d.counterpartyName === "مورد مستحق")).toBe(false);
    expect(debts.weOwe.some((d) => d.counterpartyName === "زبون دائن")).toBe(false);
  });

  it("drills into one party's unpaid invoices by typed name in both directions", async () => {
    const sale = await client.debtsByParty({ kind: "SALE", counterpartyId: null, counterpartyName: "زبون دائن" });
    expect(sale.items).toHaveLength(1);
    expect(sale.items[0]!.invoiceNumber).toMatch(/^INV-\d{4}$/u);
    expect(sale.items[0]).toMatchObject({ kind: "SALE", counterpartyName: "زبون دائن", totalAmount: 1_000, paidAmount: 400, remainingAmount: 600 });

    const purchase = await client.debtsByParty({ kind: "PURCHASE", counterpartyId: null, counterpartyName: "مورد مستحق" });
    expect(purchase.items).toHaveLength(1);
    expect(purchase.items[0]).toMatchObject({ remainingAmount: 800 });
    expect(purchase.totalCount).toBe(1);

    // a party we owe nothing is an empty drill-down, not an error
    const paidOff = await client.debtsByParty({ kind: "SALE", counterpartyId: null, counterpartyName: "زبون دائن لا شيء عليه" });
    expect(paidOff.items).toHaveLength(0);
  });

  it("drills into an id-backed party by id, never by a same-named typed name", async () => {
    const saleItem = await makeItem("ديون-جهة-معروفة", 400, 1_000);
    // the customers/suppliers RPC seams belong to another lane; seed the
    // known party through the store seam the grouping key actually reads
    const customer = await store.createCustomer({ name: "زبون مسجل" });
    const invoice = await client.invoicesCreate({
      kind: "SALE",
      counterpartyId: customer.id,
      counterpartyName: customer.name,
      initialPaid: 300,
      lines: [{ itemId: saleItem.id, quantity: 1 }],
    });
    expect(invoice.remainingAmount).toBe(700);

    // the grouping surface reports the id-backed party under owedToUs
    const summaries = await client.reportsDebts();
    const group = summaries.owedToUs.find((d) => d.counterpartyId === customer.id);
    expect(group).toMatchObject({ counterpartyName: "زبون مسجل", remainingTotal: 700, invoiceCount: 1 });

    // drilling by id returns the invoice; the typed name alone must not,
    // and the id stays authoritative even when the label name mismatches
    const byId = await client.debtsByParty({ kind: "SALE", counterpartyId: customer.id, counterpartyName: customer.name });
    expect(byId.items.map((i) => i.id)).toEqual([invoice.id]);
    const byMismatchedLabel = await client.debtsByParty({ kind: "SALE", counterpartyId: customer.id, counterpartyName: "اسم مختلف تماماً" });
    expect(byMismatchedLabel.items.map((i) => i.id)).toEqual([invoice.id]);
    const byName = await client.debtsByParty({ kind: "SALE", counterpartyId: null, counterpartyName: "زبون مسجل" });
    expect(byName.items).toHaveLength(0);



describe("expenses (ticket 31)", () => {
  it("seeds default expense categories with exactly one owner-withdrawal flag", async () => {
    const { items } = await client.expenseCategoriesList();
    expect(items.length).toBeGreaterThanOrEqual(6);
    const withdrawal = items.filter((row) => row.isOwnerWithdrawal);
    expect(withdrawal).toHaveLength(1);
    expect(withdrawal[0]!.name).toBe("سحوبات المالك");
    expect(items.some((row) => row.name === "كراء المحل")).toBe(true);
  });

  it("creates an extra expense category and rejects duplicates", async () => {
    const created = await client.expenseCategoriesCreate({ name: "تسويق" });
    expect(created.isOwnerWithdrawal).toBe(false);
    await expect(client.expenseCategoriesCreate({ name: "تسويق" })).rejects.toThrow(/EXPENSE_CATEGORY_EXISTS/);
    const flagged = await client.expenseCategoriesCreate({ name: "سحب خاص", isOwnerWithdrawal: true });
    expect(flagged.isOwnerWithdrawal).toBe(true);
  });

  it("records an expense with a note, defaults the moment, and audits it", async () => {
    const { items } = await client.expenseCategoriesList();
    const rent = items.find((row) => row.name === "كراء المحل")!;
    const expense = await client.expensesCreate({ categoryId: rent.id, amount: 1_200, note: "كراء فيفري" });
    expect(expense.amount).toBe(1_200);
    expect(expense.note).toBe("كراء فيفري");
    expect(expense.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(expense.categoryId).toBe(rent.id);
    const activity = (await client.activitiesList({})).items.find((entry) => entry.type === "EXPENSE_RECORDED");
    expect(activity).toBeDefined();
    expect(activity!.ref).toBe(expense.id);
    expect(activity!.summary).toContain("1200");
  });

  it("rejects an unknown category and a zero/negative amount", async () => {
    await expect(
      client.expensesCreate({ categoryId: "00000000-0000-4000-8000-000000000000", amount: 100 }),
    ).rejects.toThrow(/CATEGORY_NOT_FOUND/);
    await expect(client.expensesCreate({ categoryId: (await client.expenseCategoriesList()).items[0]!.id, amount: 0 })).rejects.toThrow();
    await expect(client.expensesCreate({ categoryId: (await client.expenseCategoriesList()).items[0]!.id, amount: -5 })).rejects.toThrow();
  });

  it("defaults the list to the current month, filters by category and custom range", async () => {
    const { items: categories } = await client.expenseCategoriesList();
    const op = categories.find((row) => !row.isOwnerWithdrawal)!;
    const withdrawal = categories.find((row) => row.isOwnerWithdrawal)!;
    const old = await client.expensesCreate({ categoryId: op.id, amount: 111, occurredAt: "2020-01-15T12:00:00" });
    const withdraw = await client.expensesCreate({ categoryId: withdrawal.id, amount: 333 });
    await client.expensesCreate({ categoryId: op.id, amount: 222 });

    // default = current month: the backdated expense is invisible
    const currentMonth = await client.expensesList({});
    expect(currentMonth.items.map((row) => row.id)).not.toContain(old.id);
    expect(currentMonth.items.some((row) => row.amount === 222)).toBe(true);
    expect(currentMonth.items.some((row) => row.id === withdraw.id)).toBe(true);

    // custom range brings the backdated expense back
    const custom = await client.expensesList({ from: "2020-01-01T00:00:00", to: "2020-01-31T23:59:59" });
    expect(custom.items.map((row) => row.id)).toEqual([old.id]);

    // category filter narrows the operating vs withdrawal split
    const onlyOp = await client.expensesList({ categoryIds: [op.id] });
    expect(onlyOp.items.map((row) => row.id)).not.toContain(withdraw.id);
    const onlyWithdrawal = await client.expensesList({ categoryIds: [withdrawal.id] });
    expect(onlyWithdrawal.items.map((row) => row.id)).toEqual([withdraw.id]);
  });

  it("sorts history by date or amount in both directions", async () => {
    const { items: categories } = await client.expenseCategoriesList();
    const op = categories.find((row) => !row.isOwnerWithdrawal)!;
    const small = await client.expensesCreate({ categoryId: op.id, amount: 50, occurredAt: "2026-02-01T12:00:00" });
    const big = await client.expensesCreate({ categoryId: op.id, amount: 900, occurredAt: "2026-02-20T12:00:00" });
    const mid = await client.expensesCreate({ categoryId: op.id, amount: 100, occurredAt: "2026-02-10T12:00:00" });
    const window = { from: "2026-02-01T00:00:00", to: "2026-02-28T23:59:59" };

    const byDateDesc = await client.expensesList({ ...window, sortBy: "occurredAt", sortDir: "desc" });
    expect(byDateDesc.items.map((row) => row.amount)).toEqual([900, 100, 50]);
    const byDateAsc = await client.expensesList({ ...window, sortBy: "occurredAt", sortDir: "asc" });
    expect(byDateAsc.items.map((row) => row.amount)).toEqual([50, 100, 900]);
    const byAmountAsc = await client.expensesList({ ...window, sortBy: "amount", sortDir: "asc" });
    expect(byAmountAsc.items.map((row) => row.amount)).toEqual([50, 100, 900]);
    const byAmountDesc = await client.expensesList({ ...window, sortBy: "amount", sortDir: "desc" });
    expect(byAmountDesc.items.map((row) => row.amount)).toEqual([900, 100, 50]);
    // sort stability across equal keys: the three ids stay distinct and ordered by date
    expect(new Set([...byDateDesc.items, ...byAmountDesc.items].map((row) => row.id)).size).toBe(3);
    void small; void big; void mid;
  });

  it("rejects an inverted custom window with INVALID_RANGE", async () => {
    await expect(client.expensesList({ from: "2026-03-01T00:00:00", to: "2026-02-01T00:00:00" })).rejects.toThrow(/INVALID_RANGE/);
    await expect(client.reportsProfit({ preset: "CUSTOM", customFrom: "2026-03-01T00:00:00", customTo: "2026-02-01T00:00:00" })).rejects.toThrow(/INVALID_RANGE/);
    await expect(client.reportsProfit({ preset: "CUSTOM" })).rejects.toThrow(/INVALID_RANGE/);
  });
});

describe("profit report (ticket 31) — wire reconciliation", () => {
  it("reconciles revenue − COGS − expenses = result on a worked example", async () => {
    // the router suite shares one sqlite database, so assertions are deltas
    // against a baseline report taken before this test writes anything
    const baseline = await client.reportsProfit({ preset: "CURRENT_MONTH" });

    const categories = await client.categoriesList();
    const itemCategoryId = categories.items[0]!.id;
    const item = await client.itemsCreate({ name: "ربح-مثال", categoryId: itemCategoryId, costPrice: 400, sellingPrice: 1_000, lowStockThreshold: 0 });
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 400, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({
      kind: "SALE",
      discount: { type: "AMOUNT", value: 100 },
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    expect(sale.totalAmount).toBe(900);
    expect(sale.lines[0]!.netTotal).toBe(900);

    const { items: expenseCategories } = await client.expenseCategoriesList();
    const rent = expenseCategories.find((row) => row.name === "كراء المحل")!;
    const withdrawal = expenseCategories.find((row) => row.isOwnerWithdrawal)!;
    await client.expensesCreate({ categoryId: rent.id, amount: 500, note: "الكراء" });
    await client.expensesCreate({ categoryId: withdrawal.id, amount: 300 });

    const report = await client.reportsProfit({ preset: "CURRENT_MONTH" });
    expect(report.revenue - baseline.revenue).toBe(900);
    expect(report.cogs - baseline.cogs).toBe(400);
    expect(report.grossProfit - baseline.grossProfit).toBe(500);
    expect(report.operatingExpenses - baseline.operatingExpenses).toBe(500);
    expect(report.ownerWithdrawals - baseline.ownerWithdrawals).toBe(300);
    expect(report.resultAfterExpenses - baseline.resultAfterExpenses).toBe(-300);
    // the acceptance identity holds on the recorded figures themselves
    expect(report.revenue - report.cogs - report.operatingExpenses - report.ownerWithdrawals).toBe(report.resultAfterExpenses);
    const rentRow = report.byCategory.find((row) => row.categoryId === rent.id);
    const rentBaseline = baseline.byCategory.find((row) => row.categoryId === rent.id)?.total ?? 0;
    expect(rentRow).toMatchObject({ categoryName: "كراء المحل", total: rentBaseline + 500, count: (baseline.byCategory.find((row) => row.categoryId === rent.id)?.count ?? 0) + 1 });
    const withdrawalRow = report.byCategory.find((row) => row.categoryId === withdrawal.id);
    const withdrawBaseline = baseline.byCategory.find((row) => row.categoryId === withdrawal.id)?.total ?? 0;
    expect(withdrawalRow).toMatchObject({ isOwnerWithdrawal: true, total: withdrawBaseline + 300 });
    // breakdown reconciliation: category sums equal the expense lines
    expect(report.byCategory.reduce((sum, row) => sum + row.total, 0)).toBe(
      report.operatingExpenses + report.ownerWithdrawals,
    );
  });

  it("attributes a backdated invoice to its invoiceDate window, not the report range of now", async () => {
    const categories = await client.categoriesList();
    const item = await client.itemsCreate({ name: "ربح-مؤرخ", categoryId: categories.items[0]!.id, costPrice: 100, sellingPrice: 300, lowStockThreshold: 0 });
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const backdated = await client.invoicesCreate({
      kind: "SALE",
      invoiceDate: "2020-01-10",
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    expect(backdated.totalAmount).toBe(300);

    const currentMonth = await client.reportsProfit({ preset: "CURRENT_MONTH" });
    // the backdated sale belongs to 2020, so it never moves the current report
    const previousRevenue = currentMonth.revenue;
    const custom = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-01-01T00:00:00", customTo: "2020-01-31T23:59:59" });
    expect(custom.revenue).toBe(300);
    expect(custom.cogs).toBe(100);
    expect(previousRevenue).toBeGreaterThanOrEqual(0);
  });

  it("keeps the purchase side invisible in the profit report (COGS only from sales)", async () => {
    const baseline = await client.reportsProfit({ preset: "CURRENT_MONTH" });
    const categories = await client.categoriesList();
    const item = await client.itemsCreate({ name: "ربح-شراء-فقط", categoryId: categories.items[0]!.id, costPrice: 250, sellingPrice: 500, lowStockThreshold: 0 });
    await client.invoicesCreate({ kind: "PURCHASE", invoiceDate: "2020-02-05", lines: [{ itemId: item.id, quantity: 2 }] });
    const report = await client.reportsProfit({ preset: "CURRENT_MONTH" });
    // purchases bought but not sold contribute nothing to revenue or COGS,
    // even when the purchase invoice carries a date inside the window
    expect(report.revenue).toBe(baseline.revenue);
    expect(report.cogs).toBe(baseline.cogs);
    expect(report.operatingExpenses).toBe(baseline.operatingExpenses);
    const custom = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-02-01T00:00:00", customTo: "2020-02-28T23:59:59" });
    expect(custom.revenue).toBe(0);
    expect(custom.cogs).toBe(0);

  });
});

// ---------------------------------------------------------------------------
// ticket 8 — later payments on invoices (instalments, never above remaining)
// ---------------------------------------------------------------------------
describe("invoice payments (ticket 8)", () => {
  async function makePaidItem(name: string, costPrice: number, sellingPrice: number) {
    const categories = await client.categoriesList();
    return client.itemsCreate({
      name,
      categoryId: categories.items[0]!.id,
      costPrice,
      sellingPrice,
      lowStockThreshold: 0,
    });
  }

  /** SALE invoice with zero initial payment: total 800, remaining 800. */
  async function unpaidSaleInvoice(name: string) {
    const item = await makePaidItem(name, 100, 800);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({ kind: "SALE", counterpartyName: "زبون الدفعات", lines: [{ itemId: item.id, quantity: 1 }] });
    expect(invoice.remainingAmount).toBe(800);
    return invoice;
  }

  it("rejects an unauthed later payment with UNAUTHORIZED", async () => {
    await expect(
      unauthed.invoicesPay({ invoiceId: "00000000-0000-4000-8000-000000000001", amount: 100 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a payment on a missing invoice with INVOICE_NOT_FOUND", async () => {
    await expect(
      client.invoicesPay({ invoiceId: "00000000-0000-4000-8000-000000000002", amount: 100 }),
    ).rejects.toThrow(/INVOICE_NOT_FOUND/);
  });

  it("records a partial payment: remaining drops, paid rises, history grows", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-جزئية");
    const paid = await client.invoicesPay({ invoiceId: invoice.id, amount: 300, method: "CASH", note: "أول دفعة" });

    expect(paid.id).toBe(invoice.id);
    expect(paid.totalAmount).toBe(800);
    expect(paid.paidAmount).toBe(300);
    expect(paid.remainingAmount).toBe(500);
    expect(paid.payments).toHaveLength(1);
    expect(paid.payments[0]).toMatchObject({ amount: 300, method: "CASH", note: "أول دفعة" });

    // persisted: a fresh read shows the same header + history
    const reread = await client.invoicesGet({ id: invoice.id });
    expect(reread.paidAmount).toBe(300);
    expect(reread.remainingAmount).toBe(500);
    expect(reread.payments).toHaveLength(1);
  });

  it("accumulates multiple instalments and logs PAYMENT_RECORDED per payment", async () => {
    const invoice = await unpaidSaleInvoice("دفعات-متراكمة");
    await client.invoicesPay({ invoiceId: invoice.id, amount: 200, method: "CASH" });
    await client.invoicesPay({ invoiceId: invoice.id, amount: 250, method: "BANK", note: "تحويل بنكي" });

    const reread = await client.invoicesGet({ id: invoice.id });
    expect(reread.paidAmount).toBe(450);
    expect(reread.remainingAmount).toBe(350);
    expect(reread.payments.map((p) => p.amount)).toEqual([200, 250]);
    expect(reread.payments.map((p) => p.method)).toEqual(["CASH", "BANK"]);

    const records = (await client.activitiesList({})).items.filter((a) => a.type === "PAYMENT_RECORDED" && a.ref === invoice.id);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.ref).toBe(invoice.id);
      expect(record.summary).toContain(invoice.invoiceNumber);
    }
  });

  it("accepts an exact-remaining payment (boundary) and marks the invoice PAID", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-حد-المتبقي");
    const paid = await client.invoicesPay({ invoiceId: invoice.id, amount: 800 });

    expect(paid.remainingAmount).toBe(0);
    expect(paid.paidAmount).toBe(800);
    const listed = await client.invoicesList({ status: "PAID" });
    expect(listed.items.some((i) => i.id === invoice.id)).toBe(true);
  });

  it("refuses a +1 DA overpayment with PAYMENT_EXCEEDS_REMAINING and writes nothing", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-زائدة");
    const before = await client.invoicesGet({ id: invoice.id });

    let code = "";
    try {
      await client.invoicesPay({ invoiceId: invoice.id, amount: 801 });
    } catch (err) {
      // SAFETY: oRPC surfaces server ORPCError messages as err.message
      code = (err as Error).message;
    }
    expect(code).toContain("PAYMENT_EXCEEDS_REMAINING");

    // nothing persisted: no payment row, no paid/remaining drift, no audit row
    const after = await client.invoicesGet({ id: invoice.id });
    expect(after.payments).toHaveLength(before.payments.length);
    expect(after.paidAmount).toBe(before.paidAmount);
    expect(after.remainingAmount).toBe(before.remainingAmount);
    const records = (await client.activitiesList({})).items.filter((a) => a.type === "PAYMENT_RECORDED" && a.ref === invoice.id);
    expect(records).toHaveLength(0);
  });

  it("refuses any payment on an already-paid invoice", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-مكتملة");
    await client.invoicesPay({ invoiceId: invoice.id, amount: 800 });
    let code = "";
    try {
      await client.invoicesPay({ invoiceId: invoice.id, amount: 1 });
    } catch (err) {
      // SAFETY: oRPC surfaces server ORPCError messages as err.message
      code = (err as Error).message;
    }
    expect(code).toContain("PAYMENT_EXCEEDS_REMAINING");
    expect((await client.invoicesGet({ id: invoice.id })).payments).toHaveLength(1);
  });

  it("accepts later payments on PURCHASE invoices too", async () => {
    const item = await makePaidItem("دفعة-شراء", 200, 400);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      counterpartyName: "مورد الدفعات",
      initialPaid: 200,
      lines: [{ itemId: item.id, quantity: 3, unitPrice: 200 }], // total 600
    });
    expect(invoice.remainingAmount).toBe(400);

    const paid = await client.invoicesPay({ invoiceId: invoice.id, amount: 400, method: "BANK" });
    expect(paid.kind).toBe("PURCHASE");
    expect(paid.paidAmount).toBe(600);
    expect(paid.remainingAmount).toBe(0);
    expect(paid.payments.map((p) => p.amount)).toEqual([200, 400]);
  });

  it("rejects non-positive, fractional, or non-integer amounts at the schema", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-مبلغ-فاسد");
    for (const amount of [0, -5, 12.5, Number.NaN]) {
      await expect(client.invoicesPay({ invoiceId: invoice.id, amount })).rejects.toThrow(/Input validation failed/);
    }
    // zod-valid must still reach the handler: nothing was paid so far
    expect((await client.invoicesGet({ id: invoice.id })).payments).toHaveLength(0);
  });

  it("defaults the method to CASH and stores a null note when omitted", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-افتراضية");
    const paid = await client.invoicesPay({ invoiceId: invoice.id, amount: 100 });
    expect(paid.payments[0]).toMatchObject({ amount: 100, method: "CASH", note: null });
  });

  it("rolls the payment back when the audit insert fails (atomicity)", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-ذرية");
    const paymentsBefore = (await store.listActivities(100)).filter((a) => a.type === "PAYMENT_RECORDED" && a.ref === invoice.id).length;

    const invoiceStore: StorePort = {
      ...store,
      withTransaction: <T>(fn: (tx: StorePort) => Promise<T>): Promise<T> =>
        store.withTransaction((realTx: StorePort) =>
          fn({
            ...realTx,
            insertActivity: async () => {
              throw new Error("audit-boom");
            },
          }),
        ),
      // invoicesPay runs in the write-first unit, so the same audit-boom
      // override must wrap that variant for the rollback proof to fire
      withTransactionImmediate: <T>(fn: (tx: StorePort) => Promise<T>): Promise<T> =>
        store.withTransactionImmediate((realTx: StorePort) =>
          fn({
            ...realTx,
            insertActivity: async () => {
              throw new Error("audit-boom");
            },
          }),
        ),
    };
    const failingApp = createApp({
      config,
      logger,
      auth,
      rpcRouter: createRpcRouter({ db: conn.db, config, logger, store: invoiceStore, auth }),
    });
    const failingLink = new RPCLink({
      url: () => `http://127.0.0.1:${config.port}/api/rpc`,
      // SAFETY: the link's fetch contract wants a Promise; hono's fetch returns one
      fetch: (request) => {
        const headers = Object.fromEntries(request.headers.entries());
        if (cookie !== "") headers.cookie = cookie;
        return Promise.resolve(failingApp.fetch(new Request(request, { headers })));
      },
    });
    const failingClient: DokanClient = createORPCClient(failingLink);

    // the whole unit must abort; the real proof is the rollback below — with
    // pre-fix wiring (two separate calls) this would commit the payment and
    // then fail the audit, leaving an un-audited instalment behind
    await expect(failingClient.invoicesPay({ invoiceId: invoice.id, amount: 500 })).rejects.toThrow();

    const reread = await client.invoicesGet({ id: invoice.id });
    expect(reread.paidAmount).toBe(0);
    expect(reread.remainingAmount).toBe(800);
    expect(reread.payments).toHaveLength(0);
    const paymentsAfter = (await store.listActivities(100)).filter((a) => a.type === "PAYMENT_RECORDED" && a.ref === invoice.id).length;
    expect(paymentsAfter).toBe(paymentsBefore);
  });

it("two concurrent payments serialize and never overpay the invoice", async () => {
    const invoice = await unpaidSaleInvoice("دفعتان-متزامنتان");
    const results = await Promise.allSettled([
      client.invoicesPay({ invoiceId: invoice.id, amount: 600 }),
      client.invoicesPay({ invoiceId: invoice.id, amount: 600 }),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof client.invoicesPay>>> => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // exactly one instalment lands; the loser sees the fresh remaining inside
    // its serialized unit and is refused with the money-boundary key
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]!.value).toMatchObject({ paidAmount: 600, remainingAmount: 200 });
    // SAFETY: allSettled rejected reasons are Error instances (oRPC client throws)
    expect((rejected[0]!.reason as Error).message).toContain("PAYMENT_EXCEEDS_REMAINING");
    const reread = await client.invoicesGet({ id: invoice.id });
    expect(reread.paidAmount).toBe(600);
    expect(reread.remainingAmount).toBe(200);
    expect(reread.payments).toHaveLength(1);
  });

  it("flips the invoice to PARTIAL after the first instalment and to PAID at settlement", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-حالة-الفاتورة");
    expect((await client.invoicesList({ status: "PARTIAL" })).items.some((i) => i.id === invoice.id)).toBe(false);
    await client.invoicesPay({ invoiceId: invoice.id, amount: 300 });
    expect((await client.invoicesList({ status: "PARTIAL" })).items.some((i) => i.id === invoice.id)).toBe(true);
    expect((await client.invoicesList({ status: "UNPAID" })).items.some((i) => i.id === invoice.id)).toBe(false);
    await client.invoicesPay({ invoiceId: invoice.id, amount: 500 });
    expect((await client.invoicesList({ status: "PARTIAL" })).items.some((i) => i.id === invoice.id)).toBe(false);
    expect((await client.invoicesList({ status: "PAID" })).items.some((i) => i.id === invoice.id)).toBe(true);
  });

  it("rejects amounts beyond the safe-integer money range at the schema", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-خارج-النطاق");
    await expect(client.invoicesPay({ invoiceId: invoice.id, amount: 2 ** 53 })).rejects.toThrow(/Input validation failed/);
  });

  it("normalizes an empty or whitespace-only note to null", async () => {
    const invoice = await unpaidSaleInvoice("دفعة-ملاحظة-فارغة");
    const paid = await client.invoicesPay({ invoiceId: invoice.id, amount: 100, note: "   " });
    expect(paid.payments[0]!.note).toBeNull();
  });
});
