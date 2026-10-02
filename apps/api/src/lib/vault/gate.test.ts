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
import { openVaultStore } from "../../db/vault-store";
import { AppLogger } from "../../lib/logger";
import { ensureSessionSecret } from "../../lib/session-secret";
import { createOverlay, type NodeRequestEnv } from "../overlay";
import { VaultAuthenticationError, type KdfParams } from "./crypto";
import { extractVaultBackup } from "./backup";
import { createVaultHttpApp, type VaultCleanupResult } from "./http";
import { VaultManager } from "./manager";
import { createRpcRouter } from "../../rpc/router";
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
  /** gate requests default to a loopback peer unless a test passes an env */
  gate: {
    request: (input: Request | string | URL, init?: RequestInit, env?: NodeRequestEnv) => Response | Promise<Response>;
    fetch: ReturnType<typeof createVaultHttpApp>["fetch"];
  };
  /** the raw Hono gate, for tests that drive it through the real overlay */
  gateApp: ReturnType<typeof createVaultHttpApp>;
  /** the full app comes alive after bootstrap; gate tests use it post-unlock */
  appFor: () => ReturnType<typeof createApp>;
  /** simulate a process restart: the next unlock re-runs bootstrap */
  resetApp: () => void;
  connection: () => ReturnType<typeof createEncryptedConnection>;
  store: () => StorePort;
  linkWith: (headers: Record<string, string>) => DokanClient;
};

