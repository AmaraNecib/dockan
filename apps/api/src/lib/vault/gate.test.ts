import { afterEach, describe, expect } from "bun:test";
import { itHeavy } from "../../test-support/heavy";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { serve } from "@hono/node-server";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { DokanClient } from "@dokan/contracts";
import { AUTH_REFUSAL } from "@dokan/contracts";

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
import { createVaultHttpApp, type VaultBootstrapInput, type VaultCleanupResult } from "./http";
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
  /**
   * Bootstrap the app the way an unlock does, for the tests that need a live
   * RPC router without going through an HTTP unlock — the broker mode refuses
   * the pre-boot routes, so its manager is driven directly (issue #141).
   */
  bootstrapApp: (input: VaultBootstrapInput) => Promise<void>;
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
    bootstrapApp: bootstrap,
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

/**
 * The vault session token, read from the cookie the browser path hands it in
 * (#319). The unlock/setup response body no longer carries the token, so a
 * test that needs one reads it here and presents it as the header a
 * non-browser client would use.
 */
function sessionTokenFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("the response carries no session cookie");
  const match = /(?:^|;\s*)dokan\.vault\.session=([^;]+)/u.exec(setCookie);
  if (match === null || match[1] === undefined) throw new Error(`no session cookie in ${setCookie}`);
  return match[1];
}

