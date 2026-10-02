import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { Database } from "bun:sqlite";

import { readVaultBackupBundle } from "./backup";

/**
 * The desktop shell's pre-boot broker (DOKAN_VAULT_STDIN=1) over its real
 * process boundary: the passphrase/recovery key goes in on stdin, exactly one
 * JSON reply comes back on stdout, and the HTTP app starts only after unlock.
 * Nothing is asserted about internal functions, so the shell's protocol is
 * pinned end to end.
 */

let dir: string;
let port: number;
let child: ChildProcessWithoutNullStreams | undefined;

/**
 * CI is slower than a dev laptop: every broker test spawns a real process and
 * runs Argon2id inside it, so each test states its own per-test budget (the
 * default 5s timed out in CI).
 */
const BROKER_TIMEOUT_MS = 30_000;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a live listening TCP socket's address() is an AddressInfo,
      // never null or the Unix-socket string form for an INET listener
      const assigned = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(assigned));
    });
    server.on("error", reject);
  });
}

/**
 * The exact environment the shell hands the broker. A passphrase must never
 * appear here (issue #141): it travels on stdin only. Pure so the test can pin
 * the contract without racing the child.
 */
function brokerEnvironment(dataDir: string, apiPort: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOKAN_DATA_DIR: dataDir,
    DOKAN_PORT: String(apiPort),
    DOKAN_PORT_ROOT: path.join(dataDir, "run"),
    DOKAN_VAULT_STDIN: "1",
  };
}

