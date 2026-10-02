import fs from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { MIN_VAULT_PASSPHRASE_LENGTH, type VaultErrorCode } from "@dokan/contracts";
import { Hono } from "hono";
import { z } from "zod";

import { createApp, type AppDeps } from "./app";
import { createAuth } from "./auth/auth";
import { createAppConfig, type AppConfig } from "./config";
import { openConnection, type Connection } from "./db/connection";
import { MissingVaultDatabaseError, VaultCorruptionError, readLegacyDatabaseImage } from "./db/encrypted-connection";
import { openVaultStore } from "./db/vault-store";
import { ensureDailyBackup, type BackupFileValidator } from "./lib/backups";
import { AppLogger } from "./lib/logger";
import { createOverlay, type RequestHandler } from "./lib/overlay";
import { forgetPort as forgetPortRecord, portIsReachable, publishPort } from "./lib/port-record";
import { createSchemaRefusalApp, guardBootStep } from "./lib/schema-refusal";
import { UnsupportedSchemaVersionError, assertSchemaVersionSupported } from "./lib/schema-version";
import { ensureSessionSecret } from "./lib/session-secret";
import { VaultAuthenticationError, normalizePassphrase } from "./lib/vault/crypto";
import { VaultFormatError } from "./lib/vault/format";
import { createVaultHttpApp, type VaultBootstrapInput } from "./lib/vault/http";
import { closeVaultThenReleaseLock, createVaultLockRefusalApp, VaultAlreadyLockedError, acquireVaultLock, type VaultLock } from "./lib/vault/lock";
import { VaultLockedError, VaultManager, VaultNotUnlockedError, VaultSetupInProgressError, type VaultStatus } from "./lib/vault/manager";
import { createRpcRouter } from "./rpc/router";
import { createDrizzleStore } from "./store/drizzle-store";
import type { StorePort } from "./store/port";

/**
 * Boot: config, logger, the one StorePort seam, auth, rpc, the app, then the
 * server. main.ts knows seams, not SQL (ADR-0003).
 *
 * ADR-0008 §4.6: in vault mode the database and every app route stay closed
 * until the owner unlocks. The HTTP server still answers `/health` and
 * `/api/vault/*` (the pre-boot gate in dev/e2e and rotation in settings); the
 * packaged shell drives the same manager over the stdin broker instead. Once
 * the vault opens, `bootstrapVault` builds the encrypted store and swaps the
 * live request handler — no restart, no second port.
 */


const config = createAppConfig();

// A fresh install's app-data folder does not exist yet. Nothing else creates
// it (backup copy targets <dataDir>/backups, the logger makes <dataDir>/logs),
// so the process would die on first openConnection; make the whole tree now.
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, "backups"), { recursive: true });

const logger = new AppLogger(config.dataDir);

/**
 * Issue #142: one writer per vault data folder. The lock is acquired before
 * any vault file is opened and held for the process lifetime; the module's
 * exit hook releases it on fail-stop exits too. A second instance serves the
 * Arabic refusal page instead of touching the data.
 */
