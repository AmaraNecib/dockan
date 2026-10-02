import fs from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { z } from "zod";

import { createApp, type AppDeps } from "./app";
import { createAuth } from "./auth/auth";
import { createAppConfig, type AppConfig } from "./config";
import { openConnection, type Connection } from "./db/connection";
import { MissingVaultDatabaseError, VaultCorruptionError, readLegacyDatabaseImage } from "./db/encrypted-connection";
import { openVaultStore } from "./db/vault-store";
import { ensureDailyBackup, type BackupFileValidator } from "./lib/backups";
import { tokenMatches } from "./lib/boot-token";
import { AppLogger } from "./lib/logger";
import { forgetPort as forgetPortRecord, portIsReachable, publishPort } from "./lib/port-record";
import { createSchemaRefusalApp, guardBootStep } from "./lib/schema-refusal";
import { UnsupportedSchemaVersionError, assertSchemaVersionSupported } from "./lib/schema-version";
import { ensureSessionSecret } from "./lib/session-secret";
import { VaultAuthenticationError, normalizePassphrase } from "./lib/vault/crypto";
import { VaultFormatError } from "./lib/vault/format";
import { createVaultHttpApp, type VaultBootstrapInput } from "./lib/vault/http";
import { VaultLockedError, VaultManager, VaultNotUnlockedError, VaultSetupInProgressError } from "./lib/vault/manager";
import { MIN_VAULT_PASSPHRASE_LENGTH, vaultErrorMessage } from "./lib/vault/messages";
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

type RequestHandler = (request: Request) => Response | Promise<Response>;

const config = createAppConfig();

// A fresh install's app-data folder does not exist yet. Nothing else creates
// it (backup copy targets <dataDir>/backups, the logger makes <dataDir>/logs),
// so the process would die on first openConnection; make the whole tree now.
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, "backups"), { recursive: true });

const logger = new AppLogger(config.dataDir);

/** The connection is created only when a vault opens; shutdown treats it as optional. */
let activeConnection: Connection | undefined;
/** true once the real app handler replaced the vault gate */
let appReady = false;

let vaultManager: VaultManager | undefined;
let vaultApp: Hono | undefined;

/** Before the app is ready, /api/* must refuse instead of falling through to the SPA. */
const lockedApiHandler: RequestHandler = () =>
  Response.json({ error: { code: "VAULT_NOT_UNLOCKED", message: vaultErrorMessage("VAULT_NOT_UNLOCKED") } }, { status: 503 });
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
 * Compose the live request handler. The vault gate and the health endpoints
 * are always mounted; the app handler is present only after unlock. In
 * packaged builds the remaining paths serve the bundled UI (static files plus
 * an SPA fallback for client-routed paths). Dev/e2e never set DOKAN_WEB_DIST —
 * the vite dev server owns the frontend there.
 */
function buildOverlay(api: RequestHandler | undefined): RequestHandler {
  const overlay = new Hono();
  overlay.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    // PR #51 finding 1: the shell verifies the server on its chosen port is
    // really its own child by asking for the one-time token it handed over
    // via DOKAN_BOOT_TOKEN and checking the echo. Only the spawned api knows
    // the token, so a stale or modified port record pointing at an unrelated
    // localhost server (or a decoy that 200s everything) cannot satisfy this
    // endpoint. The token is never logged or rendered into the UI.
    if (pathname === "/health-token" && config.bootToken !== undefined) {
      if (tokenMatches(url.searchParams.get("token"), config.bootToken)) {
        return c.json({ ok: true, token: config.bootToken });
      }
      return c.text("not found", 404);
    }
    if (vaultApp !== undefined && pathname.startsWith("/api/vault/")) return vaultApp.fetch(c.req.raw);
    if (pathname === "/health") {
      if (api !== undefined) return api(c.req.raw);
      return c.json({ ok: true, version: config.version, vault: vaultManager?.status().state ?? "disabled" });
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (api !== undefined) return api(c.req.raw);
      return lockedApiHandler(c.req.raw);
    }
    return next();
  });
  const index = webIndex;
  if (config.webDataDir !== undefined && index !== undefined) {
    const webRoot = config.webDataDir;
    overlay.use("*", serveStatic({ root: webRoot }));
    overlay.use("*", async (c) => c.html(index));
  }
  return (req) => overlay.fetch(req);
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
    await runDailyBackup(store, (backupPath) => conn.validateSnapshotFile(backupPath));
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
    appReady = true;
    activeHandler = buildOverlay((req) => app.fetch(req));
    // A committed vault owns the data; a plaintext database left behind by a
    // failed or interrupted first-run cleanup is stale and must not survive on
    // the stick. Retry on every unlock until it is gone.
    await vault.cleanupLegacyPlaintext();
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
  action: z.enum(["unlock", "recovery", "setup"]),
  passphrase: z.string().optional(),
  recoveryKey: z.string().optional(),
});

