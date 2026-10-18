import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireVaultLock, closeVaultThenReleaseLock, createVaultLockRefusalApp, VaultAlreadyLockedError, VaultLockLostError, VaultLockUnavailableError, vaultLockRefusalPageHtml, type VaultLockOwner } from "./lock";
import { createAppConfig } from "../../config";
import { createEncryptedConnection } from "../../db/encrypted-connection";

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

  it("reclaims a lock the injected probe calls gone, even with a fresh heartbeat", () => {
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date().toISOString() });
    const lock = acquireVaultLock(dir, { ...fastSteal, probePid: () => "gone" });
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("reclaims an inconclusive probe once the heartbeat is stale (EPERM on Windows, ADR-0012)", () => {
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const lock = acquireVaultLock(dir, { ...fastSteal, probePid: () => "unknown" });
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("refuses an inconclusive probe while the heartbeat is fresh", () => {
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date().toISOString() });
    expect(() => acquireVaultLock(dir, { ...fastSteal, probePid: () => "unknown" })).toThrow(VaultAlreadyLockedError);
  });

  it("refuses a pid the probe answers as alive however old the heartbeat", () => {
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(() => acquireVaultLock(dir, { ...fastSteal, probePid: () => "alive" })).toThrow(VaultAlreadyLockedError);
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

  it("refuses instead of deleting a replacement lock when the stale file changes hands mid-reclaim (round-5)", () => {
    writeLock({ host: "old-dead-host", heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(), token: "stale-token" });
    const realRename = fs.renameSync.bind(fs);
    let swapped = false;
    // interleaving: our stale check passed, then another sidecar won the
    // reclaim and created its own lock before our rename ran
    const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!swapped && String(from) === lockPath()) {
        swapped = true;
        fs.writeFileSync(
          lockPath(),
          JSON.stringify({
            pid: 999_999,
            host: os.hostname(),
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            token: "replacement-token",
          }),
        );
      }
      // SAFETY: the spy is typed with fs.renameSync's own PathLike overload;
      // production only ever passes PathLike values here
      return realRename(from as fs.PathLike, to as fs.PathLike);
    });
    try {
      expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultAlreadyLockedError);
    } finally {
      spy.mockRestore();
    }
    // the replacement survives at the path and no temp copy is left behind
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("replacement-token");
    expect(fs.readdirSync(dir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("fail-stops when the lock file is replaced by another owner (round-5)", async () => {
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, { heartbeatIntervalMs: 20, onLost: (reason) => lost.push(reason) });
    fs.rmSync(lockPath(), { force: true });
    writeLock({ token: "another-owner" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lost.length).toBeGreaterThan(0);
    lock.release();
    // the heartbeat never deleted the replacement's file
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("another-owner");
  });

  it("names the holder in the log and hands it to onLost on every loss", async () => {
    const logged: string[] = [];
    const holders: (VaultLockOwner | undefined)[] = [];
    const lock = acquireVaultLock(dir, {
      heartbeatIntervalMs: 20,
      logger: {
        warn() {
          /* no warns expected on this path */
        },
        error(event, message) {
          logged.push(`${event}::${message}`);
        },
      },
      onLost: (_reason, holder) => holders.push(holder),
    });
    fs.rmSync(lockPath(), { force: true });
    writeLock({ host: "shop-pc", pid: 4242, token: "another-owner" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(holders.length).toBeGreaterThan(0);
    expect(holders[0]?.host).toBe("shop-pc");
    expect(holders[0]?.pid).toBe(4242);
    expect(
      logged.some((line) => line.includes("VAULT_LOCK_LOST") && line.includes("shop-pc") && line.includes("4242")),
    ).toBe(true);
    lock.release();
  });

  it("reclaim logs name the holder's machine and pid", () => {
    const logged: string[] = [];
    writeLock({ host: "dead-laptop", pid: 7777, heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const lock = acquireVaultLock(dir, {
      ...fastSteal,
      probePid: () => "unknown",
      logger: {
        warn(event, message) {
          logged.push(`${event}::${message}`);
        },
        error() {
          /* no errors expected */
        },
      },
    });
    expect(logged.some((line) => line.includes("VAULT_LOCK_RECLAIMED") && line.includes("dead-laptop") && line.includes("7777"))).toBe(
      true,
    );
    lock.release();
  });

  it("a queued snapshot write refuses once the lock is stolen, and writes nothing (ADR-0012 clause 3)", async () => {
    const lock = acquireVaultLock(dir, { ...fastSteal, onLost: () => undefined });
    const snapshot = path.join(dir, "dokan.db.enc");
    const conn = createEncryptedConnection({
      vaultId: "11111111-2222-3333-4444-555555555555",
      masterKey: Buffer.alloc(32, 7),
      snapshotPath: snapshot,
      fresh: true,
      // the guard main.ts installs: the write path re-checks lock ownership
      writeGuard: () => lock.assertHeld(),
    });
    try {
      conn.raw.exec("CREATE TABLE t(a TEXT)");
      conn.markDirty();
      await conn.flush();
      const before = fs.readFileSync(snapshot);

      // another copy reclaims the folder while this instance is idle
      fs.rmSync(lockPath(), { force: true });
      writeLock({ token: "the-new-owner" });

      // a persist was queued (or is asked for) before the heartbeat could
      // notice: it must refuse rather than overwrite the new owner's snapshot
      conn.raw.exec("INSERT INTO t VALUES ('sale')");
      conn.markDirty();
      await expect(conn.flush()).rejects.toThrow(VaultLockLostError);
      expect(fs.readFileSync(snapshot)).toEqual(before);
      // the fail-stop ran once, and the replacement's record survived
      // SAFETY: the test wrote this JSON itself above
      const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
      expect(owner.token).toBe("the-new-owner");
    } finally {
      conn.raw.close();
    }
  });

  it("holds the lock until the store close (final checkpoint) finishes (round-5)", async () => {
    const lock = acquireVaultLock(dir);
    let releaseObservedDuringClose: boolean | undefined;
    const closing = closeVaultThenReleaseLock(
      {
        async close() {
          await new Promise((resolve) => setTimeout(resolve, 40));
          releaseObservedDuringClose = !fs.existsSync(lockPath());
        },
      },
      lock,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    // while close is in flight the lock is still held
    expect(fs.existsSync(lockPath())).toBe(true);
    await closing;
    expect(releaseObservedDuringClose).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("releases the lock even when the store close fails (round-5)", async () => {
    const lock = acquireVaultLock(dir);
    await expect(
      closeVaultThenReleaseLock(
        {
          async close() {
            throw new Error("snapshot persist failed");
          },
        },
        lock,
      ),
    ).rejects.toThrow("snapshot persist failed");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("escapes a hostile lock-record host in the refusal page (round-5)", () => {
    const html = vaultLockRefusalPageHtml({
      pid: 7,
      host: '<img src=x onerror="alert(1)">',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: "t",
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("<script");
    // the record is still identified, stripped to the hostname charset
    expect(html).toContain("imgsrcxonerroralert1");
  });

  it("treats a lock record with an over-long host as unreadable (round-5)", () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: 1,
        host: "h".repeat(65),
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        token: "t",
      }),
    );
    const lock = acquireVaultLock(dir, fastSteal);
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });
});

describe("the vault lock refusal app", () => {
  const owner: VaultLockOwner = {
    pid: 4242,
    host: "shop-pc",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    token: "other-owner",
  };

  it("answers the status route and /health with 503 and the refusal code (ADR-0012)", async () => {
    const app = createVaultLockRefusalApp(createAppConfig({}), new VaultAlreadyLockedError(owner, lockPath()));
    const status = await app.fetch(new Request("http://localhost/api/vault/status"));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } });

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ok: false, error: "VAULT_LOCKED_BY_OTHER_INSTANCE" });
  });

  it("serves the Arabic page elsewhere and never JSON for the UI route", async () => {
    const app = createVaultLockRefusalApp(createAppConfig({}), new VaultAlreadyLockedError(owner, lockPath()));
    const page = await app.fetch(new Request("http://localhost/"));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("البيانات مفتوحة في نسخة أخرى");
  });

  it("echoes the boot token so the shell keeps verifying the child", async () => {
    const token = "c".repeat(64);
    const app = createVaultLockRefusalApp(createAppConfig({ DOKAN_BOOT_TOKEN: token }), new VaultAlreadyLockedError(owner, lockPath()));
    const ok = await app.fetch(new Request(`http://localhost/health-token?token=${token}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, token });
    const wrong = await app.fetch(new Request("http://localhost/health-token?token=wrong"));
    expect(wrong.status).toBe(404);
  });
});
