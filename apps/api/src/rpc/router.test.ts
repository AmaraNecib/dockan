import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { dashboardSummaryOutputSchema, MAX_PAGE_SIZE, ONBOARDING_COMPLETED_PREFERENCE_KEY, type DokanClient } from "@dokan/contracts";

import { createApp } from "../app";
import { createAuth, type BetterAuthInstance } from "../auth/auth";
import { createAppConfig, type AppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { accounts, users } from "../db/schema";
import { AppLogger } from "../lib/logger";
import { ensureSessionSecret } from "../lib/session-secret";
import { createSetupThrottle, type SetupThrottle } from "../lib/setup-throttle";
import { createRpcRouter } from "./router";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";
import { weightedAverageCost } from "../lib/stock-ledger";

/**
 * Wire-seam tests for the merged router. The typed oRPC client calls the real
 * HTTP seam (app.fetch through RPCLink); the store sits on sqlite :memory:.
 * Ticket 02's session guard is part of the seam, so the client authenticates
 * first: provision the admin through the public first-run setup and capture
 * its cookie.
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
  });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
  logger = new AppLogger(dir);
  // One universal build (ADR-0008 §4.2): the session-signing secret is a
  // normal database row generated on first use.
  auth = createAuth(conn.db, config, await ensureSessionSecret(store));
  const app = createApp({ config, logger, auth, rpcRouter: createRpcRouter({ db: conn.db, config, logger, store, auth }) });

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

  // The public first-run setup is the only owner-provisioning path; use the
  // real wire seam so the guard tests exercise what the app actually does.
  const setupClient: DokanClient = createORPCClient(linkWith(""));
  await setupClient.firstTimeSetup({
    ownerName: "مالك الاختبار",
    phoneNumber: "0550123123",
    password: "dokan-1234",
    storeName: "متجر الاختبار",
  });

  const login = await auth.handler(
    new Request("http://localhost/api/auth/sign-in/username", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "213550123123", password: "dokan-1234" }),
    }),
  );
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie") ?? "";

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

/** Build a client over an alternate StorePort with the shared config, auth and
 * owner cookie — for tests that must observe or fail one store call. */
const clientForStore = (storeFor: StorePort): DokanClient => {
  const app = createApp({
    config,
    logger,
    auth,
    rpcRouter: createRpcRouter({ db: conn.db, config, logger, store: storeFor, auth }),
  });
  const link = new RPCLink({
    url: () => `http://127.0.0.1:${config.port}/api/rpc`,
    // SAFETY: the link's fetch contract wants a Promise; hono's fetch returns one
    fetch: (request) => {
      const headers = Object.fromEntries(request.headers.entries());
      if (cookie !== "") headers.cookie = cookie;
      return Promise.resolve(app.fetch(new Request(request, { headers })));
    },
  });
  return createORPCClient(link);
};

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
    const list = await client.itemsAll();
    const names = list.items.map((i) => i.name);
    if (names.length > 1) {
      const sorted = [...names].sort((a, b) => a.localeCompare(b, "ar"));
      expect(names).toEqual(sorted);
    }
    void catId;
  });

  it("itemsList rows carry the category name next to categoryId (issue 67)", async () => {
    const category = await client.categoriesCreate({ name: "قطع غيار" });
    const created = await client.itemsCreate({
      name: "فلتر هواء",
      categoryId: category.id,
      costPrice: 100,
      sellingPrice: 150,
    });
    const listed = await client.itemsAll();
    const row = listed.items.find((i) => i.id === created.id)!;
    expect(row.categoryName).toBe("قطع غيار");
    expect(row.categoryId).toBe(category.id);
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
    const listed = await client.itemsAll();
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

    const list = await client.itemsAll();
    const blended = list.items.find((i) => i.id === item.id)!;
    expect(blended.stockOnHand).toBe(20);
    expect(blended.costPrice).toBe(600); // ADR-0002 weighted average

    // outflow leaves the average untouched but derives remaining stock
    await client.stockAddManual({ itemId: item.id, delta: -6 });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements.at(-1)!.stockAfter).toBe(14);
    const afterSale = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
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
      total: 0,
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
    let row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
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
    row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
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
    const activities = (await store.listActivities({ limit: 10 })).items;
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
    // summaries are locale-neutral tokens; the web layer owns the Arabic copy
    expect(all.items[0]!.summary).toBe(`STOCK_ADJUSTED ${created.name}`);
    expect(all.items[1]!.summary).toBe(`ITEM_CREATED ${created.name}`);
    // the token prefix itself is ASCII, whatever the free-text name contains
    for (const entry of all.items) {
      expect(entry.summary.split(" ")[0]).toMatch(/^[A-Z_]+$/);
    }
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
    await expect(client.activitiesList({ limit: 501 })).rejects.toThrow();
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

  it("reports the store identity the first-run setup wrote", async () => {
    expect(await client.settingsGet()).toEqual({ storeName: "متجر الاختبار", storePhone: "+213550123123", storeAddress: null });
  });

  it("normalizes a loose Algerian phone, persists, and audits the change", async () => {
    const updated = await client.settingsUpdate({
      storeName: "متجر السيارات",
      storePhone: "066 12 34 56 7",
    });
    expect(updated).toEqual({ storeName: "متجر السيارات", storePhone: "+213661234567", storeAddress: null });
    // persisted: a fresh read (no local cache in this client) sees the same
    expect(await client.settingsGet()).toEqual({ storeName: "متجر السيارات", storePhone: "+213661234567", storeAddress: null });

    const activities = await client.activitiesList({});
    expect(activities.items[0]).toMatchObject({
      type: "SETTINGS_UPDATED",
      summary: "SETTINGS_UPDATED",
    });
  });

  it("persists and clears the store address through settingsUpdate", async () => {
    // the setup form collects an address, so the settings write has to carry it
    // through: forwarding only name and phone reported success while leaving the
    // stored address untouched
    const saved = await client.settingsUpdate({ storeAddress: "شارع الاستقلال 12" });
    expect(saved.storeAddress).toBe("شارع الاستقلال 12");
    expect((await client.settingsGet()).storeAddress).toBe("شارع الاستقلال 12");

    // an explicit null or empty string clears it rather than leaving it alone
    for (const clearWith of [null, ""]) {
      const cleared = await client.settingsUpdate({ storeAddress: clearWith });
      expect(cleared.storeAddress).toBeNull();
      expect((await client.settingsGet()).storeAddress).toBeNull();
    }
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
    expect(await client.settingsGet()).toEqual({ storeName: "متجر ثابت", storePhone: "+213550123123", storeAddress: null });
  });

  it("rolls the identity write back when the audit insert fails (atomicity)", async () => {
    // baseline identity that a failed attempt must NOT clobber
    await client.settingsUpdate({ storeName: "متجر ذرّي", storePhone: "0550123123" });
    const auditBefore = (await store.listActivities({ limit: 100 })).items.filter((a) => a.type === "SETTINGS_UPDATED").length;

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
    expect(await client.settingsGet()).toEqual({ storeName: "متجر ذرّي", storePhone: "+213550123123", storeAddress: null });
    const auditAfter = (await store.listActivities({ limit: 100 })).items.filter((a) => a.type === "SETTINGS_UPDATED").length;
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
    const listed = (await client.itemsAll()).items;
    expect(listed.find((i) => i.id === a.id)!.stockOnHand).toBe(5);
    expect(listed.find((i) => i.id === b.id)!.costPrice).toBe(300);

    // invoicesGet / invoicesList round-trip. invoicesList answers ONE page
    // (DEFAULT_PAGE_SIZE = 10), so asserting membership on the default page is a
    // coin-flip once the shared test DB holds more than a page of purchases.
    expect((await client.invoicesGet({ id: invoice.id })).id).toBe(invoice.id);
    const list = await client.invoicesList({ kind: "PURCHASE", limit: MAX_PAGE_SIZE });
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
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
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
    expect(await client.itemsHistory({ itemId: item.id })).toEqual({ movements: [], total: 0, stockOnHand: 0 });
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
    const listed = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
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
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
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

  it("keeps recognizing pre-token Arabic correction rows when computing the effective quantity", async () => {
    const item = await makeItem("تصحيح-قديم", 100);
    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      lines: [{ itemId: item.id, quantity: 10, unitPrice: 100 }],
    });
    const line = invoice.lines[0]!;
    // Simulate a correction written by the OLD code that took the line to 5:
    // a +5@200 inflow then a −10 reversal, both carrying the Arabic prefix.
    // Same timestamp as the original intake + a later rowid keeps the ledger
    // projection non-negative while still exercising the legacy read path.
    const originalAt = (await client.itemsHistory({ itemId: item.id })).movements.at(-1)!.occurredAt;
    const legacyReason = `تصحيح فاتورة ${invoice.invoiceNumber} #${line.id}`;
    await store.insertStockMovement({ itemId: item.id, kind: "PURCHASE", delta: 5, unitCost: 200, reason: legacyReason, ref: invoice.id, occurredAt: originalAt });
    await store.insertStockMovement({ itemId: item.id, kind: "MANUAL_ADJUSTMENT", delta: -10, unitCost: null, reason: legacyReason, ref: invoice.id, occurredAt: originalAt });
    await store.setItemStockAndCost(item.id, 5, 150);

    await client.purchasesCorrectLine({ lineId: line.id, quantity: 7, unitCost: 150 });

    // 7, not 2: a stale prefix matcher would reverse the full original 10.
    const listed = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    expect(listed.stockOnHand).toBe(7);
    // The new correction rows carry the locale-neutral token, never Arabic.
    const newReasons = (await client.itemsHistory({ itemId: item.id })).movements.slice(-2).map((movement) => movement.reason);
    expect(newReasons.every((reason) => reason?.startsWith("INVOICE_CORRECTION") === true)).toBe(true);
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
    expect((await client.itemsAll()).items.find((row) => row.id === stocked.id)?.stockOnHand).toBe(2);
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
    expect((await client.itemsAll()).items.find((row) => row.id === item.id)?.stockOnHand).toBe(1);

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

  it("books a free (0-unit-price) sale line at its real FIFO loss, never at 0 loss", async () => {
    // regression: a freebie must still consume stock AND book its exact COGS,
    // so the profit report shows the 100% loss (net 0 − cogs 200 = −200)
    const item = await makeSaleItem("بيع-هدية-كلفة", 200, 300);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 200, kind: "PURCHASE" });
    const window = {
      preset: "CUSTOM" as const,
      customFrom: `${item.createdAt.slice(0, 10)}T00:00:00`,
      customTo: `${item.createdAt.slice(0, 10)}T23:59:59`,
    };
    const baseline = await client.reportsProfit(window);
    const sale = await client.invoicesCreate({
      kind: "SALE",
      lines: [{ itemId: item.id, quantity: 1, priceOverride: { type: "AMOUNT", value: 0 } }],
    });
    expect(sale.lines[0]).toMatchObject({ unitPrice: 0, costAtSale: 200, cogsExact: 200, netTotal: 0 });
    expect(sale.totalAmount).toBe(0);
    // stock consumed normally: the 1 unit is gone, no lingering layer
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(0);
    // the report books the exact loss through the wire seam, not a 0
    const report = await client.reportsProfit(window);
    expect(report.cogs - baseline.cogs).toBe(200);
    expect(report.grossProfit - baseline.grossProfit).toBe(-200);
  });

  it("rolls back every sale write when a later line oversells", async () => {
    const first = await makeSaleItem("بيع-تراجع-أ", 100, 200);
    const second = await makeSaleItem("بيع-تراجع-ب", 100, 300);
    await client.stockAddManual({ itemId: first.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const firstBefore = await client.itemsHistory({ itemId: first.id });
    const secondBefore = await client.itemsHistory({ itemId: second.id });
    const invoicesBefore = (await client.invoicesList({ kind: "SALE" })).total;
    await expect(
      client.invoicesCreate({ kind: "SALE", lines: [{ itemId: first.id, quantity: 1 }, { itemId: second.id, quantity: 1 }] }),
    ).rejects.toThrow(/STOCK_NEGATIVE/);
    expect(await client.itemsHistory({ itemId: first.id })).toEqual(firstBefore);
    expect(await client.itemsHistory({ itemId: second.id })).toEqual(secondBefore);
    expect((await client.invoicesList({ kind: "SALE" })).total).toBe(invoicesBefore);
    expect((await client.itemsAll()).items.find((row) => row.id === first.id)?.stockOnHand).toBe(1);
  });

  it("snapshots FIFO cost across layers and reconciles stock after checkout", async () => {
    const item = await makeSaleItem("بيع-ففو", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 6 }] });
    expect(invoice.lines[0]!.costAtSale).toBe(117);
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(4);
    expect((await client.itemsAll()).items.find((row) => row.id === item.id)?.stockOnHand).toBe(history.stockOnHand);
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
    const listed = (await client.itemsAll()).items.find((row) => row.id === item.id)!;
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

  it("pages the ledger without losing the cumulative stockAfter (issue 163)", async () => {
    const item = await makeSaleItem("بيع-ترقيم-السجل", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 100, kind: "PURCHASE" });
    const full = await client.itemsHistory({ itemId: item.id });
    expect(full.total).toBe(full.movements.length);
    expect(full.total).toBe(2);

    const secondPage = await client.itemsHistory({ itemId: item.id, limit: 1, offset: 1 });
    expect(secondPage.movements).toHaveLength(1);
    expect(secondPage.total).toBe(full.total);
    // the page's own delta is 3, but the balance shown must be cumulative (8):
    // slicing before projection would restart the running total
    expect(secondPage.movements[0]!.stockAfter).toBe(full.movements[1]!.stockAfter);
    expect(secondPage.movements[0]!.stockAfter).toBe(8);
    expect(secondPage.stockOnHand).toBe(full.stockOnHand);
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

  it("snapshots the exact per-line COGS (cogsExact) alongside the rounded costAtSale", async () => {
    const item = await makeSaleItem("بيع-كلفة-دقيقة", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });
    const invoice = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 6 }] });
    // 5×100 + 1×200 consumed: exact total 700 while the rounded unit is 117
    expect(invoice.lines[0]).toMatchObject({ costAtSale: 117, cogsExact: 700 });
    const reread = await client.invoicesGet({ id: invoice.id });
    expect(reread.lines[0]?.cogsExact).toBe(700);
  });

  it("carries exact per-line COGS through the profit report seam", async () => {
    const item = await makeSaleItem("بيع-تقرير-دقيق", 100, 300);
    // the router suite shares one database: assert deltas for today's window,
    // exactly like the profit-report wire tests below
    const window = { preset: "CUSTOM" as const, customFrom: `${item.createdAt.slice(0, 10)}T00:00:00`, customTo: `${item.createdAt.slice(0, 10)}T23:59:59` };
    const baseline = await client.reportsProfit(window);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 6 }] });
    expect(sale.lines[0]!.cogsExact).toBe(700);
    const report = await client.reportsProfit(window);
    // the report sums the exact layer snapshot, not 6 × 117 = 702
    expect(report.cogs - baseline.cogs).toBe(700);
  });

  it("dates an explicit-invoiceDate sale's movements at the invoice business date", async () => {
    const item = await makeSaleItem("بيع-مؤرخ-الحركة", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE", occurredAt: "2035-06-01T08:00:00" });
    await client.invoicesCreate({ kind: "SALE", invoiceDate: "2035-06-03", lines: [{ itemId: item.id, quantity: 2 }] });
    const saleMovement = (await client.itemsHistory({ itemId: item.id })).movements.find((movement) => movement.kind === "SALE")!;
    // no inflow postdates the invoice: the movement lands at invoice-day midnight
    expect(saleMovement.occurredAt).toBe("2035-06-03T00:00:00");
  });

  it("bounded backdating: a dated sale never sorts ahead of stock it consumes", async () => {
    const item = await makeSaleItem("بيع-حد-الرجعية", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE", occurredAt: "2035-06-01T08:00:00" });
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 200, kind: "PURCHASE", occurredAt: "2035-06-05T09:00:00" });
    // invoice dated BETWEEN the two purchases; the 6 units only exist after Jun 5
    const invoice = await client.invoicesCreate({ kind: "SALE", invoiceDate: "2035-06-03", lines: [{ itemId: item.id, quantity: 6 }] });
    // clamped to the newest inflow, so the full ledger still replays cleanly
    expect(invoice.lines[0]).toMatchObject({ costAtSale: 117, cogsExact: 700 });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(2);
    const saleMovement = history.movements.find((movement) => movement.kind === "SALE")!;
    expect(saleMovement.occurredAt).toBe("2035-06-05T09:00:00");
    // chronological stockAfter proves the replay never dipped: 5 → 8 → 2
    expect(history.movements.map((movement) => movement.stockAfter)).toEqual([5, 8, 2]);
  });

  it("keeps default (undated) sales on today's wall-clock movements, not backdated", async () => {
    const item = await makeSaleItem("بيع-غير-مؤرخ", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const purchase = await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 2, unitPrice: 90 }] });
    expect(purchase.lines[0]).toMatchObject({ costAtSale: 90, cogsExact: 180 });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }] });
    const saleMovement = (await client.itemsHistory({ itemId: item.id })).movements.find((movement) => movement.kind === "SALE")!;
    // no explicit invoiceDate: the movement stays on the wall clock (today),
    // following the invoice's own business date derived server-side — and it
    // must NOT land at invoice-day midnight (that is the explicit-dating
    // behavior, which saleMovementTime clamps to the latest inflow)
    expect(saleMovement.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(saleMovement.occurredAt.startsWith(sale.invoiceDate)).toBe(true);
    expect(saleMovement.occurredAt.endsWith("T00:00:00")).toBe(false);
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
    expect(purchase.total).toBe(1);

    // a party we owe nothing is an empty drill-down, not an error
    const paidOff = await client.debtsByParty({ kind: "SALE", counterpartyId: null, counterpartyName: "زبون دائن لا شيء عليه" });
    expect(paidOff.items).toHaveLength(0);
  });

  it("drills into an id-backed party by id, never by a same-named typed name", async () => {
    const saleItem = await makeItem("ديون-جهة-معروفة", 400, 1_000);
    // the customers/suppliers RPC seams belong to another lane; seed the
    // known party through the store seam the grouping key actually reads
    const customer = await store.createParty("customer", { name: "زبون مسجل" });
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
  });
});

