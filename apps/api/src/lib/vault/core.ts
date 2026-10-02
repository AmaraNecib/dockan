import { randomUUID } from "node:crypto";

import { MIN_VAULT_PASSPHRASE_LENGTH } from "@dokan/contracts";

import { DEFAULT_KDF_PARAMS, VaultAuthenticationError, deriveKey, generateMasterKey, generateSalt, normalizePassphrase, open, seal, type KdfParams } from "./crypto";
import { type VaultHeader, type VaultWrap, VAULT_FORMAT_VERSION, generateRecoveryCode, parseRecoveryCode, parseVaultHeader, serializeVaultHeader, wrapAad } from "./format";

/**
 * VaultCore — the passphrase/recovery-key layer over one `vault.json`. It owns
 * the header document and the wrapping cryptography; it deliberately knows
 * nothing about files, sessions, throttling or the database. The manager layer
 * supplies persistence and the running master key.
 */

/** Persistence seam so tests can run the core entirely in memory. */
export type VaultHeaderStore = {
  /** raw `vault.json` text, or undefined when no vault exists yet */
  read(): string | undefined;
  write(text: string): Promise<void>;
};

export type VaultCoreDeps = {
  now?: () => Date;
  randomId?: () => string;
  kdf?: KdfParams;
};

export type VaultWrapSummary = {
  id: string;
  kind: VaultWrap["kind"];
  label?: string;
  createdAt: string;
};

export type VaultMetadata = {
  vaultId: string;
  createdAt: string;
  kdf: KdfParams;
  wraps: VaultWrapSummary[];
};

export class VaultCore {
  private constructor(
    private header: VaultHeader,
    private readonly store: VaultHeaderStore,
    private readonly now: () => Date,
    private readonly randomId: () => string,
  ) {}

