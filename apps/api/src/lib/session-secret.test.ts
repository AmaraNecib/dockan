import { afterEach, describe, expect, it } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { createApp } from "../app";
import { createAuth } from "../auth/auth";
import { createAppConfig, type AppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { AppLogger } from "./logger";
import { createRpcRouter } from "../rpc/router";
import { createDrizzleStore } from "../store/drizzle-store";
import {
  ensureSessionSecret,
  generateSessionSecret,
  isStrongSessionSecret,
  SESSION_SECRET_BYTES,
  SESSION_SECRET_MIN_LENGTH,
  SESSION_SECRET_SETTING_KEY,
} from "./session-secret";

/**
 * ADR-0008 §4.2: one universal build, the session-signing secret is generated
 * on first run and stored with the data; an existing strong value is never
 * replaced, and the migration never hands out a recovery credential.
 */
let cleanups: Array<() => void> = [];
afterEach(() => {
  // LIFO: resources are released in reverse acquisition order, so every
  // connection closes before the temp dir it lives in is removed (Windows
  // refuses to delete an open database file).
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

function removeDirRetry(dir: string): void {
  // Windows keeps sqlite/WAL handles briefly after close
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-session-secret-"));
  cleanups.push(() => removeDirRetry(dir));
  return dir;
}

function openTestConnection(config: AppConfig): Connection {
  const conn = openConnection(config);
  cleanups.push(() => conn.close());
  return conn;
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

describe("isStrongSessionSecret", () => {
  it("accepts a generated secret and a long URL-safe value", () => {
    expect(isStrongSessionSecret(generateSessionSecret())).toBe(true);
    expect(isStrongSessionSecret("x".repeat(SESSION_SECRET_MIN_LENGTH))).toBe(true);
  });

  it("rejects empty, short and malformed stored values", () => {
    expect(isStrongSessionSecret("")).toBe(false);
    expect(isStrongSessionSecret("x".repeat(SESSION_SECRET_MIN_LENGTH - 1))).toBe(false);
    expect(isStrongSessionSecret("!".repeat(SESSION_SECRET_MIN_LENGTH))).toBe(false);
    expect(isStrongSessionSecret(`${"x".repeat(SESSION_SECRET_MIN_LENGTH - 1)} `)).toBe(false);
  });
});

describe("ensureSessionSecret", () => {
  itHeavy("generates and stores a strong secret on a fresh database", async () => {
    const dir = tempDir();
    const conn = openTestConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
    const store = createDrizzleStore(conn);
    await store.setup();

    const secret = await ensureSessionSecret(store);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.getSetting(SESSION_SECRET_SETTING_KEY)).toBe(secret);
  });

  itHeavy("returns a stored strong value untouched (restoring the data keeps sessions)", async () => {
    const dir = tempDir();
    const conn = openTestConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
    const store = createDrizzleStore(conn);
    await store.setup();

    const first = await ensureSessionSecret(store);
    expect(await ensureSessionSecret(store)).toBe(first);

    // an explicitly stored strong value is never replaced
    const stored = "y".repeat(SESSION_SECRET_MIN_LENGTH);
    await store.setSetting(SESSION_SECRET_SETTING_KEY, stored);
    expect(await ensureSessionSecret(store)).toBe(stored);
  });

  itHeavy("regenerates empty, short and malformed stored values with a warning", async () => {
    for (const damaged of ["", "short-secret", "!".repeat(SESSION_SECRET_MIN_LENGTH)]) {
      const dir = tempDir();
      const conn = openTestConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
      const store = createDrizzleStore(conn);
      await store.setup();
      await store.setSetting(SESSION_SECRET_SETTING_KEY, damaged);
      const warnings: string[] = [];
      const logger = { warn: (event: string) => { warnings.push(event); } };

      const regenerated = await ensureSessionSecret(store, logger);
      expect(regenerated).not.toBe(damaged);
      expect(isStrongSessionSecret(regenerated)).toBe(true);
      expect(await store.getSetting(SESSION_SECRET_SETTING_KEY)).toBe(regenerated);
      expect(warnings).toContain("SESSION_SECRET_REGENERATED");
    }
  });

  itHeavy("keeps the regenerated secret even when the warning logger throws", async () => {
    const dir = tempDir();
    const conn = openTestConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
    const store = createDrizzleStore(conn);
    await store.setup();
    await store.setSetting(SESSION_SECRET_SETTING_KEY, "short-secret");
    const logger = { warn: () => { throw new Error("log-boom"); } };

    // The warning is emitted AFTER the transaction commits, so a failed log
    // write cannot roll the secret back (a full disk must not strand boot
    // with the damaged value still in place).
    await expect(ensureSessionSecret(store, logger)).rejects.toThrow("log-boom");
    const stored = await store.getSetting(SESSION_SECRET_SETTING_KEY);
    expect(stored).toBeDefined();
    expect(isStrongSessionSecret(stored ?? "")).toBe(true);
  });

  itHeavy("converges on one secret across two processes opening the same fresh database", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "test.db");
    const config = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath });
    // The parent creates the schema so both children race only on the secret.
    // They must be separate PROCESSES: bun:sqlite is synchronous, so two
    // connections in one process would deadlock in BEGIN IMMEDIATE instead of
    // exercising the cross-process write lock this test exists for.
    const parent = openConnection(config);
    await createDrizzleStore(parent).setup();
    parent.close();

    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(import.meta.dir, name)).href);
    const script = `
import { createAppConfig } from ${moduleUrl("../config.ts")};
import { openConnection } from ${moduleUrl("../db/connection.ts")};
import { createDrizzleStore } from ${moduleUrl("../store/drizzle-store.ts")};
import { ensureSessionSecret } from ${moduleUrl("session-secret.ts")};
const config = createAppConfig({ DOKAN_DATA_DIR: ${JSON.stringify(dir)}, DOKAN_DB_PATH: ${JSON.stringify(dbPath)} });
const conn = openConnection(config);
const store = createDrizzleStore(conn);
const secret = await ensureSessionSecret(store);
conn.close();
console.log(secret);
`;
    const runChild = async () => {
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout: stdout.trim(), stderr: stderr.trim() };
    };

    const [a, b] = await Promise.all([runChild(), runChild()]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(a.stdout).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.stdout).toBe(b.stdout);

    const verify = openTestConnection(config);
    expect(await createDrizzleStore(verify).getSetting(SESSION_SECRET_SETTING_KEY)).toBe(a.stdout);
    // SAFETY: COUNT(*) returns one row with a numeric count
    const rows = verify.raw.query("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get(SESSION_SECRET_SETTING_KEY) as { count: number };
    expect(rows.count).toBe(1);
  });

  itHeavy("migrates a pre-universal database once, with no recovery credential", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "test.db");
    const config = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath });
    const first = openConnection(config);
    const firstStore = createDrizzleStore(first);
    await firstStore.setup();
    // a real pre-universal shop: an owner marker and shop rows, but no secret
    const category = (await firstStore.listCategories())[0];
    expect(category).toBeDefined();
    await firstStore.createItem({ name: "منتج-قديم", categoryId: category?.id ?? "", costPrice: 100, sellingPrice: 200 });
    await firstStore.setSetting("adminUserId", "00000000-0000-4000-8000-000000000000");
    first.raw.query("DELETE FROM settings WHERE key = ?").run(SESSION_SECRET_SETTING_KEY);
    expect(await firstStore.getSetting(SESSION_SECRET_SETTING_KEY)).toBeUndefined();
    first.close();

    // first boot of the universal build: generate exactly one secret
    const second = openTestConnection(config);
    const secondStore = createDrizzleStore(second);
    const generated = await ensureSessionSecret(secondStore);
    expect(isStrongSessionSecret(generated)).toBe(true);
    const keys = settingKeys(second);
    expect(keys.filter((key) => key === SESSION_SECRET_SETTING_KEY)).toHaveLength(1);
    expect(keys.some((key) => key.toLowerCase().includes("recovery"))).toBe(false);
    second.close();

    // second boot: the stored secret is reused, sessions survive
    const third = openTestConnection(config);
    const thirdStore = createDrizzleStore(third);
    expect(await ensureSessionSecret(thirdStore)).toBe(generated);
    expect(await thirdStore.getSetting(SESSION_SECRET_SETTING_KEY)).toBe(generated);
  });

  itHeavy("keeps a live session cookie when the database is copied", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "test.db");
    const config = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath });
    const conn = openTestConnection(config);
    const store = createDrizzleStore(conn);
    await store.setup();
    const secret = await ensureSessionSecret(store);
    const logger = new AppLogger(dir);
    const auth = createAuth(conn.db, config, secret);
    const app = createApp({ config, logger, auth, rpcRouter: createRpcRouter({ db: conn.db, config, logger, store, auth }) });

    // provision the owner through the public first-run setup, then sign in
    const link = new RPCLink({
      url: "http://localhost/api/rpc",
      // SAFETY: the link's fetch contract wants a Promise; hono's fetch returns one
      fetch: (request) => Promise.resolve(app.fetch(request)),
    });
    const setupClient: DokanClient = createORPCClient(link);
    await setupClient.firstTimeSetup({ ownerName: "مالك الاختبار", phoneNumber: "0550123123", password: "pass-1234", storeName: "متجر الاختبار" });
    const login = await auth.handler(
      new Request("http://localhost/api/auth/sign-in/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "213550123123", password: "pass-1234" }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).not.toBe("");

    // copy the data folder's database (checkpoints the WAL first)
    const copyPath = path.join(dir, "copied.db");
    await store.copyDatabaseTo(copyPath);
    const copyConfig = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: copyPath });
    const copyConn = openTestConnection(copyConfig);
    const copyStore = createDrizzleStore(copyConn);
    const copiedSecret = await ensureSessionSecret(copyStore);
    expect(copiedSecret).toBe(secret);

    // the same cookie is still valid on the copy, because the secret travelled
    const copyAuth = createAuth(copyConn.db, copyConfig, copiedSecret);
    const session = await copyAuth.api.getSession({ headers: new Headers({ cookie }) });
    // SAFETY: the username plugin adds `username` to the user row at runtime, but
    // better-auth 1.7.12's session response type carries only the core fields
    // (id/name/email/emailVerified/image), so the compiler cannot see it
    expect((session?.user as { username?: string } | undefined)?.username).toBe("213550123123");
  });
});
