import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { HEAVY_TEST_TIMEOUT_MS } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { createApp } from "../app";
import { createAuth } from "../auth/auth";
import { createAppConfig, type AppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { AppLogger } from "../lib/logger";
import { ensureSessionSecret } from "../lib/session-secret";
import { createRpcRouter } from "./router";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";

/**
 * Regression (issue 161, Greptile finding 2): a supplier-backed purchase whose
 * total is zero (all lines free) must save with its stock intake and open NO
 * supplier charge — a zero-value entry would violate the ledger's
 * `CHECK (amount > 0)` and roll the whole invoice back.
 */
let dir: string;
let conn: Connection;
let store: StorePort;
let client: DokanClient;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-supplier-zero-"));
  const config: AppConfig = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") });
  conn = openConnection(config);
  store = createDrizzleStore(conn);
  await store.setup();
  const logger = new AppLogger(dir);
  const auth = createAuth(conn.db, config, await ensureSessionSecret(store));
  const app = createApp({ config, logger, auth, rpcRouter: createRpcRouter({ db: conn.db, config, logger, store, auth }) });
  const link = new RPCLink({
    url: () => `http://127.0.0.1:${config.port}/api/rpc`,
    fetch: (request) => Promise.resolve(app.fetch(request)),
  });
  const setupClient: DokanClient = createORPCClient(link);
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
  const cookie = login.headers.get("set-cookie") ?? "";
  const authedLink = new RPCLink({
    url: () => `http://127.0.0.1:${config.port}/api/rpc`,
    fetch: (request) => {
      const headers = Object.fromEntries(request.headers.entries());
      headers.cookie = cookie;
      return Promise.resolve(app.fetch(new Request(request, { headers })));
    },
  });
  client = createORPCClient(authedLink);
}, HEAVY_TEST_TIMEOUT_MS);

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

describe("supplier-backed free purchase (issue 161 finding 2)", () => {
  it("saves a zero-total purchase with stock intake and no supplier charge", async () => {
    const supplier = await client.suppliersCreate({ name: "مورد هدية" });
    const category = await client.categoriesCreate({ name: "هدايا" });
    const item = await client.itemsCreate({ name: "هدية", categoryId: category.id, costPrice: 0, sellingPrice: 0 });

    const invoice = await client.invoicesCreate({
      kind: "PURCHASE",
      counterpartyId: supplier.id,
      lines: [{ itemId: item.id, quantity: 3, unitPrice: 0 }],
    });

    expect(invoice.totalAmount).toBe(0);
    expect(invoice.remainingAmount).toBe(0);
    // the goods landed: stock intake survives the free invoice
    const items = await client.itemsAll();
    expect(items.items.find((row) => row.id === item.id)?.stockOnHand).toBe(3);

    // no supplier charge was opened (a zero entry would have rolled it back)
    const detail = await client.suppliersGet({ id: supplier.id });
    expect(detail.account?.balance).toBe(0);
    expect(detail.account?.entries ?? []).toHaveLength(0);
  });
});