function harness(
  dir: string,
  options: {
    onSetupCommitted?: () => Promise<VaultCleanupResult>;
    afterSetup?: () => Promise<void>;
    afterCredentialChange?: () => Promise<void>;
    bootstrap?: (input: { masterKey: Buffer; vaultId: string; fresh: boolean }) => Promise<void>;
    /** run the gate as the desktop shell's stdin-broker mode (issue #141) */
    broker?: boolean;
  } = {},
): GateHarness {
  const config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: path.join(dir, "dokan.db"),
    DOKAN_PORT: "4399",
    DOKAN_VAULT_STDIN: options.broker ? "1" : undefined,
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
    const storeInput: Parameters<typeof openVaultStore>[0] = {
      vaultId: input.vaultId,
      masterKey: input.masterKey,
      snapshotPath: manager.snapshotPath,
      headerPath: manager.headerPath,
    };
    if (input.fresh) storeInput.fresh = true;
    if (seedBytes !== undefined) storeInput.seedBytes = seedBytes;
    const opened = openVaultStore(storeInput);
    connection = opened.conn;
    store = opened.store;
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

  const gateBootstrap = options.bootstrap ?? bootstrap;

  const gateApp = createVaultHttpApp({
    manager,
    config,
    logger,
    bootstrap: gateBootstrap,
    onSetupCommitted:
      options.onSetupCommitted ??
      (async () => {
        for (const suffix of ["", "-wal", "-shm"] as const) {
          try {
            await fs.promises.unlink(`${config.db.path}${suffix}`);
          } catch {
            /* already gone */
          }
        }
        return { plaintextRemaining: [] };
      }),
    afterSetup: options.afterSetup,
    afterCredentialChange: options.afterCredentialChange,
  });
  // every gate test acts as a loopback client unless it passes its own env;
  // the credential guard fails closed on an unknown peer (round-8 finding 1)
  const gate = {
    request: async (input: Request | string | URL, init?: RequestInit, env?: NodeRequestEnv): Promise<Response> =>
      await gateApp.request(input, init, env ?? { incoming: { socket: { remoteAddress: "127.0.0.1" } } }),
    fetch: gateApp.fetch.bind(gateApp),
  };

  return {
    dir,
    config,
    manager,
    gate,
    gateApp,
    appFor: () => {
      if (app === undefined) throw new Error("app not bootstrapped");
      return app;
    },
    resetApp: () => {
      store = undefined;
      connection = undefined;
      app = undefined;
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

/** Late-bound handle so an afterCredentialChange hook can rotate mid-request. */
type ManagerHolder = { manager?: VaultManager };
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
    // SAFETY: the error contract is { error: { code } }: the API is
    // locale-neutral and never ships display copy (round-6)
    const shortBody = await json<{ error: { code: string; message?: string } }>(short);
    expect(shortBody.error.code).toBe("VAULT_PASSPHRASE_TOO_SHORT");
    expect(shortBody.error.message).toBeUndefined();
    expect(JSON.stringify(shortBody)).not.toMatch(/[\u0600-\u06FF]/);

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

  it("refuses a non-JSON pre-auth request (cross-site POST) without consuming an attempt", async () => {
    const h = harness(tempDir("dokan-vault-csrf-"));
    await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    h.manager.close();

    // a browser simple request cannot set application/json without a preflight
    const csrf = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      body: JSON.stringify({ passphrase: "wrong horse battery" }),
    });
    expect(csrf.status).toBe(415);

    // and it never counted as a failed attempt: the right passphrase still works
    const right = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(right.status).toBe(200);
  });

  it("still returns the recovery key when post-commit plaintext cleanup fails", async () => {
    const dir = tempDir("dokan-vault-cleanup-");
    createLegacyDatabaseOutsideProcess(dir);
    const h = harness(dir, {
      onSetupCommitted: async () => {
        throw new Error("EBUSY");
      },
    });
    const setup = await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(setup.status).toBe(200);
    // SAFETY: the setup contract carries the recovery key
    const body = await json<{ recoveryKey: string }>(setup);
    expect(body.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    // the vault is committed even though the plaintext files remain
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
    h.connection().close();
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
    // SAFETY: the error contract is { error: { code } }: the API is
    // locale-neutral and never ships display copy (round-6)
    const body = await json<{ error: { code: string; message?: string } }>(wrong);
    expect(body.error.code).toBe("VAULT_WRONG_PASSPHRASE");
    expect(body.error.message).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/[\u0600-\u06FF]/);
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
    // deleting a credential rotates the session token; adopt the fresh one
    // SAFETY: the delete contract is { ok: true, sessionToken }
    const afterRemove = await json<{ sessionToken: string }>(removed);
    const rotatedHeaders = { "content-type": "application/json", "x-vault-session": afterRemove.sessionToken };

    const changed = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: rotatedHeaders,
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

describe("vault gate hardening (review supplement)", () => {
  const jsonHeaders = { "content-type": "application/json" };

  async function setupVault(h: GateHarness, passphrase = "correct horse battery") {
    return h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase }),
    });
  }

  it("validates the NORMALIZED passphrase (finding: eight spaces is empty)", async () => {
    const h = harness(tempDir("dokan-vault-norm-"));
    const spaces = await setupVault(h, "        ");
    expect(spaces.status).toBe(400);
    // SAFETY: the error contract is { error: { code } }
    expect((await json<{ error: { code: string } }>(spaces)).error.code).toBe("VAULT_PASSPHRASE_TOO_SHORT");
    // a padded short passphrase normalizes below the floor too
    expect((await setupVault(h, "  short  ")).status).toBe(400);
    // and the same rule lets a real passphrase through
    expect((await setupVault(h, "correct horse battery")).status).toBe(200);
  });

  it("keeps first-run setup single-flight (finding: concurrent setups mixing keys)", async () => {
    const h = harness(tempDir("dokan-vault-single-flight-"));
    const responses = await Promise.all([setupVault(h), setupVault(h)]);
    // one request wins; a concurrent retry may resume the same pending setup,
    // so both may legitimately answer 200 with the SAME pending recovery key
    for (const response of responses) expect([200, 409]).toContain(response.status);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    const winners = responses.filter((response) => response.status === 200);
    const keys = await Promise.all(winners.map(async (winner) => (await json<{ recoveryKey: string }>(winner)).recoveryKey));
    expect(new Set(keys).size).toBe(1);
    // every key the winner(s) saw must unlock the COMMITTED header
    h.manager.close();
    h.resetApp();
    for (const recoveryKey of keys) {
      h.manager.close();
      const unlock = await h.gate.request("/api/vault/unlock-recovery", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ recoveryKey }),
      });
      expect(unlock.status).toBe(200);
    }
  });

  it("refuses a torn or damaged snapshot as corruption, never as a wrong passphrase", async () => {
    const h = harness(tempDir("dokan-vault-corrupt-"));
    await setupVault(h);
    await h.connection().close();
    h.manager.close();
    h.resetApp();

    const original = fs.readFileSync(h.manager.snapshotPath);
    // truncation: the envelope tail is cut off
    fs.writeFileSync(h.manager.snapshotPath, original.subarray(0, Math.floor(original.length / 2)));
    const torn = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(torn.status).toBe(409);
    // SAFETY: the error contract is { error: { code } }
    expect((await json<{ error: { code: string } }>(torn)).error.code).toBe("VAULT_CORRUPT");

    // byte flip: the AEAD tag fails, still corruption because the header
    // already authenticated the passphrase
    const flipped = Buffer.from(original);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
    fs.writeFileSync(h.manager.snapshotPath, flipped);
    const damaged = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(damaged.status).toBe(409);
    // SAFETY: the error contract is { error: { code } }
    expect((await json<{ error: { code: string } }>(damaged)).error.code).toBe("VAULT_CORRUPT");
  });

  it("refuses a missing snapshot instead of fabricating an empty shop", async () => {
    const h = harness(tempDir("dokan-vault-missing-"));
    await setupVault(h);
    await h.connection().close();
    h.manager.close();
    h.resetApp();
    fs.rmSync(h.manager.snapshotPath, { force: true });

    const unlock = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(unlock.status).toBe(409);
    // SAFETY: the error contract is { error: { code } }
    expect((await json<{ error: { code: string } }>(unlock)).error.code).toBe("VAULT_DATABASE_MISSING");
    // the refusal must not create a replacement empty database
    expect(fs.existsSync(h.manager.snapshotPath)).toBe(false);
  });

  it("refuses to delete the last recovery key (finding C8)", async () => {
    const h = harness(tempDir("dokan-vault-lastkey-"));
    const setup = await setupVault(h);
    // SAFETY: the setup contract carries the session token
    const { sessionToken } = await json<{ sessionToken: string }>(setup);
    const listed = await h.gate.request("/api/vault/recovery-keys", { headers: { "x-vault-session": sessionToken } });
    // SAFETY: the list contract is { keys: Array<{ id: string }> }
    const keys = (await json<{ keys: Array<{ id: string }> }>(listed)).keys;
    expect(keys).toHaveLength(1);
    const removed = await h.gate.request(`/api/vault/recovery-keys/${keys[0]!.id}`, {
      method: "DELETE",
      headers: { "x-vault-session": sessionToken },
    });
    expect(removed.status).toBe(409);
    // SAFETY: the error contract is { error: { code } }
    expect((await json<{ error: { code: string } }>(removed)).error.code).toBe("VAULT_LAST_RECOVERY_KEY");
    expect(h.manager.status().recoveryKeyCount).toBe(1);
  });

  it("resets the passphrase with a recovery key, no current passphrase needed (finding C4)", async () => {
    const h = harness(tempDir("dokan-vault-reset-"));
    const setup = await setupVault(h);
    // SAFETY: the setup contract carries the recovery key
    const { recoveryKey } = await json<{ recoveryKey: string }>(setup);
    h.manager.close();

    const reset = await h.gate.request("/api/vault/reset-passphrase", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ recoveryKey, newPassphrase: "a brand new passphrase" }),
    });
    expect(reset.status).toBe(200);
    h.manager.close();
    const old = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(old.status).toBe(401);
    const fresh = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "a brand new passphrase" }),
    });
    expect(fresh.status).toBe(200);
    h.manager.close();
    const recovered = await h.gate.request("/api/vault/unlock-recovery", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ recoveryKey }),
    });
    expect(recovered.status).toBe(200);
  });

  it("throttles credential changes, returns retryAfterMs, and rotates the session (findings C13/A14)", async () => {
    const h = harness(tempDir("dokan-vault-throttle-"));
    const setup = await setupVault(h);
    // SAFETY: the setup contract carries the session token
    const { sessionToken } = await json<{ sessionToken: string }>(setup);

    // a successful change rotates the token: the old one dies, the new works
    const changed = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vault-session": sessionToken },
      body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "a brand new passphrase" }),
    });
    expect(changed.status).toBe(200);
    // SAFETY: the change contract carries the fresh session token
    const rotated = (await json<{ sessionToken: string }>(changed)).sessionToken;
    expect(rotated).not.toBe(sessionToken);
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: { "x-vault-session": sessionToken } })).status).toBe(401);
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: { "x-vault-session": rotated } })).status).toBe(200);

    // wrong current passphrases feed the same persisted backoff
    let lastStatus = 0;
    let retryAfterMs = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await h.gate.request("/api/vault/change-passphrase", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vault-session": rotated },
        body: JSON.stringify({ currentPassphrase: "wrong current", newPassphrase: "another new passphrase" }),
      });
      lastStatus = response.status;
      if (response.status === 429) {
        // SAFETY: the locked error contract is { error: { retryAfterMs } }
        retryAfterMs = (await json<{ error: { retryAfterMs?: number } }>(response)).error.retryAfterMs ?? 0;
        break;
      }
    }
    expect(lastStatus).toBe(429);
    expect(retryAfterMs).toBeGreaterThan(0);
  });

  it("does not mount better-auth routes in vault mode (finding C10)", async () => {
    const h = harness(tempDir("dokan-vault-no-auth-"));
    await setupVault(h);
    const signIn = await h.appFor().request("/api/auth/sign-in/username", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ username: "213550123123", password: "dokan-1234" }),
    });
    expect(signIn.status).toBe(404);
  });

  it("hides the recovery-key inventory while locked", async () => {
    const h = harness(tempDir("dokan-vault-status-"));
    await setupVault(h);
    h.manager.close();
    const status = await json<{ recoveryKeyCount: number; state: string }>(await h.gate.request("/api/vault/status"));
    expect(status.state).toBe("locked");
    expect(status.recoveryKeyCount).toBe(0);
  });

  it("reports the cleanup result on setup and resumes a pending setup whose header write failed (findings 2 and 3)", async () => {
    const dir = tempDir("dokan-vault-resume-");
    const h = harness(dir);
    // simulate the crash window: the first attempt prepared the vault, bootstrapped
    // (snapshot written), then died before committing the header
    const { recoveryKey } = await h.manager.prepareSetup("correct horse battery");
    fs.writeFileSync(h.manager.snapshotPath, "placeholder-snapshot");
    h.manager.finishSetupBootstrap();

    const retry = await setupVault(h);
    expect(retry.status).toBe(200);
    // SAFETY: the setup contract carries the recovery key and the cleanup list
    const body = await json<{ recoveryKey: string; plaintextRemaining: string[] }>(retry);
    // the pending recovery key is returned again and the header is committed
    expect(body.recoveryKey).toBe(recoveryKey);
    expect(body.plaintextRemaining).toEqual([]);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
    expect(h.manager.pendingRecoveryKey()).toBeUndefined();
  });

  it("refuses to resume a pending setup for a DIFFERENT passphrase (round-4 security)", async () => {
    const dir = tempDir("dokan-vault-resume-auth-");
    const h = harness(dir);
    // simulate the crash window: snapshot written, header uncommitted
    const { recoveryKey } = await h.manager.prepareSetup("correct horse battery");
    fs.writeFileSync(h.manager.snapshotPath, "placeholder-snapshot");
    h.manager.finishSetupBootstrap();

    // a second caller with any other passphrase must get neither the recovery
    // key nor a session token
    const intruder = await setupVault(h, "another long passphrase");
    expect(intruder.status).toBe(401);
    // SAFETY: the error contract is { error: { code } }
    const intruderBody = await json<{ error: { code: string } }>(intruder);
    expect(intruderBody.error.code).toBe("VAULT_WRONG_PASSPHRASE");
    expect(JSON.stringify(intruderBody)).not.toContain(recoveryKey);
    // the pending setup is untouched
    expect(h.manager.pendingRecoveryKey()).toBe(recoveryKey);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(false);

    // the original passphrase still resumes and receives the token
    const owner = await setupVault(h, "correct horse battery");
    expect(owner.status).toBe(200);
    // SAFETY: the setup contract carries the recovery key and the session token
    const ownerBody = await json<{ recoveryKey: string; sessionToken: string }>(owner);
    expect(ownerBody.recoveryKey).toBe(recoveryKey);
    expect(ownerBody.sessionToken.length).toBeGreaterThan(20);
  });

  it("surfaces plaintext files that could not be removed instead of silently succeeding", async () => {
    const dir = tempDir("dokan-vault-remaining-");
    const h = harness(dir, {
      onSetupCommitted: async () => ({ plaintextRemaining: ["C:/data/dokan.db"] }),
    });
    const setup = await setupVault(h);
    expect(setup.status).toBe(200);
    // SAFETY: the setup contract carries the cleanup list
    const body = await json<{ plaintextRemaining: string[] }>(setup);
    expect(body.plaintextRemaining).toEqual(["C:/data/dokan.db"]);
  });

  it("revokes the in-process session on logout (finding 4)", async () => {
    const h = harness(tempDir("dokan-vault-logout-"));
    const setup = await setupVault(h);
    // SAFETY: the setup contract carries the session token
    const { sessionToken } = await json<{ sessionToken: string }>(setup);
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: { "x-vault-session": sessionToken } })).status).toBe(200);

    const logout = await h.gate.request("/api/vault/logout", {
      method: "POST",
      headers: { "x-vault-session": sessionToken },
    });
    expect(logout.status).toBe(200);
    // a copied token is dead: the unlocked process no longer accepts it
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: { "x-vault-session": sessionToken } })).status).toBe(401);
    // the client can unlock again and receive a fresh token
    h.manager.close();
    expect((await setupVault(h, "another passphrase")).status).toBe(409); // already configured
    const unlock = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(unlock.status).toBe(200);
  });

  it("keeps first-run setup retryable when the bootstrap fails after the snapshot landed (round-7 finding 1)", async () => {
    const dir = tempDir("dokan-vault-bootstrap-fail-");
    let releaseBootstrap: (() => void) | undefined;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    let bootstrapCalls = 0;
    const h = harness(dir, {
      bootstrap: async () => {
        bootstrapCalls += 1;
        // bootstrapVault flushes the snapshot before the app build can fail
        fs.writeFileSync(path.join(dir, "dokan.db.enc"), "placeholder-snapshot");
        if (bootstrapCalls === 1) {
          await bootstrapGate;
          throw new Error("app build failed after the snapshot");
        }
      },
    });
    const startSetup = async (): Promise<Response> =>
      h.gate.request("/api/vault/setup", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ passphrase: "correct horse battery" }),
      });
    const first = startSetup();
    for (let attempt = 0; attempt < 200 && !fs.existsSync(path.join(dir, "dokan.db.enc")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // a second setup must not commit (and hand out the recovery key) while the
    // first app is still bootstrapping
    const second = await startSetup();
    expect(second.status).toBe(409);
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("VAULT_SETUP_IN_PROGRESS");
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(false);

    // the bootstrap fails: nothing was committed and the install stays retryable
    releaseBootstrap?.();
    expect((await first).status).toBe(500);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(false);
    const retry = await startSetup();
    expect(retry.status).toBe(200);
    const retryBody = await json<{ recoveryKey: string; sessionToken: string }>(retry);
    expect(retryBody.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
  });

  it("refuses credential routes from a non-loopback peer through the REAL overlay, and fails closed on an unknown peer (round-8 finding 1)", async () => {
    const h = harness(tempDir("dokan-vault-loopback-"));
    // the same overlay main.ts serves: it must forward the server socket env,
    // not just the raw Request
    const overlay = createOverlay({
      config: h.config,
      api: undefined,
      lockedApiHandler: () => Response.json({ error: { code: "VAULT_NOT_UNLOCKED" } }, { status: 503 }),
      vaultApp: h.gateApp,
      vaultState: () => "unconfigured",
      webIndex: undefined,
    });
    const setupRequest = (): Request =>
      new Request("http://127.0.0.1/api/vault/setup", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ passphrase: "correct horse battery" }),
      });
    const remote = await overlay(setupRequest(), { incoming: { socket: { remoteAddress: "192.168.1.50" } } });
    expect(remote.status).toBe(403);
    expect((await json<{ error: { code: string } }>(remote)).error.code).toBe("VAULT_LOOPBACK_REQUIRED");
    // FAIL CLOSED: a peer the overlay could not observe is not trusted either
    const unknown = await overlay(setupRequest());
    expect(unknown.status).toBe(403);
    expect((await json<{ error: { code: string } }>(unknown)).error.code).toBe("VAULT_LOOPBACK_REQUIRED");
    // no refusal wrote any vault file, and status (no secret) stays reachable
    expect(fs.existsSync(path.join(h.dir, "vault", "vault.json"))).toBe(false);
    expect((await overlay(new Request("http://127.0.0.1/api/vault/status"), { incoming: { socket: { remoteAddress: "192.168.1.50" } } })).status).toBe(
      200,
    );
    // loopback through the same overlay still reaches first-run setup
    const local = await overlay(setupRequest(), { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(local.status).toBe(200);
  });

  it("refuses HTTP pre-boot credential routes in broker mode; post-unlock routes stay HTTP (issue #141)", async () => {
    const h = harness(tempDir("dokan-vault-broker-mode-"), { broker: true });
    // SAFETY: the status route contract carries the broker flag
    const status = await json<{ broker: boolean }>(await h.gate.request("/api/vault/status"));
    expect(status.broker).toBe(true);

    for (const route of ["/api/vault/setup", "/api/vault/unlock", "/api/vault/unlock-recovery", "/api/vault/reset-passphrase"]) {
      const response = await h.gate.request(route, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ passphrase: "correct horse battery", recoveryKey: "AAAA-AAAA", newPassphrase: "another long passphrase" }),
      });
      expect(response.status).toBe(403);
      // SAFETY: the error contract is { error: { code } }
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe("VAULT_BROKER_REQUIRED");
    }
    // none of the refusals created a vault
    expect(fs.existsSync(path.join(h.dir, "vault", "vault.json"))).toBe(false);

    // post-unlock credential routes stay HTTP: authenticated and already open
    await h.manager.prepareSetup("correct horse battery");
    h.manager.finishSetupBootstrap();
    const session = await h.manager.commitSetup();
    const changed = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { ...jsonHeaders, "x-vault-session": session.token },
      body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "another long passphrase" }),
    });
    expect(changed.status).toBe(200);
  });

  it("returns an increasing session generation on credential rotations (round-7 finding 5)", async () => {
    const h = harness(tempDir("dokan-vault-generation-"));
    const setup = await setupVault(h);
    // SAFETY: the setup contract carries the session token
    const { sessionToken } = await json<{ sessionToken: string }>(setup);
    const first = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { ...jsonHeaders, "x-vault-session": sessionToken },
      body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "another long passphrase" }),
    });
    expect(first.status).toBe(200);
    // SAFETY: the rotation contract carries a token and its generation
    const firstBody = await json<{ sessionToken: string; sessionGeneration: number }>(first);
    const second = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { ...jsonHeaders, "x-vault-session": firstBody.sessionToken },
      body: JSON.stringify({ currentPassphrase: "another long passphrase", newPassphrase: "a third long passphrase" }),
    });
    expect(second.status).toBe(200);
    // SAFETY: the rotation contract carries a token and its generation
    const secondBody = await json<{ sessionToken: string; sessionGeneration: number }>(second);
    expect(secondBody.sessionGeneration).toBeGreaterThan(firstBody.sessionGeneration);
    // the newest generation corresponds to the server's live token
    expect(h.manager.sessionMatches(secondBody.sessionToken)).toBe(true);
  });

  it("never reports a generation newer than the token it returns when a rotation lands during the delete refresh (round-8 finding 2)", async () => {
    const holder: ManagerHolder = {};
    const h = harness(tempDir("dokan-vault-rotation-gap-delete-"), {
      afterCredentialChange: async () => {
        // another client rotates while THIS delete response awaits the refresh
        await holder.manager?.changePassphrase("correct horse battery", "rotated during refresh");
      },
    });
    holder.manager = h.manager;
    const setup = await setupVault(h);
    // SAFETY: the setup contract carries the session token
    const { sessionToken } = await json<{ sessionToken: string }>(setup);
    // add the second key directly, so the hook fires only for the delete
    const added = await h.manager.addRecoveryKey();
    const before = h.manager.sessionEpoch();

    const removed = await h.gate.request(`/api/vault/recovery-keys/${added.id}`, {
      method: "DELETE",
      headers: { "x-vault-session": sessionToken },
    });
    expect(removed.status).toBe(200);
    // SAFETY: the rotation contract carries a token and its generation
    const body = await json<{ sessionToken: string; sessionGeneration: number }>(removed);
    // the delete rotated to before+1; the interleaved change rotated to before+2
    expect(h.manager.sessionEpoch()).toBe(before + 2);
    // the response must carry ITS OWN generation, never the newer one
    expect(body.sessionGeneration).toBe(before + 1);
    expect(h.manager.sessionMatches(body.sessionToken)).toBe(false);
  });

  it("never reports a generation newer than the token it returns when a rotation lands during the reset refresh (round-8 finding 2)", async () => {
    const holder: ManagerHolder = {};
    const h = harness(tempDir("dokan-vault-rotation-gap-reset-"), {
      afterCredentialChange: async () => {
        // the reset already set "reset passphrase"; another client rotates again
        await holder.manager?.changePassphrase("reset passphrase", "rotated during refresh");
      },
    });
    holder.manager = h.manager;
    const setup = await setupVault(h);
    // SAFETY: the setup contract carries the recovery key
    const { recoveryKey } = await json<{ recoveryKey: string }>(setup);
    const before = h.manager.sessionEpoch();

    const reset = await h.gate.request("/api/vault/reset-passphrase", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ recoveryKey, newPassphrase: "reset passphrase" }),
    });
    expect(reset.status).toBe(200);
    // SAFETY: the rotation contract carries a token and its generation
    const body = await json<{ sessionToken: string; sessionGeneration: number }>(reset);
    expect(h.manager.sessionEpoch()).toBe(before + 2);
    expect(body.sessionGeneration).toBe(before + 1);
    expect(h.manager.sessionMatches(body.sessionToken)).toBe(false);
  });

  it("refuses a stale backup after a credential change and restores the refreshed one with the new passphrase (round-7 finding 3)", async () => {
    let refreshes = 0;
    const h = harness(tempDir("dokan-vault-backup-refresh-"), {
      afterCredentialChange: async () => {
        refreshes += 1;
      },
    });
    const setup = await setupVault(h);
    // SAFETY: the setup contract carries the session token
    const { sessionToken } = await json<{ sessionToken: string }>(setup);
    const backupPath = path.join(h.dir, "backups", "dokan-2026-01-01.db");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    await h.connection().writeBackupTo(backupPath);
    expect(h.connection().validateSnapshotFile(backupPath)).toBe(true);

    const changed = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { ...jsonHeaders, "x-vault-session": sessionToken },
      body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "a brand new passphrase" }),
    });
    expect(changed.status).toBe(200);
    expect(refreshes).toBe(1);
    // the embedded header still has the OLD passphrase wrap: refused, so the
    // daily pass rebuilds today's file instead of trusting an unopenable copy
    expect(h.connection().validateSnapshotFile(backupPath)).toBe(false);
    await h.connection().writeBackupTo(backupPath);
    expect(h.connection().validateSnapshotFile(backupPath)).toBe(true);

    // restore on a fresh dir and unlock with the NEW passphrase
    const restoreDir = tempDir("dokan-vault-backup-restore-");
    await extractVaultBackup(fs.readFileSync(backupPath), restoreDir);
    const restored = new VaultManager({
      dataDir: restoreDir,
      legacyDbPath: path.join(restoreDir, "dokan.db"),
      logger: new AppLogger(restoreDir),
      kdf: FAST_KDF,
    });
    const restoredSession = await restored.unlock("a brand new passphrase");
    expect(restored.sessionMatches(restoredSession.token)).toBe(true);
    await expect(restored.unlock("correct horse battery")).rejects.toThrow(VaultAuthenticationError);
    restored.close();
  });
});

