import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppLogger } from "../logger";
import { VaultAuthenticationError, type KdfParams } from "./crypto";
import { VaultAlreadyConfiguredError, VaultLockedError, VaultManager, unlockBackoffMs } from "./manager";

const FAST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 };

let dir: string;
let clock: number;

function manager(): VaultManager {
  return new VaultManager({
    dataDir: dir,
    legacyDbPath: path.join(dir, "dokan.db"),
    logger: new AppLogger(dir),
    kdf: FAST_KDF,
    now: () => new Date(clock),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-manager-"));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function createVault(vault: VaultManager): Promise<string> {
  await vault.prepareSetup("correct horse");
  const token = await vault.commitSetup();
  return token;
}

describe("VaultManager", () => {
  it("reports unconfigured, then locked, then unlocked", async () => {
    const vault = manager();
    expect(vault.status().state).toBe("unconfigured");
    await vault.prepareSetup("correct horse");
    // preparation is not persistence: no header written yet
    expect(vault.status().state).toBe("unconfigured");
    await vault.commitSetup();
    expect(vault.status().state).toBe("unlocked");
    vault.close();
    expect(manager().status().state).toBe("locked");
  });

  it("writes the header and the initial recovery key through the commit", async () => {
    const vault = manager();
    const prepared = await vault.prepareSetup("correct horse");
    expect(prepared.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(vault.status().recoveryKeyCount).toBe(0);
    await vault.commitSetup();
    expect(vault.status().recoveryKeyCount).toBe(1);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
  });

  it("unlocks with the passphrase and with the recovery key", async () => {
    const vault = manager();
    const { recoveryKey } = await vault.prepareSetup("correct horse");
    await vault.commitSetup();
    vault.close();

    const reopened = manager();
    const token = await reopened.unlock("correct horse");
    expect(token.length).toBeGreaterThan(20);
    expect(reopened.sessionMatches(token)).toBe(true);
    expect(reopened.sessionMatches("other")).toBe(false);
    expect(reopened.unlocked).toBe(true);
    reopened.close();
    expect(reopened.unlocked).toBe(false);

    const recoveryUnlock = manager();
    await recoveryUnlock.unlockRecovery(recoveryKey);
    expect(recoveryUnlock.unlocked).toBe(true);
  });

  it("refuses a wrong passphrase, records the failure, and locks after five attempts", async () => {
    const vault = manager();
    await createVault(vault);
    vault.close();
    const reopened = manager();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(reopened.unlock("wrong")).rejects.toThrow(VaultAuthenticationError);
    }
    // the sixth attempt is refused before the KDF runs
    await expect(reopened.unlock("wrong")).rejects.toThrow(VaultLockedError);
    const status = reopened.status();
    expect(status.lockedForMs).toBeGreaterThan(0);
    // and the lockout survives a restart (persisted)
    expect(manager().status().lockedForMs).toBeGreaterThan(0);

    // once the lock expires the correct passphrase works and resets the counter
    clock += unlockBackoffMs(5) + 1;
    await reopened.unlock("correct horse");
    expect(reopened.status().lockedForMs).toBe(0);
    expect(manager().status().lockedForMs).toBe(0);
  });

  it("queues pre-unlock failures for the activity log and drains them once", async () => {
    const vault = manager();
    await createVault(vault);
    vault.close();
    const reopened = manager();
    await expect(reopened.unlock("wrong")).rejects.toThrow(VaultAuthenticationError);
    await reopened.unlock("correct horse");
    const events = reopened.drainPendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("VAULT_UNLOCK_FAILED");
    expect(reopened.drainPendingEvents()).toHaveLength(0);
  });

  it("treats an unreadable header as invalid and refuses to overwrite it", async () => {
    fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vault", "vault.json"), "{not json");
    const vault = manager();
    expect(vault.status().state).toBe("invalid");
    await expect(vault.prepareSetup("correct horse")).rejects.toThrow(VaultAlreadyConfiguredError);
  });

  it("rotates recovery keys while unlocked and requires an unlock for the rest", async () => {
    const vault = manager();
    await createVault(vault);
    const added = await vault.addRecoveryKey();
    expect(vault.metadata().wraps.filter((wrap) => wrap.kind === "recovery")).toHaveLength(2);
    await vault.removeRecoveryKey(added.id);
    expect(vault.metadata().wraps.filter((wrap) => wrap.kind === "recovery")).toHaveLength(1);
    vault.close();
    await expect(manager().addRecoveryKey()).rejects.toThrow();
  });

  it("flags a legacy plaintext database in the status for the setup flow", async () => {
    fs.writeFileSync(path.join(dir, "dokan.db"), "SQLite format 3\u0000");
    const vault = manager();
    expect(vault.status().state).toBe("unconfigured");
    expect(vault.status().legacyDatabase).toBe(true);
  });

  it("backs off exponentially after five failures and caps at 15 minutes", () => {
    expect(unlockBackoffMs(1)).toBe(0);
    expect(unlockBackoffMs(4)).toBe(0);
    expect(unlockBackoffMs(5)).toBe(30_000);
    expect(unlockBackoffMs(6)).toBe(60_000);
    expect(unlockBackoffMs(50)).toBe(15 * 60_000);
  });
});
