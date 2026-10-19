import fs from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { MIN_VAULT_PASSPHRASE_LENGTH, type PlaintextCleanupStatus, type VaultErrorCode } from "@dokan/contracts";
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
import { classifyPlaintextCleanup } from "./lib/vault/cleanup-status";
import { createOverlay, type RequestHandler } from "./lib/overlay";
import { shouldReconcilePortRecord } from "./lib/port-reconcile";
import { forgetPort as forgetPortRecord, portIsReachable, publishPort } from "./lib/port-record";
import { createSchemaRefusalApp, guardBootStep } from "./lib/schema-refusal";
import { UnsupportedSchemaVersionError, assertSchemaVersionSupported } from "./lib/schema-version";
import { ensureSessionSecret } from "./lib/session-secret";
import { VaultAuthenticationError, normalizePassphrase } from "./lib/vault/crypto";
import { VaultFormatError } from "./lib/vault/format";
import { createVaultHttpApp, type VaultBootstrapInput } from "./lib/vault/http";
import { readyHandlerFor } from "./lib/vault/boot-loss";
import { ReclaimRetry } from "./lib/vault/reclaim-retry";
import { closeVaultThenReleaseLock, connectionToCloseAtShutdown, createVaultLockRefusalApp, requireHeldLock, VaultAlreadyLockedError, VaultLockLostError, VaultLockUnreadableError, acquireVaultLock, type VaultLock, type VaultLockOwner } from "./lib/vault/lock";
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
/** true once this instance lost the folder to another copy (fail-stop) */
let lockLost = false;
/**
 * Set when this start was refused because another copy owns the folder
 * (#277): the instance serves the in-use refusal on its own listener and
 * keeps retrying, holding no lock and writing nothing. `refused` stays true
 * even when the lock record's owner could not be read.
 */
