import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { readFileIfExists, writeFileAtomic, writeFileAtomicSync } from "../atomic-file";
import { localDateTime, type AppLogger } from "../logger";
import { VaultAuthenticationError, tokensMatch, type KdfParams } from "./crypto";
import { VaultCore, type VaultHeaderStore, type VaultMetadata } from "./core";
import { VaultFormatError } from "./format";

/**
 * VaultManager — the install-side vault: files, the in-memory unlock state,
 * the persisted unlock throttle, and the owner identity the auth seam reads.
 * It is the only place that knows where `vault.json`, `state.json` and the
 * encrypted snapshot live; the crypto stays in VaultCore.
 */

export type VaultState = "unconfigured" | "locked" | "unlocked" | "invalid";

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
  private pendingSetup: { core: VaultCore; masterKey: Buffer; headerText: string; recoveryKey: string; vaultId: string } | undefined;

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
    return readFileIfExists(this.legacyDbPath) !== undefined;
  }

  /**
   * First run, phase one: build the vault and its first recovery wrap in
   * memory. Nothing is written except through commitSetup(), so a failure
   * while creating the database leaves the install unconfigured and retryable.
   */
  async prepareSetup(passphrase: string): Promise<{ recoveryKey: string; vaultId: string }> {
    if (this.headerExists()) throw new VaultAlreadyConfiguredError();
    const deferred = { text: "" };
    const store: VaultHeaderStore = {
      read: () => undefined,
      write: async (text) => {
        deferred.text = text;
      },
    };
    const { core, masterKey } = await VaultCore.create(store, passphrase, { kdf: this.kdf });
    const recovery = await core.addRecoveryKey(masterKey);
    this.pendingSetup = { core, masterKey, headerText: deferred.text, recoveryKey: recovery.code, vaultId: core.metadata().vaultId };
    return { recoveryKey: recovery.code, vaultId: core.metadata().vaultId };
  }

  /** The prepared master key, for building the first encrypted snapshot. */
  setupMasterKey(): Buffer {
    if (this.pendingSetup === undefined) throw new VaultNotUnlockedError();
    return this.pendingSetup.masterKey;
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
  async commitSetup(): Promise<string> {
    const pending = this.pendingSetup;
    if (pending === undefined) throw new VaultNotUnlockedError();
    await writeFileAtomic(this.headerPath, pending.headerText);
    this.pendingSetup = undefined;
    this.core = pending.core;
    this.replaceMasterKey(pending.masterKey);
    this.sessionToken = this.mintSessionToken();
    await this.resetFailures();
    this.logger.info("VAULT_CREATED", "vault created and unlocked", { version: pending.vaultId });
    return this.sessionToken;
  }

  /** Unlock with the passphrase; returns the in-process session token. */
  async unlock(passphrase: string): Promise<string> {
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
  async unlockRecovery(code: string): Promise<string> {
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

  private async finishUnlock(core: VaultCore, masterKey: Buffer, event: string): Promise<string> {
    this.core = core;
    this.replaceMasterKey(masterKey);
    this.sessionToken = this.mintSessionToken();
    await this.resetFailures();
    const meta = core.metadata();
    this.logger.info(event, "vault unlocked; the owner is signed in", { version: meta.vaultId });
    return this.sessionToken;
  }

  private requireCore(): VaultCore {
    const core = this.core ?? this.openCore();
    if (core === undefined) throw new VaultNotUnlockedError();
    this.core = core;
    return core;
  }

  private mintSessionToken(): string {
    return randomBytes(32).toString("base64url");
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

  async removeRecoveryKey(id: string): Promise<void> {
    const core = this.requireCore();
    await this.enqueue(() => core.removeRecoveryKey(id));
  }

  async changePassphrase(currentPassphrase: string, newPassphrase: string): Promise<void> {
    const core = this.requireCore();
    await this.enqueue(() => core.changePassphrase(currentPassphrase, newPassphrase));
    this.logger.info("VAULT_PASSPHRASE_CHANGED", "vault passphrase changed");
  }

  /** Drain the queued pre-unlock failure events for the activity log. */
  drainPendingEvents(): string[] {
    const state = this.loadThrottle();
    if (state.pendingEvents.length === 0) return [];
    this.saveThrottle({ ...state, pendingEvents: [] });
    return state.pendingEvents;
  }

  /** Zero the in-memory secrets. Best-effort: JavaScript cannot pin memory. */
  close(): void {
    this.replaceMasterKey(undefined);
    this.sessionToken = undefined;
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
      if (parsed.success) return parsed.data;
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
    await this.enqueue(async () => {
      const state = this.loadThrottle();
      const failedAttempts = state.failedAttempts + 1;
      const lockUntil = this.now().getTime() + unlockBackoffMs(failedAttempts);
      const pendingEvents = [...state.pendingEvents, `${event} ${localDateTime(this.now())}`].slice(-200);
      this.saveThrottle({ failedAttempts, lockUntil, pendingEvents });
      const retryAfterMs = Math.max(0, lockUntil - this.now().getTime());
      this.logger.warn("VAULT_ATTEMPT_FAILED", `vault attempt ${failedAttempts} failed${retryAfterMs > 0 ? `; locked for ${Math.ceil(retryAfterMs / 1000)}s` : ""}`);
    });
  }

  private async resetFailures(): Promise<void> {
    await this.enqueue(async () => {
      const state = this.loadThrottle();
      if (state.failedAttempts === 0 && state.lockUntil === 0) return;
      this.saveThrottle({ ...state, failedAttempts: 0, lockUntil: 0 });
    });
  }
}
