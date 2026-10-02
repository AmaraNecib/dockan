import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireVaultLock, VaultAlreadyLockedError, VaultLockUnavailableError, vaultLockRefusalPageHtml } from "./lock";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-lock-"));
});

afterEach(() => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

const lockPath = (): string => path.join(dir, "vault.lock");
const fastSteal = { readRetries: 1, readRetryDelayMs: 1, stealSettleMs: 5 } as const;

function writeLock(overrides: Partial<{ pid: number; host: string; heartbeatAt: string; token: string }>): void {
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: "other-owner",
      ...overrides,
    }),
  );
}

describe("vault single-writer lock", () => {
  it("does not block the normal single instance and releases cleanly", () => {
    const lock = acquireVaultLock(dir);
    expect(fs.existsSync(lockPath())).toBe(true);
    // SAFETY: the test wrote this JSON itself in acquireVaultLock
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { pid: number; host: string; token: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.host).toBe(os.hostname());
    expect(owner.token).toBe(lock.currentOwner().token);
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(false);
    // release is idempotent
    lock.release();
  });

  it("refuses a second instance while the first is live, and lets it in after release", () => {
    const first = acquireVaultLock(dir);
    expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultAlreadyLockedError);
    first.release();
    const second = acquireVaultLock(dir, fastSteal);
    expect(second.currentOwner().pid).toBe(process.pid);
    second.release();
  });

  it("reclaims a stale lock whose foreign host stopped heartbeating", () => {
    writeLock({ host: "some-other-machine", heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const lock = acquireVaultLock(dir, fastSteal);
    expect(lock.currentOwner().pid).toBe(process.pid);
    expect(lock.currentOwner().host).toBe(os.hostname());
    lock.release();
  });

  it("does NOT steal from a live same-host process even when its heartbeat is old", () => {
    // the PID wins over the heartbeat on the local host: a reused PID may look
    // quiet, and stealing from a live holder is worse than refusing
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultAlreadyLockedError);
  });

  it("reclaims a lock left by a dead same-host process", async () => {
    const child = Bun.spawn(["bun", "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    const deadPid = child.pid;
    writeLock({ pid: deadPid, host: os.hostname(), heartbeatAt: new Date().toISOString() });
    const lock = acquireVaultLock(dir, fastSteal);
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("reclaims an unreadable lock file instead of blocking forever", () => {
    fs.writeFileSync(lockPath(), "{ not json");
    const lock = acquireVaultLock(dir, fastSteal);
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("fails loudly, never a silent no-op, when the lock cannot be created", () => {
    const spy = spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    try {
      expect(() => acquireVaultLock(dir)).toThrow(VaultLockUnavailableError);
    } finally {
      spy.mockRestore();
    }
    // and the failure did not leave a lock file behind
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("heartbeats while held", async () => {
    const lock = acquireVaultLock(dir, { heartbeatIntervalMs: 20 });
    const first = lock.currentOwner().heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // SAFETY: the test wrote this JSON itself in acquireVaultLock
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { heartbeatAt: string; token: string };
    expect(owner.token).toBe(lock.currentOwner().token);
    expect(Date.parse(owner.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(first));
    lock.release();
  });

  it("release never deletes another owner's lock", () => {
    const lock = acquireVaultLock(dir);
    // simulate a steal of the file by a different owner
    fs.rmSync(lockPath(), { force: true });
    writeLock({ token: "the-new-owner" });
    lock.release();
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("the-new-owner");
  });

  it("states the Arabic refusal with the holder identity", () => {
    const html = vaultLockRefusalPageHtml({
      pid: 4242,
      host: "shop-pc",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: "t",
    });
    expect(html).toContain("البيانات مفتوحة في نسخة أخرى");
    expect(html).toContain("shop-pc");
    expect(html).toContain("4242");
  });
});