/** Late-bound handle so an afterCredentialChange hook can rotate mid-request. */
type ManagerHolder = { manager?: VaultManager };
describe("vault HTTP gate", () => {
  itHeavy("walks first run: unconfigured → setup → recovery key → owner setup → guarded RPC", async () => {
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
    // SAFETY: the setup contract is { ok: true, recoveryKey }: the token rides
    // the cookie, never the body (issue #319)
    const setupBody = await json<{ ok: boolean; recoveryKey: string }>(setup);
    const setupToken = sessionTokenFrom(setup);
    expect(setupBody.ok).toBe(true);
    expect(setupBody.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(setupBody).not.toHaveProperty("sessionToken");
    expect(fs.existsSync(path.join(h.dir, "vault", "vault.json"))).toBe(true);
    expect(fs.existsSync(path.join(h.dir, "dokan.db.enc"))).toBe(true);

    // no session header: guarded procedures refuse even while unlocked
    const unauthed = h.linkWith({});
    await expect(unauthed.categoriesList()).rejects.toThrow();

    // owner setup in vault mode sends no password
    const provisioned = h.linkWith({ "x-vault-session": setupToken });
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

  itHeavy("refuses a non-JSON pre-auth request (cross-site POST) without consuming an attempt", async () => {
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

  itHeavy("still returns the recovery key when post-commit plaintext cleanup fails", async () => {
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

  itHeavy("refuses a wrong passphrase with Arabic copy and never corrupts the vault", async () => {
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

  itHeavy("migrates a legacy plaintext database, preserving the schema version, and removes the plaintext files", async () => {
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

  itHeavy("decrypts a copied data folder on a fresh machine (portability)", async () => {
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

  itHeavy("adds, lists, and removes recovery keys while unlocked; change-passphrase keeps recovery valid", async () => {
    const h = harness(tempDir("dokan-vault-rotate-"));
    const setup = await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    // the browser path carries the credential in an HttpOnly cookie (#319)
    const sessionToken = sessionTokenFrom(setup);
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
    // from the cookie the rotation handed back
    const rotatedHeaders = { "content-type": "application/json", "x-vault-session": sessionTokenFrom(removed) };

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

  itHeavy("validates the NORMALIZED passphrase (finding: eight spaces is empty)", async () => {
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

  itHeavy("keeps first-run setup single-flight (finding: concurrent setups mixing keys)", async () => {
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

  itHeavy("refuses a torn or damaged snapshot as corruption, never as a wrong passphrase", async () => {
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

  itHeavy("refuses a missing snapshot instead of fabricating an empty shop", async () => {
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

  itHeavy("refuses to delete the last recovery key (finding C8)", async () => {
    const h = harness(tempDir("dokan-vault-lastkey-"));
    const setup = await setupVault(h);
    // the browser path carries the credential in an HttpOnly cookie (#319)
    const sessionToken = sessionTokenFrom(setup);
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

  itHeavy("resets the passphrase with a recovery key, no current passphrase needed (finding C4)", async () => {
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

  itHeavy("throttles credential changes, returns retryAfterMs, and rotates the session (findings C13/A14)", async () => {
    const h = harness(tempDir("dokan-vault-throttle-"));
    const setup = await setupVault(h);
    // the browser path carries the credential in an HttpOnly cookie (#319)
    const sessionToken = sessionTokenFrom(setup);

    // a successful change rotates the token: the old one dies, the new works
    const changed = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vault-session": sessionToken },
      body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "a brand new passphrase" }),
    });
    expect(changed.status).toBe(200);
    // the change rotates the session; the fresh token rides the cookie
    const rotated = sessionTokenFrom(changed);
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

  itHeavy("does not mount better-auth routes in vault mode (finding C10)", async () => {
    const h = harness(tempDir("dokan-vault-no-auth-"));
    await setupVault(h);
    const signIn = await h.appFor().request("/api/auth/sign-in/username", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ username: "213550123123", password: "dokan-1234" }),
    });
    expect(signIn.status).toBe(404);
  });

  itHeavy("hides the recovery-key inventory while locked", async () => {
    const h = harness(tempDir("dokan-vault-status-"));
    await setupVault(h);
    h.manager.close();
    const status = await json<{ recoveryKeyCount: number; state: string }>(await h.gate.request("/api/vault/status"));
    expect(status.state).toBe("locked");
    expect(status.recoveryKeyCount).toBe(0);
  });

  itHeavy("reports the cleanup result on setup and resumes a pending setup whose header write failed (findings 2 and 3)", async () => {
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

  itHeavy("refuses to resume a pending setup for a DIFFERENT passphrase (round-4 security)", async () => {
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
    // SAFETY: the setup contract carries the recovery key
    const ownerBody = await json<{ recoveryKey: string }>(owner);
    expect(ownerBody.recoveryKey).toBe(recoveryKey);
    expect(sessionTokenFrom(owner).length).toBeGreaterThan(20);
  });

  itHeavy("surfaces plaintext files that could not be removed instead of silently succeeding", async () => {
    const dir = tempDir("dokan-vault-remaining-");
    const h = harness(dir, {
      onSetupCommitted: async () => ({ plaintextRemaining: ["C:/data/dokan.db"] }),
    });
    const setup = await setupVault(h);
    expect(setup.status).toBe(200);
    // SAFETY: the setup contract carries the cleanup list and its status
    const body = await json<{ plaintextStatus?: string; plaintextRemaining: string[] }>(setup);
    expect(body.plaintextStatus).toBe("remaining");
    expect(body.plaintextRemaining).toEqual(["C:/data/dokan.db"]);
  });

  itHeavy("reports UNKNOWN when the HTTP cleanup throws instead of a clean empty list (round-4 finding)", async () => {
    const h = harness(tempDir("dokan-vault-cleanup-unknown-"), {
      onSetupCommitted: async () => {
        throw new Error("cleanup exploded");
      },
    });
    const setup = await setupVault(h);
    // the committed setup still succeeds and the key is returned
    expect(setup.status).toBe(200);
    // SAFETY: the setup contract carries the cleanup list and its status
    const body = await json<{ plaintextStatus?: string; plaintextRemaining?: string[]; recoveryKey?: string }>(setup);
    expect(body.plaintextStatus).toBe("unknown");
    expect(body.plaintextRemaining).toEqual([]);
    expect(body.recoveryKey).toBeDefined();
  });

  itHeavy("revokes the in-process session on logout (finding 4)", async () => {
    const h = harness(tempDir("dokan-vault-logout-"));
    const setup = await setupVault(h);
    // the browser path carries the credential in an HttpOnly cookie (#319)
    const sessionToken = sessionTokenFrom(setup);
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: { "x-vault-session": sessionToken } })).status).toBe(200);

    const logout = await h.gate.request("/api/vault/logout", {
      method: "POST",
      headers: { "x-vault-session": sessionToken },
    });
    expect(logout.status).toBe(200);
    // the browser path's credential is the cookie, and the page cannot clear an
    // HttpOnly cookie itself: the reply must do it, exactly (test-audit lens)
    const cleared = logout.headers.get("set-cookie");
    expect(cleared).not.toBeNull();
    expect(cleared).toContain("dokan.vault.session=;");
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Strict");
    expect(cleared).not.toContain("Domain");
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

  itHeavy("keeps first-run setup retryable when the bootstrap fails after the snapshot landed (round-7 finding 1)", async () => {
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
    const retryBody = await json<{ recoveryKey: string }>(retry);
    expect(retryBody.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
  });

  itHeavy("refuses credential routes from a non-loopback peer through the REAL overlay, and fails closed on an unknown peer (round-8 finding 1)", async () => {
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

  itHeavy("refuses HTTP pre-boot credential routes in broker mode; post-unlock routes stay HTTP (issue #141)", async () => {
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

  /**
   * Two windows changing the passphrase at once (round-4 test-audit). The
   * sequential rotation above pins the ORDER; nothing pinned what two CONCURRENT
   * rewrites do, and a passphrase rewrite is not the same mutation as a mint:
   * the second one's `currentPassphrase` is the one the first just replaced.
   *
   * What must hold: exactly one rewrite lands, the other is refused rather than
   * applied to a vault it no longer describes, and the vault afterwards accepts
   * exactly ONE of the two new passphrases — never both, never neither.
   */
  itHeavy("authorises exactly one of two racing passphrase rewrites, and leaves one passphrase working", async () => {
    const h = harness(tempDir("dokan-vault-racing-change-"));
    const setup = await setupVault(h);
    const token = sessionTokenFrom(setup);
    const rewrite = async (newPassphrase: string): Promise<Response> =>
      await h.gate.request("/api/vault/change-passphrase", {
        method: "POST",
        headers: { ...jsonHeaders, "x-vault-session": token },
        body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase }),
      });

    const [first, second] = await Promise.all([rewrite("window one passphrase"), rewrite("window two passphrase")]);
    const replies = [first, second];
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
    const refused = replies.filter((reply) => reply.status !== 200);
    expect(refused).toHaveLength(1);
    // Either the loser's CURRENT passphrase was already gone, or its session
    // token was: both are the same answer to "this world moved under you", and
    // neither applies the rewrite.
    // SAFETY: the error contract is { error: { code } }
    const code = (await json<{ error: { code: string } }>(refused[0] as Response)).error.code;
    expect(["VAULT_NOT_UNLOCKED", "VAULT_WRONG_PASSPHRASE"]).toContain(code);

    // the vault accepts exactly one of the two new passphrases
    h.manager.close();
    const accepts = async (passphrase: string): Promise<boolean> =>
      (
        await h.gate.request("/api/vault/unlock", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ passphrase }),
        })
      ).status === 200;
    const one = await accepts("window one passphrase");
    const two = await accepts("window two passphrase");
    expect([one, two].filter(Boolean)).toHaveLength(1);
  });

  itHeavy("returns an increasing session generation on credential rotations (round-7 finding 5)", async () => {
    const h = harness(tempDir("dokan-vault-generation-"));
    const setup = await setupVault(h);
    // the browser path carries the credential in an HttpOnly cookie (#319)
    const sessionToken = sessionTokenFrom(setup);
    const first = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { ...jsonHeaders, "x-vault-session": sessionToken },
      body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "another long passphrase" }),
    });
    expect(first.status).toBe(200);
    // SAFETY: the rotation contract carries the generation; the token rides the cookie
    const firstBody = await json<{ sessionGeneration: number }>(first);
    const firstToken = sessionTokenFrom(first);
    const second = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { ...jsonHeaders, "x-vault-session": firstToken },
      body: JSON.stringify({ currentPassphrase: "another long passphrase", newPassphrase: "a third long passphrase" }),
    });
    expect(second.status).toBe(200);
    // SAFETY: the rotation contract carries the generation; the token rides the cookie
    const secondBody = await json<{ sessionGeneration: number }>(second);
    expect(secondBody.sessionGeneration).toBeGreaterThan(firstBody.sessionGeneration);
    // the newest generation corresponds to the server's live token
    expect(h.manager.sessionMatches(sessionTokenFrom(second))).toBe(true);
  });

  itHeavy("installs NO credential when a rotation lands during the delete refresh (round-8 finding 2, greptile P1)", async () => {
    const holder: ManagerHolder = {};
    const h = harness(tempDir("dokan-vault-rotation-gap-delete-"), {
      afterCredentialChange: async () => {
        // another client rotates while THIS delete response awaits the refresh
        await holder.manager?.changePassphrase("correct horse battery", "rotated during refresh");
      },
    });
    holder.manager = h.manager;
    const setup = await setupVault(h);
    // the browser path carries the credential in an HttpOnly cookie (#319)
    const sessionToken = sessionTokenFrom(setup);
    // add the second key directly, so the hook fires only for the delete
    const added = await h.manager.addRecoveryKey();
    const before = h.manager.sessionEpoch();

    const removed = await h.gate.request(`/api/vault/recovery-keys/${added.id}`, {
      method: "DELETE",
      headers: { "x-vault-session": sessionToken },
    });
    expect(removed.status).toBe(200);
    // SAFETY: the rotation contract carries the generation
    const body = await json<{ sessionGeneration: number }>(removed);
    // the delete rotated to before+1; the interleaved change rotated to before+2
    expect(h.manager.sessionEpoch()).toBe(before + 2);
    // The reply must install NOTHING: its own token is dead, and a Set-Cookie
    // carrying it would overwrite whatever the window that rotated holds. The
    // generation it reports is the one in force, never its own dead one.
    expect(removed.headers.get("set-cookie")).toBeNull();
    expect(body.sessionGeneration).toBe(before + 2);
  });

  itHeavy("installs NO credential when a rotation lands during the reset refresh (round-8 finding 2, greptile P1)", async () => {
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryKey, newPassphrase: "reset passphrase" }),
    });
    expect(reset.status).toBe(200);
    // SAFETY: the rotation contract carries the generation
    const body = await json<{ sessionGeneration: number }>(reset);
    expect(h.manager.sessionEpoch()).toBe(before + 2);
    expect(reset.headers.get("set-cookie")).toBeNull();
    expect(body.sessionGeneration).toBe(before + 2);
  });

  itHeavy("refuses a stale backup after a credential change and restores the refreshed one with the new passphrase (round-7 finding 3)", async () => {
    let refreshes = 0;
    const h = harness(tempDir("dokan-vault-backup-refresh-"), {
      afterCredentialChange: async () => {
        refreshes += 1;
      },
    });
    const setup = await setupVault(h);
    // the browser path carries the credential in an HttpOnly cookie (#319)
    const sessionToken = sessionTokenFrom(setup);
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


/**
 * One browser, several windows (#319).
 *
 * The vault session is ONE live token on the API and the browser path carries
 * it in an HttpOnly cookie. A cookie jar belongs to the browser, not the
 * window, so the second window presents the same credential instead of needing
 * an unlock of its own — and a jar that does not hold the live token gets a
 * refusal that names the vault, not a generic failure.
 */
type Jar = { cookie: string };

describe("one unlocked vault shared between windows (#319)", () => {
  const jsonHeaders = { "content-type": "application/json" };

  /** Create the vault over the gate, as the first window's owner would. */
  async function setupVault(h: GateHarness, passphrase = "correct horse battery"): Promise<Response> {
    return await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase }),
    });
  }

  /** The cookie a browser would attach after the unlock reply set it. */
  function jarWith(token: string): Jar {
    return { cookie: `dokan.vault.session=${token}` };
  }

  itHeavy("serves a second window from the same jar without a second unlock", async () => {
    const h = harness(tempDir("dokan-vault-two-windows-"));
    const setup = await setupVault(h);
    expect(setup.status).toBe(200);
    const token = sessionTokenFrom(setup);
    // the owner row is what the RPC guard signs in; vault mode needs no password
    await h.linkWith(jarWith(token)).firstTimeSetup({ ownerName: "مالك", phoneNumber: "0550123123", storeName: "متجر" });

    // window A: the window that unlocked, making its own call
    const windowA = h.linkWith(jarWith(token));
    expect((await windowA.categoriesList()).items.length).toBeGreaterThan(0);

    // window B: opened later, never unlocked, holding only the shared jar
    const windowB = h.linkWith(jarWith(token));
    const categories = await windowB.categoriesList();
    expect(categories.items.some((category) => category.name === "عام")).toBe(true);

    // the vault routes agree: the same cookie reads what the unlock authorised
    const keys = await h.gate.request("/api/vault/recovery-keys", { headers: jarWith(token) });
    expect(keys.status).toBe(200);
  });

  itHeavy("refuses a jar that does not hold the live session, and names the vault", async () => {
    const h = harness(tempDir("dokan-vault-foreign-jar-"));
    expect((await setupVault(h)).status).toBe(200);

    // a different token: refused as "not unlocked", never a generic failure
    const wrong = await h.gate.request("/api/vault/recovery-keys", { headers: jarWith("not-the-live-token") });
    expect(wrong.status).toBe(401);
    // SAFETY: the error contract is { error: { code } }: stable code, no copy
    expect((await json<{ error: { code: string } }>(wrong)).error.code).toBe("VAULT_NOT_UNLOCKED");

    // no token at all: the same answer, through the same route
    const none = await h.gate.request("/api/vault/recovery-keys");
    expect(none.status).toBe(401);
    // SAFETY: the error contract is { error: { code } }
    expect((await json<{ error: { code: string } }>(none)).error.code).toBe("VAULT_NOT_UNLOCKED");

    // and the RPC guard says the same thing in its own dialect, which is what
    // the web maps back to the unlock screen. Read from the contract, not a
    // copy: the pair is exported precisely so a rename cannot pass here
    const stranger = h.linkWith(jarWith("not-the-live-token"));
    await expect(stranger.categoriesList()).rejects.toThrow(AUTH_REFUSAL.message);
  });

  itHeavy("refuses a foreign-origin request: it neither reads nor unlocks", async () => {
    const h = harness(tempDir("dokan-vault-foreign-origin-"));
    const foreign = { origin: "https://evil.example" };
    // a cross-origin setup does not create a vault
    const setup = await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: { ...jsonHeaders, ...foreign },
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(setup.status).toBe(403);
    // SAFETY: the error contract is { error: { code } }
    // one rule, one code: a foreign origin is VAULT_ORIGIN_FORBIDDEN here and
    // at the RPC seam. VAULT_LOOPBACK_REQUIRED answers the other question (the
    // peer is not loopback), and this peer IS loopback, so the old code told
    // the owner to open Dokan on a machine they were already on (#319 round 3).
    expect((await json<{ error: { code: string } }>(setup)).error.code).toBe("VAULT_ORIGIN_FORBIDDEN");
    expect(fs.existsSync(path.join(h.dir, "vault", "vault.json"))).toBe(false);

    const owner = await setupVault(h);
    expect(owner.status).toBe(200);
    const token = sessionTokenFrom(owner);

    // a cross-origin read with the cookie: refused, and no key is disclosed
    const read = await h.gate.request("/api/vault/recovery-keys", { headers: { ...jarWith(token), ...foreign } });
    expect(read.status).toBe(403);
    // SAFETY: the error contract is { error: { code } }
    const readBody = await json<{ error: { code: string }; keys?: unknown }>(read);
    expect(readBody.error.code).toBe("VAULT_ORIGIN_FORBIDDEN");
    expect(readBody.keys).toBeUndefined();

    // a cross-origin write with the cookie changes nothing: the passphrase it
    // named is not the one that opens the vault
    const write = await h.gate.request("/api/vault/change-passphrase", {
      method: "POST",
      headers: { ...jsonHeaders, ...jarWith(token), ...foreign },
      body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "an attacker passphrase" }),
    });
    expect(write.status).toBe(403);
    expect(
      (await h.gate.request("/api/vault/change-passphrase", {
        method: "POST",
        headers: { ...jsonHeaders, ...jarWith(token) },
        body: JSON.stringify({ currentPassphrase: "correct horse battery", newPassphrase: "a brand new passphrase" }),
      })).status,
    ).toBe(200);
  });

  itHeavy("a copied token outlives neither the next unlock nor the lock", async () => {
    const h = harness(tempDir("dokan-vault-stolen-token-"));
    const setup = await setupVault(h);
    const stolen = sessionTokenFrom(setup);
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: jarWith(stolen) })).status).toBe(200);

    // another window unlocks: exactly one live token, and the old one dies
    const again = await h.gate.request("/api/vault/unlock", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(again.status).toBe(200);
    const live = sessionTokenFrom(again);
    expect(live).not.toBe(stolen);
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: jarWith(stolen) })).status).toBe(401);
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: jarWith(live) })).status).toBe(200);
    await expect(h.linkWith(jarWith(stolen)).categoriesList()).rejects.toThrow();

    // and the lock takes the live one with it
    h.manager.close();
    expect((await h.gate.request("/api/vault/recovery-keys", { headers: jarWith(live) })).status).toBe(401);
  });

  itHeavy("keeps the broker path unchanged: no cookie, and the pre-boot routes stay off HTTP", async () => {
    const h = harness(tempDir("dokan-vault-broker-mode-"), { broker: true });
    // the shell's pipe owns the pre-boot credential: HTTP refuses it, as before
    for (const [path, body] of [
      ["/api/vault/setup", { passphrase: "correct horse battery" }],
      ["/api/vault/unlock", { passphrase: "correct horse battery" }],
    ] as const) {
      const refused = await h.gate.request(path, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
      expect(refused.status).toBe(403);
      // SAFETY: the error contract is { error: { code } }
      expect((await json<{ error: { code: string } }>(refused)).error.code).toBe("VAULT_BROKER_REQUIRED");
      // broker mode never issues the browser path's credential
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
    // the gate still tells the web which transport owns the secret
    // SAFETY: the status contract carries the broker flag
    expect((await json<{ broker: boolean }>(await h.gate.request("/api/vault/status"))).broker).toBe(true);
  });
});

/**
 * Round 2 — the origin rule, at both seams, and the refusal it produces.
 *
 * The loopback question was the hole (greptile P1): cookies ignore ports and
 * `SameSite` is scoped by site, so a page on ANY other loopback port was
 * same-site with the API and its `Origin` passed, letting one no-preflight
 * `POST` run an RPC as the owner. The rule is "is this OUR origin" now, and
 * these tests are the ones that can tell the two questions apart.
 */
describe("the origin gate at both seams (#319 round 2)", () => {
  const jsonHeaders = { "content-type": "application/json" };

  /** The app's own origin: the harness config binds port 4399. */
  const OWN_ORIGIN = "http://127.0.0.1:4399";

  function jarWith(token: string) {
    return { cookie: `dokan.vault.session=${token}` };
  }

  itHeavy("refuses a same-site page on ANOTHER PORT, which the loopback rule admitted", async () => {
    const h = harness(tempDir("dokan-vault-origin-other-port-"));
    const setup = await h.gate.request("http://127.0.0.1:4399/api/vault/setup", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(setup.status).toBe(200);
    const token = sessionTokenFrom(setup);

    // positive control: the app's own origin, on the port the request named
    const own = await h.gate.request("http://127.0.0.1:4399/api/vault/recovery-keys", {
      headers: { ...jarWith(token), origin: OWN_ORIGIN },
    });
    expect(own.status).toBe(200);

    // a different port on the same host is a different origin: same site, so
    // the browser attaches the live cookie, and only the origin rule stands
    // between that page and the vault
    for (const origin of ["http://127.0.0.1:9999", "http://localhost:9999", "http://evil.localhost:7777"]) {
      const other = await h.gate.request("http://127.0.0.1:4399/api/vault/recovery-keys", {
        headers: { ...jarWith(token), origin },
      });
      expect(other.status, origin).toBe(403);
      // SAFETY: the error contract is { error: { code } }
      expect((await json<{ error: { code: string } }>(other)).error.code, origin).toBe("VAULT_ORIGIN_FORBIDDEN");
    }

    // and the write path that mattered: no RPC runs as the owner from that page
    await expect(
      h.linkWith({ ...jarWith(token), origin: "http://127.0.0.1:9999" }).categoriesList(),
    ).rejects.toThrow("VAULT_ORIGIN_FORBIDDEN");
  });

  /**
   * The three shapes a future normalisation could quietly widen the gate into
   * accepting (round-4 test-audit). All three are refused today by accident of a
   * plain `host` comparison, and none of them had a test: a trailing dot is the
   * same DNS name and a different URL host, `null` is what a sandboxed iframe
   * sends, and case is the one direction that must NOT be refused for our own
   * origin. Pinned so a "helpful" normalisation has to argue with a test.
   */
  itHeavy("refuses a trailing-dot host, a null Origin, and a mixed-case host that is not ours", async () => {
    const h = harness(tempDir("dokan-vault-origin-edges-"));
    const setup = await h.gate.request("http://127.0.0.1:4399/api/vault/setup", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(setup.status).toBe(200);
    const token = sessionTokenFrom(setup);

    // the positive control: our own origin, spelled exactly, is accepted
    const own = await h.gate.request("http://127.0.0.1:4399/api/vault/recovery-keys", {
      headers: { ...jarWith(token), origin: OWN_ORIGIN },
    });
    expect(own.status).toBe(200);

    for (const origin of [
      // "localhost." is the same DNS name as "localhost" and a different URL
      // host: accepting it would be a normalisation nobody asked for
      "http://localhost.:4399",
      // a sandboxed iframe sends the literal string "null"; it is no origin at
      // all and must never read as ours
      "null",
      // a different host name entirely — case can never make two hosts equal
      "http://LOCALHOST:4399",
    ]) {
      const reply = await h.gate.request("http://127.0.0.1:4399/api/vault/recovery-keys", {
        headers: { ...jarWith(token), origin },
      });
      expect(reply.status, origin).toBe(403);
      // SAFETY: the error contract is { error: { code } }
      expect((await json<{ error: { code: string } }>(reply)).error.code, origin).toBe("VAULT_ORIGIN_FORBIDDEN");
    }

    // ... and the case-folding that IS meant to happen: a browser lowercases the
    // host in `Origin`, and a request ADDRESSED as `localhost` is the same
    // origin as `http://LOCALHOST:4399`
    const mixedCaseOwn = await h.gate.request("http://localhost:4399/api/vault/recovery-keys", {
      headers: { ...jarWith(token), origin: "http://LOCALHOST:4399" },
    });
    expect(mixedCaseOwn.status).toBe(200);
  });

  itHeavy("names the RPC-seam origin refusal instead of calling it a missing session (P3)", async () => {    const h = harness(tempDir("dokan-vault-rpc-origin-"));
    const setup = await h.gate.request("http://127.0.0.1:4399/api/vault/setup", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(setup.status).toBe(200);
    const token = sessionTokenFrom(setup);

    // positive control: the app's own origin is accepted at the RPC seam
    const own = await h.gate.request("http://127.0.0.1:4399/api/vault/recovery-keys", {
      headers: { ...jarWith(token), origin: OWN_ORIGIN },
    });
    expect(own.status).toBe(200);

    // the refusal the RPC seam emits carries its own stable code, not
    // `AUTH_REQUIRED`: the web must be able to tell a foreign origin from a
    // dead session
    const foreign = h.linkWith({ ...jarWith(token), origin: "https://evil.example" });
    await expect(foreign.categoriesList()).rejects.toThrow("VAULT_ORIGIN_FORBIDDEN");
  });
});

/**
 * Round 3 — the same gate with `Host` as the INPUT (test-audit P2).
 *
 * Every case above drives `app.request(absoluteUrl)`, so the only host
 * `addressedHost` ever parsed was one the test itself wrote into the URL. The
 * gate's whole claim is that it judges the host the CLIENT addressed, and only
 * a real listener can produce that: `@hono/node-server` builds `request.url`
 * from the incoming `Host` header (`newRequest` in its `request.js`). So these
 * tests bind the gate the api binds, on an ephemeral port, and speak HTTP/1.1
 * at it with each header spelled as the case needs. No session is involved:
 * `GET /api/vault/recovery-keys` runs the loopback peer check and the origin
 * gate before it looks for a credential, so the answer is 403 (refused) or 401
 * (same origin, no session).
 *
 * The three shapes here were unproven and load-bearing: a port-less loopback
 * origin against our own port, a Host the transport cannot parse (or none at
 * all), and the INERT direction of `x-forwarded-host` — the header must be
 * ignored, not merely tolerated while absent.
 *
 * What the malformed-Host case proves is the TRANSPORT, not the gate: both
 * requests answer 400 from `@hono/node-server` before the app runs, so the
 * gate's own `addressedHost() === undefined` arm is never reached through a
 * listener (a `Request` cannot be constructed with a URL that does not parse,
 * so that arm is defensive, not testable from here). The test is kept because
 * "an unstateable destination is not same-origin" is the promise the arm exists
 * for, and the name now says whose refusal it is (round-4 test-audit).
 */
describe("the origin gate with Host as the input (#319 round 3)", () => {
  type Listener = { port: number; close: () => void };

  /** Bind this harness's gate on an ephemeral loopback port, as main.ts does. */
  function listen(h: GateHarness): Promise<Listener> {
    return new Promise((resolve, reject) => {
      const server = serve(
        // `fetch(request, env)`, the shape main.ts uses for the real handler: the
        // server socket env rides along because the loopback peer guard reads it
        { fetch: (request, env) => h.gate.fetch(request, env), port: 0, hostname: "127.0.0.1" },
        (info) => resolve({ port: info.port, close: () => server.close() }),
      );
      server.on("error", reject);
    });
  }

  type RawReply = { status: number; body: string };

  /**
   * One HTTP/1.1 request with the headers written verbatim. `omitHost`
   * suppresses the header Node would otherwise add, which is how the absent-Host
   * case is produced; a supplied `host` value is sent exactly as written.
   */
  function raw(port: number, headers: Record<string, string>, omitHost = false): Promise<RawReply> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: "/api/vault/recovery-keys", method: "GET", headers, setHost: !omitHost },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      request.on("error", reject);
      request.end();
    });
  }

  /** The refusal code a body carries, or undefined when it is not a vault envelope. */
  function refusalCode(body: string): string | undefined {
    try {
      // SAFETY: the vault routes answer `{ error: { code } }` by contract; a
      // body that is not JSON throws into the catch below, and a JSON body with
      // no envelope reads as no code
      const parsed = JSON.parse(body) as { error?: { code?: string } };
      return parsed.error?.code;
    } catch {
      return undefined;
    }
  }

  itHeavy("refuses a port-less loopback Origin against our own port", async () => {
    const h = harness(tempDir("dokan-vault-origin-host-portless-"));
    const listener = await listen(h);
    try {
      // positive control: the full own origin is accepted, and the answer is the
      // missing session, not a refusal
      const own = await raw(listener.port, { host: `127.0.0.1:${listener.port}`, origin: `http://127.0.0.1:${listener.port}` });
      expect(own.status).toBe(401);
      expect(refusalCode(own.body)).toBe("VAULT_NOT_UNLOCKED");

      // `http://127.0.0.1` is a DIFFERENT origin from `http://127.0.0.1:PORT`: no
      // page can be served on a port nobody listens on, so an Origin with no port
      // is a foreign page, not this app
      for (const origin of ["http://127.0.0.1", "http://localhost:4399", "http://127.0.0.1:9999"]) {
        const reply = await raw(listener.port, { host: `127.0.0.1:${listener.port}`, origin });
        expect(reply.status, origin).toBe(403);
        expect(refusalCode(reply.body), origin).toBe("VAULT_ORIGIN_FORBIDDEN");
      }
      expect(fs.existsSync(path.join(h.dir, "vault", "vault.json"))).toBe(false);
    } finally {
      listener.close();
    }
  });

  itHeavy("the transport refuses an absent or unparseable Host before the gate sees it", async () => {
    const h = harness(tempDir("dokan-vault-origin-host-malformed-"));
    const listener = await listen(h);
    try {
      // No Host header at all: HTTP/1.1 has no destination to judge, and
      // `@hono/node-server` refuses it itself — 400 and no vault envelope. This
      // is the transport's refusal, not the gate's (see the describe above).
      const absent = await raw(listener.port, { origin: `http://127.0.0.1:${listener.port}` }, true);
      expect(absent.status).toBe(400);
      expect(refusalCode(absent.body)).toBeUndefined();

      // A Host a proxy concatenated onto the real one ("host:port, proxy"): also
      // refused by the transport, never parsed into a host the gate would bless
      const malformed = await raw(listener.port, {
        host: `127.0.0.1:${listener.port}, proxy`,
        origin: `http://127.0.0.1:${listener.port}`,
      });
      expect(malformed.status).toBe(400);
      expect(refusalCode(malformed.body)).toBeUndefined();

      // Neither refusal reached the gate, and neither wrote anything
      expect(fs.existsSync(path.join(h.dir, "vault", "vault.json"))).toBe(false);
    } finally {
      listener.close();
    }
  });

  itHeavy("ignores x-forwarded-host: our own origin passes with an attacker-set value", async () => {
    const h = harness(tempDir("dokan-vault-origin-host-forwarded-"));
    const listener = await listen(h);
    try {
      // the INERT direction. A gate that honoured this header would read the host
      // it was handed; on our own origin the same header must change nothing
      const inert = await raw(listener.port, {
        host: `127.0.0.1:${listener.port}`,
        origin: `http://127.0.0.1:${listener.port}`,
        "x-forwarded-host": "evil.example:4399",
      });
      expect(inert.status).toBe(401);
      expect(refusalCode(inert.body)).toBe("VAULT_NOT_UNLOCKED");

      // ... and it does not decide a refusal either: a foreign origin stays
      // foreign whatever the header claims, so the header is ignored rather than
      // merely harmless when absent
      const foreign = await raw(listener.port, {
        host: `127.0.0.1:${listener.port}`,
        origin: "http://evil.example:4399",
        "x-forwarded-host": `127.0.0.1:${listener.port}`,
      });
      expect(foreign.status).toBe(403);
      expect(refusalCode(foreign.body)).toBe("VAULT_ORIGIN_FORBIDDEN");
    } finally {
      listener.close();
    }
  });
});

