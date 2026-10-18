import { afterEach, beforeEach, describe, expect } from "bun:test";
import { itHeavy } from "../../test-support/heavy";
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
/** The last stderr the api child wrote, so a failed wait names the exit path. */
let apiStderr = "";

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
  const child = spawn("bun", ["src/main.ts"], {
    cwd: path.join(import.meta.dir, "..", "..", ".."),
    env: {
      ...process.env,
      DOKAN_DATA_DIR: dir,
      DOKAN_PORT: String(onPort),
      DOKAN_PORT_ROOT: path.join(dir, "run"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    apiStderr = `${apiStderr}${chunk.toString()}`.slice(-4_000);
  });
  return child;
}

/** Everything the running api child logged, for assertions and failure text. */
function readLogs(): string {
  const logsDir = path.join(dir, "logs");
  return fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).map((name) => fs.readFileSync(path.join(logsDir, name), "utf8")).join("\n")
    : "";
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The JSON envelope the RPC/vault routes accept. */
type JsonBody = { json: Record<string, string> } | { passphrase: string };

async function postJson(url: string, body: JsonBody, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Wait for the lock file to show a NEW heartbeat, so a theft has a full cadence before the next tick. */
async function waitForFreshHeartbeat(lockFile: string, seen: string | undefined): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      // SAFETY: the lock record is JSON written by the running sidecar
      const record = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { heartbeatAt?: string };
      if (record.heartbeatAt !== undefined && record.heartbeatAt !== seen) return;
    } catch {
      /* mid-write; retry */
    }
    if (Date.now() >= deadline) return;
    await sleep(50);
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-lock-integration-"));
  port = await freePort();
  apiStderr = "";
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
  itHeavy("refuses a second instance, keeps the first serving, and reclaims after a hard kill", async () => {
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
  });

  itHeavy("a refused second sidecar never overwrites the owner's .dokan-port record (round-7 finding 2)", async () => {
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
  });

  itHeavy("a running instance that loses the folder refuses on its own port instead of exiting (ADR-0012)", async () => {
    api = startApi(port);
    await waitForHealth(port);
    const portFile = path.join(dir, "run", ".dokan-port");
    const lockFile = path.join(dir, "vault.lock");
    for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));

    // another copy takes the folder: replace the running instance's lock record
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 4242,
        host: "another-machine",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        token: "the-new-owner",
      }),
    );

    // the heartbeat notices within one cadence (10s) and the instance answers
    // the JSON status route the app calls with the in-use refusal. The port
    // record must be snapshotted first so a loser cannot quietly republish it.
    const registryDir = path.join(dir, "run", ".dokan-port.registry");
    const registryBefore = fs.existsSync(registryDir) ? fs.readdirSync(registryDir).sort() : [];
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/vault/status`);
        if (response.status === 503) {
          // SAFETY: the refusal app serves this JSON shape by contract
          const body = (await response.json()) as { error?: { code?: string } };
          if (body.error?.code === "VAULT_LOCKED_BY_OTHER_INSTANCE") break;
        }
      } catch {
        // the child may be mid-swap: a transient refused connection is not a
        // failure, retry until the deadline
      }
      if (Date.now() >= deadline) {
        throw new Error(`instance never switched to the in-use refusal; stderr: ${apiStderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // no second listener and no port-record publication: the boot record is
    // untouched, the per-process registry directory gained no new entry, and
    // /health answers the refusal on the same port
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));
    const registryAfter = fs.existsSync(registryDir) ? fs.readdirSync(registryDir).sort() : [];
    expect(registryAfter).toEqual(registryBefore);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(503);
    // the replacement owner's lock file was never deleted by the loser
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { token: string };
    expect(owner.token).toBe("the-new-owner");
  });

  itHeavy("a loser neither exits nor checkpoints over the new owner's snapshot (ADR-0012 clause 3)", async () => {
    api = startApi(port);
    await waitForHealth(port);
    const snapshot = path.join(dir, "dokan.db.enc");
    const lockFile = path.join(dir, "vault.lock");

    // open the vault so this instance holds a live store and snapshot
    const passphrase = "correct horse battery staple";
    const setup = await postJson(`http://127.0.0.1:${port}/api/vault/setup`, { passphrase });
    expect(setup.status).toBe(200);
    // SAFETY: the setup route returns this shape by contract
    const { sessionToken } = (await setup.json()) as { sessionToken: string };
    // unlock signs the owner in, but the RPC guard also needs the provisioned
    // owner row: firstTimeSetup writes it (vault mode needs no password)
    const provision = await postJson(`http://127.0.0.1:${port}/api/rpc/firstTimeSetup`, {
      json: { ownerName: "Owner", phoneNumber: "0550123123", storeName: "Shop" },
    });
    expect(provision.ok).toBe(true);
    for (let attempt = 0; attempt < 200 && !fs.existsSync(snapshot); attempt += 1) await sleep(50);
    expect(fs.existsSync(snapshot)).toBe(true);

    // a committed mutation persists, so the file matches the in-memory image
    const first = await postJson(
      `http://127.0.0.1:${port}/api/rpc/preferencesSet`,
      { json: { key: "ui.pageSize", value: "25" } },
      { "x-vault-session": sessionToken },
    );
    expect(first.ok).toBe(true);
    const before = fs.readFileSync(snapshot);

    // align to a fresh heartbeat so the theft has a full cadence before the
    // heartbeat (not the write guard) could notice it
    // SAFETY: the lock record is JSON written by the running sidecar
    const seen = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { heartbeatAt?: string }).heartbeatAt;
    await waitForFreshHeartbeat(lockFile, seen);

    // another copy takes the folder, then a mutation commits in memory while
    // its persist is refused by the write guard
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 4242,
        host: "another-machine",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        token: "the-new-owner",
      }),
    );
    // let the forged record land, then mutate BEFORE the next heartbeat tick
    // (10s away): the request reaches the live app, the mutation commits, and
    // its persist is what the write guard refuses
    await sleep(50);
    const secondWrite = postJson(
      `http://127.0.0.1:${port}/api/rpc/preferencesSet`,
      { json: { key: "ui.pageSize", value: "50" } },
      { "x-vault-session": sessionToken },
    ).catch(() => undefined);
    const secondResponse = await secondWrite;
    await sleep(200);
    // onFatalError returned on VaultLockLostError instead of exiting; an exit
    // here would also close the socket mid-request
    expect(api.exitCode).toBeNull();
    expect(secondResponse?.ok).toBe(false);
    // the abandoned store is genuinely dirty: persistNow only asks the guard
    // when a mutation is unpersisted, so this line cannot appear if the refusal
    // handler intercepted the request instead of the app committing the change
    expect(readLogs()).toContain("the encrypted snapshot write was refused");

    // SIGTERM: the shutdown must skip the final checkpoint (the folder is no
    // longer ours), so the new owner's snapshot bytes stay exactly as they were
    const running = api;
    api = undefined;
    running.kill("SIGTERM");
    await new Promise<void>((resolve) => running.once("exit", () => resolve()));
    expect(fs.readFileSync(snapshot)).toEqual(before);

    // the skip is visible in the log: without it the abandoned store is closed
    // anyway, the checkpoint guard refuses, and the shutdown reports a failure.
    // Only POSIX delivers the SIGTERM: Bun's kill on Windows terminates the
    // child outright, so the shutdown path never runs there and this assertion
    // cannot bite. CI runs the api suite on ubuntu, where it is the gate.
    if (process.platform !== "win32") {
      expect(readLogs()).not.toContain("store close failed during shutdown");
    }
  });
});
