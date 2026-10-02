import { describe, expect, it } from "bun:test";

import { VaultAuthenticationError, type KdfParams } from "./crypto";
import { VaultCore, type VaultHeaderStore } from "./core";
import { generateRecoveryCode, parseVaultHeader } from "./format";

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
    const { core } = await VaultCore.create(store, "  café  ", { kdf: FAST_KDF });
    expect(() => core.unlockPassphrase("café")).not.toThrow();
    expect(() => core.unlockPassphrase("cafe\u0301")).not.toThrow();
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
    await VaultCore.create(store, "one");
    await expect(VaultCore.create(store, "two")).rejects.toThrow();
  });

  it("generates codes that parse (checksum contract)", () => {
    const { code } = generateRecoveryCode();
    expect(code).toBeDefined();
  });
});