/**
 * Round 2 — one live session, and the server as its arbiter.
 *
 * The browser applies a `Set-Cookie` whatever the page decided, so a minting
 * reply that was overtaken while it was in flight used to overwrite the LIVE
 * cookie with a revoked one: window A's slow delete reply landing after window
 * B's unlock signed every window out. The page's generation guard cannot reach
 * that, because it never sees the header.
 *
 * How the overtaking is produced here: the harness's `afterCredentialChange`
 * hook — which the delete route awaits BEFORE it builds its reply — calls
 * `manager.unlock` directly, so the second session is minted while the first
 * reply is still being built. That is the same interleaving a slow reply has,
 * without needing two HTTP clients. No cookie jar is applied anywhere in this
 * file: these tests read the `Set-Cookie` header the server produced and decide
 * from that. The client half — a real browser applying a late `Set-Cookie` — is
 * NOT covered; the server-side rule is what this file pins, and a browser cannot
 * be told a header it already applied is stale.
 */
describe("the server arbitrates the one live session (#319 round 2)", () => {
  const jsonHeaders = { "content-type": "application/json" };

  async function setupVault(h: GateHarness): Promise<Response> {
    return await h.gate.request("/api/vault/setup", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
  }

  itHeavy("drops the credential from a minting reply that another window overtook (greptile P1)", async () => {
    const holder: ManagerHolder = {};
    const h = harness(tempDir("dokan-vault-late-mint-"), {
      afterCredentialChange: async () => {
        // window B unlocks while THIS delete reply is still being built: the
        // hook runs after the rotation and before the reply is assembled
        await holder.manager?.unlock("correct horse battery");
      },
    });
    holder.manager = h.manager;
    const setup = await setupVault(h);
    const sessionToken = sessionTokenFrom(setup);
    const added = await h.manager.addRecoveryKey();
    const before = h.manager.sessionEpoch();

    const slow = await h.gate.request(`/api/vault/recovery-keys/${added.id}`, {
      method: "DELETE",
      headers: { "x-vault-session": sessionToken },
    });
    expect(slow.status).toBe(200);
    // the delete itself happened: the reply is not a failure
    expect(h.manager.metadata().wraps.filter((wrap) => wrap.kind === "recovery")).toHaveLength(1);
    // the delete minted before+1, B minted before+2, and the LATE reply must
    // install nothing at all — so the credential a browser holds is still B's
    expect(h.manager.sessionEpoch()).toBe(before + 2);
    expect(slow.headers.get("set-cookie")).toBeNull();
    // SAFETY: the rotation contract carries the generation
    const body = await json<{ sessionGeneration: number }>(slow);
    expect(body.sessionGeneration).toBe(before + 2);
  });

  itHeavy("still installs a credential when the reply carries the live session", async () => {
    // the positive control for the test above: an UNOvertaken reply sets one
    const h = harness(tempDir("dokan-vault-unraced-mint-"));
    const setup = await setupVault(h);
    const added = await h.manager.addRecoveryKey();
    const removed = await h.gate.request(`/api/vault/recovery-keys/${added.id}`, {
      method: "DELETE",
      headers: { "x-vault-session": sessionTokenFrom(setup) },
    });
    expect(removed.status).toBe(200);
    expect(removed.headers.get("set-cookie")).not.toBeNull();
    expect(h.manager.sessionMatches(sessionTokenFrom(removed))).toBe(true);
    // SAFETY: the rotation contract carries the generation
    const body = await json<{ sessionGeneration: number }>(removed);
    expect(body.sessionGeneration).toBe(h.manager.sessionEpoch());
  });

  /**
   * A minting reply that lands AFTER the credential was dropped. The generation
   * is what "still live" means, so dropping the token has to move it. The tests
   * below drop it two ways — a logout and a lock — and require that the late
   * reply installs no credential at all.
   */
  itHeavy("installs nothing when a minting reply lands after the owner logged out (round 3)", async () => {
    const holder: ManagerHolder = {};
    const h = harness(tempDir("dokan-vault-mint-after-logout-"), {
      afterCredentialChange: async () => {
        // the owner logs out while THIS delete reply is still being built
        holder.manager?.revokeSession();
      },
    });
    holder.manager = h.manager;
    const setup = await setupVault(h);
    const added = await h.manager.addRecoveryKey();
    const before = h.manager.sessionEpoch();

    const late = await h.gate.request(`/api/vault/recovery-keys/${added.id}`, {
      method: "DELETE",
      headers: { "x-vault-session": sessionTokenFrom(setup) },
    });
    expect(late.status).toBe(200);
    // the delete itself happened: only the credential it would install is lost
    expect(h.manager.metadata().wraps.filter((wrap) => wrap.kind === "recovery")).toHaveLength(1);
    // the reply installs NO credential: the cookie is what the browser would
    // apply, and the token behind it is one the server no longer holds
    expect(late.headers.get("set-cookie")).toBeNull();
    // the rotation minted before+1 and the logout moved the epoch again, so the
    // reply can only be the arbitrated-out one
    expect(h.manager.sessionEpoch()).toBe(before + 2);
    // SAFETY: the rotation contract carries the generation
    expect((await json<{ sessionGeneration: number }>(late)).sessionGeneration).toBe(before + 2);
  });

  itHeavy("installs nothing when a minting reply lands after the lock (round 3)", async () => {
    const holder: ManagerHolder = {};
    const h = harness(tempDir("dokan-vault-mint-after-lock-"), {
      afterCredentialChange: async () => {
        // the vault locks (no master key) while the reply is still being built
        holder.manager?.close();
      },
    });
    holder.manager = h.manager;
    const setup = await setupVault(h);
    const added = await h.manager.addRecoveryKey();
    const before = h.manager.sessionEpoch();

    const late = await h.gate.request(`/api/vault/recovery-keys/${added.id}`, {
      method: "DELETE",
      headers: { "x-vault-session": sessionTokenFrom(setup) },
    });
    expect(late.status).toBe(200);
    expect(late.headers.get("set-cookie")).toBeNull();
    expect(h.manager.sessionEpoch()).toBe(before + 2);
    // SAFETY: the rotation contract carries the generation
    expect((await json<{ sessionGeneration: number }>(late)).sessionGeneration).toBe(before + 2);
  });

  itHeavy("authorises exactly one of two racing unlocks, and never installs a dead cookie", async () => {
    const h = harness(tempDir("dokan-vault-racing-unlock-"));
    expect((await setupVault(h)).status).toBe(200);
    const unlockReply = async (): Promise<Response> =>
      await h.gate.request("/api/vault/unlock", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ passphrase: "correct horse battery" }),
      });

    const both = await Promise.all([unlockReply(), unlockReply()]);
    expect(both.map((reply) => reply.status)).toEqual([200, 200]);
    // EXACTLY one reply installs: the loser of the race installs nothing rather
    // than a token the winner already revoked. The earlier form accepted zero
    // (so a server that never handed out a credential passed) and its liveness
    // arm had a `: true` branch that could not fail.
    const installed = both
      .filter((reply) => reply.headers.get("set-cookie") !== null)
      .map((reply) => sessionTokenFrom(reply));
    expect(installed).toHaveLength(1);
    // and what it installed is LIVE: exactly one session exists, so the racing
    // unlock neither widens nor empties it
    for (const token of installed) expect(h.manager.sessionMatches(token)).toBe(true);
  });

  itHeavy("a broker-configured RPC seam ignores a cookie entirely (test-audit round 2)", async () => {
    const h = harness(tempDir("dokan-vault-broker-cookie-rpc-"), { broker: true });
    // the broker refuses the pre-boot HTTP routes, so the shell drives the
    // manager over its stdin pipe; the app is bootstrapped the way an unlock
    // over that pipe does it
    await h.manager.prepareSetup("correct horse battery");
    h.manager.finishSetupBootstrap();
    const session = await h.manager.commitSetup();
    await h.bootstrapApp({
      masterKey: h.manager.requireMasterKey(),
      vaultId: h.manager.metadata().vaultId,
      fresh: true,
    });
    await h.linkWith({ "x-vault-session": session.token }).firstTimeSetup({
      ownerName: "مالك",
      phoneNumber: "0550123123",
      storeName: "متجر",
    });

    // the header is the broker transport and works
    expect((await h.linkWith({ "x-vault-session": session.token }).categoriesList()).items.length).toBeGreaterThan(0);
    // the same live token in a COOKIE is not a credential on this server: the
    // packaged desktop's promise is that the secret never crosses the network,
    // so a page holding a cookie of the same name cannot act as the shell
    await expect(h.linkWith({ cookie: `dokan.vault.session=${session.token}` }).categoriesList()).rejects.toThrow(
      AUTH_REFUSAL.message,
    );
  });
});

