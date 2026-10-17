import { afterEach, describe, expect } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";

/**
 * ADR-0008 §4.1: first-run provisioning is allowed only on an empty database.
 * "Empty" means no shop record — seed rows (categories, settings, sequences,
 * expense categories, migration markers) and the activity log do not count,
 * or a fresh install could never be claimed.
 */
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function makeStore(): StorePort {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-db-empty-"));
  const conn: Connection = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
  cleanups.push(() => {
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
  return createDrizzleStore(conn);
}

describe("databaseIsEmpty", () => {
  itHeavy("is true after setup on a fresh database — seed rows do not count", async () => {
    const store = makeStore();
    await store.setup();

    expect(await store.databaseIsEmpty()).toBe(true);
    // the seeds that always exist on a fresh install are present...
    expect((await store.listCategories()).length).toBeGreaterThan(0);
    expect((await store.getSettings()).storeName).toBe("Dokan");
    // ...and settings/preferences/activity the app writes at boot must not
    // make the database look claimed (a DAILY_BACKUP activity is normal)
    await store.setPreference("ui.onboarding.dismissed", "true");
    await store.insertActivity({ type: "BACKUP_CREATED", summary: "DAILY_BACKUP test.db" });
    expect(await store.databaseIsEmpty()).toBe(true);
  });

  itHeavy("is false as soon as one shop record exists", async () => {
    const store = makeStore();
    await store.setup();
    const category = (await store.listCategories())[0];
    expect(category).toBeDefined();
    await store.createItem({ name: "منتج", categoryId: category?.id ?? "", costPrice: 100, sellingPrice: 200 });

    expect(await store.databaseIsEmpty()).toBe(false);
  });

  itHeavy("is false when the admin identity marker survives without a user row", async () => {
    const store = makeStore();
    await store.setup();
    // a half-restored folder: the provisioning marker remains, the user row
    // does not. It was claimed once and must never be claimed again.
    await store.setSetting("adminUserId", "00000000-0000-4000-8000-000000000000");

    expect(await store.databaseIsEmpty()).toBe(false);
  });

  itHeavy("is false when the invoice number sequence has been used", async () => {
    const store = makeStore();
    await store.setup();
    // no counter row exists yet; one allocation proves an invoice existed
    await store.allocateInvoiceNumber("SALE");

    expect(await store.databaseIsEmpty()).toBe(false);
  });

  itHeavy("is false when the return number sequence has been used", async () => {
    const store = makeStore();
    await store.setup();
    await store.allocateReturnNumber();

    expect(await store.databaseIsEmpty()).toBe(false);
  });
});
