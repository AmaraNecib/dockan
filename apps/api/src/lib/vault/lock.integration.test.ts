import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { itHeavy } from "../../test-support/heavy";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { acquireVaultLock, VaultAlreadyLockedError } from "./lock";
import { withPortFileLock } from "../port-record";

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
/** A third child, for the two-waiters race. */
let third: ChildProcessWithoutNullStreams | undefined;
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

function startApi(onPort: number, extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const child = spawn("bun", ["src/main.ts"], {
    cwd: path.join(import.meta.dir, "..", "..", ".."),
    env: {
      ...process.env,
      DOKAN_DATA_DIR: dir,
      DOKAN_PORT: String(onPort),
      DOKAN_PORT_ROOT: path.join(dir, "run"),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    apiStderr = `${apiStderr}${chunk.toString()}`.slice(-4_000);
  });
  return child;
}

/**
 * Wait for a log line, making NO request. Reading the log observes the boot
 * only, so a test that waits for the reclaim cannot pass on an attempt a
 * request seeded instead of one the automatic schedule made.
 */
async function waitForLog(needle: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readLogs().includes(needle)) return;
    if (Date.now() >= deadline) throw new Error(`the api never logged ${needle}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Wait for N log lines carrying `needle`, making NO request. */
async function waitForLogCount(needle: string, count: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readLogs().split(needle).length - 1 >= count) return;
    if (Date.now() >= deadline) throw new Error(`the api never logged ${needle} ${count} times`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Everything the running api child logged, for assertions and failure text. */
function readLogs(): string {
  const logsDir = path.join(dir, "logs");
  return fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).map((name) => fs.readFileSync(path.join(logsDir, name), "utf8")).join("\n")
    : "";
}

/** The log as rows, so a test can assert on ONE event's own words. */
function readLogEntries(): { event?: string; message?: string }[] {
  return readLogs()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        // SAFETY: the api's own JSONL row shape
        return JSON.parse(line) as { event?: string; message?: string };
      } catch {
        // a half-written line at the tail: not a row this test can read
        return {};
      }
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A test that needs a CLEAN process exit. Only POSIX delivers SIGTERM to a
 * child: on Windows Bun's kill terminates the child outright, so the shutdown
 * hook never runs there and whatever the exit leaves behind is a crash, not a
 * close. CI runs the api suite on ubuntu, where these run.
 */
function itPosix(name: string, fn: () => void | Promise<void>): void {
  if (process.platform === "win32") it.skip(name, fn);
  else itHeavy(name, fn);
}

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

/**
 * The OLD owner's record is gone. The file itself may or may not be there: the
 * waiter can take the folder — and write its own record — before this test
 * looks, and that is the recovery working quickly, not a failure (Greptile
 * issue 3 on #298). What must not be there is the old owner's record.
 */
function expectOldOwnerGone(lockFile: string, oldPid: number): void {
  let ownerPid: number | undefined;
  try {
    // SAFETY: the lock record is JSON written by a running sidecar
    ownerPid = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number }).pid;
  } catch {
    ownerPid = undefined;
  }
  expect(ownerPid).not.toBe(oldPid);
}

/**
 * The vault gate really answers on `onPort`. A `not.toBe(503)` also passes on a
 * 404 or a 500, so a takeover that left the refusal route mounted elsewhere
 * would read as success. Every folder in this file is fresh (no vault header),
 * so the gate's own answer is `unconfigured`.
 */
async function expectFreshVaultGate(onPort: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${onPort}/api/vault/status`);
  expect(response.status).toBe(200);
  // SAFETY: the status route returns { state: string } per the vault contract
  expect(((await response.json()) as { state?: string }).state).toBe("unconfigured");
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
  await hardKillAndWait(third);
  third = undefined;
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

  itHeavy("a refused start publishes its own registry entry and never the canonical record (#277)", async () => {
    // The desktop shell's identity check B (`registry_owned_by` in desktop.rs)
    // reads `<portRoot>/.dokan-port.registry/<child pid>` and kills a child that
    // has no entry there, after its 20 s startup budget. A refused start used to
    // publish nothing, so the shell killed the one process that can take the
    // folder by itself, and the Arabic refusal page was never shown. The entry
    // is now published; the canonical record is still the owner's business.
    const refusedPort = await freePort();
    const lockFile = path.join(dir, "vault.lock");
    const portFile = path.join(dir, "run", ".dokan-port");
    const registryDir = path.join(dir, "run", ".dokan-port.registry");
    // a holder that never publishes anything: this test is about the waiter's
    // own entry, not about a survivor's canonical
    const holder = acquireVaultLock(dir);
    second = startApi(refusedPort);
    await waitForLog("VAULT_LOCK_REFUSED");
    const refusedPid = second.pid;
    if (refusedPid === undefined) throw new Error("the refused sidecar has no pid");

    const entryPath = path.join(registryDir, String(refusedPid));
    for (let attempt = 0; attempt < 100 && !fs.existsSync(entryPath); attempt += 1) await sleep(50);
    const raw = fs.readFileSync(entryPath, "utf8");
    // the exact shape the shell's check requires: the loopback host, and the
    // assigned port anchored to the closing brace (43189 must not satisfy 4318)
    expect(raw).toContain('"host":"127.0.0.1"');
    expect(raw).toContain(`"port":${refusedPort}}`);
    expect(JSON.parse(raw)).toEqual({ host: "127.0.0.1", port: refusedPort });

    // and it wrote NO canonical record: the dev proxy must never be pointed at
    // a refusal server
    expect(fs.existsSync(portFile)).toBe(false);
    // the entry was not bought with a takeover: the holder still owns the folder
    expect((await fetch(`http://127.0.0.1:${refusedPort}/api/vault/status`)).status).toBe(503);
    // SAFETY: the lock record is JSON written by this process
    expect((JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number }).pid).toBe(process.pid);
    holder.release();
  });

  itHeavy("a refused start serves the recycled-pid page, not the close-the-other-copy one (greptile P1 on #298)", async () => {
    // A lock left by a process whose pid now belongs to something else: the pid
    // answers alive, the heartbeat is many windows old. The refusal is real, but
    // "close the other copy" is advice the owner cannot follow — there may be no
    // other copy. Startup used to reduce the refusal to its holder, which threw
    // that story away; the page must keep it.
    const stalePort = await freePort();
    const started = new Date(Date.now() - 200_000).toISOString();
    fs.writeFileSync(
      path.join(dir, "vault.lock"),
      JSON.stringify({
        pid: process.pid, // alive: the pid probe answers, so only the heartbeat says "gone"
        host: os.hostname(),
        startedAt: started,
        heartbeatAt: started,
        token: "recycled-pid",
      }),
    );

    api = startApi(stalePort);
    // no request until the page is up: the page is what this test reads
    await waitForLog("VAULT_LOCK_REFUSED");
    const page = await fetch(`http://127.0.0.1:${stalePort}/`);
    const html = await page.text();
    expect(html).toContain("لا تبدو نسخة أخرى من دكان");
    expect(html).toContain("vault.lock");
    // and NOT the advice that does not apply
    expect(html).not.toContain("لا تحذف أي ملف");
  });

  itHeavy("a plaintext start still publishes its port record (greptile P1 on #298)", async () => {
    // DOKAN_VAULT=disabled never takes a vault lock, so keying publication off
    // `vaultLock` left plaintext starts with no `.dokan-port` at all: the dev
    // proxy kept walking a stale record while the api listened elsewhere.
    const plaintextPort = await freePort();
    const portFile = path.join(dir, "run", ".dokan-port");
    api = startApi(plaintextPort, { DOKAN_VAULT: "disabled" });
    await waitForHealth(plaintextPort);

    for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.existsSync(portFile)).toBe(true);
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(plaintextPort));
  });

  // The shutdown ordering is no longer pinned by reading main.ts's source
  // text: that test could be satisfied by a comment carrying the same
  // strings, and it could not see the case that actually bites - an attempt
  // that was already in flight when the shutdown began. The behaviour is
  // pinned at the seam instead (reclaim-retry.test.ts: "reports no
  // acquisition when the loop is stopped while an attempt runs"), and the
  // ordering in beginShutdown is defence in depth on top of it.

  itHeavy("the explicit retry route asks the folder while a poll never does (#298)", async () => {
    // #277's second acceptance criterion: "the retry on the screen re-checks
    // immediately rather than waiting for the next backoff tick". It used to be
    // met by hooking EVERY request, which made a poll cancel and re-arm the
    // backoff (greptile P2 on #298). The retry is now a route of its own, and a
    // status poll is not it.
    const refusedPort = await freePort();
    const holder = acquireVaultLock(dir);
    second = startApi(refusedPort);
    await waitForLog("VAULT_LOCK_REFUSED");

    // the folder is still held, so the retry asks and is told the folder did
    // not follow: the request itself succeeded, which is what the owner's
    // button needs to hear
    const asked = await fetch(`http://127.0.0.1:${refusedPort}/api/vault/reclaim`, { method: "POST" });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ ok: true, taken: false });
    // SAFETY: the lock record is JSON written by this process
    expect((JSON.parse(fs.readFileSync(path.join(dir, "vault.lock"), "utf8")) as { pid: number }).pid).toBe(process.pid);

    // the app's own polling route is NOT the retry: a status poll leaves the
    // holder in peace and never takes the folder
    const polled = await fetch(`http://127.0.0.1:${refusedPort}/api/vault/status`);
    expect(polled.status).toBe(503);
    expect(readLogs()).not.toContain("the refused instance took the data folder");

    // release the folder and let the loop have it, so the child is closed
    // cleanly by afterEach
    holder.release();
    const deadline = Date.now() + 30_000;
    for (;;) {
      let ownerPid: number | undefined;
      try {
        // SAFETY: the lock record is JSON written by the reclaiming sidecar
        ownerPid = (JSON.parse(fs.readFileSync(path.join(dir, "vault.lock"), "utf8")) as { pid?: number }).pid;
      } catch {
        ownerPid = undefined;
      }
      if (ownerPid === second.pid) break;
      if (Date.now() >= deadline) throw new Error(`refused sidecar never took the closed folder; stderr: ${apiStderr}`);
      await sleep(100);
    }
  });

  itHeavy("the explicit retry takes the folder itself, before any automatic tick (#298)", async () => {
    // The route is not a route with a body: the POST runs the reclaim attempt
    // NOW. The only way to see that is to free the folder and ask — the answer
    // is `taken: true` and the folder is ours within the same request. An
    // automatic tick could take it first, so the ask is placed where the
    // schedule sits at its fifteen-second cap: the tick is then far away, and
    // the POST is the taker. A route disconnected from trigger() would answer
    // `taken: false` and leave the folder to the tick.
    const refusedPort = await freePort();
    const holder = acquireVaultLock(dir);
    second = startApi(refusedPort);
    await waitForLog("VAULT_LOCK_REFUSED");
    // The automatic schedule is 250, 500, 1s, 2s, 4s, 8s, 15s and 15s
    // forever, so the ticks land at 250, 750, 1750, 3750, 7750, 15750 ms.
    // Waiting past the 3750 ms tick leaves the next automatic attempt 3.75 s
    // away, so the POST below is unambiguously the taker.
    await sleep(4_000);

    holder.release();
    const asked = await fetch(`http://127.0.0.1:${refusedPort}/api/vault/reclaim`, { method: "POST" });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ ok: true, taken: true });
    // and the folder is the refused instance's, right now
    const secondPid = second.pid;
    if (secondPid === undefined) throw new Error("the refused sidecar has no pid");
    // SAFETY: the lock record is JSON written by the reclaiming sidecar
    expect((JSON.parse(fs.readFileSync(path.join(dir, "vault.lock"), "utf8")) as { pid: number }).pid).toBe(secondPid);
  });

  itPosix("a refused start that shuts down cleanly leaves the owner's port record alone (#277)", async () => {
    // The refused start publishes its own per-pid registry entry (the desktop
    // shell's identity check) and never the canonical record. Its shutdown
    // must withdraw exactly that entry: recomputing the canonical would
    // repoint or delete a record the owner is still serving.
    api = startApi(port);
    await waitForHealth(port);
    const portFile = path.join(dir, "run", ".dokan-port");
    const registryDir = path.join(dir, "run", ".dokan-port.registry");
    for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt += 1) await sleep(50);
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));
    const ownerPid = api.pid;
    if (ownerPid === undefined) throw new Error("the owner has no pid");
    // The owner's registry entry goes, so the canonical record is now one the
    // registry does not vouch for. This is the case that separates "removes its
    // own entry" from "reconciles the record": a refused start that recomputed
    // the canonical on its way out would find no survivor and DELETE a record
    // the owner is still serving (Greptile issue 6 on #298).
    fs.rmSync(path.join(registryDir, String(ownerPid)), { force: true });

    const refusedPort = await freePort();
    second = startApi(refusedPort);
    await waitForRefusal(refusedPort);
    const refusedPid = second.pid;
    if (refusedPid === undefined) throw new Error("the refused sidecar has no pid");
    // it published its own entry, and no canonical record of its own
    expect(fs.existsSync(path.join(registryDir, String(refusedPid)))).toBe(true);
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));

    // it shuts down cleanly: SIGTERM runs the shutdown, which reconciles
    const child = second;
    second = undefined;
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    expect(exitCode).toBe(0);
    // a record written after the exit would still be visible: wait a beat, so
    // a late write cannot pass unnoticed
    await sleep(500);

    // its own entry is withdrawn
    expect(fs.existsSync(path.join(registryDir, String(refusedPid)))).toBe(false);
    // and the owner's record is untouched, with the owner still serving
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  });

  itPosix("a shutdown while the publication waits for the port lock still withdraws the record (Greptile issue 2)", async () => {
    // The publication takes the shared port lock. A shutdown inside that window
    // used to read "this process published nothing" and skip the cleanup,
    // while the publication landed a moment later: the record then pointed at a
    // listener that was already gone, and discovery followed it.
    const lockDir = path.join(dir, "run", ".dokan-port.lock");
    const registryDir = path.join(dir, "run", ".dokan-port.registry");
    const portFile = path.join(dir, "run", ".dokan-port");
    api = startApi(port);
    await waitForHealth(port);
    for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt += 1) await sleep(50);
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));

    const childPort = await freePort();
    await withPortFileLock(lockDir, async () => {
      // a plaintext start publishes at bind, and its publication waits for the
      // lock this test holds
      const child = startApi(childPort, { DOKAN_VAULT: "disabled" });
      second = child;
      await waitForHealth(childPort);
      // the shutdown lands while the publication is still waiting
      child.kill("SIGTERM");
      await sleep(500);
    });
    // the lock is free again: the pending publication lands, and the shutdown
    // that waited for it withdraws what it wrote
    const child = second;
    if (child === undefined) throw new Error("the plaintext sidecar is gone");
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    expect(exitCode).toBe(0);
    // a publication that lands AFTER the exit is the bug this test is about:
    // wait a beat so a late write cannot pass unnoticed
    await sleep(2_000);
    // no entry of the child's own is left behind
    expect(fs.existsSync(path.join(registryDir, String(child.pid)))).toBe(false);
    // and the owner's record is the one that is left
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(port));
  });

  itHeavy("an unreadable lock file serves the standalone page and starts no retry loop (#298)", async () => {
    // vault.lock is a DIRECTORY: the path exists, so the read is not ENOENT,
    // and readFileSync fails with EISDIR. That is the unreadable refusal
    // (#287), a different branch from the held one: the page names the file
    // and says what to delete, and NOTHING changes until the owner acts, so
    // there is no point in a retry loop.
    const lockFile = path.join(dir, "vault.lock");
    fs.mkdirSync(lockFile);

    api = startApi(port);
    // greptile P1 on #298: this refusal is about a lock FILE, not about another
    // copy. The log row must name what the page names, and it must not be the
    // held refusal's event: the two have different remedies.
    await waitForLog("VAULT_LOCK_UNREADABLE");
    const unreadableRows = readLogEntries().filter((entry) => entry.event === "VAULT_LOCK_UNREADABLE");
    expect(unreadableRows).toHaveLength(1);
    // the row must not diagnose a second copy: nothing here read a holder, and
    // the page sends the owner to the lock file instead
    expect(unreadableRows[0]?.message).not.toContain("another instance owns the folder");
    expect(readLogEntries().some((entry) => entry.event === "VAULT_LOCK_REFUSED")).toBe(false);
    // the standalone refusal page, on the port this instance was given
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    expect(page.status).toBe(503);
    expect(html).toContain("تعذّر قراءة ملف القفل في مجلد البيانات");
    // the standalone page owns no port record: it does not own the folder
    expect(fs.existsSync(path.join(dir, "run", ".dokan-port"))).toBe(false);

    // the folder becomes acquirable: the directory is gone
    fs.rmSync(lockFile, { recursive: true, force: true });

    // The BRANCH, not the page: the unreadable refusal has no reclaim loop,
    // so the instance keeps serving the page and never takes the folder. A
    // retry loop would have taken it on its next tick (250 ms), and the page
    // alone would not have shown it.
    const reclaimDeadline = Date.now() + 3_000;
    while (Date.now() < reclaimDeadline) {
      if (fs.existsSync(lockFile)) break;
      await sleep(100);
    }
    expect(fs.existsSync(lockFile)).toBe(false);
    const still = await fetch(`http://127.0.0.1:${port}/`);
    expect(still.status).toBe(503);
    expect(await still.text()).toContain("تعذّر قراءة ملف القفل في مجلد البيانات");
    // and the reclaim never ran: main.ts logs that only when it does
    expect(readLogs()).not.toContain("the refused instance took the data folder");
  });

  itPosix("a running retry loop STOPS when it meets an unreadable lock file (#298)", async () => {
    // The other half of the unreadable story. At boot an unreadable lock starts
    // no loop (#287); this is the instance that was refused and is retrying when
    // the file becomes unreadable. The page it then serves says "delete the file
    // and reopen", so nothing may keep ticking: a loop would block the event
    // loop and log a reclaimed-race row every fifteen seconds against a story
    // only the owner can clear. The assertion is the folder itself — once the
    // file is gone, a live loop would take it on its next 250 ms tick.
    //
    // POSIX only: the holder keeps an open fd on the record, and Windows will
    // not unlink an open file.
    const lockFile = path.join(dir, "vault.lock");
    const refusedPort = await freePort();
    // the holder must survive the loss it is about to suffer: without a handler
    // the lock fail-stops the process that owns it, and that process is this
    // test runner
    const holder = acquireVaultLock(dir, { onLost: () => {} });
    second = startApi(refusedPort);
    await waitForLog("VAULT_LOCK_REFUSED");

    // swap the holder's readable record for a directory: same path, so the read
    // is EISDIR, not ENOENT — the unreadable refusal, not a free folder
    fs.rmSync(lockFile);
    fs.mkdirSync(lockFile);

    // the loop's next tick meets it and swaps the page to the lock-file story
    const pageDeadline = Date.now() + 20_000;
    for (;;) {
      const page = await fetch(`http://127.0.0.1:${refusedPort}/`);
      const html = await page.text();
      if (html.includes("تعذّر قراءة ملف القفل")) break;
      if (Date.now() >= pageDeadline) {
        throw new Error(`the refused sidecar never served the unreadable page; stderr: ${apiStderr}`);
      }
      await sleep(200);
    }

    // the owner does their half: the file goes away
    fs.rmSync(lockFile, { recursive: true, force: true });
    // longer than the first three backoff steps (250 + 500 + 1000 ms): a loop
    // that is still running takes the folder well inside this window
    await sleep(3_000);
    expect(fs.existsSync(lockFile)).toBe(false);
    // and the page still says what the owner has to do
    const still = await fetch(`http://127.0.0.1:${refusedPort}/`);
    expect(still.status).toBe(503);
    expect(await still.text()).toContain("تعذّر قراءة ملف القفل");
    expect(readLogs()).not.toContain("the refused instance took the data folder");
    holder.release();
  });

  itHeavy("a refused start takes the folder by itself once the holder is killed (#277)", async () => {
    const secondPort = await freePort();
    const thirdPort = await freePort();
    const lockFile = path.join(dir, "vault.lock");
    const portFile = path.join(dir, "run", ".dokan-port");
    const registryDir = path.join(dir, "run", ".dokan-port.registry");
    api = startApi(port);
    await waitForHealth(port);

    // the second sidecar is refused on its own port and must not hold the lock
    const refusedChild = startApi(secondPort);
    second = refusedChild;
    // the refusal is observed in the log, not over HTTP: a request is not a
    // retry any more, but the log is still the only observer that cannot
    // disturb what it watches
    await waitForLog("VAULT_LOCK_REFUSED");
    // SAFETY: the lock record is JSON written by the running sidecar
    const held = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number };
    const refusedPid = refusedChild.pid;
    if (refusedPid === undefined) throw new Error("the refused sidecar has no pid");
    expect(held.pid).not.toBe(refusedPid);

    // A THIRD sidecar is refused as well: two waiters, one folder (#298).
    // The second refusal is counted in the log, never asked for over HTTP.
    const otherChild = startApi(thirdPort);
    third = otherChild;
    const otherPid = otherChild.pid;
    if (otherPid === undefined) throw new Error("the second refused sidecar has no pid");
    await waitForLogCount("VAULT_LOCK_REFUSED", 2);
    // neither waiter holds the folder while the holder is alive
    // SAFETY: the lock record is JSON written by the running sidecar
    expect((JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number }).pid).toBe(held.pid);

    // kill the holder without a clean release: its lock stays behind, stale.
    // The refused instances must reclaim it on their own backoff, no restart.
    const holder = api;
    api = undefined;
    await hardKillAndWait(holder);

    // Watch the LOCK FILE, never the refusal server: reading the file observes
    // only what the loop did by itself, so the test cannot pass on an attempt
    // something other than the schedule set off.
    const deadline = Date.now() + 30_000;
    let ownerPid: number | undefined;
    for (;;) {
      try {
        // SAFETY: the lock record is JSON written by a running sidecar, and a
        // pid is optional in this test's view — a record without one simply is
        // not the reclaim, so `undefined` is a correct answer here
        ownerPid = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number }).pid;
      } catch {
        ownerPid = undefined;
      }
      if (ownerPid === refusedPid || ownerPid === otherPid) break;
      if (Date.now() >= deadline) throw new Error(`refused sidecar never took the folder; stderr: ${apiStderr}`);
      await sleep(100);
    }

    // EXACTLY ONE of the two waiters owns the folder (#298): the loser is
    // refused by the winner's live record, not by a lucky read
    expect(ownerPid === refusedPid || ownerPid === otherPid).toBe(true);
    const winnerPort = ownerPid === refusedPid ? secondPort : thirdPort;
    const loserPort = ownerPid === refusedPid ? thirdPort : secondPort;
    const loserPid = ownerPid === refusedPid ? otherPid : refusedPid;

    // the winner owns the folder: the vault gate serves instead of the refusal
    await expectFreshVaultGate(winnerPort);
    // SAFETY: the lock record is JSON written by the reclaiming sidecar
    expect((JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number }).pid).toBe(ownerPid);

    // the loser still refuses, and it says WHO holds the folder
    const loserStatus = await fetch(`http://127.0.0.1:${loserPort}/api/vault/status`);
    expect(loserStatus.status).toBe(503);
    // SAFETY: the refusal app serves this JSON shape by contract
    const loserBody = (await loserStatus.json()) as { error?: { code?: string } };
    expect(loserBody.error?.code).toBe("VAULT_LOCKED_BY_OTHER_INSTANCE");

    // the loser never deleted the winner's record
    expect(fs.existsSync(lockFile)).toBe(true);
    // SAFETY: the lock record is JSON written by the reclaiming sidecar
    expect((JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number }).pid).toBe(ownerPid);

    // and the loser left the canonical record to the winner. It DOES publish its
    // own per-pid registry entry: the desktop shell's identity check reads that
    // file and kills a child without one (#277), and it names the loser's own
    // port, so it points nothing at the refusal.
    expect(fs.existsSync(path.join(registryDir, String(loserPid)))).toBe(true);
    expect(fs.existsSync(path.join(registryDir, String(ownerPid)))).toBe(true);
    const publishDeadline = Date.now() + 10_000;
    for (;;) {
      if (fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8") === String(winnerPort)) break;
      if (Date.now() >= publishDeadline) break;
      await sleep(100);
    }
    expect(fs.readFileSync(portFile, "utf8")).toBe(String(winnerPort));
  });

  itHeavy("a refused start takes the folder once the holder CLOSES cleanly (#277)", async () => {
    // The headline of #277 is the CLOSE story: the other copy closes, the
    // close unlinks vault.lock, and the refused start takes the folder on its
    // next tick. The hard-kill story (the lock stays behind, stale) is a
    // different branch of acquireVaultLock and is covered by the test above.
    //
    // The holder is THIS process, because a clean close is what release() does
    // and that runs on every platform. The process-level version (a SIGTERM
    // that runs the child's exit hook) is the POSIX test below.
    const secondPort = await freePort();
    const lockFile = path.join(dir, "vault.lock");
    const holder = acquireVaultLock(dir);
    expect(fs.existsSync(lockFile)).toBe(true);

    // the second sidecar is refused on its own port and must not hold the lock
    const refusedChild = startApi(secondPort);
    second = refusedChild;
    await waitForLog("VAULT_LOCK_REFUSED");
    const refusedPid = refusedChild.pid;
    if (refusedPid === undefined) throw new Error("the refused sidecar has no pid");
    // the holder is still the owner while it is alive
    // SAFETY: the lock record is JSON written by this process
    expect((JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number }).pid).toBe(process.pid);

    // the holder CLOSES: release() is exactly what the exit hook runs on a
    // clean exit, and it unlinks the record
    holder.release();

    // the CLOSE story: the OLD owner's record is gone, not stale. A hard kill
    // would have left it behind, and the waiter would have had to reclaim it.
    // The file itself may already be the waiter's: the waiter can take the
    // folder before this test looks, and that is the recovery working, not a
    // failure (Greptile issue 3 on #298).
    expectOldOwnerGone(lockFile, process.pid);

    // the waiter's next tick sees ENOENT and takes the folder on the FIRST
    // attempt: the exclusive create succeeds, with no stale-reclaim path
    const deadline = Date.now() + 30_000;
    for (;;) {
      let ownerPid: number | undefined;
      try {
        // SAFETY: the lock record is JSON written by the reclaiming sidecar
        ownerPid = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number }).pid;
      } catch {
        ownerPid = undefined;
      }
      if (ownerPid === refusedPid) break;
      if (Date.now() >= deadline) {
        throw new Error(`refused sidecar never took the closed folder; stderr: ${apiStderr}`);
      }
      await sleep(100);
    }

    // it took the folder by the exclusive create, not by stealing a stale
    // record: the reclaim path in lock.ts logs that separately
    expect(readLogs()).not.toContain("reclaimed a stale lock");
    expect(readLogs()).not.toContain("reclaimed an unreadable lock");
    // and it now serves the vault gate, not merely something that is not a 503
    await expectFreshVaultGate(secondPort);
  });

  itPosix("a refused start takes the folder once the holder's process EXITS cleanly (#277)", async () => {
    // The same close story one level up: the holder is a separate process and
    // it closes through its own shutdown, so the lock file is unlinked by the
    // child's exit hook and not by a release() in this test.
    //
    // POSIX only: on Windows Bun's kill terminates the child outright, the
    // shutdown hook never runs, and whatever the exit leaves behind is a
    // crash, not a close. CI runs the api suite on ubuntu.
    const secondPort = await freePort();
    const lockFile = path.join(dir, "vault.lock");
    api = startApi(port);
    await waitForHealth(port);

    // the second sidecar is refused on its own port and must not hold the lock
    const refusedChild = startApi(secondPort);
    second = refusedChild;
    await waitForLog("VAULT_LOCK_REFUSED");
    const refusedPid = refusedChild.pid;
    if (refusedPid === undefined) throw new Error("the refused sidecar has no pid");

    // the holder CLOSES: SIGTERM runs its shutdown, which releases the lock
    const holder = api;
    api = undefined;
    holder.kill("SIGTERM");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    // the CLOSE story: the OLD owner's record is gone, not stale (the waiter
    // may already have written its own record here — Greptile issue 3)
    const holderPid = holder.pid;
    if (holderPid === undefined) throw new Error("the holder has no pid");
    expectOldOwnerGone(lockFile, holderPid);

    // the waiter's next tick sees ENOENT and takes the folder on the FIRST
    // attempt: the exclusive create succeeds, with no stale-reclaim path
    const deadline = Date.now() + 30_000;
    for (;;) {
      let ownerPid: number | undefined;
      try {
        // SAFETY: the lock record is JSON written by the reclaiming sidecar
        ownerPid = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number }).pid;
      } catch {
        ownerPid = undefined;
      }
      if (ownerPid === refusedPid) break;
      if (Date.now() >= deadline) {
        throw new Error(`refused sidecar never took the closed folder; stderr: ${apiStderr}`);
      }
      await sleep(100);
    }

    // it took the folder by the exclusive create, not by stealing a stale
    // record: the reclaim path in lock.ts logs that separately
    expect(readLogs()).not.toContain("reclaimed a stale lock");
    expect(readLogs()).not.toContain("reclaimed an unreadable lock");
    // and it now serves the vault gate, not merely something that is not a 503
    await expectFreshVaultGate(secondPort);
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