describe("parties (issue 120)", () => {
  async function makeItem(name: string, costPrice: number, sellingPrice: number) {
    const categories = await client.categoriesList();
    const category = categories.items[0];
    if (category === undefined) throw new Error("expected a category");
    return client.itemsCreateWithStock({ name, categoryId: category.id, costPrice, sellingPrice, stockOnHand: 1 });
  }

  it("guards the party procedures with the session", async () => {
    await expect(unauthed.customersList()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(unauthed.suppliersCreate({ name: "ممنوع" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("creates, lists, updates and reads a party detail over the wire", async () => {
    const created = await client.customersCreate({ name: "زبون جديد", phone: "0660111222" });
    // the phone is normalized to the canonical identity form before it is stored
    expect(created.phone).toBe("+213660111222");
    const list = await client.customersList();
    const row = list.items.find((item) => item.id === created.id);
    expect(row?.stats).toEqual({ invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 });

    const updated = await client.customersUpdate({ id: created.id, name: "زبون معدّل", phone: null });
    expect(updated.name).toBe("زبون معدّل");
    expect(updated.phone).toBeNull();

    const detail = await client.customersGet({ id: created.id });
    expect(detail.party).toMatchObject({ id: created.id, name: "زبون معدّل", phone: null });
    expect(detail.stats).toEqual({ invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 });
    expect(detail.invoices).toEqual([]);
    expect(detail.payments).toEqual([]);

    await expect(client.customersGet({ id: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/PARTY_NOT_FOUND/);
    await expect(client.customersUpdate({ id: "00000000-0000-4000-8000-000000000000", name: "لا أحد" })).rejects.toThrow(/PARTY_NOT_FOUND/);
  });

  it("exposes a names-only supplier list and a lean account summary (#183)", async () => {
    const supplier = await client.suppliersCreate({ name: `مورد-أسماء-${Date.now()}` });

    // the conflict-check seam is identity only
    const names = await client.suppliersListNames();
    const row = names.items.find((item) => item.id === supplier.id);
    expect(row).toEqual({ id: supplier.id, name: supplier.name });
    expect(Object.keys(row!).sort()).toEqual(["id", "name"]);

    await client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 750 });
    const summaries = await client.suppliersAccountSummaries();
    expect(summaries.items.find((item) => item.id === supplier.id)).toMatchObject({ accountBalance: 750, accountEntryCount: 1 });
    // the full list seam agrees with the lean summary
    const listRow = (await client.suppliersList()).items.find((item) => item.id === supplier.id);
    expect(listRow?.accountBalance).toBe(750);
    expect(listRow?.accountEntryCount).toBe(1);
  });

  it("maps the phone identity rule to the role-specific CONFLICT key", async () => {
    await client.suppliersCreate({ name: "مورد-هاتف", phone: "0770111222" });
    await expect(client.suppliersCreate({ name: "مورد-آخر", phone: "0770111222" })).rejects.toThrow(/SUPPLIER_PHONE_EXISTS/);
    // customers are a separate identity space (different table, same rule)
    const customer = await client.customersCreate({ name: "زبون-هاتف", phone: "0770111222" });
    await expect(client.customersCreate({ name: "زبون-هاتف-٢", phone: "0770111222" })).rejects.toThrow(/CUSTOMER_PHONE_EXISTS/);
    // a walk-in with no phone always saves, twice
    await client.customersCreate({ name: "بدون رقم ١" });
    await client.customersCreate({ name: "بدون رقم ٢" });
    expect(customer.phone).toBe("+213770111222");
    // an over-long blob is refused at the contract boundary
    await expect(client.customersCreate({ name: "طويل", phone: "0".repeat(33) })).rejects.toThrow();
    // whitespace-only clears to null instead of becoming an empty identity
    expect((await client.customersCreate({ name: "فراغ", phone: "   " })).phone).toBeNull();
    // deleting through the wrong role is NOT_FOUND, never a cross-table delete
    const crossRole = await client.suppliersCreate({ name: "مورد-حذف" });
    await expect(client.customersDelete({ id: crossRole.id })).rejects.toThrow(/PARTY_NOT_FOUND/);
  });

  it("refuses an invoice whose picked party is unknown or the wrong role", async () => {
    const item = await makeItem("تحقق-جهة-منتج", 100, 200);
    await expect(
      client.invoicesCreate({
        kind: "SALE",
        counterpartyId: "00000000-0000-4000-8000-000000000000",
        counterpartyName: "وهمي",
        lines: [{ itemId: item.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/PARTY_NOT_FOUND/);
    // a supplier id is not a customer identity
    const supplier = await client.suppliersCreate({ name: "مورد-دور" });
    await expect(
      client.invoicesCreate({
        kind: "SALE",
        counterpartyId: supplier.id,
        counterpartyName: supplier.name,
        lines: [{ itemId: item.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/PARTY_NOT_FOUND/);
    // the matching role still lands and carries the id; the resolved record's
    // name is authoritative over a mismatched typed label
    const customer = await client.customersCreate({ name: "زبون-دور" });
    const invoice = await client.invoicesCreate({
      kind: "SALE",
      counterpartyId: customer.id,
      counterpartyName: "اسم مغاير",
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    expect(invoice.counterpartyId).toBe(customer.id);
    expect(invoice.counterpartyName).toBe(customer.name);
  });

  it("labels a renamed party's debt group with its current name", async () => {
    const customer = await client.customersCreate({ name: "قبل-إعادة-التسمية" });
    const item = await makeItem("إعادة-تسمية-منتج", 100, 200);
    await client.invoicesCreate({
      kind: "SALE",
      counterpartyId: customer.id,
      counterpartyName: customer.name,
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    await client.customersUpdate({ id: customer.id, name: "بعد-إعادة-التسمية" });

    const debts = await client.reportsDebts();
    const group = debts.owedToUs.find((row) => row.counterpartyId === customer.id);
    expect(group?.counterpartyName).toBe("بعد-إعادة-التسمية");
  });

  it("records PARTY_CREATED/UPDATED/DELETED audit rows", async () => {
    const created = await client.customersCreate({ name: "تدقيق-جهة" });
    await client.customersUpdate({ id: created.id, name: "تدقيق-معدّل" });
    await client.customersDelete({ id: created.id });
    const activities = await client.activitiesList({ limit: 100 });
    const summaries = activities.items.map((entry) => entry.summary);
    expect(summaries).toContain("PARTY_CREATED CUSTOMER تدقيق-جهة");
    expect(summaries).toContain("PARTY_UPDATED CUSTOMER تدقيق-معدّل");
    expect(summaries).toContain("PARTY_DELETED CUSTOMER تدقيق-معدّل");
  });

  it("returns the detail aggregate and payment invoice numbers, and refuses to delete a party with invoices", async () => {
    const customer = await client.customersCreate({ name: "زبون-محفوظ" });
    const item = await makeItem("حذف-جهة-منتج", 100, 200);
    const invoice = await client.invoicesCreate({
      kind: "SALE",
      counterpartyId: customer.id,
      counterpartyName: customer.name,
      initialPaid: 100,
      lines: [{ itemId: item.id, quantity: 1 }],
    });

    const detail = await client.customersGet({ id: customer.id });
    expect(detail.stats).toEqual({ invoiceCount: 1, totalAmount: 200, paidAmount: 100, remainingAmount: 100 });
    expect(detail.invoices.map((i) => i.id)).toEqual([invoice.id]);
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]?.invoiceNumber).toBe(invoice.invoiceNumber);

    await expect(client.customersDelete({ id: customer.id })).rejects.toThrow(/PARTY_HAS_INVOICES/);
    // the row survives the refused delete
    expect((await client.customersList()).items.some((row) => row.id === customer.id)).toBe(true);

    const empty = await client.suppliersCreate({ name: "مورد-فارغ" });
    expect(await client.suppliersDelete({ id: empty.id })).toEqual({ deleted: true });
    expect((await client.suppliersList()).items.some((row) => row.id === empty.id)).toBe(false);
    await expect(client.suppliersDelete({ id: empty.id })).rejects.toThrow(/PARTY_NOT_FOUND/);
  });
});

describe("party-detail tab pagination (issue 174)", () => {
  async function makeItemWithStock(name: string, stock: number) {
    const categories = await client.categoriesList();
    const category = categories.items[0];
    if (category === undefined) throw new Error("expected a category");
    return client.itemsCreateWithStock({ name, categoryId: category.id, costPrice: 100, sellingPrice: 200, stockOnHand: stock });
  }

  it("pages the invoices tab, filters unpaid rows, and keeps partyDetail whole", async () => {
    const customer = await client.customersCreate({ name: "زبون ترقيم الفواتير" });
    const item = await makeItemWithStock("صنف ترقيم الفواتير", 50);
    for (let i = 0; i < 12; i++) {
      await client.invoicesCreate({
        kind: "SALE",
        counterpartyId: customer.id,
        counterpartyName: customer.name,
        initialPaid: 100,
        lines: [{ itemId: item.id, quantity: 1 }],
      });
    }
    // one fully paid invoice: excluded by unpaidOnly, included without it
    await client.invoicesCreate({
      kind: "SALE",
      counterpartyId: customer.id,
      counterpartyName: customer.name,
      initialPaid: 200,
      lines: [{ itemId: item.id, quantity: 1 }],
    });

    const first = await client.partyInvoices({ role: "customer", id: customer.id, limit: 10, offset: 0 });
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(13);
    const second = await client.partyInvoices({ role: "customer", id: customer.id, limit: 10, offset: 10 });
    expect(second.items).toHaveLength(3);
    expect(second.total).toBe(13);
    // pages never overlap and together cover every row
    const seen = [...first.items, ...second.items].map((invoice) => invoice.id);
    expect(new Set(seen).size).toBe(13);

    const unpaid = await client.partyInvoices({ role: "customer", id: customer.id, unpaidOnly: true, limit: 10, offset: 0 });
    expect(unpaid.total).toBe(12);
    expect(unpaid.items.every((invoice) => invoice.remainingAmount > 0)).toBe(true);

    // the money read is untouched: partyDetail still returns every invoice
    const detail = await client.customersGet({ id: customer.id });
    expect(detail.invoices).toHaveLength(13);
    expect(detail.stats.invoiceCount).toBe(13);
  });

  it("pages the payments tab and rejects an out-of-range page size", async () => {
    const customer = await client.customersCreate({ name: "زبون ترقيم الدفعات" });
    const item = await makeItemWithStock("صنف ترقيم الدفعات", 50);
    for (let i = 0; i < 12; i++) {
      await client.invoicesCreate({
        kind: "SALE",
        counterpartyId: customer.id,
        counterpartyName: customer.name,
        initialPaid: 100,
        lines: [{ itemId: item.id, quantity: 1 }],
      });
    }
    const first = await client.partyPayments({ id: customer.id, limit: 5, offset: 0 });
    expect(first.items).toHaveLength(5);
    expect(first.total).toBe(12);
    const last = await client.partyPayments({ id: customer.id, limit: 5, offset: 10 });
    expect(last.items).toHaveLength(2);
    expect(last.total).toBe(12);
    expect(last.items.every((payment) => payment.invoiceNumber.length > 0)).toBe(true);

    await expect(client.partyInvoices({ role: "customer", id: customer.id, limit: 0 })).rejects.toThrow(/Input validation failed/);
    await expect(client.partyInvoices({ role: "customer", id: customer.id, limit: MAX_PAGE_SIZE + 1 })).rejects.toThrow(/Input validation failed/);
    await expect(client.partyInvoices({ role: "customer", id: customer.id, offset: -1 })).rejects.toThrow(/Input validation failed/);
    await expect(client.partyInvoices({ role: "customer", id: customer.id, limit: 1.5 })).rejects.toThrow(/Input validation failed/);
  });

  it("pages a supplier's account entries while the detail account stays whole", async () => {
    const supplier = await client.suppliersCreate({ name: "مورد ترقيم الحساب" });
    const item = await makeItemWithStock("صنف ترقيم الحساب", 1);
    for (let i = 0; i < 12; i++) {
      await client.invoicesCreate({ kind: "PURCHASE", counterpartyId: supplier.id, lines: [{ itemId: item.id, quantity: 1, unitPrice: 100 }] });
    }
    const first = await client.supplierEntries({ id: supplier.id, limit: 10, offset: 0 });
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(12);
    const second = await client.supplierEntries({ id: supplier.id, limit: 10, offset: 10 });
    expect(second.items).toHaveLength(2);
    expect(second.total).toBe(12);

    // the signed balance is derived from the FULL entries, not the page
    const detail = await client.suppliersGet({ id: supplier.id });
    expect(detail.account?.entries).toHaveLength(12);
    expect(detail.account?.balance).toBe(1200);
    await expect(client.suppliersDelete({ id: supplier.id })).rejects.toThrow(/PARTY_HAS_INVOICES/);
  });

  it("settles a supplier across more than one page without truncating the distribution (issue 174)", async () => {
    const supplier = await client.suppliersCreate({ name: "مورد ترقيم التسوية" });
    const item = await makeItemWithStock("صنف ترقيم التسوية", 1);
    for (let i = 0; i < 12; i++) {
      await client.invoicesCreate({ kind: "PURCHASE", counterpartyId: supplier.id, lines: [{ itemId: item.id, quantity: 1, unitPrice: 100 }] });
    }
    // the tab pages, but the money read carries every invoice the OLDEST-first
    // allocation walks; if pagination had leaked into that read, this would
    // leave unpaid remainders behind
    expect((await client.suppliersGet({ id: supplier.id })).invoices).toHaveLength(12);
    const paid = await client.suppliersPay({ supplierId: supplier.id, amount: 1_200, target: { kind: "OLDEST" } });
    expect(paid.balance).toBe(0);
    const all = await client.partyInvoices({ role: "supplier", id: supplier.id, limit: 100, offset: 0 });
    expect(all.total).toBe(12);
    expect(all.items.every((invoice) => invoice.remainingAmount === 0)).toBe(true);
  });

  it("returns an empty page for an unknown party and never crosses roles", async () => {
    const ghost = "00000000-0000-4000-8000-0000000000ff";
    expect(await client.partyInvoices({ role: "customer", id: ghost })).toEqual({ items: [], total: 0 });
    expect(await client.partyPayments({ id: ghost })).toEqual({ items: [], total: 0 });
    expect(await client.supplierEntries({ id: ghost })).toEqual({ items: [], total: 0 });

    const customer = await client.customersCreate({ name: "زبون ترقيم الأدوار" });
    const item = await makeItemWithStock("صنف ترقيم الأدوار", 1);
    await client.invoicesCreate({ kind: "SALE", counterpartyId: customer.id, counterpartyName: customer.name, lines: [{ itemId: item.id, quantity: 1 }] });
    // a customer id under the supplier role scans purchase invoices: none
    expect(await client.partyInvoices({ role: "supplier", id: customer.id })).toEqual({ items: [], total: 0 });
    expect(await client.supplierEntries({ id: customer.id })).toEqual({ items: [], total: 0 });

    const empty = await client.suppliersCreate({ name: "مورد ترقيم فارغ" });
    expect(await client.supplierEntries({ id: empty.id })).toEqual({ items: [], total: 0 });
    expect((await client.partyInvoices({ role: "supplier", id: empty.id })).total).toBe(0);
  });
});

async function setupSupplier(name: string, units = 10) {
  const category = await client.categoriesCreate({ name: `تصنيف ${name}` });
  const item = await client.itemsCreateWithStock({ name: `صنف ${name}`, categoryId: category.id, costPrice: 100, sellingPrice: 100, stockOnHand: 1 });
  const supplier = await client.suppliersCreate({ name });
  const invoice = await client.invoicesCreate({ kind: "PURCHASE", counterpartyId: supplier.id, lines: [{ itemId: item.id, quantity: units, unitPrice: 100 }] });
  return { supplier, invoice };
}

describe("supplier adjustments (issue 176)", () => {

  it("records an account-only adjustment: the balance moves and no invoice is touched", async () => {
    const { supplier, invoice } = await setupSupplier("مورد تسوية رصيد", 10);

    const increased = await client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 800, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });
    expect(increased.balance).toBe(1800);
    expect(increased.entries.find((entry) => entry.kind === "ADJUSTMENT")).toMatchObject({
      direction: "WE_OWE",
      amount: 800,
      invoiceId: null,
      note: "رصيد افتتاحي",
      // the backdatable date is persisted as the owner entered it
      occurredAt: "2026-10-13T12:00:00",
    });

    const decreased = await client.suppliersAdjust({ supplierId: supplier.id, direction: "THEY_OWE", amount: 300, reason: "تصحيح" });
    expect(decreased.balance).toBe(1500);

    // the account-only adjustment never touches paid/remaining
    const detail = await client.invoicesGet({ id: invoice.id });
    expect(detail.paidAmount).toBe(0);
    expect(detail.remainingAmount).toBe(1000);
    expect(detail.returnCreditAmount).toBe(0);

    // the list seam shows the same signed balance
    expect((await client.suppliersList()).items.find((row) => row.id === supplier.id)?.accountBalance).toBe(1500);
  });

  it("reduces a linked invoice's remaining without cash and the header reconciles", async () => {
    const { supplier, invoice } = await setupSupplier("مورد تسوية خصم", 50);

    const account = await client.suppliersAdjust({ supplierId: supplier.id, direction: "THEY_OWE", amount: 500, reason: "خصم", invoiceId: invoice.id });
    expect(account.balance).toBe(4500);
    expect(account.entries.find((entry) => entry.kind === "ADJUSTMENT")).toMatchObject({ direction: "THEY_OWE", amount: 500, invoiceId: invoice.id });

    const detail = await client.invoicesGet({ id: invoice.id });
    expect(detail.remainingAmount).toBe(4500);
    expect(detail.paidAmount).toBe(0);
    expect(detail.returnCreditAmount).toBe(500);
    expect(detail.remainingAmount).toBe(detail.totalAmount - detail.paidAmount - detail.returnCreditAmount);

    // the account balance and the invoice agree, as the owner's worked example requires
    expect(account.balance).toBe(detail.remainingAmount);
  });

  it("refuses a linked adjustment above the remaining and writes nothing", async () => {
    const { supplier, invoice } = await setupSupplier("مورد تسوية زائدة", 50);

    await expect(client.suppliersAdjust({ supplierId: supplier.id, direction: "THEY_OWE", amount: 5001, reason: "خصم", invoiceId: invoice.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "ADJUSTMENT_EXCEEDS_REMAINING",
    });

    // atomic: neither the invoice nor the account moved
    expect((await client.invoicesGet({ id: invoice.id })).remainingAmount).toBe(5000);
    expect((await client.suppliersGet({ id: supplier.id })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(0);
  });

  it("rejects a duplicate adjustment submission so a retry cannot double-post (issue 177)", async () => {
    const { supplier } = await setupSupplier("مورد تكرار تسوية", 10);
    const payload = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 400, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" };

    const first = await client.suppliersAdjust(payload);
    expect(first.balance).toBe(1400);

    // the same signature (supplier, direction, amount, reason, timestamp) is
    // refused: one entry, one balance move
    await expect(client.suppliersAdjust(payload)).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    const account = await client.suppliersGet({ id: supplier.id });
    expect(account.account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
    expect(account.account?.balance).toBe(1400);
  });

  it("does not reduce a linked invoice twice on a duplicate submission (issue 177)", async () => {
    const { supplier, invoice } = await setupSupplier("مورد تكرار رابط", 50);
    const payload = { supplierId: supplier.id, direction: "THEY_OWE" as const, amount: 500, reason: "خصم", occurredAt: "2026-10-13T12:00:00", invoiceId: invoice.id };

    await client.suppliersAdjust(payload);
    await expect(client.suppliersAdjust(payload)).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });

    // the entry and the reduction both moved exactly once
    const detail = await client.invoicesGet({ id: invoice.id });
    expect(detail.remainingAmount).toBe(4500);
    expect(detail.returnCreditAmount).toBe(500);
    expect(detail.remainingAmount).toBe(detail.totalAmount - detail.paidAmount - detail.returnCreditAmount);
  });

  it("accepts the same amount on a different date (not a duplicate) (issue 177)", async () => {
    const { supplier } = await setupSupplier("مورد تواريخ تسوية", 10);
    await client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 200, reason: "دين قديم", occurredAt: "2026-10-13T12:00:00" });
    const second = await client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 200, reason: "دين قديم", occurredAt: "2026-10-14T12:00:00" });
    expect(second.balance).toBe(1400);
    expect(second.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(2);
  });

  it("refuses a retry that omits the date (server-stamped signature) (issue 177)", async () => {
    const { supplier } = await setupSupplier("مورد ختم الخادم", 10);
    // the caller omits occurredAt, so the server stamps a fresh second each call;
    // the duplicate signature must still catch the retry at any time
    const payload = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 300, reason: "دين قديم" };
    await client.suppliersAdjust(payload);
    await expect(client.suppliersAdjust(payload)).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    const account = await client.suppliersGet({ id: supplier.id });
    expect(account.account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
    expect(account.account?.balance).toBe(1300);
  });

  it("rejects a duplicate row inside an opening-balance batch with a row-specific error (issue 177)", async () => {
    const supplier = await client.suppliersCreate({ name: "مورد صف مكرر" });
    await expect(
      client.suppliersOpeningBalances({
        occurredAt: "2026-10-13T12:00:00",
        reason: "رصيد افتتاحي",
        rows: [
          { supplierId: supplier.id, direction: "WE_OWE", amount: 500 },
          { supplierId: supplier.id, direction: "WE_OWE", amount: 500 },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_OPENING_BALANCE_ROW" });
    // nothing half-saved
    expect((await client.suppliersGet({ id: supplier.id })).account?.entries ?? []).toHaveLength(0);
  });

  it("serialises two identical concurrent submissions so only one posts (issue 177)", async () => {
    const { supplier } = await setupSupplier("مورد تزامن تسوية", 10);
    const payload = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 450, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" };
    const results = await Promise.allSettled([client.suppliersAdjust(payload), client.suppliersAdjust(payload)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const account = await client.suppliersGet({ id: supplier.id });
    expect(account.account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
    expect(account.account?.balance).toBe(1450);
  });

  it("keeps remaining >= 0 when two linked adjustments race (issue 177)", async () => {
    const { supplier, invoice } = await setupSupplier("مورد تزامن رابط", 5);
    const base = { supplierId: supplier.id, direction: "THEY_OWE" as const, amount: 300, occurredAt: "2026-10-13T12:00:00", invoiceId: invoice.id };
    const results = await Promise.allSettled([
      client.suppliersAdjust({ ...base, reason: "خصم أ" }),
      client.suppliersAdjust({ ...base, reason: "خصم ب" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const detail = await client.invoicesGet({ id: invoice.id });
    expect(detail.remainingAmount).toBe(200);
    expect(detail.remainingAmount).toBeGreaterThanOrEqual(0);
  });

  it("does not double-post an identical bulk opening-balance batch (issue 177)", async () => {
    const supplier = await client.suppliersCreate({ name: "مورد دفعي مكرر" });
    const payload = {
      occurredAt: "2026-10-13T12:00:00",
      reason: "رصيد افتتاحي",
      rows: [{ supplierId: supplier.id, direction: "WE_OWE" as const, amount: 700, confirmExisting: true }],
    };
    const first = await client.suppliersOpeningBalances(payload);
    expect(first.created).toBe(1);
    await expect(client.suppliersOpeningBalances(payload)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await client.suppliersGet({ id: supplier.id })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
  });

  it("posts one row per distinct supplier in a bulk batch (issue 177)", async () => {
    const a = await client.suppliersCreate({ name: "مورد دفعي أ" });
    const b = await client.suppliersCreate({ name: "مورد دفعي ب" });
    const result = await client.suppliersOpeningBalances({
      occurredAt: "2026-10-13T12:00:00",
      reason: "رصيد افتتاحي",
      rows: [
        { supplierId: a.id, direction: "WE_OWE", amount: 500 },
        { supplierId: b.id, direction: "WE_OWE", amount: 500 },
      ],
    });
    expect(result.created).toBe(2);
  });

  it("refuses two rows naming the same new supplier before creating a party (issue 177)", async () => {
    await expect(
      client.suppliersOpeningBalances({
        occurredAt: "2026-10-13T12:00:00",
        rows: [
          { newSupplierName: "مورد اسم مكرر", direction: "WE_OWE", amount: 100 },
          { newSupplierName: "مورد  اسم مكرر", direction: "WE_OWE", amount: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_OPENING_BALANCE_ROW" });
    // the folded-whitespace duplicate never created a party
    expect((await client.suppliersList()).items.some((row) => row.name.includes("اسم مكرر"))).toBe(false);
  });

  it("does not double-post a new-supplier opening balance when the response is lost (Greptile round 1)", async () => {
    const name = `مورد إعادة إرسال-${Date.now()}`;
    const payload = {
      occurredAt: "2026-10-13T12:00:00",
      reason: "رصيد افتتاحي",
      rows: [{ newSupplierName: name, direction: "WE_OWE" as const, amount: 900 }],
    };
    const first = await client.suppliersOpeningBalances(payload);
    expect(first.created).toBe(1);

    // the response is lost; the client resends the exact batch. The name must
    // resolve to the supplier the first attempt created, so the signature dedup
    // sees the prior entry instead of minting a second supplier and double-posting.
    await expect(client.suppliersOpeningBalances(payload)).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });

    const matches = (await client.suppliersList({ limit: MAX_PAGE_SIZE })).items.filter((row) => row.name === name);
    expect(matches).toHaveLength(1);
    expect(matches.reduce((sum, row) => sum + (row.accountBalance ?? 0), 0)).toBe(900);
  });

  it("does not double-post an existing-supplier opening balance when the response is lost (Greptile round 1)", async () => {
    const supplier = await client.suppliersCreate({ name: `مورد إعادة معرف-${Date.now()}` });
    // a first attempt against a supplier with no entries legitimately sends no
    // confirmExisting; its exact resend must be a duplicate, not a confirmation
    const payload = {
      occurredAt: "2026-10-13T12:00:00",
      reason: "رصيد افتتاحي",
      rows: [{ supplierId: supplier.id, direction: "WE_OWE" as const, amount: 700 }],
    };
    const first = await client.suppliersOpeningBalances(payload);
    expect(first.created).toBe(1);

    await expect(client.suppliersOpeningBalances(payload)).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    const entries = (await client.suppliersGet({ id: supplier.id })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT") ?? [];
    expect(entries).toHaveLength(1);
  });

  it("requires confirmation when a new-supplier name collides with a supplier that has entries (Greptile round 1)", async () => {
    const collisionName = `مورد تصادم-${Date.now()}`;
    const existing = await client.suppliersCreate({ name: collisionName });
    await client.suppliersAdjust({ supplierId: existing.id, direction: "WE_OWE", amount: 100 });

    // a typed new name that resolves to an existing supplier with entries is a
    // different amount: it must not append without the confirmation the
    // supplierId path requires
    await expect(
      client.suppliersOpeningBalances({
        occurredAt: "2026-10-13T12:00:00",
        rows: [{ newSupplierName: collisionName, direction: "WE_OWE", amount: 700 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "OPENING_BALANCE_EXISTS" });

    // no second supplier and no second entry
    expect((await client.suppliersList({ limit: MAX_PAGE_SIZE })).items.filter((row) => row.name === collisionName)).toHaveLength(1);
    expect((await client.suppliersGet({ id: existing.id })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
  });

  it("resolves a duplicated folded name to the supplier that already carries entries (Greptile round 1)", async () => {
    const name = `مورد ازدواج-${Date.now()}`;
    // the two names fold to the same normalizeTextKey (whitespace collapses)
    const empty = await client.suppliersCreate({ name });
    const carrying = await client.suppliersCreate({ name: name.replace(" ", "  ") });
    await client.suppliersAdjust({ supplierId: carrying.id, direction: "WE_OWE", amount: 500, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

    // the resend of the carrying supplier's entry must resolve to it, not the
    // empty twin, so the duplicate is reported against the right account
    await expect(
      client.suppliersOpeningBalances({ occurredAt: "2026-10-13T12:00:00", reason: "رصيد افتتاحي", rows: [{ newSupplierName: name, direction: "WE_OWE", amount: 500 }] }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });

    expect((await client.suppliersGet({ id: empty.id })).account?.entries ?? []).toHaveLength(0);
    expect((await client.suppliersGet({ id: carrying.id })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
  });

  it("resolves a typed name to the same supplier the opening-balance write lands on (issue 184)", async () => {
    const name = `مورد قرار-${Date.now()}`;
    // both fold to one normalizeTextKey; only the second carries an entry
    const empty = await client.suppliersCreate({ name });
    const carrying = await client.suppliersCreate({ name: name.replace(" ", "  ") });
    await client.suppliersAdjust({ supplierId: carrying.id, direction: "WE_OWE", amount: 100, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

    const resolved = await client.suppliersResolveName({ name, direction: "WE_OWE", amount: 500, occurredAt: "2026-10-13T12:00:00", reason: "رصيد افتتاحي" });
    expect(resolved.supplier?.id).toBe(carrying.id);
    // the dialog renders the server's stored text; the write returns the same name
    expect(resolved.supplier?.name).toBe(name.replace(" ", "  "));

    // the dialog names the resolved account; the write must land on that same one
    const result = await client.suppliersOpeningBalances({
      occurredAt: "2026-10-13T12:00:00",
      reason: "رصيد افتتاحي",
      rows: [{ newSupplierName: name, direction: "WE_OWE", amount: 500, confirmExisting: true }],
    });
    expect(result.accounts[0]?.supplierId).toBe(resolved.supplier?.id);
    expect(result.accounts[0]?.supplierId).toBe(carrying.id);
    expect(result.accounts[0]?.name).toBe(resolved.supplier?.name);
    expect((await client.suppliersGet({ id: empty.id })).account?.entries ?? []).toHaveLength(0);
  });

  it("resolves two empty folded names to the lowest id, the same id the write picks (issue 184)", async () => {
    const name = `مورد فارغ-${Date.now()}`;
    const a = await client.suppliersCreate({ name });
    const b = await client.suppliersCreate({ name: name.replace(" ", "  ") });
    const expectedId = a.id < b.id ? a.id : b.id;

    const resolved = await client.suppliersResolveName({ name, direction: "WE_OWE", amount: 300, occurredAt: "2026-10-13T12:00:00" });
    expect(resolved.supplier?.id).toBe(expectedId);
    expect(resolved.supplier?.accountEntryCount).toBe(0);

    const result = await client.suppliersOpeningBalances({ occurredAt: "2026-10-13T12:00:00", rows: [{ newSupplierName: name, direction: "WE_OWE", amount: 300 }] });
    expect(result.accounts[0]?.supplierId).toBe(expectedId);
  });

  it("resolves a fresh name to null, meaning a write would create one (issue 184)", async () => {
    const resolved = await client.suppliersResolveName({ name: `مورد فرِيد-${Date.now()}`, direction: "WE_OWE", amount: 400, occurredAt: "2026-10-13T12:00:00" });
    expect(resolved.supplier).toBeNull();
  });

  it("resolves a retry to the account already holding the row signature, over the entry-count winner (issue 184)", async () => {
    const name = `مورد توقيع-${Date.now()}`;
    const busier = await client.suppliersCreate({ name });
    const holder = await client.suppliersCreate({ name: name.replace(" ", "  ") });
    // busier carries more entries, so the tie-break alone would pick it
    await client.suppliersAdjust({ supplierId: busier.id, direction: "WE_OWE", amount: 10, reason: "أ" });
    await client.suppliersAdjust({ supplierId: busier.id, direction: "WE_OWE", amount: 20, reason: "ب" });
    // holder already carries the exact row signature below
    await client.suppliersAdjust({ supplierId: holder.id, direction: "WE_OWE", amount: 700, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

    const row = { direction: "WE_OWE" as const, amount: 700, occurredAt: "2026-10-13T12:00:00", reason: "رصيد افتتاحي" };
    const resolved = await client.suppliersResolveName({ name, ...row });
    expect(resolved.supplier?.id).toBe(holder.id);

    // the write targets the same account and reports the duplicate there, never
    // posting the 700 to the busier tie-break winner
    await expect(
      client.suppliersOpeningBalances({ occurredAt: row.occurredAt, reason: row.reason, rows: [{ newSupplierName: name, direction: row.direction, amount: row.amount, confirmExisting: true }] }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    expect((await client.suppliersGet({ id: busier.id })).account?.entries.filter((entry) => entry.amount === 700) ?? []).toHaveLength(0);
  });

  it("refuses when the named destination no longer matches the server's resolution (issue 184)", async () => {
    const name = `مورد تغيّر-${Date.now()}`;
    const a = await client.suppliersCreate({ name });
    const b = await client.suppliersCreate({ name: name.replace(" ", "  ") });
    const resolved = await client.suppliersResolveName({ name, direction: "WE_OWE", amount: 400, occurredAt: "2026-10-13T12:00:00" });
    const otherId = resolved.supplier?.id === a.id ? b.id : a.id;

    // the dialog named `otherId`, but the live resolution picks someone else:
    // the write must refuse instead of posting to an account the owner never saw
    await expect(
      client.suppliersOpeningBalances({
        occurredAt: "2026-10-13T12:00:00",
        rows: [{ newSupplierName: name, direction: "WE_OWE", amount: 400, expectedSupplierId: otherId }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "OPENING_BALANCE_TARGET_CHANGED" });
    expect((await client.suppliersGet({ id: a.id })).account?.entries ?? []).toHaveLength(0);
    expect((await client.suppliersGet({ id: b.id })).account?.entries ?? []).toHaveLength(0);

    // a name that folds to an existing supplier cannot be sent as "new" either
    await expect(
      client.suppliersOpeningBalances({
        occurredAt: "2026-10-13T12:00:00",
        rows: [{ newSupplierName: name, direction: "WE_OWE", amount: 400, expectedSupplierId: null }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "OPENING_BALANCE_TARGET_CHANGED" });
  });

  it("refuses when the named account no longer folds to the typed name (issue 184)", async () => {
    const name = `مورد أعيدت-${Date.now()}`;
    const named = await client.suppliersCreate({ name });
    // the dialog named `named`, then the supplier was renamed so the name no
    // longer folds to it
    await client.suppliersUpdate({ id: named.id, name: `${name}-2` });

    await expect(
      client.suppliersOpeningBalances({
        occurredAt: "2026-10-13T12:00:00",
        rows: [{ newSupplierName: name, direction: "WE_OWE", amount: 400, expectedSupplierId: named.id }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "OPENING_BALANCE_TARGET_CHANGED" });
    // the name was not silently materialized as a brand-new party
    const matches = (await client.suppliersList({ limit: MAX_PAGE_SIZE })).items.filter((row) => row.name === name);
    expect(matches).toHaveLength(0);
  });

  it("accepts expectedSupplierId: null when the name is genuinely new (issue 184)", async () => {
    const name = `مورد جديد-${Date.now()}`;
    const resolved = await client.suppliersResolveName({ name, direction: "WE_OWE", amount: 250, occurredAt: "2026-10-13T12:00:00" });
    expect(resolved.supplier).toBeNull();

    const result = await client.suppliersOpeningBalances({
      occurredAt: "2026-10-13T12:00:00",
      rows: [{ newSupplierName: name, direction: "WE_OWE", amount: 250, expectedSupplierId: null }],
    });
    expect(result.created).toBe(1);
    expect(result.accounts[0]?.name).toBe(name);
  });

  it("rejects a whitespace-only resolve name and a zero amount, and folds surrounding whitespace (issue 184)", async () => {
    await expect(client.suppliersResolveName({ name: "   ", direction: "WE_OWE", amount: 100, occurredAt: "2026-10-13T12:00:00" })).rejects.toThrow(/Input validation failed/);
    await expect(client.suppliersResolveName({ name: "مورد حد", direction: "WE_OWE", amount: 0, occurredAt: "2026-10-13T12:00:00" })).rejects.toThrow(/Input validation failed/);

    const name = `مورد هامش-${Date.now()}`;
    const supplier = await client.suppliersCreate({ name });
    // surrounding whitespace folds to the stored name, exactly as the write folds it
    const resolved = await client.suppliersResolveName({ name: `  ${name}  `, direction: "WE_OWE", amount: 100, occurredAt: "2026-10-13T12:00:00" });
    expect(resolved.supplier?.id).toBe(supplier.id);
  });

  it("rejects expectedSupplierId on an explicit supplierId row at the contract (issue 184)", async () => {
    const supplier = await client.suppliersCreate({ name: `مورد صريح-${Date.now()}` });
    await expect(
      client.suppliersOpeningBalances({
        occurredAt: "2026-10-13T12:00:00",
        rows: [{ supplierId: supplier.id, direction: "WE_OWE", amount: 100, expectedSupplierId: supplier.id }],
      }),
    ).rejects.toThrow(/Input validation failed/);
  });

  it("keeps a named-batch retry on the original account when both fold to one name (Greptile round 3)", async () => {
    const name = `مورد مطابق-${Date.now()}`;
    const a = await client.suppliersCreate({ name });
    const b = await client.suppliersCreate({ name: name.replace(" ", "  ") });

    // the first attempt posts to the tie-break winner (both 0 entries -> lowest id)
    const payload = { occurredAt: "2026-10-13T12:00:00", reason: "رصيد افتتاحي", rows: [{ newSupplierName: name, direction: "WE_OWE" as const, amount: 700 }] };
    const first = await client.suppliersOpeningBalances(payload);
    expect(first.created).toBe(1);
    const originalId = first.accounts[0]!.supplierId;

    // the OTHER folded-match gains more entries, so the entry-count tie-break
    // alone would now pick it and miss the entry on the original
    const otherId = originalId === a.id ? b.id : a.id;
    await client.suppliersAdjust({ supplierId: otherId, direction: "WE_OWE", amount: 50 });
    await client.suppliersAdjust({ supplierId: otherId, direction: "WE_OWE", amount: 60 });

    // the client's confirmed retry must resolve to the original account and
    // report the duplicate, never post a second 700 to the other supplier
    await expect(
      client.suppliersOpeningBalances({ ...payload, rows: [{ ...payload.rows[0]!, confirmExisting: true }] }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });

    expect((await client.suppliersGet({ id: originalId })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT" && entry.amount === 700) ?? []).toHaveLength(1);
    expect((await client.suppliersGet({ id: otherId })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT" && entry.amount === 700) ?? []).toHaveLength(0);
  });

  it("accepts an explicit supplierId for a same-name sibling with no matching entry (Greptile round 4)", async () => {
    const name = `مورد توأم-${Date.now()}`;
    const a = await client.suppliersCreate({ name, phone: "0550111111" });
    const b = await client.suppliersCreate({ name, phone: "0550222222" });

    // A already holds an identical signature
    await client.suppliersAdjust({ supplierId: a.id, direction: "WE_OWE", amount: 700, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

    // B is the user's explicit choice: its opening balance must be accepted, not
    // replaced by A's id (which would refuse the whole batch as a duplicate)
    const result = await client.suppliersOpeningBalances({
      occurredAt: "2026-10-13T12:00:00",
      reason: "رصيد افتتاحي",
      rows: [{ supplierId: b.id, direction: "WE_OWE", amount: 700, confirmExisting: true }],
    });
    expect(result.created).toBe(1);
    expect((await client.suppliersGet({ id: b.id })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT" && entry.amount === 700) ?? []).toHaveLength(1);
    expect((await client.suppliersGet({ id: a.id })).account?.entries.filter((entry) => entry.kind === "ADJUSTMENT" && entry.amount === 700) ?? []).toHaveLength(1);
  });

  it("reports a linked resend as a duplicate, not an over-remaining error (Greptile round 1)", async () => {
    const { supplier, invoice } = await setupSupplier("مورد إعادة رابط", 5);
    const payload = { supplierId: supplier.id, direction: "THEY_OWE" as const, amount: 300, reason: "خصم", occurredAt: "2026-10-13T12:00:00", invoiceId: invoice.id };

    await client.suppliersAdjust(payload);
    expect((await client.invoicesGet({ id: invoice.id })).remainingAmount).toBe(200);

    // the invoice now has 200 left, but the exact resend is a duplicate, not an
    // amount that newly exceeds the remaining
    await expect(client.suppliersAdjust(payload)).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    expect((await client.invoicesGet({ id: invoice.id })).remainingAmount).toBe(200);
  });

  it("reports a full-settlement linked resend as a duplicate (Greptile round 1)", async () => {
    const { supplier, invoice } = await setupSupplier("مورد إعادة تسوية كامل", 5);
    const payload = { supplierId: supplier.id, direction: "THEY_OWE" as const, amount: 500, reason: "خصم", occurredAt: "2026-10-13T12:00:00", invoiceId: invoice.id };

    await client.suppliersAdjust(payload);
    expect((await client.invoicesGet({ id: invoice.id })).remainingAmount).toBe(0);

    // a zeroed invoice must still report the resend as a duplicate
    await expect(client.suppliersAdjust(payload)).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    expect((await client.invoicesGet({ id: invoice.id })).remainingAmount).toBe(0);
  });

  it("refuses to link a نسالوه adjustment that would increase an invoice", async () => {
    const { supplier, invoice } = await setupSupplier("مورد تسوية اتجاه", 10);
    await expect(client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, invoiceId: invoice.id })).rejects.toThrow(/Input validation failed/);
  });

  it("refuses a link to another supplier's invoice or to a sale invoice", async () => {
    const a = await setupSupplier("مورد رابط أ", 10);
    const b = await setupSupplier("مورد رابط ب", 10);
    await expect(client.suppliersAdjust({ supplierId: a.supplier.id, direction: "THEY_OWE", amount: 100, invoiceId: b.invoice.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "INVOICE_NOT_PURCHASE",
    });

    const item = (await client.itemsAll()).items.find((row) => row.name === "صنف مورد رابط أ");
    if (item === undefined) throw new Error("expected the seeded item");
    const customer = await client.customersCreate({ name: "زبون رابط" });
    const sale = await client.invoicesCreate({ kind: "SALE", counterpartyId: customer.id, lines: [{ itemId: item.id, quantity: 1 }] });
    await expect(client.suppliersAdjust({ supplierId: a.supplier.id, direction: "THEY_OWE", amount: 50, invoiceId: sale.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "INVOICE_NOT_PURCHASE",
    });
  });

  it("rejects an empty opening-balance batch and a zero amount at the contract", async () => {
    const supplier = await client.suppliersCreate({ name: "مورد حدود صفر" });
    await expect(client.suppliersOpeningBalances({ occurredAt: "2026-10-13T12:00:00", rows: [] })).rejects.toThrow(/Input validation failed/);
    await expect(client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 0 })).rejects.toThrow(/Input validation failed/);
  });

  it("zeroes an invoice when the linked adjustment equals its remaining", async () => {
    const { supplier, invoice } = await setupSupplier("مورد تسوية كامل", 50);

    const account = await client.suppliersAdjust({ supplierId: supplier.id, direction: "THEY_OWE", amount: 5000, reason: "خصم", invoiceId: invoice.id });
    expect(account.balance).toBe(0);

    const detail = await client.invoicesGet({ id: invoice.id });
    expect(detail.remainingAmount).toBe(0);
    expect(detail.returnCreditAmount).toBe(5000);
    // a settled invoice is no longer offered for linking
    const outstanding = await store.listOutstandingPurchaseInvoices(supplier.id);
    expect(outstanding.map((row) => row.id)).not.toContain(invoice.id);
  });

  it("writes one opening balance per filled row and confirms a supplier that already has entries", async () => {
    const existing = await client.suppliersCreate({ name: "مورد رصيد قائم" });
    const fresh = await client.suppliersCreate({ name: "مورد بلا حركات" });
    await client.suppliersAdjust({ supplierId: existing.id, direction: "WE_OWE", amount: 100 });

    // an unconfirmed row for a supplier that already has an entry is refused
    // atomically: nothing is written
    await expect(
      client.suppliersOpeningBalances({ occurredAt: "2026-10-13T12:00:00", reason: "رصيد افتتاحي", rows: [{ supplierId: existing.id, direction: "WE_OWE", amount: 800 }] }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "OPENING_BALANCE_EXISTS" });
    expect((await client.suppliersGet({ id: existing.id })).account?.entries).toHaveLength(1);

    const result = await client.suppliersOpeningBalances({
      occurredAt: "2026-10-13T12:00:00",
      reason: "رصيد افتتاحي",
      rows: [
        { supplierId: existing.id, direction: "WE_OWE", amount: 800, confirmExisting: true },
        { supplierId: fresh.id, direction: "THEY_OWE", amount: 300 },
        { newSupplierName: "مورد جملة جديد", direction: "WE_OWE", amount: 5000 },
      ],
    });
    expect(result.created).toBe(3);
    expect(result.accounts.find((account) => account.supplierId === existing.id)?.balance).toBe(900);
    expect(result.accounts.find((account) => account.supplierId === fresh.id)?.balance).toBe(-300);
    expect(result.accounts.find((account) => account.name === "مورد جملة جديد")?.balance).toBe(5000);

    // the inline supplier is real, listable, and carries its opening balance
    const created = (await client.suppliersList()).items.find((row) => row.name === "مورد جملة جديد");
    expect(created).toBeDefined();
    expect(created?.accountBalance).toBe(5000);
    expect(created?.accountEntryCount).toBe(1);
  });

  it("rolls the whole batch back when one row names an unknown supplier", async () => {
    const fresh = await client.suppliersCreate({ name: "مورد دفعة صالحة" });
    await expect(
      client.suppliersOpeningBalances({
        occurredAt: "2026-10-13T12:00:00",
        rows: [
          { supplierId: fresh.id, direction: "WE_OWE", amount: 100 },
          { supplierId: "00000000-0000-4000-8000-000000000000", direction: "WE_OWE", amount: 200 },
        ],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // nothing half-saved, even for the valid first row
    expect((await client.suppliersGet({ id: fresh.id })).account?.entries ?? []).toHaveLength(0);
  });
});

describe("suppliersResolveName uses the lean reads (issue 213)", () => {
  it("resolves from listPartyNames + listSupplierAccountSummaries, never listParties (issue 213)", async () => {
    const name = `مورد-قراءة-رقيقة-${Date.now()}`;
    const supplier = await client.suppliersCreate({ name });
    await client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 120, reason: "رصيد افتتاحي", occurredAt: "2026-10-13T12:00:00" });

    // count the reads the resolve path performs: a regression back to
    // `listParties` re-joins every invoice and re-introduces the aggregate #183
    // removed, so the assertion that it is never called is the whole point.
    let listPartiesCalls = 0;
    const reads: string[] = [];
    const countingStore: StorePort = {
      ...store,
      listParties: (role) => {
        listPartiesCalls += 1;
        return store.listParties(role);
      },
      listPartyNames: (role) => {
        reads.push(`names:${role}`);
        return store.listPartyNames(role);
      },
      listSupplierAccountSummaries: () => {
        reads.push("summaries");
        return store.listSupplierAccountSummaries();
      },
    };
    const countingClient = clientForStore(countingStore);

    const resolved = await countingClient.suppliersResolveName({ name, direction: "WE_OWE", amount: 120, occurredAt: "2026-10-13T12:00:00", reason: "رصيد افتتاحي" });
    expect(resolved.supplier?.id).toBe(supplier.id);
    expect(resolved.supplier?.accountEntryCount).toBe(1);
    expect(listPartiesCalls).toBe(0);
    expect(reads).toEqual(["names:supplier", "summaries"]);
  });

  it("returns null from an empty store without touching the aggregate (issue 213)", async () => {
    // zero suppliers: both lean reads are empty and `listParties` is booby-trapped
    // so a regression fails loudly instead of merely costing more.
    const emptyStore: StorePort = {
      ...store,
      listPartyNames: async () => [],
      listSupplierAccountSummaries: async () => [],
      listParties: async () => {
        throw new Error("suppliersResolveName must not call listParties");
      },
    };
    const emptyClient = clientForStore(emptyStore);

    const resolved = await emptyClient.suppliersResolveName({ name: `مورد-فارغ-${Date.now()}`, direction: "WE_OWE", amount: 100, occurredAt: "2026-10-13T12:00:00" });
    expect(resolved.supplier).toBeNull();
  });

  it("resolves a no-match name to null through the lean filter (issue 213)", async () => {
    const resolved = await client.suppliersResolveName({ name: `مورد-بلا-مطابقة-${Date.now()}`, direction: "WE_OWE", amount: 100, occurredAt: "2026-10-13T12:00:00" });
    expect(resolved.supplier).toBeNull();
  });
});

describe("supplier adjustment idempotency key (issue 181)", () => {
  it("refuses a keyed retry whose timestamp changed (issue 181)", async () => {
    const { supplier } = await setupSupplier("مورد مفتاح تغيّر الوقت");
    const payload = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 400, reason: "رصيد افتتاحي", idempotencyKey: "retry-gap-1" };

    const first = await client.suppliersAdjust({ ...payload, occurredAt: "2026-10-13T12:00:00" });
    expect(first.balance).toBe(1400);

    // the #177 guard keyed on the timestamp and would post again here; the
    // explicit key makes the changed timestamp irrelevant
    await expect(client.suppliersAdjust({ ...payload, occurredAt: "2026-10-14T09:30:00" })).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    const account = await client.suppliersGet({ id: supplier.id });
    expect(account.account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
    expect(account.account?.balance).toBe(1400);
  });

  it("treats the key as the request identity even when other fields change (issue 181)", async () => {
    const { supplier } = await setupSupplier("مورد مفتاح تغيّر المبلغ");
    const first = await client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, reason: "دين قديم", idempotencyKey: "same-request", occurredAt: "2026-10-13T12:00:00" });
    expect(first.balance).toBe(1100);
    await expect(
      client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 200, reason: "دين قديم", idempotencyKey: "same-request", occurredAt: "2026-10-13T12:00:00" }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    const account = await client.suppliersGet({ id: supplier.id });
    expect(account.account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
    expect(account.account?.balance).toBe(1100);
  });

  it("does not let the key weaken the signature guard (issue 181)", async () => {
    const { supplier } = await setupSupplier("مورد مفتاح لا يضعف التوقيع");
    const occurredAt = "2026-10-13T12:00:00";
    await client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 300, reason: "دين قديم", occurredAt });
    // a fresh key on the identical signature is still an identical repeat
    await expect(
      client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 300, reason: "دين قديم", occurredAt, idempotencyKey: "fresh-key" }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    const account = await client.suppliersGet({ id: supplier.id });
    expect(account.account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
    expect(account.account?.balance).toBe(1300);
  });

  it("scopes the key to the supplier account (issue 181)", async () => {
    const a = await setupSupplier("مورد مفتاح أ");
    const b = await setupSupplier("مورد مفتاح ب");
    await client.suppliersAdjust({ supplierId: a.supplier.id, direction: "WE_OWE", amount: 100, idempotencyKey: "shared", occurredAt: "2026-10-13T12:00:00" });
    // the same key on a different account is a different request
    const second = await client.suppliersAdjust({ supplierId: b.supplier.id, direction: "WE_OWE", amount: 100, idempotencyKey: "shared", occurredAt: "2026-10-13T12:00:00" });
    expect(second.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
    expect(second.balance).toBe(1100);
    expect((await client.suppliersGet({ id: a.supplier.id })).account?.balance).toBe(1100);
  });

  it("rejects a blank or oversized idempotency key at the contract and accepts the 200-char boundary (issue 181)", async () => {
    const { supplier } = await setupSupplier("مورد مفتاح غير صالح");
    await expect(client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, idempotencyKey: "   " })).rejects.toThrow(/Input validation failed/);
    await expect(client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, idempotencyKey: "x".repeat(201) })).rejects.toThrow(/Input validation failed/);
    const boundary = await client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, idempotencyKey: "x".repeat(200), occurredAt: "2026-10-13T12:00:00" });
    expect(boundary.balance).toBe(1100);
    // the contract trims, so a padded identical key is the same request
    await expect(
      client.suppliersAdjust({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, idempotencyKey: "   " + "x".repeat(200) + "   ", occurredAt: "2026-10-13T12:00:00" }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "DUPLICATE_ADJUSTMENT" });
    const account = await client.suppliersGet({ id: supplier.id });
    expect(account.account?.entries.filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
  });
});

describe("expenses (ticket 31)", () => {
  it("seeds default expense categories with exactly one owner-withdrawal flag", async () => {
    const { items } = await client.expenseCategoriesList();
    expect(items.length).toBeGreaterThanOrEqual(6);
    // scoped to the seeded name: later tests may intentionally add flagged rows
    const seeded = items.filter((row) => row.name === "سحوبات المالك");
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.isOwnerWithdrawal).toBe(true);
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
    const activityRows = (await client.activitiesList({})).items.filter((entry) => entry.type === "EXPENSE_RECORDED");
    expect(activityRows.some((entry) => entry.ref === expense.id && entry.summary.includes("1200"))).toBe(true);
  });

  it("rejects an unknown category and schema-invalid amounts", async () => {
    await expect(
      client.expensesCreate({ categoryId: "00000000-0000-4000-8000-000000000000", amount: 100 }),
    ).rejects.toThrow(/CATEGORY_NOT_FOUND/);
    const validId = (await client.expenseCategoriesList()).items[0]!.id;
    // zero/negative/huge amounts fail zod before the router ever runs
    await expect(client.expensesCreate({ categoryId: validId, amount: 0 })).rejects.toThrow(/Input validation failed/);
    await expect(client.expensesCreate({ categoryId: validId, amount: -5 })).rejects.toThrow(/Input validation failed/);
    await expect(client.expensesCreate({ categoryId: validId, amount: 1_000_000_000_001 })).rejects.toThrow(/Input validation failed/);
    // malformed occurredAt and unknown presets are rejected at the schema too;
    // the casts only widen a literal so the zod boundary is exercised
    // occurredAt is format-validated like every other local timestamp (regex
    // policy shared with invoiceDate: no calendar-range checks app-wide); a
    // value that fails the fixed-width pattern is rejected at the schema
    await expect(client.expensesCreate({ categoryId: validId, amount: 1, occurredAt: "not-a-time" })).rejects.toThrow(/Input validation failed/);
    // SAFETY: the cast feeds a value deliberately outside the closed preset enum
    await expect(client.reportsProfit({ preset: "FORTNIGHT" as never })).rejects.toThrow(/Input validation failed/);
    // SAFETY: the cast feeds a value deliberately outside the sort fields
    await expect(client.expensesList({ sortBy: "nonsense" as never })).rejects.toThrow(/Input validation failed/);
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

    // multi-category filter: both ids together return both rows, nothing else
    const both = await client.expensesList({ categoryIds: [op.id, withdrawal.id] });
    const bothIds = both.items.map((row) => row.id);
    expect(bothIds).toContain(withdraw.id);
    expect(bothIds.some((id) => id !== withdraw.id)).toBe(true); // at least the op rows (222 etc.)
    // an empty-window filter returns no rows
    const empty = await client.expensesList({ categoryIds: [withdrawal.id], from: "2020-09-01T00:00:00", to: "2020-09-30T23:59:59" });
    expect(empty.items).toEqual([]);
  });

  it("sorts history by date or amount in both directions", async () => {
    const { items: categories } = await client.expenseCategoriesList();
    const op = categories.find((row) => !row.isOwnerWithdrawal)!;
    // far-past dates (2020) keep this strict window immune to the machine clock
    // landing inside the window during a run
    const small = await client.expensesCreate({ categoryId: op.id, amount: 50, occurredAt: "2020-02-01T12:00:00" });
    const big = await client.expensesCreate({ categoryId: op.id, amount: 900, occurredAt: "2020-02-20T12:00:00" });
    const mid = await client.expensesCreate({ categoryId: op.id, amount: 100, occurredAt: "2020-02-10T12:00:00" });
    const window = { from: "2020-02-01T00:00:00", to: "2020-02-28T23:59:59" };
    const amounts = (rows: readonly { amount: number }[]) => rows.map((row) => row.amount);
    const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

    const byDateDesc = await client.expensesList({ ...window, sortBy: "occurredAt", sortDir: "desc" });
    expect(ids(byDateDesc.items)).toEqual([big.id, mid.id, small.id]);
    expect(amounts(byDateDesc.items)).toEqual([900, 100, 50]);
    const byDateAsc = await client.expensesList({ ...window, sortBy: "occurredAt", sortDir: "asc" });
    expect(ids(byDateAsc.items)).toEqual([small.id, mid.id, big.id]);
    const byAmountAsc = await client.expensesList({ ...window, sortBy: "amount", sortDir: "asc" });
    expect(amounts(byAmountAsc.items)).toEqual([50, 100, 900]);
    const byAmountDesc = await client.expensesList({ ...window, sortBy: "amount", sortDir: "desc" });
    expect(amounts(byAmountDesc.items)).toEqual([900, 100, 50]);
  });

  it("pages expenses after the sort, keeping the total stable (issue 163)", async () => {
    const { items: categories } = await client.expenseCategoriesList();
    const op = categories.find((row) => !row.isOwnerWithdrawal)!;
    // a dedicated far-past window keeps this test its own slice of the store
    const window = { categoryIds: [op.id], from: "2020-03-01T00:00:00", to: "2020-03-31T23:59:59" };
    await client.expensesCreate({ categoryId: op.id, amount: 50, occurredAt: "2020-03-01T12:00:00" });
    await client.expensesCreate({ categoryId: op.id, amount: 900, occurredAt: "2020-03-20T12:00:00" });
    await client.expensesCreate({ categoryId: op.id, amount: 100, occurredAt: "2020-03-10T12:00:00" });
    const amounts = (rows: readonly { amount: number }[]) => rows.map((row) => row.amount);

    const first = await client.expensesList({ ...window, sortBy: "amount", sortDir: "asc", limit: 2, offset: 0 });
    expect(amounts(first.items)).toEqual([50, 100]);
    expect(first.total).toBe(3);
    // the second page continues the SORTED order (a slice before the sort
    // would repeat rows), and total never shrinks to the page size
    const second = await client.expensesList({ ...window, sortBy: "amount", sortDir: "asc", limit: 2, offset: 2 });
    expect(amounts(second.items)).toEqual([900]);
    expect(second.total).toBe(3);
  });

  it("rejects an inverted custom window with INVALID_RANGE", async () => {
    await expect(client.expensesList({ from: "2026-03-01T00:00:00", to: "2026-02-01T00:00:00" })).rejects.toThrow(/INVALID_RANGE/);
    await expect(client.reportsProfit({ preset: "CUSTOM", customFrom: "2026-03-01T00:00:00", customTo: "2026-02-01T00:00:00" })).rejects.toThrow(/INVALID_RANGE/);
    await expect(client.reportsProfit({ preset: "CUSTOM" })).rejects.toThrow(/INVALID_RANGE/);
  });

  it("honors customFrom/customTo even without a preset (never silently dropped)", async () => {
    const { items: categories } = await client.expenseCategoriesList();
    const op = categories.find((row) => !row.isOwnerWithdrawal)!;
    const entry = await client.expensesCreate({ categoryId: op.id, amount: 321, occurredAt: "2020-03-05T12:00:00" });
    const windowed = await client.expensesList({ customFrom: "2020-03-01T00:00:00", customTo: "2020-03-31T23:59:59" });
    expect(windowed.items.map((row) => row.id)).toContain(entry.id);
    const outside = await client.expensesList({ customFrom: "2020-04-01T00:00:00", customTo: "2020-04-30T23:59:59" });
    expect(outside.items.map((row) => row.id)).not.toContain(entry.id);
    await expect(
      client.expensesList({ customFrom: "2020-04-01T00:00:00", customTo: "2020-03-01T00:00:00" }),
    ).rejects.toThrow(/INVALID_RANGE/);
  });

  it("documents preset precedence: an explicit preset wins over stray from/to bounds", async () => {
    const { items: categories } = await client.expenseCategoriesList();
    const op = categories.find((row) => !row.isOwnerWithdrawal)!;
    await client.expensesCreate({ categoryId: op.id, amount: 777, occurredAt: "2020-05-05T12:00:00" });
    // preset CURRENT_MONTH plus an inverted from/to: the preset must win, so no
    // INVALID_RANGE and the current-month rows come back, not a 2020 window
    const mixed = await client.expensesList({ preset: "CURRENT_MONTH", from: "2020-06-01T00:00:00", to: "2020-05-01T00:00:00" });
    expect(mixed.items.map((row) => row.id)).not.toContain("");
    expect(mixed.items.every((row) => row.occurredAt !== "2020-05-05T12:00:00")).toBe(true);
  });

  it("wires non-default presets (24H / LAST_YEAR) through reportsProfit", async () => {
    const lastYear = await client.reportsProfit({ preset: "LAST_YEAR" });
    expect(lastYear.range.preset).toBe("LAST_YEAR");
    expect(lastYear.range.from).toMatch(/^\d{4}-01-01T00:00:00$/);
    expect(lastYear.range.to).toMatch(/^\d{4}-12-31T23:59:59$/);
    expect(lastYear.revenue).toBeGreaterThanOrEqual(0);
    const last24h = await client.reportsProfit({ preset: "24H" });
    expect(last24h.range.preset).toBe("24H");
    expect(last24h.range.from <= last24h.range.to).toBe(true);
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
    const baselineCurrent = await client.reportsProfit({ preset: "CURRENT_MONTH" });
    const backdated = await client.invoicesCreate({
      kind: "SALE",
      invoiceDate: "2020-01-10",
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    expect(backdated.totalAmount).toBe(300);

    // current-month figures are byte-identical after the backdated sale
    const after = await client.reportsProfit({ preset: "CURRENT_MONTH" });
    expect(after.revenue).toBe(baselineCurrent.revenue);
    expect(after.cogs).toBe(baselineCurrent.cogs);
    expect(after.grossProfit).toBe(baselineCurrent.grossProfit);
    // …while a CUSTOM window over 2020-01 reports it exactly
    const custom = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-01-01T00:00:00", customTo: "2020-01-31T23:59:59" });
    expect(custom.revenue).toBe(300);
    expect(custom.cogs).toBe(100);
  });

  it("reports multi-line sales and fully-discounted sales exactly", async () => {
    const categories = await client.categoriesList();
    const catId = categories.items[0]!.id;
    const cheap = await client.itemsCreate({ name: "ربح-سطر-رخيص", categoryId: catId, costPrice: 100, sellingPrice: 250, lowStockThreshold: 0 });
    const costly = await client.itemsCreate({ name: "ربح-سطر-غال", categoryId: catId, costPrice: 700, sellingPrice: 1_500, lowStockThreshold: 0 });
    await client.stockAddManual({ itemId: cheap.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: costly.id, delta: 1, unitCost: 700, kind: "PURCHASE" });
    const baseline = await client.reportsProfit({ preset: "CURRENT_MONTH" });

    const multi = await client.invoicesCreate({
      kind: "SALE",
      lines: [
        { itemId: cheap.id, quantity: 2, unitPrice: 230 },
        { itemId: costly.id, quantity: 1, unitPrice: 1_400 },
      ],
    });
    expect(multi.totalAmount).toBe(1_860);

    const freeItem = await client.itemsCreate({ name: "ربح-مجاني", categoryId: catId, costPrice: 50, sellingPrice: 120, lowStockThreshold: 0 });
    await client.stockAddManual({ itemId: freeItem.id, delta: 1, unitCost: 50, kind: "PURCHASE" });
    const free = await client.invoicesCreate({ kind: "SALE", discount: { type: "AMOUNT", value: 9_999 }, lines: [{ itemId: freeItem.id, quantity: 1 }] });
    expect(free.totalAmount).toBe(0);

    const after = await client.reportsProfit({ preset: "CURRENT_MONTH" });
    expect(after.revenue - baseline.revenue).toBe(1_860 + 0);
    expect(after.cogs - baseline.cogs).toBe(2 * 100 + 1 * 700 + 1 * 50);
    expect(after.grossProfit - baseline.grossProfit).toBe(1_860 - 950);
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

describe("from-only windows clamp to now (half-open bounds)", () => {
  it("a from-only expensesList keeps past rows and excludes future-dated ones", async () => {
    const { items: categories } = await client.expenseCategoriesList();
    const op = categories.find((row) => !row.isOwnerWithdrawal)!;
    const past = await client.expensesCreate({ categoryId: op.id, amount: 111, occurredAt: "2020-01-15T12:00:00" });
    const future = await client.expensesCreate({ categoryId: op.id, amount: 222, occurredAt: "2099-06-30T12:00:00" });
    const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

    // from-only (+ category filter ANDs with the window): the window is
    // [from, now] — the future row must not leak in
    const fromOnly = await client.expensesList({ from: "2020-01-01T00:00:00", categoryIds: [op.id], limit: 500 });
    expect(ids(fromOnly.items)).toContain(past.id);
    expect(ids(fromOnly.items)).not.toContain(future.id);

    // custom pair without a preset, single lower bound: same half-open filler
    const pairOnly = await client.expensesList({ customFrom: "2020-01-01T00:00:00", limit: 500 });
    expect(ids(pairOnly.items)).toContain(past.id);
    expect(ids(pairOnly.items)).not.toContain(future.id);

    // bare to-only stays open-ended from the beginning of records (unchanged)
    const toOnly = await client.expensesList({ to: "2099-12-31T23:59:59", limit: 500 });
    expect(ids(toOnly.items)).toContain(past.id);
    expect(ids(toOnly.items)).toContain(future.id);

    // from+to keeps the exact window (unchanged); scoped to the op category so
    // 2020-08 stays this test's own slice of the shared store
    const mid = await client.expensesCreate({ categoryId: op.id, amount: 333, occurredAt: "2020-08-10T12:00:00" });
    const both = await client.expensesList({ categoryIds: [op.id], from: "2020-08-01T00:00:00", to: "2020-08-31T23:59:59" });
    expect(ids(both.items)).toEqual([mid.id]);

    // a from-only window starting in the future is contradictory → INVALID_RANGE
    await expect(client.expensesList({ from: "2099-01-01T00:00:00" })).rejects.toThrow(/INVALID_RANGE/);
    // CUSTOM is the preset's own customFrom/customTo pair — bare from/to stay
    // a no-preset alternative (documented precedence: preset wins)
    await expect(
      client.expensesList({ preset: "CUSTOM", from: "2020-01-01T00:00:00", to: "2020-01-31T23:59:59" }),
    ).rejects.toThrow(/INVALID_RANGE/);
  });

  it("a from-only profit report (CUSTOM with only customFrom) excludes future-dated expenses", async () => {
    const category = await client.expenseCategoriesCreate({ name: "حدود-انطلاقة" });
    await client.expensesCreate({ categoryId: category.id, amount: 111, occurredAt: "2020-01-15T12:00:00" });
    await client.expensesCreate({ categoryId: category.id, amount: 222, occurredAt: "2099-06-30T12:00:00" });

    // from-only report: window is [customFrom, now] — only the past row counts
    const fromOnly = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-01-01T00:00:00" });
    const fromRow = fromOnly.byCategory.find((entry) => entry.categoryId === category.id);
    expect(fromRow).toMatchObject({ total: 111, count: 1 });

    // to-only report opens at the beginning of records — same half-open filler
    // as bare to-only (the custom pair previously rejected any single bound;
    // the wire now accepts one, deliberately, see the resolver docstring)
    const toOnly = await client.reportsProfit({ preset: "CUSTOM", customTo: "2099-12-31T23:59:59" });
    const toRow = toOnly.byCategory.find((entry) => entry.categoryId === category.id);
    expect(toRow).toMatchObject({ total: 333, count: 2 });

    // a future-dated SALE invoice follows the same clamp: invisible from-only
    const categories = await client.categoriesList();
    const item = await client.itemsCreate({ name: "ربح-أفق-مستقبلي", categoryId: categories.items[0]!.id, costPrice: 100, sellingPrice: 300, lowStockThreshold: 0 });
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const baselineFrom = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-01-01T00:00:00" });
    await client.invoicesCreate({ kind: "SALE", invoiceDate: "2020-01-10", lines: [{ itemId: item.id, quantity: 1 }] });
    await client.invoicesCreate({ kind: "SALE", invoiceDate: "2099-06-30", lines: [{ itemId: item.id, quantity: 1 }] });
    const afterFrom = await client.reportsProfit({ preset: "CUSTOM", customFrom: "2020-01-01T00:00:00" });
    // deltas are exact: the 2099 invoice would add 300 revenue / 100 COGS too
    expect(afterFrom.revenue - baselineFrom.revenue).toBe(300);
    expect(afterFrom.cogs - baselineFrom.cogs).toBe(100);

    // an explicit CUSTOM with no bounds is still a caller bug in both procedures
    await expect(client.expensesList({ preset: "CUSTOM" })).rejects.toThrow(/INVALID_RANGE/);
    await expect(client.reportsProfit({ preset: "CUSTOM" })).rejects.toThrow(/INVALID_RANGE/);
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
    // invoicesList answers ONE page (DEFAULT_PAGE_SIZE = 10) and orders by
    // (invoiceDate, createdAt), which ties for rows written in the same second —
    // so asserting membership in the returned page is a coin-flip once the
    // shared test DB holds more than a page of PAID invoices, and no limit fixes
    // that for good. `total` counts the whole filtered set regardless of the
    // page and ordering, so a +1 is the stable proof the PAID filter picked this
    // invoice up.
    const paidBefore = (await client.invoicesList({ status: "PAID", limit: 1 })).total;

    const paid = await client.invoicesPay({ invoiceId: invoice.id, amount: 800 });

    expect(paid.remainingAmount).toBe(0);
    expect(paid.paidAmount).toBe(800);
    expect((await client.invoicesList({ status: "PAID", limit: 1 })).total).toBe(paidBefore + 1);
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
    const paymentsBefore = (await store.listActivities({ limit: 100 })).items.filter((a) => a.type === "PAYMENT_RECORDED" && a.ref === invoice.id).length;

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
    const paymentsAfter = (await store.listActivities({ limit: 100 })).items.filter((a) => a.type === "PAYMENT_RECORDED" && a.ref === invoice.id).length;
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
    // the shared test database accumulates invoices; request the full page so a
    // same-second createdAt tie cannot push this invoice off page 1
    expect((await client.invoicesList({ status: "PARTIAL", limit: MAX_PAGE_SIZE })).items.some((i) => i.id === invoice.id)).toBe(false);
    await client.invoicesPay({ invoiceId: invoice.id, amount: 300 });
    expect((await client.invoicesList({ status: "PARTIAL", limit: MAX_PAGE_SIZE })).items.some((i) => i.id === invoice.id)).toBe(true);
    expect((await client.invoicesList({ status: "UNPAID", limit: MAX_PAGE_SIZE })).items.some((i) => i.id === invoice.id)).toBe(false);
    await client.invoicesPay({ invoiceId: invoice.id, amount: 500 });
    expect((await client.invoicesList({ status: "PARTIAL", limit: MAX_PAGE_SIZE })).items.some((i) => i.id === invoice.id)).toBe(false);
    expect((await client.invoicesList({ status: "PAID", limit: MAX_PAGE_SIZE })).items.some((i) => i.id === invoice.id)).toBe(true);
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

// returns & refunds: cash refunds, per-line caps, marked stock movements
// ---------------------------------------------------------------------------
describe("returns & refunds", () => {
  async function makeReturnItem(name: string, costPrice: number, sellingPrice: number) {
    const categories = await client.categoriesList();
    return client.itemsCreate({ name, categoryId: categories.items[0]!.id, costPrice, sellingPrice, lowStockThreshold: 0 });
  }

  it("refuses returns on a missing or non-sale invoice before any write", async () => {
    await expect(
      client.returnsCreate({ invoiceId: "00000000-0000-4000-8000-000000000099", lines: [{ invoiceLineId: "00000000-0000-4000-8000-000000000098", quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "INVOICE_NOT_FOUND" });

    const item = await makeReturnItem("مرجوع-ليست-بيع", 100, 300);
    const purchase = await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 2, unitPrice: 100 }] });
    await expect(
      client.returnsCreate({ invoiceId: purchase.id, lines: [{ invoiceLineId: purchase.lines[0]!.id, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETURN_NOT_SALE" });
  });

  it("refuses a line that is not on the invoice and an itemless (description-only) line", async () => {
    const item = await makeReturnItem("مرجوع-سطر-خارجي", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    await expect(
      client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: "00000000-0000-4000-8000-000000000097", quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "LINE_NOT_ON_INVOICE" });

    // inject a description-only SALE line directly (the sale router never
    // creates one; the store seam does) and prove returns refuse it atomically
    const itemless = await store.insertInvoiceLine({
      invoiceId: sale.id,
      itemId: null,
      description: "سطر بدون منتج",
      quantity: 1,
      defaultUnitPrice: 5,
      unitPrice: 5,
      costAtSale: 0,
      total: 5,
      discountAllocated: 0,
      netTotal: 5,
    });
    await expect(
      client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: itemless.id, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETURN_LINE_NOT_RETURNABLE" });
  });

  it("refuses a return over the sold−already-returned cap and leaves the ledger untouched", async () => {
    const item = await makeReturnItem("مرجوع-حد-الكمية", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 3 }] });
    const lineId = sale.lines[0]!.id;

    // 4 units were never sold — the cap is 3
    await expect(client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 4 }] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "RETURN_EXCEEDS_RETURNABLE",
    });
    // and the whole request is refused even when a sibling line fits: atomic
    const second = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    const secondLineId = second.lines[0]!.id;
    await expect(
      client.returnsCreate({ invoiceId: second.id, lines: [{ invoiceLineId: secondLineId, quantity: 2 }, { invoiceLineId: secondLineId, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETURN_EXCEEDS_RETURNABLE" });

    const before = await client.itemsHistory({ itemId: item.id });
    expect(before.stockOnHand).toBe(0);
    expect((await client.returnsList({ invoiceId: sale.id })).items).toHaveLength(0);
  });

  it("creates a return: stock straight back in, marked pending, refund from the effective price", async () => {
    const item = await makeReturnItem("مرجوع-كامل", 100, 900);
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    // 2 × 900 with a 100 DZD discount → the customer effectively paid 850/unit
    const sale = await client.invoicesCreate({ kind: "SALE", discount: { type: "AMOUNT", value: 100 }, lines: [{ itemId: item.id, quantity: 2 }] });
    expect(sale.lines[0]?.netTotal).toBe(1_700);

    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 2 }], reason: "الزبون بدل رأيه" });

    expect(created.returnNumber).toMatch(/^RTN-/);
    expect(created.invoiceId).toBe(sale.id);
    expect(created.invoiceNumber).toBe(sale.invoiceNumber);
    expect(created.status).toBe("PENDING_REVIEW");
    expect(created.payoutMethod).toBe("CASH");
    expect(created.refundAmount).toBe(1_700);
    expect(created.reason).toBe("الزبون بدل رأيه");
    expect(created.lines).toHaveLength(1);
    expect(created.lines[0]).toMatchObject({ invoiceLineId: sale.lines[0]!.id, quantity: 2, refundUnitPrice: 850, refundAmount: 1_700 });

    // stock is back and the movement is the marked SALE reversal
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(2);
    const returnMovement = history.movements.find((movement) => movement.returnMark === "PENDING");
    expect(returnMovement).toBeDefined();
    expect(returnMovement).toMatchObject({ kind: "SALE", delta: 2, unitCost: 100, reason: "RETURN_RECORDED", ref: created.id });
    expect((await client.itemsAll()).items.find((row) => row.id === item.id)?.stockOnHand).toBe(2);
    expect((await client.activitiesList({})).items.some((entry) => entry.type === "RETURN_RECORDED" && entry.ref === created.id)).toBe(true);

    // a second return cannot exceed what is left (2 of 2 already returned)
    await expect(client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "RETURN_EXCEEDS_RETURNABLE",
    });
  });

  it("partial returns refund only the returned units and cap subsequent returns", async () => {
    const item = await makeReturnItem("مرجوع-جزئي", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 5 }] });
    const first = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 2 }] });
    expect(first.refundAmount).toBe(600);
    // 3 units are still returnable
    const second = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 3 }] });
    expect(second.refundAmount).toBe(900);
    const remaining = await client.returnsList({ invoiceId: sale.id });
    expect(remaining.items).toHaveLength(2);
    await expect(
      client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETURN_EXCEEDS_RETURNABLE" });
  });

  it("returnsForInvoice serves the complete history while returnsList pages (issue #163 review)", async () => {
    const item = await makeReturnItem("مرجوع-ترقيم-الكل", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 15, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 15 }] });
    const lineId = sale.lines[0]!.id;
    for (let i = 0; i < 11; i++) {
      await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 1 }] });
    }

    const page = await client.returnsList({ invoiceId: sale.id, limit: 10, offset: 0 });
    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(11);

    // the invoice panel's form read must not truncate: every prior return is
    // visible so the remaining quantity and the refund preview are correct
    const full = await client.returnsForInvoice({ invoiceId: sale.id });
    expect(full.items).toHaveLength(11);
    expect(full.items.reduce((sum, record) => sum + record.lines.reduce((lineSum, line) => lineSum + line.quantity, 0), 0)).toBe(11);
  });

  it("reads one supplier voucher by id even past the list's first page (issue #163 review)", async () => {
    const supplier = await client.suppliersCreate({ name: "مورد ترقيم مرتجع" });
    const category = await client.categoriesCreate({ name: "تصنيف ترقيم مرتجع" });
    const item = await client.itemsCreateWithStock({ name: "صنف ترقيم مرتجع", categoryId: category.id, costPrice: 100, sellingPrice: 100, stockOnHand: 20 });
    for (let i = 0; i < 11; i++) {
      await client.suppliersReturn({ supplierId: supplier.id, itemId: item.id, quantity: 1, amount: 100 });
    }

    const firstPage = await client.suppliersReturnsList({ supplierId: supplier.id, limit: 10, offset: 0 });
    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.total).toBe(11);
    const secondPage = await client.suppliersReturnsList({ supplierId: supplier.id, limit: 10, offset: 10 });
    expect(secondPage.items).toHaveLength(1);
    const oldest = secondPage.items[0]!;
    expect(firstPage.items.some((row) => row.id === oldest.id)).toBe(false);

    // the voucher print page's by-id read resolves the oldest voucher directly
    const voucher = await client.suppliersReturnGet({ returnId: oldest.id });
    expect(voucher.id).toBe(oldest.id);
    expect(voucher.returnNumber).toBe(oldest.returnNumber);
    expect(voucher.lines).toHaveLength(1);
  });

  it("returned units join normal FIFO cost layers — a later sale consumes oldest layers first and replay stays valid", async () => {
    const item = await makeReturnItem("مرجوع-ففو", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 6 }] });
    expect(sale.lines[0]).toMatchObject({ costAtSale: 117, cogsExact: 700 });
    await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 2 }] });

    const history = await client.itemsHistory({ itemId: item.id });
    // 5 → 10 → 4 → 6: every step stays non-negative (deterministic replay)
    expect(history.movements.map((movement) => movement.stockAfter)).toEqual([5, 10, 4, 6]);

    // the returned layer (at the 150 average) joins behind the remaining 4×200
    const laterSale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }] });
    expect(laterSale.lines[0]?.costAtSale).toBe(200);
    // outflows never move the ADR-0002 average — the return inflow at the
    // current average leaves it untouched too
    expect((await client.itemsAll()).items.find((row) => row.id === item.id)?.costPrice).toBe(150);
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(5);
  });

  it("accept consumes the pending mark and can never run twice", async () => {
    const item = await makeReturnItem("مرجوع-قبول", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 2 }] });

    const accepted = await client.returnsAccept({ returnId: created.id });
    expect(accepted.status).toBe("ACCEPTED");
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements.find((movement) => movement.returnMark === "ACCEPTED")).toBeDefined();
    expect(history.movements.find((movement) => movement.returnMark === "PENDING")).toBeUndefined();
    expect(history.stockOnHand).toBe(2);

    await expect(client.returnsAccept({ returnId: created.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETURN_NOT_PENDING" });
    await expect(client.returnsReject({ returnId: created.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "RETURN_NOT_PENDING" });
  });

  it("reject (damaged) removes the returned quantity as a MANUAL_ADJUSTMENT outflow with an Arabic reason", async () => {
    const item = await makeReturnItem("مرجوع-تالف", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 2 }] });
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(2);

    const rejected = await client.returnsReject({ returnId: created.id, reason: "كسر في العبوة" });
    expect(rejected.status).toBe("REJECTED_DAMAGED");
    // the rejection note is recorded on the return too, so the voucher and
    // the returns list tell the full story
    expect(rejected.reason).toBe("كسر في العبوة");

    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(0);
    const removal = history.movements.find((movement) => movement.kind === "MANUAL_ADJUSTMENT" && movement.delta < 0);
    expect(removal).toBeDefined();
    expect(removal?.reason).toContain("RETURN_REJECTED_DAMAGED");
    expect(removal?.reason).toContain("كسر في العبوة");
    expect(removal?.ref).toBe(created.id);
    expect(history.movements.find((movement) => movement.returnMark === "REJECTED")).toBeDefined();
    // the full ledger still replays: 2 → 0 → 2 → 0
    expect(history.movements.map((movement) => movement.stockAfter)).toEqual([2, 0, 2, 0]);
  });

  it("reads one item's history once for the whole multi-line scrap, not once per line", async () => {
    const item = await makeReturnItem("مرجوع-قراءة-واحدة", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 100, kind: "PURCHASE" });
    // a THREE-line sale of one item: the reject must not re-read and re-sort the
    // item history per line (a supported return can carry 200)
    const sale = await client.invoicesCreate({
      kind: "SALE",
      lines: [
        { itemId: item.id, quantity: 1 },
        { itemId: item.id, quantity: 1 },
        { itemId: item.id, quantity: 1 },
      ],
    });
    const created = await client.returnsCreate({
      invoiceId: sale.id,
      lines: sale.lines.map((line) => ({ invoiceLineId: line.id, quantity: 1 })),
    });
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(3);

    // count the ledger reads the reject performs through the real transaction
    let historyReads = 0;
    const countingStore: StorePort = {
      ...store,
      withTransactionImmediate: <T>(fn: (tx: StorePort) => Promise<T>): Promise<T> =>
        store.withTransactionImmediate((tx: StorePort) =>
          fn({
            ...tx,
            listStockMovements: (id) => {
              historyReads += 1;
              return tx.listStockMovements(id);
            },
          }),
        ),
    };
    const countingClient = clientForStore(countingStore);

    await countingClient.returnsReject({ returnId: created.id, reason: "تلف" });
    // one pre-scrap clamp projection + one batched history read for the whole
    // scrap; a regression back to one post per line would read four-plus times
    const expectedLedgerReads = 1 + 1;
    expect(historyReads).toBe(expectedLedgerReads);

    // every line still contributes its own movement row, and the numbers hold
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(0);
    const scraps = history.movements.filter((m) => m.kind === "MANUAL_ADJUSTMENT" && m.delta < 0);
    expect(scraps).toHaveLength(3);
    expect(scraps.reduce((sum, m) => sum + m.delta, 0)).toBe(-3);
    expect(scraps.every((m) => m.ref === created.id && (m.reason ?? "").includes("RETURN_REJECTED_DAMAGED"))).toBe(true);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(100);
  });

  it("reject after some units were resold clamps the removal to available stock and never blocks the review", async () => {
    // returned goods are salable immediately; by review time some may be gone
    const item = await makeReturnItem("مرجوع-إعادة-بيع", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 3 }] });
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 3 }] });
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(5);
    // resell 4 of the 5 on hand → stock 1 (< the 3 returned units)
    const resale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 4 }] });
    expect(resale.lines[0]?.costAtSale).toBe(100);
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(1);

    const rejected = await client.returnsReject({ returnId: created.id });
    expect(rejected.status).toBe("REJECTED_DAMAGED");
    const history = await client.itemsHistory({ itemId: item.id });
    // the clamp removes only what is physically present: stock 1 → 0
    expect(history.stockOnHand).toBe(0);
    const removal = history.movements.find((movement) => movement.kind === "MANUAL_ADJUSTMENT" && movement.delta < 0);
    expect(removal?.delta).toBe(-1);
    expect(history.movements.find((movement) => movement.returnMark === "REJECTED")).toBeDefined();
    // 5 → 2 → 5 → 1 → 0: the full replay never dips negative
    expect(history.movements.map((movement) => movement.stockAfter)).toEqual([5, 2, 5, 1, 0]);
  });

  it("lists and fetches returns; the voucher source is the stored record", async () => {
    const item = await makeReturnItem("مرجوع-قائمة", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", counterpartyName: "زبون الإيصال", lines: [{ itemId: item.id, quantity: 1 }] });
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }] });

    const fetched = await client.returnsGet({ returnId: created.id });
    expect(fetched.invoiceNumber).toBe(sale.invoiceNumber);
    expect(fetched.counterpartyName).toBe("زبون الإيصال");
    expect(fetched.lines[0]).toMatchObject({ description: item.name, refundUnitPrice: 300, refundAmount: 300 });
    expect((await client.returnsList({})).items.some((row) => row.id === created.id)).toBe(true);
  });

  it("defers the debt offset to acceptance: old debt 1000, return 500, cash 200 / debt 300", async () => {
    const item = await makeReturnItem("مرجوع-مثال-الوالد", 100, 500);
    const item2 = await makeReturnItem("مرجوع-مثال-ثان", 100, 500);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item2.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    // two 500-DZD lines so the invoice totals 1000 (old debt) while only one
    // line is returned — the exact deterministic parent case
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }, { itemId: item2.id, quantity: 1 }] });
    expect(sale.totalAmount).toBe(1_000);
    expect(sale.remainingAmount).toBe(1_000);

    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }], cashPaidOut: 200 });
    expect(created.refundAmount).toBe(500);
    expect(created.cashPaidOut).toBe(200);
    expect(created.debtOffset).toBe(300);
    expect(created.status).toBe("PENDING_REVIEW");
    // #68: while PENDING the debt is untouched — the promised deduction is
    // applied only when the owner accepts the return
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(1_000);

    const accepted = await client.returnsAccept({ returnId: created.id });
    expect(accepted.status).toBe("ACCEPTED");
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(700);
  });

  it("allows all-cash on a fully unpaid invoice and records zero debt offset", async () => {
    const item = await makeReturnItem("مرجوع-نقد-كامل", 100, 500);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }] });
    expect(sale.remainingAmount).toBe(500);
    // no cashPaidOut sent = all-cash preset
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }] });
    expect(created.cashPaidOut).toBe(500);
    expect(created.debtOffset).toBe(0);
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(500);
  });

  it("never lets the debt go negative: an all-debt split beyond the remaining debt flows to cash", async () => {
    const item = await makeReturnItem("مرجوع-فائض-دين", 100, 500);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", initialPaid: 200, lines: [{ itemId: item.id, quantity: 1 }] });
    expect(sale.remainingAmount).toBe(300);
    // all-debt request (= cashPaidOut 0) of a 500 return against 300 debt
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }], cashPaidOut: 0 });
    expect(created.refundAmount).toBe(500);
    expect(created.debtOffset).toBe(300); // capped at the remaining debt
    expect(created.cashPaidOut).toBe(200); // the excess flows to cash
    // #68: the cap is recorded on the voucher; the ledger applies it at accept
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(300);
    const accepted = await client.returnsAccept({ returnId: created.id });
    expect(accepted.status).toBe("ACCEPTED");
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(0);
  });

  it("applies accepted offsets sequentially, capping each against the debt still owed (#68)", async () => {
    const item = await makeReturnItem("مرجوع-تتابع-دين", 100, 500);
    await client.stockAddManual({ itemId: item.id, delta: 4, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 4 }] });
    expect(sale.remainingAmount).toBe(2_000);
    // all three returns are recorded while the debt is still 2000: each cap is
    // 500, and NONE of them touches the invoice while pending (#68)
    const first = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }], cashPaidOut: 0 });
    expect(first.debtOffset).toBe(500);
    const second = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }], cashPaidOut: 0 });
    expect(second.debtOffset).toBe(500);
    const third = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }], cashPaidOut: 0 });
    expect(third.debtOffset).toBe(500);
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(2_000);

    // each acceptance applies its own recorded offset against what is still owed
    await client.returnsAccept({ returnId: first.id });
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(1_500);
    await client.returnsAccept({ returnId: second.id });
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(1_000);
    await client.returnsAccept({ returnId: third.id });
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(500);
  });

  it("keeps the debt on the debts page while a return is pending (#68 user scenario)", async () => {
    const item = await makeReturnItem("مرجوع-قضية-68", 100, 500);
    const item2 = await makeReturnItem("مرجوع-قضية-68-ب", 100, 500);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item2.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    // customer "test": INV total 10000, paid 5000 → remaining 5000
    const sale = await client.invoicesCreate({
      kind: "SALE",
      counterpartyName: "test",
      initialPaid: 5_000,
      lines: [
        { itemId: item.id, quantity: 1, priceOverride: { type: "AMOUNT", value: 5_000 } },
        { itemId: item2.id, quantity: 1, priceOverride: { type: "AMOUNT", value: 5_000 } },
      ],
    });
    expect(sale.remainingAmount).toBe(5_000);

    const created = await client.returnsCreate({
      invoiceId: sale.id,
      cashPaidOut: 5_000,
      lines: [
        { invoiceLineId: sale.lines[0]!.id, quantity: 1 },
        { invoiceLineId: sale.lines[1]!.id, quantity: 1 },
      ],
    });
    expect(created.status).toBe("PENDING_REVIEW");
    expect(created.refundAmount).toBe(10_000);
    expect(created.cashPaidOut).toBe(5_000);
    expect(created.debtOffset).toBe(5_000);

    // the debts page STILL lists the customer while the return is pending
    const whilePending = await client.reportsDebts();
    expect(whilePending.owedToUs.some((row) => (row.counterpartyName ?? row.counterpartyId) === "test" && row.remainingTotal === 5_000)).toBe(true);
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(5_000);

    // accepting applies the promised 5000 offset: the debt is now really zeroed
    await client.returnsAccept({ returnId: created.id });
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(0);
    expect((await client.reportsDebts()).owedToUs.some((row) => (row.counterpartyName ?? row.counterpartyId) === "test")).toBe(false);
  });

  it("a REJECTED return never applies its debt offset (#68)", async () => {
    const item = await makeReturnItem("مرجوع-رفض-دين", 100, 500);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", counterpartyName: "test", lines: [{ itemId: item.id, quantity: 1 }] });
    expect(sale.remainingAmount).toBe(500);
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }], cashPaidOut: 0 });
    expect(created.debtOffset).toBe(500);

    const rejected = await client.returnsReject({ returnId: created.id, reason: "كسر في العبوة" });
    expect(rejected.status).toBe("REJECTED_DAMAGED");
    expect(rejected.debtApplied).toBe(0);
    // damaged goods: the promised deduction is cancelled, the customer still owes
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(500);
    expect((await client.reportsDebts()).owedToUs.some((row) => (row.counterpartyName ?? row.counterpartyId) === "test")).toBe(true);
  });

  it("accepting a pre-#68 PENDING return (offset backfilled as applied) never double-relieves (#68)", async () => {
    // simulate the upgraded legacy state: the invoice's debt was ALREADY
    // reduced by the old code (remaining 0), and the migration backfill set
    // debt_applied = debt_offset on the PENDING return row
    const invoiceId = "00000000-0000-4000-8000-0000000000a1";
    const returnId = "00000000-0000-4000-8000-0000000000a2";
    conn.raw
      .query(
        `INSERT INTO invoices (id, invoice_number, kind, counterparty_name, invoice_date, subtotal_amount, discount_amount, total_amount, paid_amount, remaining_amount, created_at, updated_at)
         VALUES (?, 'INV-LEGACY', 'SALE', 'test', '2026-08-01', 0, 0, 10000, 10000, 0, '2026-08-01T00:00:00', '2026-08-01T00:00:00')`,
      )
      .run(invoiceId);
    conn.raw
      .query(
        `INSERT INTO returns (id, return_number, invoice_id, refund_amount, cash_paid_out, debt_offset, debt_applied, payout_method, status, occurred_at, created_at, updated_at)
         VALUES (?, 'RTN-LEGACY', ?, 10000, 5000, 5000, 5000, 'CASH', 'PENDING_REVIEW', '2026-08-01T10:00:00', '2026-08-01T10:00:00', '2026-08-01T10:00:00')`,
      )
      .run(returnId, invoiceId);

    const accepted = await client.returnsAccept({ returnId });
    expect(accepted.status).toBe("ACCEPTED");
    // nothing new was applied: the invoice stays at 0 and debtApplied stays 5000
    expect(accepted.debtApplied).toBe(5_000);
    expect((await client.invoicesGet({ id: invoiceId })).remainingAmount).toBe(0);
  });


  it("accepting an over-promised offset caps it at the debt still owed (#68)", async () => {
    const item = await makeReturnItem("مرجوع-تجاوز-قبول", 100, 1_000);
    const item2 = await makeReturnItem("مرجوع-تجاوز-قبول-ب", 100, 1_000);
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item2.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    // two SALE lines of 2000 net each (total 4000), but only 2000 was paid, so
    // the debt is 2000 — TWO all-debt returns can each record a 2000 promise
    // at creation (each individually capped at the then-debt), aggregating past
    // what the invoice actually owes. That over-promise must surface at accept.
    const sale = await client.invoicesCreate({
      kind: "SALE",
      initialPaid: 2_000,
      lines: [
        { itemId: item.id, quantity: 2, priceOverride: { type: "AMOUNT", value: 1_000 } },
        { itemId: item2.id, quantity: 2, priceOverride: { type: "AMOUNT", value: 1_000 } },
      ],
    });
    expect(sale.remainingAmount).toBe(2_000);
    const first = await client.returnsCreate({
      invoiceId: sale.id,
      cashPaidOut: 0,
      lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 2 }],
    });
    const second = await client.returnsCreate({
      invoiceId: sale.id,
      cashPaidOut: 0,
      lines: [{ invoiceLineId: sale.lines[1]!.id, quantity: 2 }],
    });
    expect(first.debtOffset).toBe(2_000);
    expect(second.debtOffset).toBe(2_000);
    // neither touches the invoice while pending (#68)
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(2_000);

    // accepting the first applies its full promise; the second is CAPPED at
    // the 0 still owed — applied 0, never negative, debtApplied stays 0
    const acceptedFirst = await client.returnsAccept({ returnId: first.id });
    expect(acceptedFirst.debtApplied).toBe(2_000);
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(0);
    const acceptedSecond = await client.returnsAccept({ returnId: second.id });
    expect(acceptedSecond.debtApplied).toBe(0);
    expect((await client.invoicesGet({ id: sale.id })).remainingAmount).toBe(0);
  });

  it("refuses a cash portion larger than the return value", async () => {
    const item = await makeReturnItem("مرجوع-تجاوز-نقد", 100, 500);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }] });
    await expect(
      client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 1 }], cashPaidOut: 501 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "REFUND_SPLIT_INVALID" });
    expect((await client.returnsList({ invoiceId: sale.id })).items).toHaveLength(0);
  });

  it("returning a free (0-price) line unwinds its booked loss: report back to baseline, stock back", async () => {
    const item = await makeReturnItem("مرجوع-هدية-كلفة", 200, 300);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 200, kind: "PURCHASE" });
    const window = {
      preset: "CUSTOM" as const,
      customFrom: `${item.createdAt.slice(0, 10)}T00:00:00`,
      customTo: `${item.createdAt.slice(0, 10)}T23:59:59`,
    };
    const report = async () => client.reportsProfit(window);
    const baseline = await report();
    const freebie = await client.invoicesCreate({
      kind: "SALE",
      lines: [{ itemId: item.id, quantity: 1, priceOverride: { type: "AMOUNT", value: 0 } }],
    });
    expect(freebie.lines[0]).toMatchObject({ unitPrice: 0, cogsExact: 200, netTotal: 0 });
    const afterSale = await report();
    expect(afterSale.cogs - baseline.cogs).toBe(200); // the loss is booked
    expect(afterSale.grossProfit - baseline.grossProfit).toBe(-200);

    // the free return: value 0 (net 0), goods back at cost
    const returned = await client.returnsCreate({ invoiceId: freebie.id, lines: [{ invoiceLineId: freebie.lines[0]!.id, quantity: 1 }] });
    expect(returned.refundAmount).toBe(0);
    expect(returned.cashPaidOut).toBe(0);
    // stock is back: the sale consumed 1, the return put it back
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(1);
    expect(history.movements.map((movement) => movement.stockAfter)).toEqual([1, 0, 1]);
    // the profit report no longer shows the line: no lingering loss
    const afterReturn = await report();
    expect(afterReturn.cogs).toBe(baseline.cogs);
    expect(afterReturn.grossProfit).toBe(baseline.grossProfit);
  });

  it("a REJECTED freebie return keeps the loss: scrapped goods are a real cost", async () => {
    const item = await makeReturnItem("مرجوع-هدية-مرفوضة", 200, 300);
    await client.stockAddManual({ itemId: item.id, delta: 1, unitCost: 200, kind: "PURCHASE" });
    const window = {
      preset: "CUSTOM" as const,
      customFrom: `${item.createdAt.slice(0, 10)}T00:00:00`,
      customTo: `${item.createdAt.slice(0, 10)}T23:59:59`,
    };
    const report = async () => client.reportsProfit(window);
    const baseline = await report();
    const freebie = await client.invoicesCreate({
      kind: "SALE",
      lines: [{ itemId: item.id, quantity: 1, priceOverride: { type: "AMOUNT", value: 0 } }],
    });
    const afterSale = await report();
    expect(afterSale.grossProfit - baseline.grossProfit).toBe(-200);
    const returned = await client.returnsCreate({ invoiceId: freebie.id, lines: [{ invoiceLineId: freebie.lines[0]!.id, quantity: 1 }] });
    // the owner rejects: the returned goods are scrapped, not back in inventory
    await client.returnsReject({ returnId: returned.id });
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(0);
    const afterReject = await report();
    // the line stays booked — no hidden loss, the report is back to the
    // after-sale state (not the pre-sale baseline)
    expect(afterReject.grossProfit - baseline.grossProfit).toBe(-200);
    expect(afterReject.cogs - baseline.cogs).toBe(200);
  });

  it("prices split duplicate entries of one line ONCE (no per-entry rounding over-refund)", async () => {
    const item = await makeReturnItem("مرجوع-سطر-مقسوم", 100, 100);
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 100, kind: "PURCHASE" });
    // 3 × 100 with a 199 DZD discount → the line nets 101; per-unit rounding
    // gives 34, so two entries [qty 2, qty 1] would refund 34+34 = 102 if
    // priced independently — the fix consolidates to a full-line exact 101
    const sale = await client.invoicesCreate({ kind: "SALE", discount: { type: "AMOUNT", value: 199 }, lines: [{ itemId: item.id, quantity: 3 }] });
    expect(sale.lines[0]).toMatchObject({ netTotal: 101 });
    const created = await client.returnsCreate({
      invoiceId: sale.id,
      lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 2 }, { invoiceLineId: sale.lines[0]!.id, quantity: 1 }],
    });
    expect(created.refundAmount).toBe(101);
    expect(created.lines).toHaveLength(1);
    expect(created.lines[0]).toMatchObject({ invoiceLineId: sale.lines[0]!.id, quantity: 3, refundUnitPrice: 34, refundAmount: 101 });
    // one SALE-reversal movement for the whole line, stock fully back
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(3);
    expect(history.movements.filter((movement) => movement.returnMark === "PENDING")).toHaveLength(1);
  });

  it("reject after a resale books the original line only for the scrapped-now portion (nothing double-booked)", async () => {
    const item = await makeReturnItem("مرجوع-إعادة-تقرير", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 100, kind: "PURCHASE" });
    const window = {
      preset: "CUSTOM" as const,
      customFrom: `${item.createdAt.slice(0, 10)}T00:00:00`,
      customTo: `${item.createdAt.slice(0, 10)}T23:59:59`,
    };
    const report = async () => client.reportsProfit(window);
    const baseline = await report();
    // sale A: 3 @ 300 (900 rev / 300 cogs)
    const a = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 3 }] });
    expect(a.lines[0]).toMatchObject({ netTotal: 900, cogsExact: 300 });
    const sold = await report();
    expect(sold.revenue - baseline.revenue).toBe(900);
    expect(sold.cogs - baseline.cogs).toBe(300);
    // customer returns all 3; while pending the line is un-booked
    const returned = await client.returnsCreate({ invoiceId: a.id, lines: [{ invoiceLineId: a.lines[0]!.id, quantity: 3 }] });
    const pending = await report();
    expect(pending.revenue - baseline.revenue).toBe(0);
    expect(pending.cogs - baseline.cogs).toBe(0);
    // 2 of the returned units are resold (sale B)
    const b = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    expect(b.lines[0]).toMatchObject({ netTotal: 600, cogsExact: 200 });
    // the owner rejects: the clamp scraps only the 1 still on hand
    await client.returnsReject({ returnId: returned.id });
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(0);
    const afterReject = await report();
    // original line keeps ONLY the scrapped-now unit (300 rev / 100 cogs);
    // the resold 2 are booked by B (600 / 200) — every unit booked exactly once
    expect(afterReject.revenue - baseline.revenue).toBe(900);
    expect(afterReject.cogs - baseline.cogs).toBe(300);
  });

  it("settles sequential partial returns on a non-even line exactly: 34 + 67 = 101, never 102", async () => {
    const item = await makeReturnItem("مرجوع-تتابع-تقسيط", 100, 100);
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 100, kind: "PURCHASE" });
    // 3 × 100 with a 199 DZD discount → the line nets 101, unit round = 34
    const sale = await client.invoicesCreate({ kind: "SALE", discount: { type: "AMOUNT", value: 199 }, lines: [{ itemId: item.id, quantity: 3 }] });
    const lineId = sale.lines[0]!.id;
    const first = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 1 }] });
    expect(first.refundAmount).toBe(34); // partial at the rounded unit
    const second = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 2 }] });
    expect(second.refundAmount).toBe(67); // completing: the exact remainder
    expect(first.refundAmount + second.refundAmount).toBe(101);
    expect((await client.returnsList({ invoiceId: sale.id })).items.reduce((sum, r) => sum + r.refundAmount, 0)).toBe(101);
    // and the cap now refuses any further return
    await expect(client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 1 }] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "RETURN_EXCEEDS_RETURNABLE",
    });
  });

  it("partials then the remainder settle the exact full-line total", async () => {
    const item = await makeReturnItem("مرجوع-باقي-الخط", 100, 100);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", discount: { type: "AMOUNT", value: 404 }, lines: [{ itemId: item.id, quantity: 5 }] });
    // 5 × 100 gross − 404 discount = 96 net, unit round(96/5) = 19
    expect(sale.lines[0]?.netTotal).toBe(96);
    const lineId = sale.lines[0]!.id;
    const a = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 1 }] });
    expect(a.refundAmount).toBe(19);
    const b = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 1 }] });
    expect(b.refundAmount).toBe(19);
    const c = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineId, quantity: 3 }] });
    expect(c.refundAmount).toBe(58); // 96 − 38, the exact remainder (3×19 = 57 would under-refund)
    expect(a.refundAmount + b.refundAmount + c.refundAmount).toBe(96);
  });

  it("attributes the reject scrap per LINE for a same-item multi-line return (no double count)", async () => {
    const item = await makeReturnItem("مرجوع-سطران-نفس-المنتج", 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 100, kind: "PURCHASE" });
    const window = {
      preset: "CUSTOM" as const,
      customFrom: `${item.createdAt.slice(0, 10)}T00:00:00`,
      customTo: `${item.createdAt.slice(0, 10)}T23:59:59`,
    };
    const report = async () => client.reportsProfit(window);
    const baseline = await report();
    // sale with TWO lines of the same item: A(2) + B(1)
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }, { itemId: item.id, quantity: 1 }] });
    expect(sale.lines).toHaveLength(2);
    const lineA = sale.lines[0]!;
    const lineB = sale.lines[1]!;
    const returned = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: lineA.id, quantity: 2 }, { invoiceLineId: lineB.id, quantity: 1 }] });
    expect(returned.lines).toHaveLength(2);
    // resell 2 of the returned units, then reject: only 1 unit is still on hand
    await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(1);
    await client.returnsReject({ returnId: returned.id });
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(0);
    const afterReject = await report();
    // FIFO allocation scrapes 1 unit off line A (A: rejected 2, scrap 1 →
    // bookedQty 1); line B's unit was resold and is booked by the resale (2
    // units 600 / 200). Booked: A 1 unit (300 / 100) + resale 2 (600 / 200) =
    // revenue 900, cogs 300 — every unit exactly once.
    expect(afterReject.revenue - baseline.revenue).toBe(900);
    expect(afterReject.cogs - baseline.cogs).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// First-run setup provisioning (greptile PR #74, ADR-0008 §4.1)
