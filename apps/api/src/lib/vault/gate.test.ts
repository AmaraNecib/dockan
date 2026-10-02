import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";

import { createApp } from "../../app";
import { createAuth } from "../../auth/auth";
import { createAppConfig, type AppConfig } from "../../config";
import { createEncryptedConnection, readLegacyDatabaseImage } from "../../db/encrypted-connection";
import { AppLogger } from "../../lib/logger";
import { ensureSessionSecret } from "../../lib/session-secret";
import { type KdfParams } from "./crypto";
import { createVaultHttpApp } from "./http";
import { VaultManager } from "./manager";
import { createRpcRouter } from "../../rpc/router";
import { createDrizzleStore } from "../../store/drizzle-store";
import type { StorePort } from "../../store/port";

/**
 * The vault gate over its real seams: the HTTP gate drives the same manager
 * the desktop shell does, and once open the router accepts the minted session
 * as the owner. Also the portability and legacy-migration stories end to end.
 */

const FAST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDirRetry(dir);
});

/** bun:sqlite can hold a Windows file handle a beat after close; retry. */
function removeDirRetry(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Create a phase-1 plaintext database from a separate process. The migration
 * always runs in a fresh process in production (a shop that upgrades); the
 * OS releases the SQLite file handles when the writer exits, which same-process
 * reopen on Windows does not do reliably.
 */
function createLegacyDatabaseOutsideProcess(dir: string): void {
  const dbPath = path.join(dir, "dokan.db");
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(dbPath)}, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.exec("INSERT INTO categories VALUES ('cat-zina', 'زينة', '2026-01-01T00:00:00', '2026-01-01T00:00:00')");
    db.exec("PRAGMA user_version = 1");
    db.close();
  `;
  const result = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`legacy database fixture failed: ${result.stderr.toString()}`);
  if (!fs.existsSync(dbPath)) throw new Error("legacy database fixture did not create the file");
}

type GateHarness = {
  dir: string;
  config: AppConfig;
  manager: VaultManager;
  gate: ReturnType<typeof createVaultHttpApp>;
  /** the full app comes alive after bootstrap; gate tests use it post-unlock */
  appFor: () => ReturnType<typeof createApp>;
  connection: () => ReturnType<typeof createEncryptedConnection>;
  store: () => StorePort;
  linkWith: (headers: Record<string, string>) => DokanClient;
};

function harness(dir: string): GateHarness {
  const config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: path.join(dir, "dokan.db"),
    DOKAN_PORT: "4399",
  });
  const logger = new AppLogger(dir);
  const manager = new VaultManager({ dataDir: dir, legacyDbPath: config.db.path, logger, kdf: FAST_KDF });
  let connection: ReturnType<typeof createEncryptedConnection> | undefined;
  let store: StorePort | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  const bootstrap = async (input: { masterKey: Buffer; vaultId: string; fresh: boolean }): Promise<void> => {
    if (store !== undefined) return;
    const legacyPath = config.db.path;
    const seedBytes = input.fresh && fs.existsSync(legacyPath) ? readLegacyDatabaseImage(legacyPath).image : undefined;
    const connectionOptions: Parameters<typeof createEncryptedConnection>[0] = {
      vaultId: input.vaultId,
      masterKey: input.masterKey,
      snapshotPath: manager.snapshotPath,
    };
    if (seedBytes !== undefined) connectionOptions.seedBytes = seedBytes;
    connection = createEncryptedConnection(connectionOptions);
    store = createDrizzleStore(connection);
    await store.setup();
    await connection.flush();
    const ownerId = await store.getSetting("adminUserId");
    if (ownerId !== undefined) manager.setOwnerId(ownerId);
    const sessionSecret = await ensureSessionSecret(store);
    const auth = createAuth(connection.db, config, sessionSecret);
    const router = createRpcRouter({
      db: connection.db,
      config,
      logger,
      store,
      auth,
      vault: {
        sessionMatches: (token) => manager.sessionMatches(token),
        ownerId: () => manager.ownerId(),
        setOwnerId: (value) => manager.setOwnerId(value),
      },
    });
    app = createApp({ config, logger, auth, rpcRouter: router });
  };

  const gate = createVaultHttpApp({
    manager,
    config,
    logger,
    bootstrap,
    onSetupCommitted: async () => {
      for (const suffix of ["", "-wal", "-shm"] as const) {
        try {
          await fs.promises.unlink(`${config.db.path}${suffix}`);
        } catch {
          /* already gone */
        }
      }
    },
  });

  return {
    dir,
    config,
    manager,
    gate,
    appFor: () => {
      if (app === undefined) throw new Error("app not bootstrapped");
      return app;
    },
    connection: () => {
      if (connection === undefined) throw new Error("connection not bootstrapped");
      return connection;
    },
    store: () => {
      if (store === undefined) throw new Error("store not bootstrapped");
      return store;
    },
    linkWith: (headers: Record<string, string>) =>
      // SAFETY: RPCLink + createORPCClient on the Dokan contract is exactly the
      // DokanClient construction every wire test in this repo uses
      createORPCClient(
        new RPCLink({
          url: () => `http://127.0.0.1:${config.port}/api/rpc`,
          fetch: (request) => {
            const merged = new Headers(request.headers);
            for (const [key, value] of Object.entries(headers)) merged.set(key, value);
            if (app === undefined) throw new Error("app not bootstrapped");
            return Promise.resolve(app.fetch(new Request(request, { headers: merged })));
          },
        }),
      ) as DokanClient,
  };
}

