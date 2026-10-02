import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";
import {
  ensureSessionSecret,
  generateSessionSecret,
  SESSION_SECRET_BYTES,
  SESSION_SECRET_SETTING_KEY,
} from "./session-secret";

/**
 * ADR-0008 §4.2: one universal build, the session-signing secret is generated
 * on first run and stored with the data; an existing value is never replaced,
 * and the migration never hands out a recovery credential.
 */
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

type TestStore = { store: StorePort; conn: Connection };

function makeStore(): TestStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-session-secret-"));
  const conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
  cleanups.push(() => {
    conn.close();
    // Windows keeps the sqlite/WAL handles briefly after close
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });
  return { store: createDrizzleStore(conn), conn };
}

function settingKeys(conn: Connection): string[] {
  // SAFETY: settings.key is the primary key; the literal SELECT yields one
  // string column per row
  return (conn.raw.query("SELECT key FROM settings").all() as Array<{ key: string }>).map((row) => row.key);
}

describe("generateSessionSecret", () => {
  it("returns a 256-bit base64url secret", () => {
    const secret = generateSessionSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, "base64url")).toHaveLength(SESSION_SECRET_BYTES);
  });

  it("never repeats", () => {
    expect(generateSessionSecret()).not.toBe(generateSessionSecret());
  });
});

describe("ensureSessionSecret", () => {
  it("generates and stores a strong secret on a fresh database", async () => {
    const { store } = makeStore();
    await store.setup();

    const secret = await ensureSessionSecret(store);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.getSetting(SESSION_SECRET_SETTING_KEY)).toBe(secret);
  });

  it("returns the stored secret on every later call (restoring the data keeps sessions)", async () => {
    const { store } = makeStore();
    await store.setup();

    const first = await ensureSessionSecret(store);
    expect(await ensureSessionSecret(store)).toBe(first);

    // an explicitly present value is never replaced, whatever its shape
    await store.setSetting(SESSION_SECRET_SETTING_KEY, "existing-value");
    expect(await ensureSessionSecret(store)).toBe("existing-value");
  });

  it("hands out no recovery credential when it migrates a database", async () => {
    const { store, conn } = makeStore();
    await store.setup();
    await ensureSessionSecret(store);

    const keys = settingKeys(conn);
    expect(keys).toContain(SESSION_SECRET_SETTING_KEY);
    expect(keys.some((key) => key.toLowerCase().includes("recovery"))).toBe(false);
  });

  it("converges on one secret when two calls race", async () => {
    const { store } = makeStore();
    await store.setup();

    const [a, b] = await Promise.all([ensureSessionSecret(store), ensureSessionSecret(store)]);
    expect(a).toBe(b);
    expect(await store.getSetting(SESSION_SECRET_SETTING_KEY)).toBe(a);
  });
});