type BrokerReply =
  | { ok: true; sessionToken: string; recoveryKey?: string }
  | { ok: false; code: string; message: string; retryAfterMs?: number };

function writeBrokerReply(reply: BrokerReply): void {
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

/** One line from the parent shell's pipe; undefined when the pipe closed. */
async function readStdinLine(): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline >= 0) return buffer.slice(0, newline);
  }
  return buffer.length > 0 ? buffer : undefined;
}

function brokerFailure(action: "unlock" | "recovery" | "setup", error: Error): BrokerReply {
  const wrongCode = action === "recovery" ? "VAULT_WRONG_RECOVERY" : "VAULT_WRONG_PASSPHRASE";
  if (error instanceof VaultAuthenticationError) return { ok: false, code: wrongCode, message: vaultErrorMessage(wrongCode) };
  if (error instanceof VaultLockedError) {
    return { ok: false, code: "VAULT_LOCKED", message: vaultErrorMessage("VAULT_LOCKED"), retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof VaultFormatError) return { ok: false, code: "VAULT_INVALID", message: vaultErrorMessage("VAULT_INVALID") };
  if (error instanceof UnsupportedSchemaVersionError) {
    return { ok: false, code: "VAULT_SCHEMA_TOO_NEW", message: vaultErrorMessage("VAULT_SCHEMA_TOO_NEW") };
  }
  if (error instanceof VaultNotUnlockedError) {
    return { ok: false, code: "VAULT_NOT_UNLOCKED", message: vaultErrorMessage("VAULT_NOT_UNLOCKED") };
  }
  if (error instanceof MissingVaultDatabaseError) {
    return { ok: false, code: "VAULT_DATABASE_MISSING", message: vaultErrorMessage("VAULT_DATABASE_MISSING") };
  }
  if (error instanceof VaultCorruptionError) {
    return { ok: false, code: "VAULT_CORRUPT", message: vaultErrorMessage("VAULT_CORRUPT") };
  }
  if (error instanceof VaultSetupInProgressError) {
    return { ok: false, code: "VAULT_SETUP_IN_PROGRESS", message: vaultErrorMessage("VAULT_SETUP_IN_PROGRESS") };
  }
  const fallback = action === "setup" ? "VAULT_SETUP_FAILED" : wrongCode;
  return { ok: false, code: fallback, message: vaultErrorMessage(fallback) };
}

/**
 * The packaged desktop shell's pre-boot gate: one JSON request over stdin, one
 * JSON reply over stdout. The passphrase or recovery key never touches argv,
 * the environment or disk. Failure exits the process (the shell respawns for
 * the next attempt), so no pre-unlock child lingers.
 */
async function runVaultBroker(vault: VaultManager): Promise<void> {
  const line = await readStdinLine();
  let decoded: string | number | boolean | null | Array<string | number | boolean | null> | { [key: string]: string | number | boolean | null };
  try {
    if (line === undefined) throw new Error("stdin closed");
    decoded = JSON.parse(line);
  } catch {
    writeBrokerReply({ ok: false, code: "VAULT_SETUP_FAILED", message: vaultErrorMessage("VAULT_SETUP_FAILED") });
    process.exit(1);
  }
  const parsedRequest = brokerRequestSchema.safeParse(decoded);
  if (!parsedRequest.success) {
    writeBrokerReply({ ok: false, code: "VAULT_SETUP_FAILED", message: vaultErrorMessage("VAULT_SETUP_FAILED") });
    process.exit(1);
  }
  const request = parsedRequest.data;
  try {
    if (request.action === "setup") {
      const passphrase = request.passphrase ?? "";
      // the NORMALIZED passphrase decides: eight spaces is empty
      if (normalizePassphrase(passphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) {
        writeBrokerReply({ ok: false, code: "VAULT_PASSPHRASE_TOO_SHORT", message: vaultErrorMessage("VAULT_PASSPHRASE_TOO_SHORT") });
        process.exit(1);
      }
      const prepared = await vault.prepareSetup(passphrase);
      await bootstrapVault({ masterKey: vault.setupMasterKey(), vaultId: prepared.vaultId, fresh: true });
      const sessionToken = await vault.commitSetup();
      // the recovery key reaches the shell first; cleanup is retried on every
      // unlock anyway, so it must never delay or fail the one-time reply
      writeBrokerReply({ ok: true, sessionToken, recoveryKey: prepared.recoveryKey });
      await vault.cleanupLegacyPlaintext();
      // wait for the owner's acknowledgement (the shell shows the key); a
      // closed pipe means the app quit on the key screen, which is safe: the
      // vault exists and the key can be regenerated after unlocking
      await readStdinLine();
      return;
    }
    const sessionToken =
      request.action === "recovery"
        ? await vault.unlockRecovery(request.recoveryKey ?? "")
        : await vault.unlock(request.passphrase ?? "");
    await bootstrapVault({ masterKey: vault.requireMasterKey(), vaultId: vault.metadata().vaultId, fresh: false });
    writeBrokerReply({ ok: true, sessionToken });
  } catch (error) {
    const failure = brokerFailure(request.action, error instanceof Error ? error : new Error(String(error)));
    writeBrokerReply(failure);
    vault.close();
    process.exit(1);
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
    { fetch: (request) => activeHandler(request), port, hostname: config.host },
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
  // a survivor), then tear down the db and exit — single listener, so no
  // shutdown path can exit before the reconcile finishes
  server.on("close", async () => {
    await reconcileBeforeExit();
    await activeConnection?.close();
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
    await activeConnection?.close();
    process.exit(1);
  }
}

// an explicit port that still collides is a hard failure, never a silent
// rebind that would desync the proxy (greptile P1)

function beginShutdown(): void {
  server?.close();
  // a stuck close (keep-alive connection) must not hang the kiosk forever;
  // the forced path still awaits the full reconcile before exiting
  setTimeout(async () => {
    await reconcileBeforeExit();
    await activeConnection?.close();
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
  });
  activeHandler = buildOverlay(undefined);
  startServer();
  if (process.env.DOKAN_VAULT_STDIN === "1") {
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
 * Serve the standalone update page when this build is older than the
 * database. The store, auth and router never start, so nothing touches the
 * newer file (plaintext mode only; the vault path returns the refusal through
 * the unlock screen instead). The shell's identity probe still passes (the
 * token echo and the port-record publication below), so the packaged webview
 * navigates here and the owner reads the Arabic message (ADR-0008 §4.5).
 * Never returns: the process stays up while the owner reads the page.
 */
async function serveSchemaRefusal(config: AppConfig, error: UnsupportedSchemaVersionError): Promise<never> {
  const port = config.portExplicit ? config.port : await firstFreePort(config.port, config.probeHost);
  const portRecordDir = config.portRecordDir ?? findWorkspaceRoot();
  if (config.portRecordDir !== undefined) fs.mkdirSync(portRecordDir, { recursive: true });
  const portFile = path.resolve(portRecordDir, ".dokan-port");
  const portLockDir = path.join(portRecordDir, ".dokan-port.lock");
  const registryDir = path.join(portRecordDir, ".dokan-port.registry");
  const refusalApp = createSchemaRefusalApp(config, error);

  const server = serve(
    { fetch: refusalApp.fetch, port, hostname: config.host },
    async (info) => {
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
      logger.warn("SCHEMA_VERSION_REFUSED", `serving the update-required page on http://${info.address}:${info.port}`);
    },
  );
  server.on("error", (err: NodeJS.ErrnoException) => {
    logger.error("SERVER_ERROR", `could not bind the refusal page on ${config.host}:${port}`, err);
    process.exit(1);
  });
  const shutdown = () => {
    server.close(() => {
      void forgetPortRecord({ portFile, lockDir: portLockDir, registryDir, pid: process.pid }).finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // never resolves: the event loop keeps the refusal server alive
  return new Promise<never>(() => {});
}
