import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { createApp } from "../app";
import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { AppLogger } from "../lib/logger";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";

/**
 * Wire-seam tests for ticket 03 (spec seam 1). The typed oRPC client calls
 * the real HTTP seam (app.fetch through RPCLink); the store sits on sqlite
 * :memory:. Nothing is mocked; every assertion is an observable behaviour.
 */
let dir: string;
let conn: Connection;
let store: StorePort;
let client: DokanClient;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-rpc-"));
  const config = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();

  const app = createApp(store, new AppLogger(dir), config);
  const link = new RPCLink({
    url: () => `http://127.0.0.1:${config.port}/api/rpc`,
    // SAFETY: the link's fetch contract wants a Promise; hono's fetch returns one
    fetch: (request) => Promise.resolve(app.fetch(request)),
  });
  client = createORPCClient(link);
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