/**
 * The status route's `session` answer (#319 review P2).
 *
 * Without it the web cannot know whether THIS window holds the live credential,
 * so a window with no valid cookie mounted the app and was sent to the unlock
 * screen by its first refused query — the page of failed queries the module
 * exists to prevent, only shorter. The answer is about the request that asked.
 */
describe("the status route reports this request's own credential (#319 round 2)", () => {
  const jsonHeaders = { "content-type": "application/json" };
  const AT = "http://127.0.0.1:4399/api/vault/status";

  async function sessionOf(response: Response | Promise<Response>): Promise<boolean> {
    // SAFETY: the status contract carries the flag
    const body = await json<{ session: boolean }>(await response);
    return body.session;
  }

  itHeavy("is false before an unlock, true for the window that holds the cookie, and false for anything else", async () => {
    const h = harness(tempDir("dokan-vault-status-session-"));
    expect(await sessionOf(h.gate.request(AT))).toBe(false);

    const setup = await h.gate.request("http://127.0.0.1:4399/api/vault/setup", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(setup.status).toBe(200);
    const token = sessionTokenFrom(setup);

    // the window that unlocked: its cookie is the live session
    expect(await sessionOf(h.gate.request(AT, { headers: { cookie: `dokan.vault.session=${token}` } }))).toBe(true);
    // a jar that does not hold the live session, and a window with no jar
    expect(await sessionOf(h.gate.request(AT, { headers: { cookie: "dokan.vault.session=not-the-token" } }))).toBe(false);
    expect(await sessionOf(h.gate.request(AT))).toBe(false);
    // and a refused origin is not "your credential works": the answer is false,
    // which leaks nothing to the page that asked
    expect(
      await sessionOf(h.gate.request(AT, { headers: { cookie: `dokan.vault.session=${token}`, origin: "http://127.0.0.1:9999" } })),
    ).toBe(false);
  });
});