let vaultLock: VaultLock | undefined;
if (config.vault === "on") {
  try {
    vaultLock = acquireVaultLock(config.dataDir, {
      logger,
      onLost: (reason) => {
        logger.error("VAULT_LOCK_LOST", `the single-writer lock was lost (${reason}); exiting to avoid two writers`);
        process.exit(1);
      },
    });
  } catch (error) {
    if (error instanceof VaultAlreadyLockedError) await serveLockRefusal(config, error);
    logger.error(
      "VAULT_LOCK_FAILED",
      "the vault data folder could not be locked",
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exit(1);
  }
}

/** The connection is created only when a vault opens; shutdown treats it as optional. */
let activeConnection: Connection | undefined;
/** true once the real app handler replaced the vault gate */
let appReady = false;

let vaultManager: VaultManager | undefined;
let vaultApp: Hono | undefined;

/** Before the app is ready, /api/* must refuse instead of falling through to the SPA. */
const lockedApiHandler: RequestHandler = () =>
  Response.json({ error: { code: "VAULT_NOT_UNLOCKED" } }, { status: 503 });
let activeHandler: RequestHandler = lockedApiHandler;

/** Read the packaged index once; dev/e2e have no bundled UI (vite serves it). */
let webIndex: string | undefined;
if (config.webDataDir !== undefined) {
  try {
    webIndex = fs.readFileSync(path.join(config.webDataDir, "index.html"), "utf8");
  } catch (err) {
    // A missing ui folder means a broken install — the api must still boot (the
    // desktop window falls back to the bundled frontendDist UI whose in-app
    // error states surface the problem) instead of dying before first request.
    logger.error(
      "WEB_UI_SERVE_FAILED",
      "packaged ui missing; serving api only",
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

/**
 * Compose the live request handler (the real composition lives in
 * lib/overlay.ts, which keeps the peer address reachable by the vault gate's
 * loopback guard).
 */
function buildOverlay(api: RequestHandler | undefined): RequestHandler {
  return createOverlay({
    config,
    api,
    lockedApiHandler,
    vaultApp,
    vaultState: () => vaultManager?.status().state ?? "disabled",
    webIndex,
  });
}

/** Startup daily backup: one copy per Algeria-local day, validated by format. */
async function runDailyBackup(store: StorePort, validate?: BackupFileValidator): Promise<void> {
  try {
    const options: Parameters<typeof ensureDailyBackup>[0] = { store, dataDir: config.dataDir };
    if (validate !== undefined) options.validate = validate;
    const daily = await ensureDailyBackup(options);
    if (daily.created) {
      await store.insertActivity({
        type: "BACKUP_CREATED",
        summary: `DAILY_BACKUP ${daily.path.split(/[\\/]/).pop()}`,
        ref: daily.path,
      });
    }
  } catch (err) {
    // A failed backup is logged loudly but must not block boot — a full disk
    // should not stop the shop from selling.
    logger.error("SERVER_ERROR", "daily startup backup failed", err instanceof Error ? err : new Error(String(err)));
  }
}

/** The plaintext phase-1 path (DOKAN_VAULT=disabled, dev/e2e only). */
async function startPlaintext(): Promise<void> {
  const conn = await guardBootStep(
    () => openConnection(config),
    (error) => serveSchemaRefusal(config, error),
  );
  activeConnection = conn;
  const store = createDrizzleStore(conn, logger);
  try {
    await guardBootStep(
      () => store.setup(),
      async (error) => {
        // release the file before serving the page; the store never started
        await conn.close();
        return serveSchemaRefusal(config, error);
      },
    );
  } catch (error) {
    await conn.close();
    throw error;
  }

  // One universal build (ADR-0008 §4.2): the session-signing secret is generated
  // here on first run and stored in the database.
  const sessionSecret = await ensureSessionSecret(store, logger);
  await runDailyBackup(store);

  const auth = createAuth(conn.db, config, sessionSecret);
  const rpcRouter = createRpcRouter({ db: conn.db, config, logger, store, auth });
  const deps: AppDeps = { config, logger, auth, rpcRouter };
  const app = createApp(deps);
  appReady = true;
  activeHandler = buildOverlay((req) => app.fetch(req));
  logger.info("SERVER_BOOT_DONE", "database and auth ready", { driver: config.db.driver });
}

/**
 * Open the encrypted store once. For the first run the snapshot is written and
 * flushed before `commitSetup()` writes the header, so a crash in between
 * leaves a retryable plaintext install, never a header without data. For a
 * legacy plaintext database the serialised image is adopted first and the
 * schema version is preserved by the image itself.
 */
/** The live store/connection pair, for post-setup work (the first backup). */
let vaultStoreForBackup: StorePort | undefined;

/** The first daily backup needs the committed header, so it runs post-commit. */
async function runVaultDailyBackup(): Promise<void> {
  const store = vaultStoreForBackup;
  const conn = activeConnection;
  if (store === undefined || conn === undefined) return;
  await runDailyBackup(store, conn.validateSnapshotFile?.bind(conn));
}

async function bootstrapVault(input: VaultBootstrapInput): Promise<void> {
  if (appReady) return;
  const vault = vaultManager;
  if (vault === undefined) throw new Error("vault bootstrap without a vault manager");
  const legacyPath = config.db.path;
  const seedBytes =
    input.fresh && fs.existsSync(legacyPath) ? readLegacyDatabaseImage(legacyPath).image : undefined;
  const storeInput: Parameters<typeof openVaultStore>[0] = {
    vaultId: input.vaultId,
    masterKey: input.masterKey,
    snapshotPath: vault.snapshotPath,
    headerPath: vault.headerPath,
    logger,
  };
  // first run: an orphan snapshot from a crashed attempt is overwritten
  if (input.fresh) storeInput.fresh = true;
  if (seedBytes !== undefined) storeInput.seedBytes = seedBytes;
  const { conn, store } = openVaultStore(storeInput);
  // A committed unit that cannot be written to its snapshot is fail-stop: the
  // client must never get a "failed" answer for something already committed
  // (a retry would duplicate a sale/payment). Exiting here means the client
  // sees a connection loss, not a business refusal.
  conn.onFatalError = (error) => {
    logger.error("SNAPSHOT_PERSIST_FAILED", "FATAL: encrypted snapshot could not be written; exiting to avoid divergence", error);
    process.exit(1);
  };
  try {
    // Refuse a newer database before any migration writes (ADR-0008 §4.5): the
    // refusal is surfaced by the unlock screen, never a half-migrated image.
    assertSchemaVersionSupported(conn.raw);
    await store.setup();
    // the snapshot must exist before the header can commit (migration ordering)
    await conn.flush();
    // Replay the pre-unlock failures now that the shop activity log exists.
    for (const event of await vault.drainPendingEvents()) {
      await store.insertActivity({ type: "VAULT_UNLOCK_FAILED", summary: event });
    }
    const sessionSecret = await ensureSessionSecret(store, logger);
    const ownerId = await store.getSetting("adminUserId");
    if (ownerId !== undefined) vault.setOwnerId(ownerId);

    const auth = createAuth(conn.db, config, sessionSecret);
    const rpcRouter = createRpcRouter({
      db: conn.db,
      config,
      logger,
      store,
      auth,
      vault: {
        sessionMatches: (token) => vault.sessionMatches(token),
        ownerId: () => vault.ownerId(),
        setOwnerId: (ownerIdValue) => vault.setOwnerId(ownerIdValue),
      },
    });
    const deps: AppDeps = { config, logger, auth, rpcRouter };
    const app = createApp(deps);
    activeConnection = conn;
    vaultStoreForBackup = store;
    appReady = true;
    activeHandler = buildOverlay((req) => app.fetch(req));
    // A committed vault owns the data; a plaintext database (live or under
    // backups/) left behind by a failed or interrupted first-run cleanup is
    // stale and must not survive. Retry on every unlock until it is gone.
    const cleanup = await vault.cleanupLegacyPlaintext();
    if (cleanup.plaintextRemaining.length > 0) {
      logger.warn("VAULT_PLAINTEXT_REMAINS", `plaintext files still readable after unlock: ${cleanup.plaintextRemaining.join(", ")}`);
    }
    // unlock path only: the first-run path runs this after commitSetup, when
    // the header exists and a self-contained backup can actually be written
    if (!input.fresh) await runVaultDailyBackup();
    logger.info("SERVER_BOOT_DONE", "vault store and auth ready", { driver: "sqlite-encrypted" });
  } catch (error) {
    await conn.close();
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  Desktop-shell broker (DOKAN_VAULT_STDIN=1)                          */
/* ------------------------------------------------------------------ */

const brokerRequestSchema = z.object({
  action: z.enum(["unlock", "recovery", "setup", "status", "reset"]),
  passphrase: z.string().optional(),
  recoveryKey: z.string().optional(),
  newPassphrase: z.string().optional(),
});

/** The vault status payload the pipe and the HTTP status route both serve. */
type VaultStatusPayload = {
  mode: "vault";
  state: VaultStatus["state"];
  legacyDatabase: boolean;
  recoveryKeyCount: number;
  lockedForMs: number;
  unlocked: boolean;
  broker: boolean;
};

/** The gate status over the pipe (same fields the HTTP status route serves). */
function brokerStatusPayload(vault: VaultManager): VaultStatusPayload {
  const status = vault.status();
  return {
    mode: "vault",
    state: status.state,
    legacyDatabase: status.legacyDatabase,
    // never advertise the wrap inventory before unlock
    recoveryKeyCount: status.state === "unlocked" ? status.recoveryKeyCount : 0,
    lockedForMs: status.lockedForMs,
    unlocked: vault.unlocked,
    broker: true,
  };
}

type BrokerReply =
  | { ok: true; sessionToken: string; sessionGeneration?: number; recoveryKey?: string; plaintextRemaining?: string[] }
  | { ok: true; status: VaultStatusPayload }
  | { ok: true; warning: "plaintext"; plaintextRemaining: string[] }
  | { ok: false; code: VaultErrorCode; retryAfterMs?: number };

function writeBrokerReply(reply: BrokerReply): void {
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

/**
 * One reusable stdin reader: `Bun.stdin.stream()` is single-use, so a second
 * `readStdinLine` call on a new stream never saw the next line (the status
 * probe exposed it). The source is created once and buffered across calls;
 * bytes after the returned newline stay in the buffer.
 */
function createStdinLineReader(): () => Promise<string | undefined> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return line;
      }
      const { done, value } = await reader.read();
      if (done) return buffer.length > 0 ? buffer : undefined;
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

let stdinLineReader: (() => Promise<string | undefined>) | undefined;

/** One line from the parent shell's pipe; undefined when the pipe closed. */
async function readStdinLine(): Promise<string | undefined> {
  stdinLineReader ??= createStdinLineReader();
  return stdinLineReader();
}

function brokerFailure(action: "unlock" | "recovery" | "setup" | "reset", error: Error): BrokerReply {
  const wrongCode: VaultErrorCode = action === "unlock" ? "VAULT_WRONG_PASSPHRASE" : "VAULT_WRONG_RECOVERY";
  if (error instanceof VaultAuthenticationError) return { ok: false, code: wrongCode };
  if (error instanceof VaultLockedError) {
    return { ok: false, code: "VAULT_LOCKED", retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof VaultFormatError) return { ok: false, code: "VAULT_INVALID" };
  if (error instanceof UnsupportedSchemaVersionError) {
    return { ok: false, code: "VAULT_SCHEMA_TOO_NEW" };
  }
  if (error instanceof VaultNotUnlockedError) {
    return { ok: false, code: "VAULT_NOT_UNLOCKED" };
  }
  if (error instanceof MissingVaultDatabaseError) {
    return { ok: false, code: "VAULT_DATABASE_MISSING" };
  }
  if (error instanceof VaultCorruptionError) {
    return { ok: false, code: "VAULT_CORRUPT" };
  }
  if (error instanceof VaultSetupInProgressError) {
    return { ok: false, code: "VAULT_SETUP_IN_PROGRESS" };
  }
  const fallback: VaultErrorCode = action === "setup" ? "VAULT_SETUP_FAILED" : wrongCode;
  return { ok: false, code: fallback };
}

/**
 * The packaged desktop shell's pre-boot gate: one JSON request over stdin, one
 * JSON reply over stdout. The passphrase or recovery key never touches argv,
 * the environment or disk. Failure exits the process (the shell respawns for
 * the next attempt), so no pre-unlock child lingers.
 */
async function runVaultBroker(vault: VaultManager): Promise<void> {
  for (;;) {
    const line = await readStdinLine();
    // the shell closed the pipe without asking anything: nothing to do
    if (line === undefined) return;
    let decoded: string | number | boolean | null | Array<string | number | boolean | null> | { [key: string]: string | number | boolean | null };
    try {
      decoded = JSON.parse(line);
    } catch {
      writeBrokerReply({ ok: false, code: "VAULT_SETUP_FAILED" });
      process.exit(1);
    }
    const parsedRequest = brokerRequestSchema.safeParse(decoded);
    if (!parsedRequest.success) {
      writeBrokerReply({ ok: false, code: "VAULT_SETUP_FAILED" });
      process.exit(1);
    }
    const request = parsedRequest.data;
    // a status probe is free: answer and keep waiting for the real request
    if (request.action === "status") {
      writeBrokerReply({ ok: true, status: brokerStatusPayload(vault) });
      continue;
    }
    try {
      if (request.action === "setup") {
        const passphrase = request.passphrase ?? "";
        // the NORMALIZED passphrase decides: eight spaces is empty
        if (normalizePassphrase(passphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) {
          writeBrokerReply({ ok: false, code: "VAULT_PASSPHRASE_TOO_SHORT" });
          process.exit(1);
        }
        const prepared = await vault.prepareSetup(passphrase);
        await bootstrapVault({ masterKey: vault.setupMasterKey(), vaultId: prepared.vaultId, fresh: true });
        // the app is up; a concurrent resume would now be safe, but the broker is
        // single-request anyway
        vault.finishSetupBootstrap();
        const session = await vault.commitSetup();
        // The ONE-TIME recovery key must never wait on the sweep: a run with
        // many legacy backups can outlive the shell's reply budget, and a
        // timed-out shell would kill the child after the vault committed,
        // losing the only copy of the key (round-3 finding 1). Reply FIRST,
        // then deliver the plaintext warning as a second framed message.
        writeBrokerReply({
          ok: true,
          sessionToken: session.token,
          sessionGeneration: session.generation,
          recoveryKey: prepared.recoveryKey,
        });
        let plaintextRemaining: string[] = [];
        try {
          const cleanup = await vault.cleanupLegacyPlaintext();
          plaintextRemaining = cleanup.plaintextRemaining;
          if (plaintextRemaining.length > 0) {
            logger.warn("VAULT_PLAINTEXT_REMAINS", `plaintext files still readable after setup: ${plaintextRemaining.join(", ")}`);
          }
        } catch (error) {
          logger.error(
            "VAULT_SETUP_CLEANUP_FAILED",
            "plaintext files could not be removed after vault setup",
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        // the follow-up the shell waits for on its own (longer) budget
        writeBrokerReply({ ok: true, warning: "plaintext", plaintextRemaining });
        // the first daily backup needs the committed header, which now exists
        await runVaultDailyBackup();
        // wait for the owner's acknowledgement (the shell shows the key); a
        // closed pipe means the app quit on the key screen, which is safe: the
        // vault exists and the key can be regenerated after unlocking
        await readStdinLine();
        return;
      }
      if (request.action === "reset") {
        const newPassphrase = request.newPassphrase ?? "";
        if (normalizePassphrase(newPassphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) {
          writeBrokerReply({ ok: false, code: "VAULT_PASSPHRASE_TOO_SHORT" });
          process.exit(1);
        }
        // recovery-authorised reset (round-2 finding 2): the settings UI needs
        // it while the vault is open, and broker mode refuses the HTTP route
        const session = await vault.setPassphraseFromRecovery(request.recoveryKey ?? "", newPassphrase);
        writeBrokerReply({ ok: true, sessionToken: session.token, sessionGeneration: session.generation });
        return;
      }
      const session =
        request.action === "recovery"
          ? await vault.unlockRecovery(request.recoveryKey ?? "")
          : await vault.unlock(request.passphrase ?? "");
      await bootstrapVault({ masterKey: vault.requireMasterKey(), vaultId: vault.metadata().vaultId, fresh: false });
      writeBrokerReply({ ok: true, sessionToken: session.token, sessionGeneration: session.generation });
      return;
    } catch (error) {
      const failure = brokerFailure(request.action, error instanceof Error ? error : new Error(String(error)));
      writeBrokerReply(failure);
      vault.close();
      process.exit(1);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Port discovery + server lifetime                                   */
/* ------------------------------------------------------------------ */

/**
 * Workspace root = the directory containing .git (repo anchor), used only in
 * dev/e2e. Packaged builds redirect the record via DOKAN_PORT_ROOT, so the
 * port record never lands in an install folder or a user's home tree.
 */
function findWorkspaceRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

// An explicitly configured port is authoritative: falling back silently
// would desync the proxy and point traffic at an unrelated process (greptile
// P1). Without an explicit port, probe upward and record the winner; the web
// proxy prefers that record.
const port = config.portExplicit ? config.port : await firstFreePort(config.port, config.probeHost);
const portRecordDir = config.portRecordDir ?? findWorkspaceRoot();
// Packaged builds point the record at a fresh app-data/run folder; create it
// so the lock mkdir below never fails. Dev's workspace root always exists.
if (config.portRecordDir !== undefined) fs.mkdirSync(portRecordDir, { recursive: true });
const portFile = path.resolve(portRecordDir, ".dokan-port");
const portLockDir = path.join(portRecordDir, ".dokan-port.lock");
const registryDir = path.join(portRecordDir, ".dokan-port.registry");

async function firstFreePort(start: number, host: string): Promise<number> {
  for (let candidate = start; candidate < start + 25; candidate++) {
    if (!(await portIsReachable(host, candidate, 200))) return candidate;
  }
  throw new Error("no free port found for the api");
}

/**
 * The HTTP server starts in every mode, before unlock too: the vault gate must
 * answer on the port the shell reserved, and a locked install still reports
 * health so the desktop shell can verify its child. Only the app routes wait
 * for the vault. Plaintext mode starts it only after the store opened, so the
 * schema-refusal page can own the port first.
 */
let server: ReturnType<typeof serve> | undefined;

function startServer(): void {
  server = serve(
    { fetch: (request, env) => activeHandler(request, env), port, hostname: config.host },
    async (info) => {
      // record the port that actually bound: for fallback/ephemeral binds this
      // differs from the configured value and must be what the proxy trusts.
      // A publication failure is a boot failure: running while Vite still walks
      // the previous record would strand /api traffic, so fail loudly (before
      // logging the server as started) instead of discarding the rejection.
      try {
        await publishPort({
          portFile,
          lockDir: portLockDir,
          registryDir,
          pid: process.pid,
          host: config.host,
          port: info.port,
        });
      } catch (err) {
        // SAFETY: every rejection path throws an Error (lock timeout / fs error)
        logger.error("SERVER_ERROR", `port record publication failed after binding ${info.port}`, err as Error);
        process.exit(1);
      }
      logger.info("SERVER_STARTED", "Dokan API booted", {
        url: `http://${info.address}:${info.port}`,
        version: config.version,
      });
      // stderr, never stdout: in broker mode stdout carries the JSON protocol
      // between the shell and the vault gate, and any stray line corrupts it
      console.error(`Dokan API listening on http://${info.address}:${info.port}`);
    },
  );

  // an explicit port that still collides is a hard failure, never a silent
  // rebind that would desync the proxy (greptile P1)
  server.on("error", async (err: NodeJS.ErrnoException) => {
    logger.error("SERVER_ERROR", `could not bind ${config.host}:${port}`, err);
    await reconcileBeforeExit();
    process.exit(1);
  });

  // graceful shutdown: reconcile FIRST (registry removed, canonical pointed at
  // a survivor), then close the store and only then release the lock — the
  // lock must outlive the final checkpoint (round-5 finding) — single
  // listener, so no shutdown path can exit before the reconcile finishes
  server.on("close", async () => {
    await reconcileBeforeExit();
    await closeStoreThenLock();
    process.exit(0);
  });
}

/**
 * Shutdown reconcile: remove our registry entry, then point the canonical at
 * the newest surviving instance (or delete it when none is up). Every exit
 * path awaits this before leaving, so discovery never strands the proxy.
 */
async function forgetPort(): Promise<void> {
  await forgetPortRecord({ portFile, lockDir: portLockDir, registryDir, pid: process.pid });
}

/**
 * Close the store (draining pending snapshot writes and the final checkpoint)
 * and only then release the single-writer lock; the lock and the connection
 * are module-level so every shutdown path shares this order. A close failure
 * is logged, never fatal: the helper already released the lock in `finally`.
 */
async function closeStoreThenLock(): Promise<void> {
  try {
    await closeVaultThenReleaseLock(activeConnection, vaultLock);
  } catch (err) {
    logger.error("SERVER_ERROR", "store close failed during shutdown", err instanceof Error ? err : new Error(String(err)));
  }
}

/** Cleanup must be observable: exiting successfully after a failed reconcile
 * leaves the proxy with stale discovery data. */
async function reconcileBeforeExit(): Promise<void> {
  try {
    await forgetPort();
  } catch (err) {
    logger.error(
      "SERVER_ERROR",
      "port record cleanup failed before exit",
      err instanceof Error ? err : new Error(String(err)),
    );
    await closeStoreThenLock();
    process.exit(1);
  }
}

// an explicit port that still collides is a hard failure, never a silent
// rebind that would desync the proxy (greptile P1)

function beginShutdown(): void {
  server?.close();
  // a stuck close (keep-alive connection) must not hang the kiosk forever;
  // the forced path still awaits the full reconcile and the store close before
  // releasing the lock and exiting
  setTimeout(async () => {
    await reconcileBeforeExit();
    await closeStoreThenLock();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", beginShutdown);
process.on("SIGTERM", beginShutdown);

/* ------------------------------------------------------------------ */
/*  Mode selection                                                     */
/* ------------------------------------------------------------------ */

if (config.vault === "on") {
  if (config.vaultOptOutIgnored) {
    logger.warn(
      "VAULT_OPT_OUT_IGNORED",
      "DOKAN_VAULT=disabled was ignored: a packaged build (DOKAN_WEB_DIST set) always runs the encrypted vault",
    );
  }
  const manager = new VaultManager({
    dataDir: config.dataDir,
    legacyDbPath: config.db.path,
    logger,
  });
  vaultManager = manager;
  vaultApp = createVaultHttpApp({
    manager,
    config,
    logger,
    bootstrap: bootstrapVault,
    onSetupCommitted: () => manager.cleanupLegacyPlaintext(),
    afterSetup: runVaultDailyBackup,
    // a credential change makes today's backup stale (its embedded header has
    // the old wraps); the daily pass rebuilds it with the live header
    afterCredentialChange: runVaultDailyBackup,
  });
  activeHandler = buildOverlay(undefined);
  startServer();
  if (config.vaultBroker) {
    await runVaultBroker(manager);
  }
} else {
  logger.warn(
    "VAULT_DISABLED",
    "DOKAN_VAULT=disabled: the encrypted store is off and the legacy plaintext path is active (development/e2e only)",
  );
  await startPlaintext();
  startServer();
}

/**
 * Serve one standalone refusal page on the reserved/app port, echoing the boot
 * token so the desktop shell's identity probe still passes and the webview
 * navigates to the Arabic message. Shared by the schema gate (ADR-0008 §4.5)
 * and the single-writer lock gate (issue #142).
 *
 * The schema gate is the only instance on the folder, so it publishes the
 * shared `.dokan-port` record the proxy reads. The lock-refusal instance does
 * NOT: it does not own the folder, and publishing would point the first
 * instance's clients at the refusal server (round-7 finding 2).
 * Never returns: the process stays up while the owner reads the page.
 */
async function serveRefusalServer(
  config: AppConfig,
  refusalApp: Hono,
  event: string,
  options: { publishPortRecord?: boolean } = {},
): Promise<never> {
  const publish = options.publishPortRecord ?? true;
  const port = config.portExplicit ? config.port : await firstFreePort(config.port, config.probeHost);
  const portRecordDir = config.portRecordDir ?? findWorkspaceRoot();
  if (publish && config.portRecordDir !== undefined) fs.mkdirSync(portRecordDir, { recursive: true });
  const portFile = path.resolve(portRecordDir, ".dokan-port");
  const portLockDir = path.join(portRecordDir, ".dokan-port.lock");
  const registryDir = path.join(portRecordDir, ".dokan-port.registry");

  const server = serve(
    { fetch: refusalApp.fetch, port, hostname: config.host },
    async (info) => {
      if (publish) {
        try {
          await publishPort({
            portFile,
            lockDir: portLockDir,
            registryDir,
            pid: process.pid,
            host: config.host,
            port: info.port,
          });
        } catch (err) {
          logger.error(
            "SERVER_ERROR",
            `refusal page port publication failed after binding ${info.port}`,
            err instanceof Error ? err : new Error(String(err)),
          );
          process.exit(1);
        }
      }
      logger.warn(
        event,
        publish
          ? `serving a refusal page on http://${info.address}:${info.port}`
          : `serving a refusal page on http://${info.address}:${info.port} (port record untouched: another instance owns the folder)`,
      );
    },
  );
  server.on("error", (err: NodeJS.ErrnoException) => {
    logger.error("SERVER_ERROR", `could not bind the refusal page on ${config.host}:${port}`, err);
    process.exit(1);
  });
  const shutdown = () => {
    server.close(() => {
      const cleanup = publish
        ? forgetPortRecord({ portFile, lockDir: portLockDir, registryDir, pid: process.pid })
        : Promise.resolve();
      void cleanup.finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // never resolves: the event loop keeps the refusal server alive
  return new Promise<never>(() => {});
}

/**
 * The standalone update page when this build is older than the database. The
 * store, auth and router never start, so nothing touches the newer file
 * (plaintext mode only; the vault path returns the refusal through the unlock
 * screen instead).
 */
async function serveSchemaRefusal(config: AppConfig, error: UnsupportedSchemaVersionError): Promise<never> {
  return serveRefusalServer(config, createSchemaRefusalApp(config, error), "SCHEMA_VERSION_REFUSED");
}

/**
 * The second instance on one vault folder: the lock was refused, so no vault
 * file is opened and the owner reads why. The first instance keeps running
 * untouched.
 */
async function serveLockRefusal(config: AppConfig, error: VaultAlreadyLockedError): Promise<never> {
  // the first instance owns the folder and the shared port record; this
  // second instance must not overwrite it (round-7 finding 2)
  return serveRefusalServer(config, createVaultLockRefusalApp(config, error), "VAULT_LOCK_REFUSED", { publishPortRecord: false });
}
