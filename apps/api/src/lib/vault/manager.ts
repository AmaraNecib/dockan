import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MIN_VAULT_PASSPHRASE_LENGTH } from "@dokan/contracts";
import { z } from "zod";

import { readFileIfExists, writeFileAtomic, writeFileAtomicSync } from "../atomic-file";
import { localDateTime, type AppLogger } from "../logger";
import { buildEncryptedSnapshot, readLegacyDatabaseImage } from "../../db/encrypted-connection";
import { createVaultBackupBundle } from "./backup";
import { VaultAuthenticationError, normalizePassphrase, tokensMatch, type KdfParams } from "./crypto";
import { VaultCore, type VaultHeaderStore, type VaultMetadata } from "./core";
import { VaultFormatError } from "./format";

/**
 * VaultManager — the install-side vault: files, the in-memory unlock state,
 * the persisted unlock throttle, and the owner identity the auth seam reads.
 * It is the only place that knows where `vault.json`, `state.json` and the
 * encrypted snapshot live; the crypto stays in VaultCore.
 */

export type VaultState = "unconfigured" | "locked" | "unlocked" | "invalid";

/**
 * A minted session token together with the generation it was minted at. The
 * pair is produced atomically so no caller can report a generation newer than
 * the token it returns (round-8 finding 2).
 */
export type VaultSession = { token: string; generation: number };

export type VaultStatus = {
  state: VaultState;
  /** true when a legacy plaintext `dokan.db` is waiting to be migrated */
  legacyDatabase: boolean;
  recoveryKeyCount: number;
  /** ms until the next attempt is accepted; 0 when not locked out */
  lockedForMs: number;
};

/** A wrong passphrase/recovery code. Callers map to the Arabic refusal. */
export class VaultLockedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("VAULT_LOCKED");
    this.name = "VaultLockedError";
  }
}

export class VaultAlreadyConfiguredError extends Error {
  constructor() {
    super("VAULT_ALREADY_CONFIGURED");
    this.name = "VaultAlreadyConfiguredError";
  }
}

/** A first-run setup is already holding the pending slot; settle it first. */
export class VaultSetupInProgressError extends Error {
  constructor() {
    super("VAULT_SETUP_IN_PROGRESS");
    this.name = "VaultSetupInProgressError";
  }
}

export class VaultInvalidError extends Error {
  constructor() {
    super("VAULT_INVALID");
    this.name = "VaultInvalidError";
  }
}

export class VaultNotUnlockedError extends Error {
  constructor() {
    super("VAULT_NOT_UNLOCKED");
    this.name = "VaultNotUnlockedError";
  }
}

export type VaultManagerOptions = {
  dataDir: string;
  /** legacy plaintext database path (migrated on first setup, then deleted) */
  legacyDbPath: string;
  logger: AppLogger;
  now?: () => Date;
  /** override for tests; production uses DEFAULT_KDF_PARAMS */
  kdf?: KdfParams;
};

/** The persisted, non-secret unlock throttle + the activity replay queue. */
type VaultThrottleState = {
  failedAttempts: number;
  lockUntil: number;
  pendingEvents: string[];
};

const throttleSchema = z.object({
  failedAttempts: z.number().int().min(0),
  lockUntil: z.number().int().min(0),
  pendingEvents: z.array(z.string().max(200)).max(200),
});

const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
const MAX_TRACKED_ATTEMPTS = 1_000;

/** Exponential backoff after the free attempts, capped at 15 minutes. */
export function unlockBackoffMs(failedAttempts: number): number {
  if (failedAttempts < FREE_ATTEMPTS) return 0;
  const exponent = Math.min(failedAttempts - FREE_ATTEMPTS, 10);
  return Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** exponent);
}

export class VaultManager {
  readonly vaultDir: string;
  readonly headerPath: string;
  readonly statePath: string;
  readonly snapshotPath: string;
  private readonly legacyDbPath: string;
  private readonly logger: AppLogger;
  private readonly now: () => Date;
  private readonly kdf: KdfParams | undefined;

  private core: VaultCore | undefined;
  private sessionToken: string | undefined;
  private masterKey: Buffer | undefined;
  private currentOwnerId: string | undefined;

  /** prepared first-run state; committed only after the snapshot is on disk */
  private pendingSetup:
    | { core: VaultCore; masterKey: Buffer; headerText: string; recoveryKey: string; vaultId: string; bootstrapping: boolean }
    | undefined;