  /** Create a brand-new vault and its passphrase wrap. Refuses an existing header. */
  static async create(
    store: VaultHeaderStore,
    passphrase: string,
    deps: VaultCoreDeps = {},
  ): Promise<{ core: VaultCore; masterKey: Buffer }> {
    if (store.read() !== undefined) throw new Error("refusing to create a vault over an existing vault header");
    // the primitive owns its floor (finding: create() trusted its callers): a
    // normalized whitespace-only passphrase must never become a usable wrap
    if (normalizePassphrase(passphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) throw new Error("VAULT_PASSPHRASE_TOO_SHORT");
    const now = deps.now ?? (() => new Date());
    const randomId = deps.randomId ?? (() => randomUUID());
    const kdf = deps.kdf ?? DEFAULT_KDF_PARAMS;
    const masterKey = generateMasterKey();
    const header: VaultHeader = {
      format: VAULT_FORMAT_VERSION,
      vaultId: randomId(),
      createdAt: now().toISOString(),
      kdf,
      wraps: [],
    };
    const core = new VaultCore(header, store, now, randomId);
    header.wraps.push(core.buildWrap(masterKey, normalizePassphrase(passphrase), "passphrase"));
    await store.write(serializeVaultHeader(header));
    return { core, masterKey };
  }

  /** Open an existing vault; undefined when there is no header yet. */
  static open(store: VaultHeaderStore, deps: VaultCoreDeps = {}): VaultCore | undefined {
    const text = store.read();
    if (text === undefined) return undefined;
    const now = deps.now ?? (() => new Date());
    const randomId = deps.randomId ?? (() => randomUUID());
    return new VaultCore(parseVaultHeader(text), store, now, randomId);
  }

  metadata(): VaultMetadata {
    return {
      vaultId: this.header.vaultId,
      createdAt: this.header.createdAt,
      kdf: this.header.kdf,
      wraps: this.header.wraps.map((wrap) => {
        const summary: VaultWrapSummary = { id: wrap.id, kind: wrap.kind, createdAt: wrap.createdAt };
        if (wrap.label !== undefined) summary.label = wrap.label;
        return summary;
      }),
    };
  }

  /** Unwrap the master key with a passphrase. Throws on any mismatch. */
  unlockPassphrase(passphrase: string): Buffer {
    const wrap = this.header.wraps.find((candidate) => candidate.kind === "passphrase");
    if (wrap === undefined) throw new VaultAuthenticationError();
    return this.unwrap(wrap, normalizePassphrase(passphrase));
  }

  /**
   * Unwrap the master key with a recovery code. Every recovery wrap is tried;
   * one success leaves the others valid. The checksum is validated before any
   * KDF work, so a typo fails fast.
   */
  unlockRecovery(code: string): Buffer {
    const parsed = parseRecoveryCode(code);
    if (!parsed.ok) throw new VaultAuthenticationError();
    for (const wrap of this.header.wraps) {
      if (wrap.kind !== "recovery") continue;
      try {
        return this.unwrap(wrap, parsed.bytes);
      } catch (error) {
        if (error instanceof VaultAuthenticationError) continue;
        throw error;
      }
    }
    throw new VaultAuthenticationError();
  }

  /**
   * Add one recovery wrap (max 5). The caller must already hold the unlocked
   * master key; the new code is returned exactly once and never stored in the
   * clear. The header object is replaced only after the write succeeded, so a
   * failed persist never leaves memory and disk divergent (finding: mutation
   * before persist).
   */
  async addRecoveryKey(masterKey: Uint8Array): Promise<{ id: string; code: string; createdAt: string }> {
    const recoveryWraps = this.header.wraps.filter((wrap) => wrap.kind === "recovery");
    if (recoveryWraps.length >= 5) throw new Error("VAULT_RECOVERY_LIMIT");
    const { code, bytes } = generateRecoveryCode();
    const wrap = this.buildWrap(masterKey, bytes, "recovery", `0${recoveryWraps.length + 1}`);
    await this.persistHeader({ ...this.header, wraps: [...this.header.wraps, wrap] });
    return { id: wrap.id, code, createdAt: wrap.createdAt };
  }

  /**
   * Remove one recovery wrap. Unknown ids are refused, and the LAST recovery
   * key can never be deleted (finding: last-key removal): losing every
   * recovery key silently removes the forgotten-passphrase path.
   */
  async removeRecoveryKey(id: string): Promise<void> {
    const recoveryWraps = this.header.wraps.filter((wrap) => wrap.kind === "recovery");
    if (recoveryWraps.length <= 1) throw new Error("VAULT_LAST_RECOVERY_KEY");
    const next = this.header.wraps.filter((wrap) => !(wrap.kind === "recovery" && wrap.id === id));
    if (next.length === this.header.wraps.length) throw new Error("VAULT_RECOVERY_NOT_FOUND");
    await this.persistHeader({ ...this.header, wraps: next });
  }

  /**
   * Replace the passphrase wrap. The current passphrase must still unwrap the
   * master key; the new wrap is committed before anything else can observe it.
   */
  async changePassphrase(currentPassphrase: string, newPassphrase: string): Promise<void> {
    const masterKey = this.unlockPassphrase(currentPassphrase);
    try {
      await this.setPassphraseFromMasterKey(masterKey, newPassphrase);
    } finally {
      masterKey.fill(0);
    }
  }

  /**
   * Re-wrap a new passphrase around an already-unwrapped master key (recovery
   * path, finding C4). The master key is NOT owned by this method; the caller
   * zeroes its copy.
   */
  async setPassphraseFromMasterKey(masterKey: Uint8Array, newPassphrase: string): Promise<void> {
    if (normalizePassphrase(newPassphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) throw new Error("VAULT_PASSPHRASE_TOO_SHORT");
    const wrap = this.buildWrap(masterKey, normalizePassphrase(newPassphrase), "passphrase");
    const wraps = [wrap, ...this.header.wraps.filter((candidate) => candidate.kind !== "passphrase")];
    await this.persistHeader({ ...this.header, wraps });
  }

  /** True when the header already carries a recovery wrap that parses (UI hint only). */
  recoveryCount(): number {
    return this.header.wraps.filter((wrap) => wrap.kind === "recovery").length;
  }

  private buildWrap(masterKey: Uint8Array, secret: string | Uint8Array, kind: VaultWrap["kind"], label?: string): VaultWrap {
    const salt = generateSalt();
    const key = deriveKey(secret, salt, this.header.kdf);
    try {
      const ciphertext = seal(key, masterKey, wrapAad(this.header.vaultId, kind));
      const wrap: VaultWrap = {
        id: this.randomId(),
        kind,
        salt: salt.toString("base64"),
        nonce: ciphertext.subarray(0, 12).toString("base64"),
        ciphertext: ciphertext.subarray(12).toString("base64"),
        createdAt: this.now().toISOString(),
      };
      if (label !== undefined) wrap.label = label;
      return wrap;
    } finally {
      key.fill(0);
    }
  }

  private unwrap(wrap: VaultWrap, secret: string | Uint8Array): Buffer {
    const salt = Buffer.from(wrap.salt, "base64");
    const key = deriveKey(secret, salt, this.header.kdf);
    try {
      const sealed = Buffer.concat([Buffer.from(wrap.nonce, "base64"), Buffer.from(wrap.ciphertext, "base64")]);
      const plain = open(key, sealed, wrapAad(this.header.vaultId, wrap.kind));
      if (plain.length !== 32) throw new VaultAuthenticationError();
      return plain;
    } finally {
      key.fill(0);
    }
  }

  private async persistHeader(next: VaultHeader): Promise<void> {
    await this.store.write(serializeVaultHeader(next));
    this.header = next;
  }
}