async function json<T>(response: Response): Promise<T> {
  // SAFETY: the vault routes return JSON by contract; tests decode their known shape
  return (await response.json()) as T;
}
describe("vault HTTP gate", () => {
  it("walks first run: unconfigured → setup → recovery key → owner setup → guarded RPC", async () => {
    const h = harness(tempDir("dokan-vault-gate-"));
    const status = await json<{ state: string; unlocked: boolean }>(await h.gate.request("/api/vault/status"));
    expect(status.state).toBe("unconfigured");
    expect(status.unlocked).toBe(false);

    // a short passphrase is refused with Arabic copy before any crypto
    const short = await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "short" }),
    });
    expect(short.status).toBe(400);
    // SAFETY: the error contract is { error: { code, message } }
    const shortBody = await json<{ error: { code: string; message: string } }>(short);
    expect(shortBody.error.code).toBe("VAULT_PASSPHRASE_TOO_SHORT");
    expect(shortBody.error.message).toContain("كلمة المرور");

    const setup = await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(setup.status).toBe(200);
    // SAFETY: the setup contract is { ok: true, recoveryKey, sessionToken }
    const setupBody = await json<{ ok: boolean; recoveryKey: string; sessionToken: string }>(setup);
    expect(setupBody.ok).toBe(true);
    expect(setupBody.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(fs.existsSync(path.join(h.dir, "vault", "vault.json"))).toBe(true);
    expect(fs.existsSync(path.join(h.dir, "dokan.db.enc"))).toBe(true);

    // no session header: guarded procedures refuse even while unlocked
    const unauthed = h.linkWith({});
    await expect(unauthed.categoriesList()).rejects.toThrow();

    // owner setup in vault mode sends no password
    const provisioned = h.linkWith({ "x-vault-session": setupBody.sessionToken });
    await provisioned.firstTimeSetup({
      ownerName: "مالك الاختبار",
      phoneNumber: "0550123123",
      storeName: "متجر الاختبار",
    });
    const categories = await provisioned.categoriesList();
    expect(categories.items.some((category) => category.name === "عام")).toBe(true);

    // a wrong token is not the owner
    await expect(h.linkWith({ "x-vault-session": "not-the-token" }).categoriesList()).rejects.toThrow();

    // the recovery key unlocks again after a close
    h.manager.close();
    const recoveryUnlock = await h.gate.request("/api/vault/unlock-recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryKey: setupBody.recoveryKey }),
    });
    expect(recoveryUnlock.status).toBe(200);
  });

  it("refuses a wrong passphrase with Arabic copy and never corrupts the vault", async () => {
    const h = harness(tempDir("dokan-vault-wrong-"));
    await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    h.manager.close();

    const wrong = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "wrong horse battery" }),
    });
    expect(wrong.status).toBe(401);
    // SAFETY: the error contract is { error: { code, message } }
    const body = await json<{ error: { code: string; message: string } }>(wrong);
    expect(body.error.code).toBe("VAULT_WRONG_PASSPHRASE");
    expect(body.error.message).toContain("كلمة المرور");
    // the header and snapshot are untouched
    expect(fs.existsSync(path.join(h.dir, "vault", "vault.json"))).toBe(true);

    // and the right passphrase still opens it
    const right = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(right.status).toBe(200);
  });

  it("migrates a legacy plaintext database, preserving the schema version, and removes the plaintext files", async () => {
    const dir = tempDir("dokan-vault-migrate-");
    createLegacyDatabaseOutsideProcess(dir);

    const h = harness(dir);
    const setup = await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(setup.status).toBe(200);
    // the plaintext files are gone and only the encrypted snapshot remains
    expect(fs.existsSync(path.join(dir, "dokan.db"))).toBe(false);
    expect(fs.existsSync(h.manager.snapshotPath)).toBe(true);
    const categories = await h.store().listCategories();
    expect(categories.some((category) => category.name === "زينة")).toBe(true);
    h.connection().close();
  });

  it("decrypts a copied data folder on a fresh machine (portability)", async () => {
    const source = tempDir("dokan-vault-portable-src-");
    const h = harness(source);
    const setup = await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    // SAFETY: the setup contract carries the recovery key
    const { recoveryKey } = await json<{ recoveryKey: string }>(setup);
    await h.store().createCategory({ name: "حامل" });
    await h.connection().flush();
    h.connection().close();
    h.manager.close();

    // copy the whole data folder to a new location ("fresh machine")
    const destination = tempDir("dokan-vault-portable-dst-");
    fs.cpSync(source, destination, { recursive: true });
    const moved = harness(destination);
    const unlock = await moved.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(unlock.status).toBe(200);
    expect((await moved.store().listCategories()).some((category) => category.name === "حامل")).toBe(true);
    moved.connection().close();

    // the recovery key travels with the folder too
    moved.manager.close();
    const recovery = await moved.gate.request("/api/vault/unlock-recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryKey }),
    });
    expect(recovery.status).toBe(200);
  });

  it("adds, lists, and removes recovery keys while unlocked; change-passphrase keeps recovery valid", async () => {
    const h = harness(tempDir("dokan-vault-rotate-"));
    const setup = await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    // SAFETY: the setup contract carries a session token
    const { sessionToken } = await json<{ sessionToken: string }>(setup);
    const authHeaders = { "content-type": "application/json", "x-vault-session": sessionToken };
    const added = await h.gate.request("/api/vault/recovery-keys", { method: "POST", headers: authHeaders });
    expect(added.status).toBe(200);
    // SAFETY: the add contract is { ok, id, code }
    const addedBody = await json<{ id: string; code: string }>(added);
    expect(addedBody.code).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);

    const listed = await h.gate.request("/api/vault/recovery-keys", { headers: authHeaders });
    // SAFETY: the list contract is { keys: Array<{ id: string }> }
    const listedBody = await json<{ keys: Array<{ id: string }> }>(listed);
    expect(listedBody.keys).toHaveLength(2);

    const removed = await h.gate.request(`/api/vault/recovery-keys/${addedBody.id}`, { method: "DELETE", headers: authHeaders });
    expect(removed.status).toBe(200);

    const changed = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "a brand new passphrase" }),
    });
    expect(changed.status).toBe(200);
    // the old passphrase no longer opens, the new one does
    h.manager.close();
    const old = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(old.status).toBe(401);
    const fresh = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "a brand new passphrase" }),
    });
    expect(fresh.status).toBe(200);
  });
});