  /**
   * Bumped on every minted session token. Rotating endpoints return it so the
   * web can ignore an out-of-order response that carries an older session
   * (round-7 finding 5).
   */
  private sessionGeneration = 0;

  /** serialises header/state writes so two unlock attempts cannot interleave */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: VaultManagerOptions) {
    this.vaultDir = path.join(options.dataDir, "vault");
    this.headerPath = path.join(this.vaultDir, "vault.json");
    this.statePath = path.join(this.vaultDir, "state.json");
    this.snapshotPath = path.join(options.dataDir, "dokan.db.enc");
    this.legacyDbPath = options.legacyDbPath;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.kdf = options.kdf;
    // the data dir is created by main before the vault opens, but tests and the
    // atomically-written header must never depend on that order
    fs.mkdirSync(this.vaultDir, { recursive: true });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(job);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private openCore(): VaultCore | undefined {
    const text = readFileIfExists(this.headerPath);
    if (text === undefined) return undefined;
    return VaultCore.open({ read: () => text, write: (next) => Promise.resolve().then(() => writeFileAtomicSync(this.headerPath, next)) }, { kdf: this.kdf });
  }

  status(): VaultStatus {
    const headerText = readFileIfExists(this.headerPath);
    const legacyDatabase = this.legacyDatabaseExists();
    let state: VaultState;
    let recoveryKeyCount = 0;
    if (headerText === undefined) {
      state = "unconfigured";
    } else if (this.masterKey !== undefined) {
      state = "unlocked";
      recoveryKeyCount = this.core?.recoveryCount() ?? 0;
    } else {
      try {
        const core = this.openCore();
        recoveryKeyCount = core?.recoveryCount() ?? 0;
        state = "locked";
      } catch (error) {
        if (error instanceof VaultFormatError) state = "invalid";
        else throw error;
      }
    }
    return { state, legacyDatabase, recoveryKeyCount, lockedForMs: this.lockedForMs() };
  }

  /** True when the header exists (in any state, including invalid). */
  private headerExists(): boolean {
    return readFileIfExists(this.headerPath) !== undefined;
  }

  private legacyDatabaseExists(): boolean {
    // existence only: status() runs on every locked poll, and reading a whole
    // (possibly multi-GB) legacy SQLite file here blocked the API (round-7
    // finding 7). main.ts reads the file once, for the actual migration.
    return fs.existsSync(this.legacyDbPath);
  }

  /**
   * First run, phase one: build the vault and its first recovery wrap in
   * memory. Nothing is written except through commitSetup(), so a failure
   * while creating the database leaves the install unconfigured and retryable.
   */
  async prepareSetup(passphrase: string): Promise<{ recoveryKey: string; vaultId: string }> {
    return this.enqueue(async () => {
      if (this.headerExists()) throw new VaultAlreadyConfiguredError();
      // single-flight: a second concurrent first-run request must never
      // overwrite the pending header/master key, or the committed header and
      // the key returned to the other caller would not match
      if (this.pendingSetup !== undefined) throw new VaultSetupInProgressError();
      if (normalizePassphrase(passphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) {
        throw new Error("VAULT_PASSPHRASE_TOO_SHORT");
      }
      const deferred = { text: "" };
      const store: VaultHeaderStore = {
        read: () => undefined,
        write: async (text) => {
          deferred.text = text;
        },
      };
      const { core, masterKey } = await VaultCore.create(store, passphrase, { kdf: this.kdf });
      let recovery;
      try {
        recovery = await core.addRecoveryKey(masterKey);
      } catch (error) {
        // never leak the prepared key if the first recovery wrap fails
        masterKey.fill(0);
        throw error;
      }
      this.pendingSetup = { core, masterKey, headerText: deferred.text, recoveryKey: recovery.code, vaultId: core.metadata().vaultId, bootstrapping: true };
      return { recoveryKey: recovery.code, vaultId: core.metadata().vaultId };
    });
  }

  /**
   * The preparing request's bootstrap finished; only now may another request
   * resume-commit the pending setup (round-7 finding 1). Until this is called,
   * a resume would hand out the recovery key and a session for an app that the
   * first request can still fail to boot.
   */
  finishSetupBootstrap(): void {
    if (this.pendingSetup === undefined) return;
    this.pendingSetup.bootstrapping = false;
  }

  /** The prepared master key, for building the first encrypted snapshot. */
  setupMasterKey(): Buffer {
    if (this.pendingSetup === undefined) throw new VaultNotUnlockedError();
    return this.pendingSetup.masterKey;
  }

  /** The prepared recovery key, so a failed header write can be resumed. */
  pendingRecoveryKey(): string | undefined {
    return this.pendingSetup?.recoveryKey;
  }

  /** Drop a prepared-but-uncommitted setup (a failed first snapshot attempt). */
  abortSetup(): void {
    if (this.pendingSetup === undefined) return;
    this.pendingSetup.masterKey.fill(0);
    this.pendingSetup = undefined;
  }

  /**
   * First run, phase two (commit): the snapshot exists, so the header may be
   * written now. After this the vault is unlocked for the session: the setup
   * flow continues straight into owner provisioning.
   */
  async commitSetup(): Promise<VaultSession> {
    return this.enqueue(async () => {
      // a concurrent retry may have committed the same pending setup first;
      // that is a success, not a missing-vault error
      if (this.pendingSetup === undefined) {
        if (this.sessionToken !== undefined) return { token: this.sessionToken, generation: this.sessionGeneration };
        throw new VaultNotUnlockedError();
      }
      return this.commitPending();
    });
  }

  /**
   * Resume a first-run attempt that wrote its snapshot but whose header write
   * failed (finding 3). A request that finds setup in progress may only commit
   * when the snapshot already exists, AND it must authenticate as the pending
   * setup's owner: without this, any local HTTP client could submit a
   * different passphrase and walk away with the first caller's recovery key
   * and session token (round-4 security finding).
   */
  async resumeSetup(passphrase: string): Promise<VaultSession> {
    this.assertAttemptAllowed();
    return this.enqueue(async () => {
      const pending = this.pendingSetup;
      if (pending === undefined) throw new VaultNotUnlockedError();
      // the first request may still be bootstrapping the app: never commit (and
      // release the recovery key) for an app that can still fail to boot
      if (pending.bootstrapping) throw new VaultSetupInProgressError();
      if (!fs.existsSync(this.snapshotPath)) throw new VaultSetupInProgressError();
      // verify against the PENDING passphrase wrap before releasing anything
      try {
        const masterKey = pending.core.unlockPassphrase(passphrase);
        masterKey.fill(0);
      } catch (error) {
        if (error instanceof VaultAuthenticationError) {
          // must not re-enqueue: resumeSetup already holds the write queue
          await this.recordFailureInternal("VAULT_SETUP_RESUME_FAILED");
          throw error;
        }
        throw error;
      }
      return this.commitPending();
    });
  }

  private async commitPending(): Promise<VaultSession> {
    const pending = this.pendingSetup;
    if (pending === undefined) throw new VaultNotUnlockedError();
    await writeFileAtomic(this.headerPath, pending.headerText);
    this.pendingSetup = undefined;
    // Re-open from disk instead of keeping the prepared core: the prepared
    // core's store was a deferred buffer (nothing may be written before the
    // snapshot exists), so later credential changes would silently never be
    // persisted (found by the round-7 backup-refresh test).
    const committedCore = this.openCore();
    if (committedCore === undefined) throw new Error("the committed vault header could not be read back");
    this.core = committedCore;
    this.replaceMasterKey(pending.masterKey);
    const session = this.mintSession();
    // must not enqueue again: the caller already holds the write queue
    await this.resetFailuresInternal();
    this.logger.info("VAULT_CREATED", "vault created and unlocked", { version: pending.vaultId });
    return session;
  }

  /** Unlock with the passphrase; returns the freshly minted session. */
  async unlock(passphrase: string): Promise<VaultSession> {
    this.assertAttemptAllowed();
    const core = this.requireCore();
    try {
      const masterKey = core.unlockPassphrase(passphrase);
      return await this.finishUnlock(core, masterKey, "VAULT_UNLOCKED");
    } catch (error) {
      if (error instanceof VaultAuthenticationError) {
        await this.recordFailure("VAULT_UNLOCK_FAILED");
        throw error;
      }
      throw error;
    }
  }

  /** Unlock with one recovery code; other codes stay valid. */
  async unlockRecovery(code: string): Promise<VaultSession> {
    this.assertAttemptAllowed();
    const core = this.requireCore();
    try {
      const masterKey = core.unlockRecovery(code);
      return await this.finishUnlock(core, masterKey, "VAULT_RECOVERY_UNLOCKED");
    } catch (error) {
      if (error instanceof VaultAuthenticationError) {
        await this.recordFailure("VAULT_RECOVERY_FAILED");
        throw error;
      }
      throw error;
    }
  }

  private async finishUnlock(core: VaultCore, masterKey: Buffer, event: string): Promise<VaultSession> {
    this.core = core;
    this.replaceMasterKey(masterKey);
    const session = this.mintSession();
    await this.enqueue(() => this.resetFailuresInternal());
    const meta = core.metadata();
    this.logger.info(event, "vault unlocked; the owner is signed in", { version: meta.vaultId });
    return session;
  }

  private requireCore(): VaultCore {
    const core = this.core ?? this.openCore();
    if (core === undefined) throw new VaultNotUnlockedError();
    this.core = core;
    return core;
  }

  private mintSession(): VaultSession {
    this.sessionGeneration += 1;
    const token = randomBytes(32).toString("base64url");
    this.sessionToken = token;
    return { token, generation: this.sessionGeneration };
  }

  /** Monotonic session generation; see the field comment (round-7 finding 5). */
  sessionEpoch(): number {
    return this.sessionGeneration;
  }

  sessionMatches(token: string | null | undefined): boolean {
    if (this.sessionToken === undefined) return false;
    return tokensMatch(token, this.sessionToken);
  }

  get unlocked(): boolean {
    return this.masterKey !== undefined;
  }

  /** The master key for the encrypted store. Never log or serialise it. */
  requireMasterKey(): Buffer {
    if (this.masterKey === undefined) throw new VaultNotUnlockedError();
    return this.masterKey;
  }

  ownerId(): string | undefined {
    return this.currentOwnerId;
  }

  setOwnerId(ownerId: string): void {
    this.currentOwnerId = ownerId;
  }

  metadata(): VaultMetadata {
    const core = this.pendingSetup?.core ?? this.requireCore();
    return core.metadata();
  }

  async addRecoveryKey(): Promise<{ id: string; code: string; createdAt: string }> {
    const core = this.requireCore();
    return this.enqueue(() => core.addRecoveryKey(this.requireMasterKey()));
  }

  async removeRecoveryKey(id: string): Promise<VaultSession> {
    const core = this.requireCore();
    // serialize the mutation and its rotation: concurrent credential changes
    // must not interleave rotations, or a response can carry a token that a
    // later rotation already revoked (round-7 finding 5)
    return this.enqueue(async () => {
      await core.removeRecoveryKey(id);
      // deleting a credential revokes every session minted before it: rotate
      // the in-process token and return the fresh one for the caller's client
      return this.rotateSession("VAULT_RECOVERY_KEY_REMOVED");
    });
  }

  async changePassphrase(currentPassphrase: string, newPassphrase: string): Promise<VaultSession> {
    this.assertAttemptAllowed();
    const core = this.requireCore();
    let session: VaultSession;
    try {
      session = await this.enqueue(async () => {
        await core.changePassphrase(currentPassphrase, newPassphrase);
        return this.rotateSession("VAULT_PASSPHRASE_CHANGED");
      });
    } catch (error) {
      // a wrong current passphrase is an unlock attempt and feeds the same
      // persisted backoff as the unlock screen
      if (error instanceof VaultAuthenticationError) await this.recordFailure("VAULT_CHANGE_PASSPHRASE_FAILED");
      throw error;
    }
    this.logger.info("VAULT_PASSPHRASE_CHANGED", "vault passphrase changed");
    // the old passphrase (and every token minted while it was valid) is refused
    // from now on; the caller keeps working on the freshly minted token
    return session;
  }

  /**
   * Recovery-authorised passphrase reset (C4): the recovery key unwraps the
   * master key, which then re-wraps a new passphrase. No current passphrase is
   * needed — that is the whole point of recovery.
   */
  async setPassphraseFromRecovery(recoveryKey: string, newPassphrase: string): Promise<VaultSession> {
    this.assertAttemptAllowed();
    if (normalizePassphrase(newPassphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) throw new Error("VAULT_PASSPHRASE_TOO_SHORT");
    const core = this.requireCore();
    let masterKey: Buffer;
    try {
      masterKey = core.unlockRecovery(recoveryKey);
    } catch (error) {
      if (error instanceof VaultAuthenticationError) await this.recordFailure("VAULT_RECOVERY_RESET_FAILED");
      throw error;
    }
    try {
      return await this.enqueue(async () => {
        try {
          await core.setPassphraseFromMasterKey(masterKey, newPassphrase);
        } finally {
          masterKey.fill(0);
        }
        await this.resetFailuresInternal();
        this.logger.info("VAULT_PASSPHRASE_RESET", "vault passphrase set from a recovery key");
        return this.rotateSession("VAULT_PASSPHRASE_RESET");
      });
    } finally {
      masterKey.fill(0);
    }
  }

  private rotateSession(event: string): VaultSession {
    const session = this.mintSession();
    this.logger.info(event, "vault session rotated after a credential change");
    return session;
  }

  /** Result of a plaintext sweep: paths that are still readable in the clear. */
  async cleanupLegacyPlaintext(): Promise<{ plaintextRemaining: string[] }> {
    const remaining: string[] = [];
    if (!this.headerExists()) return { plaintextRemaining: remaining };
    // 1. the live legacy database and its sidecars
    for (const suffix of ["", "-wal", "-shm"] as const) {
      const candidate = `${this.legacyDbPath}${suffix}`;
      try {
        await fs.promises.unlink(candidate);
        this.logger.warn("VAULT_LEGACY_PLAINTEXT_REMOVED", `removed stale plaintext database ${candidate}`);
      } catch (error) {
        // SAFETY: the `"code" in error` probe establishes the NodeJS errno shape
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        remaining.push(candidate);
        this.logger.error(
          "VAULT_LEGACY_PLAINTEXT_STAYED",
          `could not remove plaintext database ${candidate}; will retry on next unlock`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    // 2. historical plaintext backups (finding: they survived the migration):
    // each is converted to a self-contained bundle under a `.dknvbak` name, so
    // the backup history stays restorable without leaving shop data readable
    // on the stick; converted files are never scanned again (round-4 perf)
    remaining.push(...(await this.encryptLegacyBackups()));
    return { plaintextRemaining: remaining };
  }

  /** Read only the leading magic bytes of a file; never the whole file. */
  private async readHead(file: string, length = 16): Promise<Buffer> {
    const handle = await fs.promises.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /**
   * Convert every plaintext `backups/*.db` into `*.dknvbak` bundles. The
   * plaintext file is deleted only after the bundle is on disk; the next
   * unlock retries anything left. Converted names are the durable "already
   * done" marker, so a migrated history is never rescanned or read again.
   */
  private async encryptLegacyBackups(): Promise<string[]> {
    const masterKey = this.masterKey;
    const headerText = readFileIfExists(this.headerPath);
    if (masterKey === undefined || headerText === undefined) return [];
    const backupsDir = path.join(path.dirname(this.legacyDbPath), "backups");
    let entries: string[];
    try {
      entries = await fs.promises.readdir(backupsDir);
    } catch {
      return [];
    }
    const vaultId = this.core?.metadata().vaultId ?? "";
    if (vaultId === "") return [];
    const remaining: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith("dokan-") || !entry.endsWith(".db")) continue;
      const file = path.join(backupsDir, entry);
      let head: Buffer;
      try {
        head = await this.readHead(file);
      } catch {
        remaining.push(file);
        continue;
      }
      // already converted (or not a plaintext database): nothing to do
      if (head.toString("utf8") !== "SQLite format 3\u0000") continue;
      const converted = file.replace(/\.db$/i, ".dknvbak");
      try {
        const { image } = readLegacyDatabaseImage(file);
        const bundle = createVaultBackupBundle(headerText, buildEncryptedSnapshot(masterKey, vaultId, image));
        await writeFileAtomic(converted, bundle);
        // the plaintext original leaves only after its replacement is durable
        try {
          await fs.promises.unlink(file);
        } catch (error) {
          remaining.push(file);
          this.logger.error(
            "VAULT_LEGACY_BACKUP_STAYED",
            `encrypted copy of ${entry} was written but the plaintext original could not be deleted`,
            error instanceof Error ? error : new Error(String(error)),
          );
          continue;
        }
        for (const suffix of ["-wal", "-shm"] as const) {
          try {
            await fs.promises.unlink(`${file}${suffix}`);
          } catch {
            /* no sidecar */
          }
        }
        this.logger.info("VAULT_LEGACY_BACKUP_ENCRYPTED", `encrypted legacy plaintext backup ${entry} as ${path.basename(converted)}`);
      } catch (error) {
        remaining.push(file);
        this.logger.error(
          "VAULT_LEGACY_BACKUP_STAYED",
          `could not encrypt legacy plaintext backup ${entry}; it still contains readable shop data`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return remaining;
  }

  /** Revoke the in-process session (logout): every existing token stops working. */
  revokeSession(): void {
    if (this.sessionToken === undefined) return;
    this.dropSession();
    this.logger.info("VAULT_SESSION_REVOKED", "vault session revoked (logout)");
  }

  /**
   * Drop the live token AND advance the generation (#319 round 3).
   *
   * The generation means "still live": `sessionResponse` treats a minting
   * reply as arbitrated-out when its generation no longer equals
   * `sessionEpoch()`. A logout or a lock that dropped the token without moving
   * the number left the epoch describing a session that was already gone, so a
   * slow minting reply landing AFTER the logout still matched and installed a
   * `Set-Cookie` for a token `sessionMatches` refuses — every window then fell
   * to the unlock screen while the API held no session at all.
   */
  private dropSession(): void {
    this.sessionToken = undefined;
    this.sessionGeneration += 1;
  }

  /** Drain the queued pre-unlock failure events for the activity log. */
  async drainPendingEvents(): Promise<string[]> {
    return this.enqueue(async () => {
      const state = this.loadThrottle();
      if (state.pendingEvents.length === 0) return [];
      this.saveThrottle({ ...state, pendingEvents: [] });
      return state.pendingEvents;
    });
  }

  /** Zero the in-memory secrets. Best-effort: JavaScript cannot pin memory. */
  close(): void {
    this.replaceMasterKey(undefined);
    // the lock drops the session too, so it must move the generation: an
    // in-flight minting reply that lands after the lock carries a generation
    // that is no longer live, and installs nothing (see dropSession). No log
    // line: `VAULT_SESSION_REVOKED` names a logout, and a lock is not one.
    if (this.sessionToken !== undefined) this.dropSession();
  }

  private replaceMasterKey(next: Buffer | undefined): void {
    if (this.masterKey !== undefined) this.masterKey.fill(0);
    this.masterKey = next;
  }

  private lockedForMs(): number {
    const state = this.loadThrottle();
    return Math.max(0, state.lockUntil - this.now().getTime());
  }

  private assertAttemptAllowed(): void {
    const lockedFor = this.lockedForMs();
    if (lockedFor > 0) throw new VaultLockedError(lockedFor);
  }

  private loadThrottle(): VaultThrottleState {
    const text = readFileIfExists(this.statePath);
    if (text === undefined) return { failedAttempts: 0, lockUntil: 0, pendingEvents: [] };
    try {
      const parsed = throttleSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        // clamp hostile/tampered values: a hand-edited state.json must not lock
        // the owner out for years, and a huge counter must not overflow backoff
        return {
          ...parsed.data,
          failedAttempts: Math.min(parsed.data.failedAttempts, MAX_TRACKED_ATTEMPTS),
          lockUntil: Math.min(parsed.data.lockUntil, this.now().getTime() + MAX_LOCK_MS),
        };
      }
    } catch {
      // fall through to the safe default; a corrupt throttle must not brick boot
    }
    this.logger.warn("VAULT_STATE_RESET", "vault throttle state was unreadable; starting from zero attempts");
    return { failedAttempts: 0, lockUntil: 0, pendingEvents: [] };
  }

  private saveThrottle(state: VaultThrottleState): void {
    writeFileAtomicSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async recordFailure(event: string): Promise<void> {
    await this.enqueue(() => this.recordFailureInternal(event));
  }

  /** Must not be called while holding the write queue (see resumeSetup). */
  private async recordFailureInternal(event: string): Promise<void> {
    const state = this.loadThrottle();
    const failedAttempts = state.failedAttempts + 1;
    const lockUntil = this.now().getTime() + unlockBackoffMs(failedAttempts);
    const pendingEvents = [...state.pendingEvents, `${event} ${localDateTime(this.now())}`].slice(-200);
    this.saveThrottle({ failedAttempts, lockUntil, pendingEvents });
    const retryAfterMs = Math.max(0, lockUntil - this.now().getTime());
    this.logger.warn("VAULT_ATTEMPT_FAILED", `vault attempt ${failedAttempts} failed${retryAfterMs > 0 ? `; locked for ${Math.ceil(retryAfterMs / 1000)}s` : ""}`);
  }

  private async resetFailuresInternal(): Promise<void> {
    const state = this.loadThrottle();
    if (state.failedAttempts === 0 && state.lockUntil === 0) return;
    this.saveThrottle({ ...state, failedAttempts: 0, lockUntil: 0 });
  }
}