// ---------------------------------------------------------------------------

/**
 * Setup is the only unauthenticated write that can create an owner, so these
 * cover the two ways it could hand out a broken or duplicated account: two
 * concurrent setups racing, and a partial failure that leaves a user row but no
 * working credential. The gate is the database state, not a secret: an empty
 * database may be claimed once; a database that already carries shop records
 * refuses a new owner.
 */
describe("first-time setup provisioning", () => {
  const teardown: Array<() => void> = [];
  afterAll(() => {
    for (const close of teardown) close();
  });

  const openInstance = async (extraEnv: NodeJS.ProcessEnv = {}) => {
    const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-setup-"));
    const instanceConfig = createAppConfig({
      DOKAN_DATA_DIR: instanceDir,
      DOKAN_DB_PATH: path.join(instanceDir, "setup.db"),
      ...extraEnv,
    });
    const instanceConn = openConnection(instanceConfig);
    const instanceStore = createDrizzleStore(instanceConn);
    // a fresh database has no tables until the store creates them
    await instanceStore.setup();
    const instanceLogger = new AppLogger(instanceDir);
    // One universal build: the signing secret is a normal database row.
    const instanceAuth = createAuth(instanceConn.db, instanceConfig, await ensureSessionSecret(instanceStore));

    const clientFor = (storeFor: StorePort, routerDeps: { setupThrottle?: SetupThrottle } = {}): DokanClient => {
      const app = createApp({
        config: instanceConfig,
        logger: instanceLogger,
        auth: instanceAuth,
        rpcRouter: createRpcRouter({
          ...routerDeps,
          db: instanceConn.db,
          config: instanceConfig,
          logger: instanceLogger,
          store: storeFor,
          auth: instanceAuth,
        }),
      });
      const link = new RPCLink({
        url: () => `http://127.0.0.1:${instanceConfig.port}/api/rpc`,
        // SAFETY: the link's fetch contract wants a Promise; hono's fetch returns one
        fetch: (request) => Promise.resolve(app.fetch(new Request(request))),
      });
      return createORPCClient(link);
    };

    teardown.push(() => {
      instanceConn.close();
      // Windows keeps the sqlite/WAL handles briefly after close
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(instanceDir, { recursive: true, force: true });
          return;
        } catch {
          Bun.sleepSync(50);
        }
      }
    });

    return { conn: instanceConn, store: instanceStore, client: clientFor(instanceStore), clientFor };
  };

  const setupCalls = (client: DokanClient, ownerName: string, phoneNumber: string) =>
    client.firstTimeSetup({
      ownerName,
      phoneNumber,
      password: "pass-1234",
      storeName: `متجر ${ownerName}`,
    });

  it("provisions the owner on an empty database", async () => {
    const inst = await openInstance();
    expect(await inst.client.needsSetup()).toEqual({ needsSetup: true, setupBlocked: false });

    await expect(setupCalls(inst.client, "مالك", "0550111111")).resolves.toEqual({ ok: true });
    const userRows = await inst.conn.db.select({ id: users.id }).from(users);
    expect(userRows).toHaveLength(1);
    expect(await inst.client.needsSetup()).toEqual({ needsSetup: false, setupBlocked: false });
  });

  it("refuses uniformly once an owner exists", async () => {
    const inst = await openInstance();
    await expect(setupCalls(inst.client, "مالك", "0550111111")).resolves.toEqual({ ok: true });

    // A completed installation must never mint a second owner, whatever the
    // caller sends.
    await expect(setupCalls(inst.client, "متطفل", "0550222222")).rejects.toThrow("SETUP_ALREADY_DONE");
    const userRows = await inst.conn.db.select({ id: users.id }).from(users);
    expect(userRows).toHaveLength(1);
  });

  it("refuses a non-empty database with no owner and writes nothing", async () => {
    const inst = await openInstance();
    // A shop record with no owner: a tampered or half-restored data folder.
    // Setup must refuse it, or anyone holding the stick could claim the shop.
    const category = (await inst.store.listCategories())[0];
    expect(category).toBeDefined();
    await inst.store.createItem({ name: "منتج-بدون-مالك", categoryId: category?.id ?? "", costPrice: 100, sellingPrice: 200 });

    // neither the gate nor the procedure offers a way in, and the UI can tell
    // the blocked state from a fresh install
    expect(await inst.client.needsSetup()).toEqual({ needsSetup: false, setupBlocked: true });
    await expect(setupCalls(inst.client, "متطفل", "0550222222")).rejects.toThrow("SETUP_DATABASE_NOT_EMPTY");
    expect(await inst.conn.db.select({ id: users.id }).from(users)).toHaveLength(0);
  });

  it("refuses while the setup lockout is active and writes nothing", async () => {
    const inst = await openInstance();
    // the KDF is a public CPU cost: a denied throttle must stop the handler
    // before the password hash and before any write
    const locked = createSetupThrottle({ maxAttempts: 1 });
    locked.recordAttempt();
    const lockedClient = inst.clientFor(inst.store, { setupThrottle: locked });

    await expect(setupCalls(lockedClient, "متطفل", "0550222222")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "SETUP_LOCKED",
    });
    expect(await inst.conn.db.select({ id: users.id }).from(users)).toHaveLength(0);
  });

  it("requires the shell's one-time token in packaged builds", async () => {
    const token = "a".repeat(64);
    const inst = await openInstance({ DOKAN_BOOT_TOKEN: token });

    // a local process that merely found the loopback port has no token
    await expect(setupCalls(inst.client, "متطفل", "0550222222")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "SETUP_TOKEN_REQUIRED",
    });
    await expect(
      inst.client.firstTimeSetup({
        ownerName: "متطفل",
        phoneNumber: "0550222222",
        password: "pass-1234",
        storeName: "متجر",
        setupToken: "wrong-token",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "SETUP_TOKEN_REQUIRED" });
    expect(await inst.conn.db.select({ id: users.id }).from(users)).toHaveLength(0);

    // the shell's own window holds the token and provisions normally
    await expect(
      inst.client.firstTimeSetup({
        ownerName: "مالك",
        phoneNumber: "0550111111",
        password: "pass-1234",
        storeName: "متجر",
        setupToken: token,
      }),
    ).resolves.toEqual({ ok: true });
    expect(await inst.conn.db.select({ id: users.id }).from(users)).toHaveLength(1);
  });

  it("provisions exactly one owner when two setups race", async () => {
    const inst = await openInstance();
    expect(await inst.client.needsSetup()).toEqual({ needsSetup: true, setupBlocked: false });

    // The gate checks and every write must share one BEGIN IMMEDIATE unit.
    // Before that, both requests passed the check while the password hash was
    // pending and each created an owner.
    const results = await Promise.allSettled([
      setupCalls(inst.client, "أ", "0550111111"),
      setupCalls(inst.client, "ب", "0550222222"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const userRows = await inst.conn.db.select({ id: users.id }).from(users);
    expect(userRows).toHaveLength(1);
    const accountRows = await inst.conn.db.select({ id: accounts.id }).from(accounts);
    expect(accountRows).toHaveLength(1);

    // the store points at whichever request won, and only that one
    const settings = await inst.store.getSettings();
    expect(["متجر أ", "متجر ب"]).toContain(settings.storeName);

    // and setup is closed afterwards
    expect(await inst.client.needsSetup()).toEqual({ needsSetup: false, setupBlocked: false });
    await expect(setupCalls(inst.client, "ج", "0550333333")).rejects.toThrow();
  });

  it("rolls back a failed setup so it can be retried, and keeps the address", async () => {
    const inst = await openInstance();

    // A store whose audit write fails inside the unit. Every provisioning write
    // must roll back with it: a surviving user row would make needsSetup false
    // and the installation could never be set up again.
    const failingStore: StorePort = {
      ...inst.store,
      withTransactionImmediate: <T>(fn: (tx: StorePort) => Promise<T>): Promise<T> =>
        inst.store.withTransactionImmediate((realTx: StorePort) =>
          fn({
            ...realTx,
            insertActivity: async () => {
              throw new Error("audit-boom");
            },
          }),
        ),
    };

    await expect(
      inst.clientFor(failingStore).firstTimeSetup({
        ownerName: "مالك",
        phoneNumber: "0550111111",
        password: "pass-1234",
        storeName: "متجر",
        storeAddress: "شارع الاستقلال 12",
      }),
    ).rejects.toThrow();

    const afterFailure = await inst.conn.db.select({ id: users.id }).from(users);
    expect(afterFailure).toHaveLength(0);
    expect(await inst.client.needsSetup()).toEqual({ needsSetup: true, setupBlocked: false });

    // the retry succeeds, and the address the form sent is retained
    await expect(
      inst.client.firstTimeSetup({
        ownerName: "مالك",
        phoneNumber: "0550111111",
        password: "pass-1234",
        storeName: "متجر",
        storeAddress: "شارع الاستقلال 12",
      }),
    ).resolves.toEqual({ ok: true });
    expect(await inst.store.getSettings()).toEqual({
      storeName: "متجر",
      storePhone: "+213550111111",
      storeAddress: "شارع الاستقلال 12",
    });
  });
});

describe("dashboard summary (issue 84)", () => {
  it("returns the server's own local day with the newest invoice first", async () => {
    const category = await client.categoriesCreate({ name: `لوحة-${Date.now()}` });
    const item = await client.itemsCreateWithStock({ name: `مادة-${Date.now()}`, categoryId: category.id, costPrice: 100, sellingPrice: 150, stockOnHand: 1 });
    const created = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }] });

    const summary = await client.dashboardSummary();

    const day = summary.day;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(summary.recentInvoices?.[0]?.invoiceNumber).toBe(created.invoiceNumber);

    const daySales = await client.invoicesList({ kind: "SALE", fromDate: day, toDate: day, limit: 500 });
    // the day's sum must see every row: `total` is the filter count, and the
    // page request carries the max so the sum below never under-counts
    expect(daySales.total).toBe(daySales.items.length);
    const expectedSalesTotal = daySales.items.reduce((sum, invoice) => sum + invoice.totalAmount, 0);
    expect(summary.salesTotal).toBe(expectedSalesTotal);
    expect(summary.salesCount).toBe(daySales.total);
    // on a healthy store these sections must be populated, not degraded: null
    // means the read failed, so comparing the count alone would let an
    // unexpectedly broken response pass
    expect(summary.lowStockItems).not.toBeNull();
    expect(summary.lowStockCount).not.toBeNull();
    expect(summary.lowStockItems?.length ?? null).toBe(summary.lowStockCount);
  });

  it("reports the day the server clock says, not the wall clock", async () => {
    // 2026-08-24T23:00:00Z is midnight in Algiers, so the day must roll over.
    // The expectation is a literal, so a wrong timezone or format in the
    // production helper cannot agree with itself here.
    const pinned = new Date("2026-08-24T23:00:00Z");
    const pinnedApp = createApp({
      config,
      logger,
      auth,
      rpcRouter: createRpcRouter({ db: conn.db, config, logger, store, auth, now: () => pinned }),
    });
    const pinnedLink = new RPCLink({
      url: () => `http://127.0.0.1:${config.port}/api/rpc`,
      // SAFETY: the link's fetch contract wants a Promise; hono's fetch returns one
      fetch: (request) => {
        const headers = Object.fromEntries(request.headers.entries());
        if (cookie !== "") headers.cookie = cookie;
        return Promise.resolve(pinnedApp.fetch(new Request(request, { headers })));
      },
    });
    const pinnedClient: DokanClient = createORPCClient(pinnedLink);

    const summary = await pinnedClient.dashboardSummary();
    expect(summary.day).toBe("2026-08-25");
  });

  it("accepts a signed weOwe in the dashboard output contract (issue 176 round 2)", () => {
    // a shop whose suppliers are net in credit is a valid state: the supervisor
    // must not reject it (round 1 made weOwe signed but left the schema min 0)
    const base = {
      day: "2026-10-13",
      salesTotal: 0,
      salesCount: 0,
      owedToUs: 0,
      lowStockCount: 0,
      lowStockItems: [],
      recentInvoices: [],
    };
    expect(dashboardSummaryOutputSchema.safeParse({ ...base, weOwe: -300 }).success).toBe(true);
    expect(dashboardSummaryOutputSchema.safeParse({ ...base, weOwe: 300 }).success).toBe(true);
    // still bounded to the safe-integer money range on both sides
    expect(dashboardSummaryOutputSchema.safeParse({ ...base, weOwe: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(dashboardSummaryOutputSchema.safeParse({ ...base, weOwe: -(Number.MAX_SAFE_INTEGER + 1) }).success).toBe(false);
  });

  it("serves the signed supplier net for a credit-only shop and agrees with /debts (issue 176 round 2)", async () => {
    const supplier = await client.suppliersCreate({ name: `مورد دائن-${Date.now()}` });
    // large enough to dominate any positive supplier ledger the suite has seeded
    await client.suppliersAdjust({ supplierId: supplier.id, direction: "THEY_OWE", amount: 500_000_000 });

    // before the schema fix this call rejected with an output-validation error
    const summary = await client.dashboardSummary();
    expect(summary.weOwe).toBeLessThan(0);

    const debts = await client.reportsDebts();
    const supplierNet = debts.weOwe.reduce((sum, row) => sum + (row.accountBalance ?? row.remainingTotal), 0);
    expect(summary.weOwe).toBe(supplierNet);
  });
});

describe("onboarding progress (issue 97)", () => {
  it("requires a session", async () => {
    await expect(unauthed.onboardingProgress()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns the four record-derived completion booleans", async () => {
    const category = await client.categoriesCreate({ name: `بداية-راوتر-${Date.now()}` });
    const item = await client.itemsCreateWithStock({
      name: `بداية-مادة-${Date.now()}`,
      categoryId: category.id,
      costPrice: 100,
      sellingPrice: 150,
      stockOnHand: 2,
    });
    await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 1 }] });
    // no initialPaid + a party name => a real, party-attributed SALE debt
    await client.invoicesCreate({ kind: "SALE", counterpartyName: "بداية-زبون", lines: [{ itemId: item.id, quantity: 1 }] });

    const progress = await client.onboardingProgress();

    expect(Object.keys(progress).sort()).toEqual(["hasDebt", "hasItems", "hasPurchase", "hasSale"]);
    expect(progress).toEqual({ hasItems: true, hasPurchase: true, hasSale: true, hasDebt: true });
  });
});