let refused = false;
/** The holder named to the owner while refused (may be unknown). */
let refusalOwner: VaultLockOwner | undefined;
/** The reclaim loop while refused; cleared once this instance owns the folder. */
let reclaim: ReclaimRetry<VaultLockOwner> | undefined;
if (config.vault === "on") {
  try {
    vaultLock = acquireVaultLock(config.dataDir, { logger, onLost: onLockLost });
  } catch (error) {
    if (error instanceof VaultAlreadyLockedError) {
      // Do not exit and do not serve a standalone page: this instance binds
      // its own listener with the refusal and keeps trying to take the folder,
      // so closing the holder lets the owner in without a restart (#277).
      refused = true;
      refusalOwner = error.owner;
    } else if (error instanceof VaultLockUnreadableError) {
      // NOT the same state, and deliberately not retried (#287): the lock file
      // exists but cannot be parsed or read, so nothing will change until the
      // owner acts. The page names the file and says what to delete; a retry
      // loop would hide that behind a spinner that never resolves.
      await serveLockRefusal(config, error);
    } else {
      logger.error(
        "VAULT_LOCK_FAILED",
        "the vault data folder could not be locked",
        error instanceof Error ? error : new Error(String(error)),
      );
      process.exit(1);
    }
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

/**
 * The refusal a running instance serves the moment it loses the folder: the
 * same app a refused second instance serves, on the port this instance
 * already owns. It opens no second listener and touches no port record. The
 * boot-token echo stays, so the desktop shell keeps verifying this child
 * instead of treating the refusal as a dead sidecar.
 */
function buildLockRefusalHandler(holder: VaultLockOwner | undefined): RequestHandler {
  // the holder-free variant takes no path: there is no lock file to name when
  // this instance never held the folder, and an empty-string sentinel would be
  // worse than omitting it
  const app = createVaultLockRefusalApp(config, new VaultAlreadyLockedError(holder));
  return (request, env) => app.fetch(request, env);
}

/**
 * The fail-stop once this instance loses the folder (ADR-0012 clause 3): stop
 * serving writes at once and answer the in-use refusal on the port already
 * bound. An exiting sidecar left the shell's broker with nothing to talk to, so
 * the web fell back to "server unreachable" — the wrong diagnosis. No second
 * listener, no port-record publication, no new writes. The single
 * VAULT_LOCK_LOST line is emitted by the lock itself.
 */
function onLockLost(_reason: string, holder?: VaultLockOwner): void {
  lockLost = true;
  activeHandler = buildLockRefusalHandler(holder);
}

/**
 * The handler a refused start serves (#277). Every request is also a
 * deliberate retry: it asks the folder again before answering, so the screen's
 * retry is never slower than the automatic backoff. When the reclaim wins,
 * `onAcquired` swaps in the vault gate and this request is answered through it.
 */
function buildRefusedHandler(): RequestHandler {
  let cached: RequestHandler | undefined;
  let cachedOwnerToken: string | undefined;
  const serveRefusal: RequestHandler = (request, env) => {
    reclaim?.trigger();
    const current = activeHandler;
    if (current !== serveRefusal) return current(request, env);
    if (cached === undefined || cachedOwnerToken !== refusalOwner?.token) {
      cachedOwnerToken = refusalOwner?.token;
      cached = buildLockRefusalHandler(refusalOwner);
    }
    return cached(request, env);
  };
  return serveRefusal;
}

/**
 * Retry the reclaim while the refusal is served (#277): bounded backoff, one
 * attempt per tick, and an immediate re-check on every request. Resolves once
 * this instance owns the folder, without a restart and without a second
 * listener (the handler swaps on the server already bound).
 */
async function reclaimUntilOwned(): Promise<void> {
  await new Promise<void>((resolve) => {
    // VaultLockUnavailableError during a retry is logged once, never per tick:
    // a folder that stays unwritable must not grow the log without bound.
    let unavailableLogged = false;
    const loop = new ReclaimRetry<VaultLockOwner>({
      attempt: () => {
        try {
          vaultLock = acquireVaultLock(config.dataDir, { logger, onLost: onLockLost });
          return { ok: true };
        } catch (error) {
          if (error instanceof VaultAlreadyLockedError) return { ok: false, owner: error.owner };
          if (!unavailableLogged) {
            unavailableLogged = true;
            logger.error(
              "VAULT_LOCK_FAILED",
              "the vault data folder could not be locked",
              error instanceof Error ? error : new Error(String(error)),
            );
          }
          return { ok: false, owner: refusalOwner };
        }
      },
      onRefused: (owner) => {
        refusalOwner = owner;
      },
      onAcquired: () => {
        refusalOwner = undefined;
        reclaim = undefined;
        logger.info("VAULT_LOCK_RECLAIMED", "the refused instance took the data folder; serving the vault gate");
        activeHandler = buildOverlay(undefined);
        // now (and only now) the proxy may be pointed at this instance
        if (boundPort !== undefined) void publishOwnedPort(boundPort);
        resolve();
      },
    });
    reclaim = loop;
    loop.start();
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
  // ADR-0012 clause 3: every snapshot write re-checks that this process still
  // owns the folder, so a persist queued before another copy reclaimed the
  // lock cannot overwrite that copy's data (the heartbeat alone is too slow).
  // Fail loud, never open: a missing lock must not turn the guard into a no-op.
  storeInput.writeGuard = requireHeldLock(vaultLock);
  const { conn, store } = openVaultStore(storeInput);
  // A committed unit that cannot be written to its snapshot is fail-stop: the
  // client must never get a "failed" answer for something already committed
  // (a retry would duplicate a sale/payment). Exiting here means the client
  // sees a connection loss, not a business refusal.
  conn.onFatalError = (error) => {
    // A lost lock is not a snapshot failure: the write-path guard refused the
    // write, and the lock's fail-stop already switched this instance to the
    // in-use refusal. Exiting here would reproduce the bug this change fixes
    // (the shell's broker would have nothing to talk to). The swallow is
    // deliberate, but never wordless: the log must name the refusal, so an
    // offline sale is not attributed to a disk failure.
    if (error instanceof VaultLockLostError) {
      logger.error(
        "SERVER_ERROR",
        "the encrypted snapshot write was refused: another copy owns the folder; this instance is serving the in-use refusal",
      );
      return;
    }
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
    if (readyHandlerFor(lockLost) === "refused") {
      // The folder was taken while this instance was booting (a heartbeat or a
      // guarded write). Never install the live app: a mutation would commit in
      // SQLite, its guarded persist would fail, and a retry would re-execute
      // against the real app. Throwing refuses every caller at one place; a
      // plain return left the broker free to commit the setup header and unlink
      // plaintext files in a folder another copy owns.
      logger.error("SERVER_ERROR", "the vault opened while another copy owns the folder; keeping the in-use refusal");
      throw new VaultLockLostError(vaultLock?.path ?? vault.headerPath);
    }
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
    // the header exists and a self-contained backup can actually be written.
    // The cleanup above awaits, so a loss can land inside it: never start a
    // backup in a folder another copy owns.
    if (!input.fresh && readyHandlerFor(lockLost) === "live") await runVaultDailyBackup();
    logger.info("SERVER_BOOT_DONE", "vault store and auth ready", { driver: "sqlite-encrypted" });
  } catch (error) {
    // a lost folder abandons the store: closing it would run the final
    // checkpoint over the new owner's snapshot (ADR-0012 clause 3)
    if (!lockLost) await conn.close();
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
  /**
   * True once another copy owns the folder. `unlocked` is then false and
   * `state` reads `"locked"` even though the manager still holds the
   * in-memory image, so the shell neither reports a healthy unlocked vault nor
   * sends an unlock down the broker while HTTP serves the refusal.
   */
  lockLost: boolean;
};

/** The gate status over the pipe (the HTTP status fields, plus `lockLost`). */
function brokerStatusPayload(vault: VaultManager): VaultStatusPayload {
  const status = vault.status();
  const unlocked = vault.unlocked && !lockLost;
  return {
    mode: "vault",
    // a lost folder is a refusal, not an unlocked vault: reporting state
    // "unlocked" with unlocked:false invites the shell to send exactly the
    // unlock the broker must refuse
    state: lockLost ? "locked" : status.state,
    legacyDatabase: status.legacyDatabase,
    // never advertise the wrap inventory before unlock (or after a loss)
    recoveryKeyCount: unlocked ? status.recoveryKeyCount : 0,
    lockedForMs: status.lockedForMs,
    unlocked,
    broker: true,
    lockLost,
  };
}

type BrokerReply =
  | { ok: true; sessionToken: string; sessionGeneration?: number; recoveryKey?: string; plaintextRemaining?: string[] }
  | { ok: true; status: VaultStatusPayload }
  | { ok: true; warning: "plaintext"; plaintextStatus: PlaintextCleanupStatus; plaintextRemaining: string[] }
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
    // ADR-0012 clause 3: the broker is a second entry point over stdin, and the
    // HTTP refusal does not close it. Once another copy owns the folder no
    // action may reach the header, the snapshot or the plaintext sweep, and no
    // session may be promised: answer the same typed refusal the HTTP port
    // serves, and keep the loop alive so the shell can still ask for status.
    if (lockLost) {
      writeBrokerReply({ ok: false, code: "VAULT_LOCKED_BY_OTHER_INSTANCE" });
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
        // bootstrap throws VaultLockLostError when the folder is taken mid-boot, and
        // the catch answers the typed refusal over the pipe. It also RETURNS EARLY
        // when the app is already up, so a loss during its own await slips past the
        // throw: refuse here too, before the header is committed, exactly as the
        // unlock branch below does
        await bootstrapVault({ masterKey: vault.setupMasterKey(), vaultId: prepared.vaultId, fresh: true });
        if (lockLost) {
          writeBrokerReply({ ok: false, code: "VAULT_LOCKED_BY_OTHER_INSTANCE" });
          continue;
        }
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
        // the follow-up the shell waits for on its own (longer) budget; a
        // sweep that throws reports UNKNOWN, never a clean empty warning. A
        // loss between the header commit and this sweep means the folder is not
        // ours: never unlink in it, and report an honest UNKNOWN.
        const skippedCleanup = { status: "unknown", remaining: [] } satisfies { status: PlaintextCleanupStatus; remaining: string[] };
        const cleanup = lockLost
          ? skippedCleanup
          : await classifyPlaintextCleanup(
              () => vault.cleanupLegacyPlaintext(),
              (error) =>
                logger.error("VAULT_SETUP_CLEANUP_FAILED", "plaintext files could not be removed after vault setup", error),
            );
        if (cleanup.status === "remaining") {
          logger.warn("VAULT_PLAINTEXT_REMAINS", `plaintext files still readable after setup: ${cleanup.remaining.join(", ")}`);
        }
        writeBrokerReply({
          ok: true,
          warning: "plaintext",
          plaintextStatus: cleanup.status,
          plaintextRemaining: cleanup.remaining,
        });
        // the first daily backup needs the committed header, which now exists
        if (!lockLost) await runVaultDailyBackup();
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
      // bootstrap throws when it has to open the store in a folder that is no
      // longer ours, but it returns early when the app is already up: a loss
      // during the unlock await must still refuse here, because promising a
      // session would hand the shell a token every HTTP path rejects
      if (lockLost) {
        writeBrokerReply({ ok: false, code: "VAULT_LOCKED_BY_OTHER_INSTANCE" });
        continue;
      }
      writeBrokerReply({ ok: true, sessionToken: session.token, sessionGeneration: session.generation });
      return;
    } catch (error) {
      // a guarded write inside the request may have discovered the loss: answer
      // the typed refusal and keep the broker alive rather than exiting (the
      // shell needs a process to talk to, and the store is now abandoned)
      if (error instanceof VaultLockLostError) {
        writeBrokerReply({ ok: false, code: "VAULT_LOCKED_BY_OTHER_INSTANCE" });
        continue;
      }
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
/** The port the server actually bound; set in the listen callback. */
let boundPort: number | undefined;
/** True once this process wrote its own registry entry (shutdown reaps only its own). */
let portPublished = false;

/**
 * Publish the port record for a folder this instance owns. Split from the bind
 * callback because a refused start binds before it owns anything and must not
 * touch the owning instance's record (#277); it publishes after it reclaims.
 * A publication failure is a boot failure: running while Vite still walks the
 * previous record would strand /api traffic, so fail loudly instead of
 * discarding the rejection.
 */
async function publishOwnedPort(port: number): Promise<void> {
  try {
    await publishPort({ portFile, lockDir: portLockDir, registryDir, pid: process.pid, host: config.host, port });
    portPublished = true;
  } catch (err) {
    // SAFETY: every rejection path throws an Error (lock timeout / fs error)
    logger.error("SERVER_ERROR", `port record publication failed after binding ${port}`, err as Error);
    process.exit(1);
  }
}

function startServer(): void {
  server = serve(
    { fetch: (request, env) => activeHandler(request, env), port, hostname: config.host },
    async (info) => {
      boundPort = info.port;
      // A refused start does not own the folder yet: publishing would point
      // the proxy (and the owner's clients) at the refusal server, so it
      // stays silent until the reclaim succeeds (#277, round-7 finding 2).
      // Only a REFUSED start suppresses publication (#277). Plaintext starts
      // have no vault lock at all and still own the port, so keying this off
      // `vaultLock` alone silently broke port discovery for
      // DOKAN_VAULT=disabled (Greptile P1): Vite kept walking the previous
      // record while the API listened somewhere else.
      if (refused) {
        logger.warn(
          "VAULT_LOCK_REFUSED",
          `serving the in-use refusal on http://${info.address}:${info.port} (port record untouched: another instance owns the folder)`,
        );
      } else {
        await publishOwnedPort(info.port);
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
    // A lost lock means another instance owns the folder now. Closing this
    // connection would run a final checkpoint over ITS snapshot, so the
    // abandoned store is left alone: no request can reach it any more, and
    // the replacement instance's data is never overwritten (ADR-0012).
    await closeVaultThenReleaseLock(connectionToCloseAtShutdown(lockLost, activeConnection), vaultLock);
  } catch (err) {
    logger.error("SERVER_ERROR", "store close failed during shutdown", err instanceof Error ? err : new Error(String(err)));
  }
}

/** Cleanup must be observable: exiting successfully after a failed reconcile
 * leaves the proxy with stale discovery data. */
async function reconcileBeforeExit(): Promise<void> {
  // A refused instance that never published has no entry of its own; probing
  // survivors to recompute canonical would still touch the owner's record, so
  // it stays out of the port record entirely (#277).
  if (!shouldReconcilePortRecord(portPublished)) return;
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
  // Stop the reclaim loop FIRST (Greptile P2): a pending tick that wins during
  // shutdown would take the lock and publish a port whose listener is already
  // closing, stranding the proxy on a dead record until the process exits.
  reclaim?.stop();
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
  activeHandler = refused ? buildRefusedHandler() : buildOverlay(undefined);
  startServer();
  // A refused start serves the refusal from the listener it just bound and
  // retries the folder in the background; the broker (packaged shells) starts
  // with the vault gate once the folder is ours.
  if (refused) await reclaimUntilOwned();
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
 * The unreadable-lock refusal (#287): the file exists but cannot be parsed or
 * read, so no vault file is opened and the owner is told which file to remove.
 * A held lock does NOT come here — it takes the retry path above instead.
 */
async function serveLockRefusal(config: AppConfig, error: VaultLockUnreadableError): Promise<never> {
  // another instance may own the shared port record; this page must not
  // overwrite it (round-7 finding 2)
  return serveRefusalServer(config, createVaultLockRefusalApp(config, error), "VAULT_LOCK_REFUSED", { publishPortRecord: false });
}
