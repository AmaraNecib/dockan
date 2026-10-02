import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { acquireVaultLock, VaultAlreadyLockedError } from "./lock";

/**
 * Issue #142 over a real process boundary: a running sidecar holds the vault
 * folder, a second acquirer is refused while the first keeps serving, and a
 * hard kill (no exit handler) leaves a stale lock that the next instance
 * reclaims. This is the cross-process complement to lock.test.ts.
 */

let dir: string;
let port: number;
let api: ChildProcessWithoutNullStreams | undefined;
let second: ChildProcessWithoutNullStreams | undefined;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a live listening TCP socket's address() is an AddressInfo
      const assigned = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(assigned));
    });
    server.on("error", reject);
  });
}

function startApi(onPort: number): ChildProcessWithoutNullStreams {
  return spawn("bun", ["src/main.ts"], {
    cwd: path.join(import.meta.dir, "..", "..", ".."),
    env: {
      ...process.env,
      DOKAN_DATA_DIR: dir,
      DOKAN_PORT: String(onPort),
      DOKAN_PORT_ROOT: path.join(dir, "run"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function waitForHealth(onPort: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${onPort}/health`);
      if (response.ok) return;
    } catch {
      /* not bound yet */
    }
    if (Date.now() >= deadline) throw new Error("api never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Wait for the lock refusal page (503 VAULT_LOCKED_BY_OTHER_INSTANCE). */
async function waitForRefusal(onPort: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${onPort}/health`);
      if (response.status === 503) {
        // SAFETY: the refusal app serves this JSON shape by contract
        const body = (await response.json()) as { error?: string };
        if (body.error === "VAULT_LOCKED_BY_OTHER_INSTANCE") return;
      }
    } catch {
      /* not bound yet */
    }
    if (Date.now() >= deadline) throw new Error("refusal api never answered");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Kill without letting the process run its exit hook (lock stays behind). */
async function hardKillAndWait(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (child === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-lock-integration-"));
  port = await freePort();
});

afterEach(async () => {
  await hardKillAndWait(api);
  api = undefined;
  await hardKillAndWait(second);
  second = undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

describe("vault single-writer lock over a live sidecar", () => {
  it("refuses a second instance, keeps the first serving, and reclaims after a hard kill", async () => {
    api = startApi(port);
    await waitForHealth(port);

    // the live sidecar owns the folder: this process cannot take the lock
    expect(() => acquireVaultLock(dir, { readRetries: 1, readRetryDelayMs: 5, stealSettleMs: 5 })).toThrow(
      VaultAlreadyLockedError,
    );
    // ... and the first instance is unaffected
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.ok).toBe(true);

    // kill it without a clean release, then reclaim the stale lock
    const running = api;
    api = undefined;
    await hardKillAndWait(running);
    const lock = acquireVaultLock(dir, { readRetries: 1, readRetryDelayMs: 5, stealSettleMs: 5 });
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(path.join(dir, "vault.lock"))).toBe(false);
  }, 30_000);

  it("a refused second sidecar never overwrites the owner's .dokan-port record (round-7 finding 2)", async () => {
    api = startApi(port);
    await waitForHealth(port);
    const portFile = path.join(dir, "run", ".dokan-port");
    // the first instance owns the canonical record the dev proxy reads
    for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));

    // a second sidecar on the same folder serves the Arabic refusal on its own
    // port, but must not publish/overwrite the shared record
    const secondPort = await freePort();
    second = startApi(secondPort);
    await waitForRefusal(secondPort);

    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));
    // the first instance still owns the folder and keeps serving
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  }, 30_000);
});