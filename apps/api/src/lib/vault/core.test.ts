import { describe, expect, it } from "bun:test";

import { VaultAuthenticationError, type KdfParams } from "./crypto";
import { VaultCore, type VaultHeaderStore } from "./core";
import { generateRecoveryCode, parseRecoveryCode, parseVaultHeader } from "./format";

/** Test KDF parameters: the same code path, milliseconds instead of seconds. */
const FAST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 };

type MemoryStoreState = { text: string | undefined };
type MemoryStore = { store: VaultHeaderStore; text: () => string };

function memoryStore(): MemoryStore {
  const state: MemoryStoreState = { text: undefined };
  return {
    store: {
      read: () => state.text,
      write: (text) => {
        state.text = text;
        return Promise.resolve();
      },
    },
    text: () => {
      if (state.text === undefined) throw new Error("store is empty");
      return state.text;
    },
  };
}

async function freshVault(): Promise<{ core: VaultCore; masterKey: Buffer; store: VaultHeaderStore; text: () => string }> {
  const { store, text } = memoryStore();
  const { core, masterKey } = await VaultCore.create(store, "correct horse", { kdf: FAST_KDF });
  return { core, masterKey, store, text };
}

describe("VaultCore", () => {
  it("creates a vault whose passphrase wrap unwraps the master key", async () => {
    const { core, masterKey } = await freshVault();
    const unlocked = core.unlockPassphrase("correct horse");
    expect(unlocked.equals(masterKey)).toBe(true);
    expect(unlocked.length).toBe(32);
  });

  it("fails a wrong passphrase with the typed auth error and no partial key", async () => {
    const { core } = await freshVault();
    expect(() => core.unlockPassphrase("wrong horse")).toThrow(VaultAuthenticationError);
  });

  it("normalises the passphrase (NFC + surrounding whitespace)", async () => {
    const { store } = memoryStore();
    const { core } = await VaultCore.create(store, "  café pass  ", { kdf: FAST_KDF });
    expect(() => core.unlockPassphrase("café pass")).not.toThrow();
    expect(() => core.unlockPassphrase("cafe\u0301 pass")).not.toThrow();
  });

  it("adds recovery keys that unwrap the master key, without invalidating each other", async () => {
    const { core, masterKey } = await freshVault();
    const first = await core.addRecoveryKey(masterKey);
    const second = await core.addRecoveryKey(masterKey);
    expect(core.recoveryCount()).toBe(2);
    expect(core.unlockRecovery(first.code).equals(masterKey)).toBe(true);
    expect(core.unlockRecovery(second.code).equals(masterKey)).toBe(true);
    // using one does not invalidate the other
    expect(core.unlockRecovery(first.code).equals(masterKey)).toBe(true);
  });

  it("caps recovery keys at five", async () => {
    const { core, masterKey } = await freshVault();
    for (let index = 0; index < 5; index += 1) await core.addRecoveryKey(masterKey);
    expect(core.recoveryCount()).toBe(5);
    await expect(core.addRecoveryKey(masterKey)).rejects.toThrow("VAULT_RECOVERY_LIMIT");
  });

  it("removes one recovery key and leaves the rest usable", async () => {
    const { core, masterKey } = await freshVault();
    const first = await core.addRecoveryKey(masterKey);
    const second = await core.addRecoveryKey(masterKey);
    await core.removeRecoveryKey(first.id);
    expect(core.recoveryCount()).toBe(1);
    expect(() => core.unlockRecovery(first.code)).toThrow(VaultAuthenticationError);
    expect(core.unlockRecovery(second.code).equals(masterKey)).toBe(true);
  });

  it("refuses a malformed recovery code before any KDF work", async () => {
    const { core } = await freshVault();
    expect(() => core.unlockRecovery("nope")).toThrow(VaultAuthenticationError);
  });

  it("rejects a recovery code whose checksum is wrong even if the wrap exists", async () => {
    const { core, masterKey } = await freshVault();
    const { code } = await core.addRecoveryKey(masterKey);
    const raw = code.replace(/-/g, "");
    const typo = `${raw.slice(0, 32)}${raw.slice(32) === "AA" ? "AB" : "AA"}`;
    expect(() => core.unlockRecovery(typo)).toThrow(VaultAuthenticationError);
  });

  it("changes the passphrase and keeps recovery working", async () => {
    const { core, masterKey, text } = await freshVault();
    const recovery = await core.addRecoveryKey(masterKey);
    await core.changePassphrase("correct horse", "new passphrase");
    expect(() => core.unlockPassphrase("correct horse")).toThrow(VaultAuthenticationError);
    expect(core.unlockPassphrase("new passphrase").equals(masterKey)).toBe(true);
    expect(core.unlockRecovery(recovery.code).equals(masterKey)).toBe(true);
    // exactly one passphrase wrap survives
    const header = parseVaultHeader(text());
    expect(header.wraps.filter((wrap) => wrap.kind === "passphrase")).toHaveLength(1);
  });

  it("refuses to change the passphrase without the current one", async () => {
    const { core } = await freshVault();
    await expect(core.changePassphrase("wrong", "new passphrase")).rejects.toThrow(VaultAuthenticationError);
    expect(core.unlockPassphrase("correct horse")).toBeDefined();
  });

  it("reopens from serialized text and still unlocks (portability)", async () => {
    const { store, core, masterKey, text } = await freshVault();
    const recovery = await core.addRecoveryKey(masterKey);
    const reopened = VaultCore.open(store);
    expect(reopened).toBeDefined();
    expect(reopened?.unlockPassphrase("correct horse").equals(masterKey)).toBe(true);
    expect(reopened?.unlockRecovery(recovery.code).equals(masterKey)).toBe(true);
    expect(text()).toContain("argon2id");
  });

  it("refuses to create a vault over an existing header", async () => {
    const { store } = memoryStore();
    await VaultCore.create(store, "one long enough");
    await expect(VaultCore.create(store, "two long enough")).rejects.toThrow();
  });

  it("enforces the passphrase floor in create() itself (normalized, finding 7)", async () => {
    const { store, text } = memoryStore();
    await expect(VaultCore.create(store, "        ", { kdf: FAST_KDF })).rejects.toThrow("VAULT_PASSPHRASE_TOO_SHORT");
    await expect(VaultCore.create(store, "  short  ", { kdf: FAST_KDF })).rejects.toThrow("VAULT_PASSPHRASE_TOO_SHORT");
    // nothing was written: the primitive did not half-create a vault
    expect(() => text()).toThrow();
  });

  it("generates codes whose checksum verifies the key bytes (not just the checksum chars)", () => {
    const { code, bytes } = generateRecoveryCode();
    // the code decodes back to the same 20 bytes and its own checksum
    const parsed = parseRecoveryCode(code);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a valid code");
    expect(parsed.bytes.equals(bytes)).toBe(true);
    // two codes never collide on a small sample
    expect(generateRecoveryCode().code).not.toBe(code);
  });

  it("refuses to remove the last recovery key (finding C8)", async () => {
    const { core, masterKey } = await freshVault();
    const only = await core.addRecoveryKey(masterKey);
    expect(core.recoveryCount()).toBe(1);
    await expect(core.removeRecoveryKey(only.id)).rejects.toThrow("VAULT_LAST_RECOVERY_KEY");
    expect(core.recoveryCount()).toBe(1);
  });

  it("sets a new passphrase from an already-unwrapped master key (finding C4)", async () => {
    const { core, masterKey } = await freshVault();
    const recovery = await core.addRecoveryKey(masterKey);
    // simulate the recovery path: unwrap with the code, then re-wrap
    const unwrapped = core.unlockRecovery(recovery.code);
    await core.setPassphraseFromMasterKey(unwrapped, "a brand new passphrase");
    unwrapped.fill(0);
    expect(() => core.unlockPassphrase("correct horse")).toThrow(VaultAuthenticationError);
    expect(core.unlockPassphrase("a brand new passphrase").equals(masterKey)).toBe(true);
    expect(core.unlockRecovery(recovery.code).equals(masterKey)).toBe(true);
  });

  it("leaves the in-memory header untouched when a mutation persist fails (finding C9)", async () => {
    const { store, text } = memoryStore();
    const { masterKey } = await VaultCore.create(store, "correct horse", { kdf: FAST_KDF });

    let failWrites = false;
    const flaky: VaultHeaderStore = {
      read: () => text(),
      write: async (next) => {
        if (failWrites) throw new Error("disk full");
        await store.write(next);
      },
    };
    const reopened = VaultCore.open(flaky);
    if (reopened === undefined) throw new Error("expected a vault");
    await reopened.addRecoveryKey(masterKey);
    const recovery = await reopened.addRecoveryKey(masterKey);
    const beforeMeta = reopened.metadata();
    const recoveryWrapId = beforeMeta.wraps.find((wrap) => wrap.id === recovery.id)?.id;
    if (recoveryWrapId === undefined) throw new Error("expected a recovery wrap");

    failWrites = true;
    await expect(reopened.addRecoveryKey(masterKey)).rejects.toThrow("disk full");
    await expect(reopened.removeRecoveryKey(recoveryWrapId)).rejects.toThrow("disk full");
    await expect(reopened.changePassphrase("correct horse", "a brand new passphrase")).rejects.toThrow("disk full");
    // memory and disk still agree: no half-applied header
    expect(reopened.metadata()).toEqual(beforeMeta);
    expect(VaultCore.open(flaky)?.metadata()).toEqual(beforeMeta);
    failWrites = false;
    expect(reopened.unlockPassphrase("correct horse").equals(masterKey)).toBe(true);
    expect(reopened.unlockRecovery(recovery.code).equals(masterKey)).toBe(true);
  });

  it("keeps short or padded passphrases out of the core (normalized floor)", async () => {
    const { core, masterKey } = await freshVault();
    await expect(core.setPassphraseFromMasterKey(masterKey, "        ")).rejects.toThrow("VAULT_PASSPHRASE_TOO_SHORT");
    await expect(core.changePassphrase("correct horse", "  short  ")).rejects.toThrow("VAULT_PASSPHRASE_TOO_SHORT");
  });
});