function spawnBroker(dataDir: string, apiPort: number): ChildProcessWithoutNullStreams {
  return spawn("bun", ["src/main.ts"], {
    cwd: path.join(import.meta.dir, "..", "..", ".."),
    env: brokerEnvironment(dataDir, apiPort),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** One line at a time from the child's stdout, buffered by readline. */
function lineReader(child: ChildProcessWithoutNullStreams): () => Promise<string> {
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return async () => {
    const next = await lines.next();
    if (next.done === true) throw new Error("broker stdout closed");
    return next.value;
  };
}

/** Send one broker line; the child only needs newline framing. */
function send(child: ChildProcessWithoutNullStreams, line: string): void {
  child.stdin.write(`${line}\n`);
}

async function waitForHealth(apiPort: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/health`);
      if (response.ok) return;
    } catch {
      /* not bound yet */
    }
    if (Date.now() >= deadline) throw new Error("api never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The first daily backup lands right after the setup reply; poll for it. */
async function waitForBackupFile(timeoutMs = 15_000): Promise<string> {
  const backupsDir = path.join(dir, "backups");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const entry = fs.readdirSync(backupsDir).find((name) => name.startsWith("dokan-"));
      if (entry !== undefined) return path.join(backupsDir, entry);
    } catch {
      /* the folder does not exist yet */
    }
    if (Date.now() >= deadline) throw new Error("daily backup was never created after setup");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopAndWait(): Promise<void> {
  if (child === undefined) return;
  const running = child;
  child = undefined;
  const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
  running.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-broker-"));
  port = await freePort();
});

afterEach(async () => {
  await stopAndWait();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

describe("desktop shell vault broker", () => {
  it("rejects a whitespace-only setup passphrase over stdin (normalized floor)", async () => {
    child = spawnBroker(dir, port);
    const nextLine = lineReader(child);
    send(child, JSON.stringify({ action: "setup", passphrase: "        " }));
    // SAFETY: the broker contract is a single JSON reply line per request
    const reply = JSON.parse(await nextLine()) as { ok: boolean; code?: string };
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("VAULT_PASSPHRASE_TOO_SHORT");
    await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
    expect(child?.exitCode).not.toBe(0);
  }, BROKER_TIMEOUT_MS);

  it("sets up over stdin, returns the recovery key once, and serves the app after the ack", async () => {
    child = spawnBroker(dir, port);
    const nextLine = lineReader(child);
    send(child, JSON.stringify({ action: "setup", passphrase: "correct horse battery" }));

    // SAFETY: the broker contract is a single JSON reply line per request
    const setupReply = JSON.parse(await nextLine()) as { ok: boolean; recoveryKey?: string; sessionToken?: string };
    expect(setupReply.ok).toBe(true);
    expect(setupReply.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(setupReply.sessionToken?.length).toBeGreaterThan(20);
    // the vault is open and the recovery key was returned before the shell can navigate
    const status = await fetch(`http://127.0.0.1:${port}/api/vault/status`);
    // SAFETY: the status route returns { state: string } per the vault contract
    expect(((await status.json()) as { state: string }).state).toBe("unlocked");

    send(child, "ack");
    await waitForHealth(port);
    // the app is reachable with the minted session token
    const rpc = await fetch(`http://127.0.0.1:${port}/api/rpc/needsSetup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vault-session": setupReply.sessionToken ?? "" },
      body: "{}",
    });
    expect(rpc.ok).toBe(true);

    // the first daily backup runs AFTER the header commit (finding 6): the
    // brand-new shop has a valid self-contained backup without another unlock
    const backupFile = await waitForBackupFile();
    expect(readVaultBackupBundle(fs.readFileSync(backupFile))).toBeDefined();
  }, BROKER_TIMEOUT_MS);

  it("refuses a wrong passphrase with the Arabic code and exits without serving", async () => {
    // create a vault first
    child = spawnBroker(dir, port);
    const firstLine = lineReader(child);
    send(child, JSON.stringify({ action: "setup", passphrase: "correct horse battery" }));
    await firstLine();
    send(child, "ack");
    await waitForHealth(port);
    await stopAndWait();

    // a failed unlock must report a code and exit (the shell respawns)
    child = spawnBroker(dir, port);
    const nextLine = lineReader(child);
    send(child, JSON.stringify({ action: "unlock", passphrase: "wrong horse battery" }));
    // SAFETY: the broker contract is a single JSON reply line per request;
    // failures carry only the stable code (locale-neutral, round-6)
    const reply = JSON.parse(await nextLine()) as { ok: boolean; code?: string; message?: string };
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("VAULT_WRONG_PASSPHRASE");
    expect(reply.message).toBeUndefined();
    expect(JSON.stringify(reply)).not.toMatch(/[\u0600-\u06FF]/);
    // and the process is gone (no lingering pre-unlock server)
    await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
    expect(child?.exitCode).not.toBe(0);
  }, BROKER_TIMEOUT_MS);

  it("unlocks with a recovery key over stdin", async () => {
    child = spawnBroker(dir, port);
    const firstLine = lineReader(child);
    send(child, JSON.stringify({ action: "setup", passphrase: "correct horse battery" }));
    // SAFETY: the broker contract is a single JSON reply line per request
    const setupReply = JSON.parse(await firstLine()) as { recoveryKey: string };
    send(child, "ack");
    await waitForHealth(port);
    await stopAndWait();

    child = spawnBroker(dir, port);
    const nextLine = lineReader(child);
    send(child, JSON.stringify({ action: "recovery", recoveryKey: setupReply.recoveryKey }));
    // SAFETY: the broker contract is a single JSON reply line per request
    const reply = JSON.parse(await nextLine()) as { ok: boolean; sessionToken?: string };
    expect(reply.ok).toBe(true);
    expect(reply.sessionToken?.length).toBeGreaterThan(20);
    await waitForHealth(port);
  }, BROKER_TIMEOUT_MS);

  it("answers a status probe over the pipe without consuming the one-shot request (issue #141)", async () => {
    child = spawnBroker(dir, port);
    const nextLine = lineReader(child);
    send(child, JSON.stringify({ action: "status" }));
    // SAFETY: the broker status contract is a single JSON reply line
    const statusReply = JSON.parse(await nextLine()) as { ok: boolean; status?: { broker?: boolean; state?: string } };
    expect(statusReply.ok).toBe(true);
    expect(statusReply.status?.broker).toBe(true);
    expect(statusReply.status?.state).toBe("unconfigured");

    // the same child still takes the real one-shot request
    send(child, JSON.stringify({ action: "setup", passphrase: "correct horse battery" }));
    // SAFETY: the broker contract is a single JSON reply line per request
    const setupReply = JSON.parse(await nextLine()) as { ok: boolean; recoveryKey?: string };
    expect(setupReply.ok).toBe(true);
    expect(setupReply.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    send(child, "ack");
    await waitForHealth(port);
  }, BROKER_TIMEOUT_MS);

  it("refuses HTTP pre-boot credential routes in broker mode: the secret has only the pipe (issue #141)", async () => {
    child = spawnBroker(dir, port);
    await waitForHealth(port);
    const status = await fetch(`http://127.0.0.1:${port}/api/vault/status`);
    expect(status.status).toBe(200);
    // SAFETY: the status route contract includes the broker flag
    expect(((await status.json()) as { broker?: boolean }).broker).toBe(true);

    for (const route of ["/api/vault/setup", "/api/vault/unlock", "/api/vault/unlock-recovery", "/api/vault/reset-passphrase"]) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "over http", recoveryKey: "AAAA-AAAA", newPassphrase: "over http too" }),
      });
      expect(response.status).toBe(403);
      // SAFETY: the error contract is { error: { code } }
      expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("VAULT_BROKER_REQUIRED");
    }

    // the HTTP refusals did not consume the pipe: the real request still works
    const nextLine = lineReader(child);
    send(child, JSON.stringify({ action: "setup", passphrase: "correct horse battery" }));
    // SAFETY: the broker contract is a single JSON reply line per request
    const setupReply = JSON.parse(await nextLine()) as { ok: boolean; recoveryKey?: string };
    expect(setupReply.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
  }, BROKER_TIMEOUT_MS);

  it("resets the passphrase from a recovery key over the pipe (round-2 finding 2)", async () => {
    child = spawnBroker(dir, port);
    const firstLine = lineReader(child);
    send(child, JSON.stringify({ action: "setup", passphrase: "correct horse battery" }));
    // SAFETY: the broker contract is a single JSON reply line per request
    const setupReply = JSON.parse(await firstLine()) as { recoveryKey: string };
    send(child, "ack");
    await waitForHealth(port);
    await stopAndWait();

    // settings resets from the recovery key while the vault is open; broker
    // mode refuses the HTTP route, so the reset must work on the pipe
    child = spawnBroker(dir, port);
    const resetLine = lineReader(child);
    send(
      child,
      JSON.stringify({ action: "reset", recoveryKey: setupReply.recoveryKey, newPassphrase: "a brand new passphrase" }),
    );
    // SAFETY: the broker contract is a single JSON reply line per request
    const resetReply = JSON.parse(await resetLine()) as { ok: boolean; sessionToken?: string };
    expect(resetReply.ok).toBe(true);
    expect(resetReply.sessionToken?.length).toBeGreaterThan(20);
    await waitForHealth(port);
    await stopAndWait();

    // the new passphrase is the one that unlocks now
    child = spawnBroker(dir, port);
    const unlockLine = lineReader(child);
    send(child, JSON.stringify({ action: "unlock", passphrase: "a brand new passphrase" }));
    // SAFETY: the broker contract is a single JSON reply line per request
    const unlockReply = JSON.parse(await unlockLine()) as { ok: boolean; sessionToken?: string };
    expect(unlockReply.ok).toBe(true);
    expect(unlockReply.sessionToken?.length).toBeGreaterThan(20);
  }, BROKER_TIMEOUT_MS);

  it("reports plaintext files that could not be removed in the setup reply (round-2 finding 4)", async () => {
    // an unencryptable legacy backup: the sweep reports it instead of hiding it
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const stubborn = path.join(backupsDir, "dokan-2020-01-02.db");
    const legacy = new Database(stubborn, { create: true });
    legacy.exec("CREATE TABLE t(a TEXT)");
    legacy.exec("PRAGMA user_version = 99");
    legacy.close();

    child = spawnBroker(dir, port);
    const nextLine = lineReader(child);
    send(child, JSON.stringify({ action: "setup", passphrase: "correct horse battery" }));
    // SAFETY: the broker setup contract carries the cleanup list
    const reply = JSON.parse(await nextLine()) as { ok: boolean; recoveryKey?: string; plaintextRemaining?: string[] };
    expect(reply.ok).toBe(true);
    expect(reply.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    // the warning data rides the one reply the owner sees
    expect(reply.plaintextRemaining).toEqual([stubborn]);
    send(child, "ack");
    await waitForHealth(port);
  }, BROKER_TIMEOUT_MS);

  it("keeps the passphrase out of the sidecar's argv and environment (issue #141)", async () => {
    const secret = "phrase only the stdin pipe may see";
    const env = brokerEnvironment(dir, port);
    expect(JSON.stringify(Object.entries(env))).not.toContain(secret);
    child = spawnBroker(dir, port);
    await waitForHealth(port);
    const nextLine = lineReader(child);
    // the secret goes in ONLY on stdin
    send(child, JSON.stringify({ action: "setup", passphrase: secret }));
    // SAFETY: the broker contract is a single JSON reply line per request
    const reply = JSON.parse(await nextLine()) as { ok: boolean };
    expect(reply.ok).toBe(true);

    // the live process's own argv/env must not carry it (Linux exposes both)
    expect(child.spawnargs.join(" ")).not.toContain(secret);
    if (process.platform === "linux" && child.pid !== undefined) {
      const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
      const environ = fs.readFileSync(`/proc/${child.pid}/environ`, "utf8");
      expect(cmdline).not.toContain(secret);
      expect(environ).not.toContain(secret);
    }
    send(child, "ack");
    await waitForHealth(port);
  }, BROKER_TIMEOUT_MS);
});