describe("UI preferences (issue 97 follow-up)", () => {
  it("requires a session to read or write", async () => {
    await expect(unauthed.preferencesGet()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(unauthed.preferencesSet({ key: "ui.sidebar.collapsed", value: "true" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("round-trips a client-owned preference over the wire", async () => {
    // the endpoint is for shell state the owner owns, not for arbitrary keys:
    // see "refuses a key the server owns" below
    await client.preferencesSet({ key: "ui.sidebar.collapsed", value: "true" });
    const { values } = await client.preferencesGet();
    expect(values["ui.sidebar.collapsed"]).toBe("true");
  });

  it("rejects an empty preference key at the contract boundary", async () => {
    await expect(client.preferencesSet({ key: "  ", value: "true" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects keys and values beyond the contract bounds", async () => {
    await expect(client.preferencesSet({ key: "k".repeat(65), value: "true" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(client.preferencesSet({ key: "ui.test.oversize", value: "v".repeat(513) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a key the server owns", async () => {
    // the completion milestone is derived from shop records; a client that could
    // write it would hide the checklist forever with nothing behind it. The
    // server records it itself, so this test only pins the refusal.
    await expect(client.preferencesSet({ key: "ui.onboarding.completed", value: "true" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("still accepts the shell keys the owner owns", async () => {
    await client.preferencesSet({ key: "ui.sidebar.collapsed", value: "true" });
    await client.preferencesSet({ key: "ui.onboarding.dismissed", value: "true" });
    const { values } = await client.preferencesGet();
    expect(values["ui.sidebar.collapsed"]).toBe("true");
    expect(values["ui.onboarding.dismissed"]).toBe("true");
  });
});

describe("onboarding completion milestone (issue 97 follow-up)", () => {
  it("requires a session", async () => {
    await expect(unauthed.onboardingComplete()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("records the milestone idempotently once every record exists", async () => {
    const category = await client.categoriesCreate({ name: `اكتمال-${Date.now()}` });
    const item = await client.itemsCreateWithStock({
      name: `اكتمال-مادة-${Date.now()}`,
      categoryId: category.id,
      costPrice: 100,
      sellingPrice: 150,
      stockOnHand: 2,
    });
    await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 1 }] });
    await client.invoicesCreate({ kind: "SALE", counterpartyName: "اكتمال-زبون", lines: [{ itemId: item.id, quantity: 1 }] });

    // idempotent: a retry returns the same answer and the milestone stays set
    expect(await client.onboardingComplete()).toEqual({ completed: true });
    expect(await client.onboardingComplete()).toEqual({ completed: true });
    const { values } = await client.preferencesGet();
    expect(values[ONBOARDING_COMPLETED_PREFERENCE_KEY]).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// issue 144 — a manual cost edit is a ledger fact
// ---------------------------------------------------------------------------
describe("items cost correction (issue 144)", () => {
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

  it("keeps an edited cost across a later purchase replay", async () => {
    const item = await makeItem(`تصحيح-شراء-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE" });

    const edited = await client.itemsUpdate({ id: item.id, costPrice: 300 });
    expect(edited?.costPrice).toBe(300);

    // the correction is a real ledger row, not only a cache write
    const historyAfterEdit = await client.itemsHistory({ itemId: item.id });
    expect(historyAfterEdit.stockOnHand).toBe(10);
    expect(
      historyAfterEdit.movements.some((m) => m.delta === 0 && m.unitCost === 300 && m.reason === "COST_CORRECTION"),
    ).toBe(true);

    // a later purchase replays the full ledger: (10×300 + 10×200) / 20 = 250
    await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 10, unitPrice: 200 }] });
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(20);
    expect(row.costPrice).toBe(250);
  });

  it("keeps an edited cost across a later outflow replay", async () => {
    const item = await makeItem(`تصحيح-بيع-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE" });
    await client.itemsUpdate({ id: item.id, costPrice: 300 });

    // a sale replays the ledger; without the movement the edit would revert to 100
    await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(8);
    expect(row.costPrice).toBe(300);
  });

  it("a cost-only correction defines the zero-quantity case without touching quantity", async () => {
    const item = await makeItem(`تصحيح-صفر-${Date.now()}`, 100);

    // zero on hand: the correction is the only movement and sets the cache
    const edited = await client.itemsUpdate({ id: item.id, costPrice: 300 });
    expect(edited?.costPrice).toBe(300);
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(0);
    expect(history.movements).toHaveLength(1);
    expect(history.movements[0]).toMatchObject({
      kind: "MANUAL_ADJUSTMENT",
      delta: 0,
      unitCost: 300,
      reason: "COST_CORRECTION",
    });

    // the next inflow ignores the zero-quantity correction and takes the buy cost
    await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 8, unitPrice: 250 }] });
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(8);
    expect(row.costPrice).toBe(250);
  });

  it("still blends a manual quantity adjustment against the corrected cost", async () => {
    const item = await makeItem(`تصحيح-كمية-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE" });
    await client.itemsUpdate({ id: item.id, costPrice: 300 });

    // +5 @ 100: (10×300 + 5×100) / 15 = 233.33 → 233
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100 });
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(15);
    expect(row.costPrice).toBe(233);
  });

  it("writes exactly one correction activity row, and none on replay", async () => {
    const item = await makeItem(`تصحيح-سجل-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE" });
    await client.itemsUpdate({ id: item.id, costPrice: 300 });
    await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 5, unitPrice: 200 }] });
    await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }] });

    const activities = await client.activitiesList({ limit: 200 });
    const corrections = activities.items.filter((a) => a.type === "ITEM_COST_CORRECTED" && a.ref === item.id);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.summary).toBe(`ITEM_COST_CORRECTED 300 ${item.name}`);
    // locale-neutral: an ASCII action tag, then data, free text last
    expect(corrections[0]!.summary.split(" ")[0]).toBe("ITEM_COST_CORRECTED");

    const movements = (await client.itemsHistory({ itemId: item.id })).movements;
    expect(movements.filter((m) => m.reason === "COST_CORRECTION")).toHaveLength(1);
  });

  it("stays consistent when an edit and a purchase race", async () => {
    const item = await makeItem(`تصحيح-سباق-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE" });

    const results = await Promise.allSettled([
      client.itemsUpdate({ id: item.id, costPrice: 300 }),
      client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 10, unitPrice: 200 }] }),
    ]);
    for (const result of results) expect(result.status).toBe("fulfilled");

    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    const movements = (await client.itemsHistory({ itemId: item.id })).movements;
    expect(row.stockOnHand).toBe(20);
    expect(movements.filter((m) => m.reason === "COST_CORRECTION")).toHaveLength(1);
    expect(movements.filter((m) => m.kind === "PURCHASE")).toHaveLength(2);
    // the cache agrees with a full replay of whatever order the queue chose
    expect(row.costPrice).toBe(weightedAverageCost(movements));
  });

  it("keeps a correction against a future-dated row, then blends a later purchase from it", async () => {
    const item = await makeItem(`تصحيح-مستقبل-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE", occurredAt: "2020-01-01T00:00:00" });
    // a manually entered future-dated inflow must not leapfrog the correction
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 200, kind: "PURCHASE", occurredAt: "2999-01-01T00:00:00" });

    const edited = await client.itemsUpdate({ id: item.id, costPrice: 300 });
    expect(edited?.costPrice).toBe(300);

    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(20);
    expect(history.movements.find((m) => m.reason === "COST_CORRECTION")?.unitCost).toBe(300);

    // a purchase recorded AFTER the edit blends from 300 even though it is
    // dated before the future-dated row (recording order beats business date)
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 150, kind: "PURCHASE" });
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(30);
    expect(row.costPrice).toBe(250); // (20×300 + 10×150) / 30
  });
});

/**
 * Issue 143 — one parity test per stock-write call site. Each pins the exact
 * movement row(s) and the `stockOnHand` / `costPrice` golden values the
 * extracted seam must keep producing. The pre-existing suites are the wider
 * behavior contract; these make the seam's per-site output explicit.
 */
describe("movement posting seam parity (issue 143)", () => {
  async function makeItem(name: string, costPrice: number, sellingPrice = costPrice * 2) {
    const categories = await client.categoriesList();
    return client.itemsCreate({ name, categoryId: categories.items[0]!.id, costPrice, sellingPrice, lowStockThreshold: 0 });
  }

  it("stockAddManual: inflow blends, outflow replays without moving the average", async () => {
    const item = await makeItem(`seam-adjust-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE", occurredAt: "2020-01-01T00:00:00" });
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 300, kind: "PURCHASE", occurredAt: "2020-01-02T00:00:00" });

    const posted = await client.stockAddManual({ itemId: item.id, delta: -6, occurredAt: "2020-01-03T00:00:00" });
    expect(posted).toMatchObject({ kind: "MANUAL_ADJUSTMENT", delta: -6, unitCost: null, ref: null });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(14);
    expect(history.movements.map((m) => m.stockAfter)).toEqual([10, 20, 14]);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(200);
  });

  it("stockAddManual: a backdated outflow replays the full ledger (issue 143 outflow rule)", async () => {
    const item = await makeItem(`seam-outflow-rule-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE", occurredAt: "2020-01-02T10:00:00" });
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 300, kind: "PURCHASE", occurredAt: "2020-01-03T10:00:00" });
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(200);

    // replay in business-date order: 5@100 after the backdated outflow + 10@300 → 233
    await client.stockAddManual({ itemId: item.id, delta: -5, occurredAt: "2020-01-02T12:00:00" });
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(15);
    expect(row.costPrice).toBe(233);
  });

  it("invoicesCreate SALE: FIFO snapshot and exact cogs land on the line and the seam row", async () => {
    const item = await makeItem(`seam-sale-${Date.now()}`, 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });

    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 6 }] });
    expect(sale.lines[0]).toMatchObject({ costAtSale: 117, cogsExact: 700, quantity: 6 });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements.find((m) => m.kind === "SALE" && m.ref === sale.id)).toMatchObject({ delta: -6, unitCost: null });
    expect(history.stockOnHand).toBe(4);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(150);
  });

  it("invoicesCreate SALE: each line's FIFO read sees the prior line's movement", async () => {
    const item = await makeItem(`seam-sale-lines-${Date.now()}`, 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 100, kind: "PURCHASE" });
    await client.stockAddManual({ itemId: item.id, delta: 5, unitCost: 200, kind: "PURCHASE" });

    const sale = await client.invoicesCreate({
      kind: "SALE",
      lines: [
        { itemId: item.id, quantity: 3 },
        { itemId: item.id, quantity: 4 },
      ],
    });
    // line 1 consumes 3@100; line 2 consumes the remaining 2@100 + 2@200
    expect(sale.lines.map((line) => line.cogsExact)).toEqual([300, 600]);
    expect(sale.lines.map((line) => line.costAtSale)).toEqual([100, 150]);
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(3);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(150);
  });

  it("invoicesCreate PURCHASE: the line cost is the inflow cost and the cache replays", async () => {
    const item = await makeItem(`seam-purchase-${Date.now()}`, 100);
    const invoice = await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 4, unitPrice: 250 }] });
    expect(invoice.lines[0]).toMatchObject({ unitPrice: 250, costAtSale: 250, cogsExact: 1000 });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements[0]).toMatchObject({ kind: "PURCHASE", delta: 4, unitCost: 250, ref: invoice.id });
    expect(history.stockOnHand).toBe(4);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(250);
  });

  it("returnsCreate: a PENDING SALE return joins the layers at the current average", async () => {
    const item = await makeItem(`seam-return-${Date.now()}`, 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 2, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 2 }] });
    const created = await client.returnsCreate({ invoiceId: sale.id, lines: [{ invoiceLineId: sale.lines[0]!.id, quantity: 2 }] });

    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements.find((m) => m.returnMark === "PENDING")).toMatchObject({
      kind: "SALE",
      delta: 2,
      unitCost: 100,
      reason: "RETURN_RECORDED",
      ref: created.id,
    });
    expect(history.stockOnHand).toBe(2);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(100);
  });

  it("returnsReject: scrapping allocates across the return's lines and zeroes the stock", async () => {
    const item = await makeItem(`seam-reject-${Date.now()}`, 100, 300);
    await client.stockAddManual({ itemId: item.id, delta: 3, unitCost: 100, kind: "PURCHASE" });
    const sale = await client.invoicesCreate({ kind: "SALE", lines: [{ itemId: item.id, quantity: 1 }, { itemId: item.id, quantity: 2 }] });
    const created = await client.returnsCreate({
      invoiceId: sale.id,
      lines: [
        { invoiceLineId: sale.lines[0]!.id, quantity: 1 },
        { invoiceLineId: sale.lines[1]!.id, quantity: 2 },
      ],
    });
    expect((await client.itemsHistory({ itemId: item.id })).stockOnHand).toBe(3);

    await client.returnsReject({ returnId: created.id, reason: "تلف" });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.stockOnHand).toBe(0);
    const scraps = history.movements.filter((m) => m.kind === "MANUAL_ADJUSTMENT" && m.delta < 0);
    expect(scraps.reduce((sum, m) => sum + m.delta, 0)).toBe(-3);
    expect(scraps.every((m) => m.ref === created.id && (m.reason ?? "").includes("RETURN_REJECTED_DAMAGED"))).toBe(true);
    // one scrap row per return line, keyed by the line id. The store's return
    // line order is not guaranteed, so compare line-id → scrapped quantity
    // rather than the positional order of the rows.
    const scrapByLine = new Map(scraps.map((m) => [m.reason?.split("#").at(-1), Math.abs(m.delta)]));
    expect(scrapByLine).toEqual(new Map(created.lines.map((line) => [line.id, line.quantity])));
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(100);
  });

  it("purchasesCorrectLine: the inflow-first pair lands and replays to the ADR average", async () => {
    const item = await makeItem(`seam-correct-${Date.now()}`, 100);
    const invoice = await client.invoicesCreate({ kind: "PURCHASE", lines: [{ itemId: item.id, quantity: 10, unitPrice: 100 }] });
    await client.stockAddManual({ itemId: item.id, delta: -4 }); // settled outflow keeps its basis

    await client.purchasesCorrectLine({ lineId: invoice.lines[0]!.id, quantity: 10, unitCost: 300 });
    const history = await client.itemsHistory({ itemId: item.id });
    const correctionRows = history.movements.filter((m) => (m.reason ?? "").startsWith("INVOICE_CORRECTION"));
    expect(correctionRows.map((m) => m.kind)).toEqual(["PURCHASE", "MANUAL_ADJUSTMENT"]);
    expect(correctionRows[0]!.occurredAt).toBe(correctionRows[1]!.occurredAt);
    const row = (await client.itemsAll()).items.find((i) => i.id === item.id)!;
    expect(row.stockOnHand).toBe(6);
    expect(row.costPrice).toBe(225); // (100×6 + 300×10) / 16
  });

  it("suppliersReturn: an outflow reduces stock and keeps the average", async () => {
    const category = await client.categoriesCreate({ name: `seam-supplier-cat-${Date.now()}` });
    const item = await client.itemsCreateWithStock({ name: `seam-supplier-item-${Date.now()}`, categoryId: category.id, costPrice: 100, sellingPrice: 200, stockOnHand: 5 });
    const supplier = await client.suppliersCreate({ name: `مورد-تدفق-${Date.now()}` });

    await client.suppliersReturn({ supplierId: supplier.id, itemId: item.id, quantity: 2, amount: 200 });
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements.find((m) => m.reason === "SUPPLIER_RETURN")).toMatchObject({ kind: "MANUAL_ADJUSTMENT", delta: -2, unitCost: null });
    expect(history.stockOnHand).toBe(3);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(100);
  });

  it("itemsCreateWithStock: the opening movement and the cache agree", async () => {
    const category = await client.categoriesCreate({ name: `seam-opening-cat-${Date.now()}` });
    const item = await client.itemsCreateWithStock({ name: `seam-opening-item-${Date.now()}`, categoryId: category.id, costPrice: 400, sellingPrice: 800, stockOnHand: 12 });
    expect(item.stockOnHand).toBe(12);
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements[0]).toMatchObject({ kind: "MANUAL_ADJUSTMENT", delta: 12, unitCost: 400, reason: "opening" });
    expect(history.stockOnHand).toBe(12);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(400);
  });

  it("itemsUpdate: a cost edit is a zero-delta correction row and resyncs the cache", async () => {
    const item = await makeItem(`seam-cost-${Date.now()}`, 100);
    await client.stockAddManual({ itemId: item.id, delta: 10, unitCost: 100, kind: "PURCHASE" });

    const edited = await client.itemsUpdate({ id: item.id, costPrice: 250 });
    expect(edited?.costPrice).toBe(250);
    const history = await client.itemsHistory({ itemId: item.id });
    expect(history.movements.at(-1)).toMatchObject({ kind: "MANUAL_ADJUSTMENT", delta: 0, unitCost: 250, reason: "COST_CORRECTION" });
    expect(history.stockOnHand).toBe(10);
    expect((await client.itemsAll()).items.find((i) => i.id === item.id)!.costPrice).toBe(250);
  });
});
