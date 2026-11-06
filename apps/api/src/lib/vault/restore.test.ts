import { afterEach, expect, it, spyOn } from "bun:test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEncryptedConnection, type EncryptedConnection } from "../../db/encrypted-connection";
import { createDrizzleStore } from "../../store/drizzle-store";
import { AppLogger } from "../logger";
import { CURRENT_SCHEMA_VERSION } from "../schema-version";
import { createVaultBackupBundle, extractVaultBackup } from "./backup";
import { acquireVaultLock, VaultAlreadyLockedError } from "./lock";
import { VaultManager } from "./manager";
import { recoverVaultReplacement, replaceVaultOffline, type RestoreStep } from "./restore";

const KDF = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 } as const;
const CURRENT = { passphrase: "current shop passphrase" };
const INCOMING = { passphrase: "backup shop passphrase" };
const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-replace-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function fixture(dir: string, name: string, passphrase: string, oldSchema = false, mutate?: (conn: EncryptedConnection) => void) {
  const manager = new VaultManager({ dataDir: dir, legacyDbPath: path.join(dir, "dokan.db"), logger: new AppLogger(dir), kdf: KDF });
  const prepared = await manager.prepareSetup(passphrase);
  const conn = createEncryptedConnection({ vaultId: prepared.vaultId, masterKey: manager.setupMasterKey(), snapshotPath: manager.snapshotPath, headerPath: manager.headerPath, fresh: true });
  const store = createDrizzleStore(conn);
  await store.setup();
  await store.createCategory({ name });
  conn.raw.exec(`INSERT INTO user (id, name, created_at, updated_at) VALUES ('owner', 'Fixture owner', 1, 1);
    INSERT INTO session (id, expiresAt, token, created_at, updated_at, userId) VALUES ('session', 9999999999999, 'stale-token', 1, 1, 'owner')`);
  conn.markDirty();
  await store.setSetting("adminUserId", "owner");
  if (oldSchema) {
    conn.raw.exec("PRAGMA user_version = 0");
    conn.markDirty();
  }
  mutate?.(conn);
  await conn.flush();
  await manager.commitSetup();
  await conn.close();
  manager.close();
  return { bundle: readBundle(dir), recoveryKey: prepared.recoveryKey };
}
function readBundle(dir: string) {
  return createVaultBackupBundle(fs.readFileSync(path.join(dir, "vault/vault.json"), "utf8"), fs.readFileSync(path.join(dir, "dokan.db.enc")));
}
async function names(dir: string, passphrase: string) {
  const manager = new VaultManager({ dataDir: dir, legacyDbPath: path.join(dir, "dokan.db"), logger: new AppLogger(dir), kdf: KDF });
  const session = await manager.unlock(passphrase);
  const conn = createEncryptedConnection({ vaultId: manager.metadata().vaultId, masterKey: manager.requireMasterKey(), snapshotPath: manager.snapshotPath });
  try {
    const store = createDrizzleStore(conn);
    return { names: (await store.listCategories()).map((c) => c.name), version: conn.raw.query("PRAGMA user_version").get(), sessions: conn.raw.query('SELECT token FROM "session"').all(), session }; 
  } finally {
    await conn.close();
    manager.close();
  }
}

it("installs and migrates an encrypted backup, preserving an independently unlockable safety copy", async () => {
  const current = temp();
  await fixture(current, "Current shop record", CURRENT.passphrase);
  const incoming = await fixture(temp(), "Restored shop record", INCOMING.passphrase, true);
  const result = await replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: INCOMING, currentCredential: CURRENT });
  const reopened = await names(current, INCOMING.passphrase);
  expect(reopened.names).toContain("Restored shop record");
  expect(reopened.names).not.toContain("Current shop record");
  expect(reopened.version).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
  expect(reopened.sessions).toEqual([]);
  const safetyDir = temp();
  await extractVaultBackup(fs.readFileSync(result.safetyPath), safetyDir);
  expect((await names(safetyDir, CURRENT.passphrase)).names).toContain("Current shop record");
  const lock = acquireVaultLock(current);
  try { expect(recoverVaultReplacement(current, lock)).toBe("committed"); } finally { lock.release(); }
  expect((await names(current, INCOMING.passphrase)).names).toContain("Restored shop record");
});

for (const step of ["snapshot", "migrated"] as const) {
  it(`rolls back original encrypted business records after failure at ${step}`, async () => {
    const current = temp();
    await fixture(current, "Original record", CURRENT.passphrase);
    const before = readBundle(current);
    const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase, true);
    await expect(replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: INCOMING, currentCredential: CURRENT,
      onProgress: (at) => { if (at === step) throw new Error(`injected ${step} failure`); },
    })).rejects.toThrow(`injected ${step} failure`);
    expect(readBundle(current).equals(before)).toBe(true);
    expect((await names(current, CURRENT.passphrase)).names).toContain("Original record");
  });
}

async function interrupt(current: string, bundle: Buffer, step: RestoreStep) {
  const source = path.join(temp(), "incoming.dknvbak");
  fs.writeFileSync(source, bundle);
  const moduleUrl = new URL("./restore.ts", import.meta.url).href;
  const script = `import fs from 'node:fs'; import { replaceVaultOffline } from ${JSON.stringify(moduleUrl)};
    await replaceVaultOffline({ dataDir: ${JSON.stringify(current)}, bundle: fs.readFileSync(${JSON.stringify(source)}),
      credential: ${JSON.stringify(INCOMING)}, currentCredential: ${JSON.stringify(CURRENT)},
      onProgress: step => { if (step === ${JSON.stringify(step)}) process.exit(77); } });`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 77, stderr: "" });
}
async function freePort() {
  return await new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: listening on a TCP port returns AddressInfo, not a pipe name.
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}
async function bootAndStop(dir: string) {
  const port = await freePort();
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...process.env, DOKAN_DATA_DIR: dir, DOKAN_PORT_ROOT: path.join(dir, "run"), DOKAN_PORT: String(port), DOKAN_VAULT: "on", DOKAN_VAULT_STDIN: "1" },
    stdin: new Blob(['{"action":"status"}\n']), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const reply = new TextDecoder().decode(first.value);
    expect(reply).toContain('"ok":true');
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    if (stderr !== "") console.error(stderr);
  }
}

for (const step of ["safety", "intent", "snapshot", "header", "migrated", "verified"] as const) {
  it(`recovers original records on real sidecar startup after process interruption at ${step}`, async () => {
    const current = temp();
    await fixture(current, "Original record", CURRENT.passphrase);
    const before = readBundle(current);
    const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase, true);
    await interrupt(current, incoming.bundle, step);
    await bootAndStop(current);
    expect(readBundle(current).equals(before)).toBe(true);
    expect((await names(current, CURRENT.passphrase)).names).toContain("Original record");
  }, 15000);
}

it("does not replay terminal rollback over records saved after recovery on later boots", async () => {
  const current = temp();
  await fixture(current, "Original record", CURRENT.passphrase);
  const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase);
  await expect(replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: INCOMING, currentCredential: CURRENT,
    onProgress: (step) => { if (step === "header") throw new Error("injected install failure"); },
  })).rejects.toThrow("injected install failure");
  const journalPath = path.join(current, "vault/restore-intent.json");
  const journal = fs.readFileSync(journalPath);
  expect(JSON.parse(journal.toString()).state).toBe("rolled-back");
  const manager = new VaultManager({ dataDir: current, legacyDbPath: path.join(current, "dokan.db"), logger: new AppLogger(current), kdf: KDF });
  await manager.unlock(CURRENT.passphrase);
  const conn = createEncryptedConnection({ vaultId: manager.metadata().vaultId, masterKey: manager.requireMasterKey(), snapshotPath: manager.snapshotPath });
  try { await createDrizzleStore(conn).createCategory({ name: "Saved after rollback" }); }
  finally { await conn.close(); manager.close(); }
  const saved = readBundle(current);
  for (let boot = 0; boot < 2; boot++) {
    await bootAndStop(current);
    expect(readBundle(current).equals(saved)).toBe(true);
    expect(fs.readFileSync(journalPath).equals(journal)).toBe(true);
    expect((await names(current, CURRENT.passphrase)).names).toContain("Saved after rollback");
  }
}, 15000);

it("retains a retryable intent when rollback itself is interrupted between the encrypted pair", async () => {
  const current = temp();
  await fixture(current, "Original record", CURRENT.passphrase);
  const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase);
  await interrupt(current, incoming.bundle, "header");
  const lock = acquireVaultLock(current);
  const rename = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === path.join(current, "vault/vault.json")) throw new Error("interrupted rollback");
    return rename(from, to);
  });
  try {
    expect(() => recoverVaultReplacement(current, lock)).toThrow("interrupted rollback");
  } finally {
    spy.mockRestore();
    lock.release();
  }
  await bootAndStop(current);
  expect((await names(current, CURRENT.passphrase)).names).toContain("Original record");
}, 15000);

it("native quiescence refuses unauthorized stops, closes the served vault, and refuses stale writers", async () => {
  const current = temp();
  await fixture(current, "Original record", CURRENT.passphrase);
  const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase);
  const port = await freePort();
  const bootToken = "a".repeat(64);
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...process.env, DOKAN_DATA_DIR: current, DOKAN_PORT_ROOT: path.join(current, "run"), DOKAN_PORT: String(port), DOKAN_VAULT: "on", DOKAN_VAULT_STDIN: "1", DOKAN_BOOT_TOKEN: bootToken },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 12000);
  try {
    const reader = child.stdout.getReader();
    child.stdin.write(`${JSON.stringify({ action: "unlock", passphrase: CURRENT.passphrase })}\n`);
    const first = await reader.read();
    const reply = JSON.parse(new TextDecoder().decode(first.value));
    expect(reply.ok).toBe(true);
    const url = `http://127.0.0.1:${port}`;
    const stop = (token: string, boot: string) => fetch(`${url}/api/vault/quiesce`, { method: "POST", headers: { "x-vault-session": token, "x-dokan-boot-token": boot } });
    expect((await stop(reply.sessionToken, "wrong-launch")).status).toBe(401);
    expect((await stop("stale-session", bootToken)).status).toBe(401);
    await expect(replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: INCOMING, currentCredential: CURRENT })).rejects.toBeInstanceOf(VaultAlreadyLockedError);
    // Hold a real RPC body in flight. Node emits 100 Continue before awaiting
    // the body, so the request is admitted before native quiescence arrives.
    const body = JSON.stringify({ json: { name: "Drained business record" } });
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    let continued = () => {};
    const admitted = new Promise<void>((resolve) => { continued = resolve; });
    const completed = new Promise<string>((resolve, reject) => {
      socket.on("data", (chunk) => { response += chunk.toString(); if (response.includes("100 Continue")) continued(); });
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
    });
    socket.write(`POST /api/rpc/categoriesCreate HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-vault-session: ${reply.sessionToken}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`);
    await admitted;
    const stopping = stop(reply.sessionToken, bootToken).catch((error: Error) => error);
    // Wait until admission is closed without completing the held request.
    for (;;) {
      const probe = await fetch(`${url}/api/vault/status`);
      if (probe.status === 503) break;
      await Bun.sleep(1);
    }
    socket.write(body);
    expect(await completed).toContain("200 OK");
    const stopped = await stopping;
    if (stopped instanceof Error) throw stopped;
    expect(stopped.status).toBe(200);
    for (const route of ["/api/rpc/categoriesCreate", "/api/vault/change-passphrase", "/api/vault/setup", "/api/vault/unlock"]) {
      expect((await fetch(`${url}${route}`, { method: "POST", headers: { "x-vault-session": reply.sessionToken, "content-type": "application/json" }, body: "{}" })).status).toBe(503);
    }
    // Quiescence retains the lock until the native process has reaped this child.
    await expect(replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: INCOMING, currentCredential: CURRENT })).rejects.toBeInstanceOf(VaultAlreadyLockedError);
    child.kill();
    await child.exited;
    const installed = await replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: INCOMING, currentCredential: CURRENT });
    const safetyDir = temp();
    await extractVaultBackup(fs.readFileSync(installed.safetyPath), safetyDir);
    expect((await names(safetyDir, CURRENT.passphrase)).names).toContain("Drained business record");
    expect((await names(current, INCOMING.passphrase)).names).toContain("Replacement record");
    const manager = new VaultManager({ dataDir: current, legacyDbPath: path.join(current, "dokan.db"), logger: new AppLogger(current), kdf: KDF });
    try {
      await manager.unlock(INCOMING.passphrase);
      expect(manager.sessionMatches(reply.sessionToken)).toBe(false);
    } finally { manager.close(); }
  } finally {
    clearTimeout(timer);
    if (child.exitCode !== null && child.exitCode !== 0) {
      const logDir = path.join(current, "logs");
      for (const file of fs.readdirSync(logDir)) console.error(fs.readFileSync(path.join(logDir, file), "utf8"));
    }
    child.kill();
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    if (stderr !== "") console.error(stderr);
  }
}, 15000);

type NativeWorkerRequest = {
  action: string; path?: string; credential: { passphrase: string };
  currentCredential?: { passphrase: string }; expectedSha256?: string; confirmed?: boolean;
};
async function nativeWorker(dir: string, request: NativeWorkerRequest) {
  const child = Bun.spawn([process.execPath, "src/main.ts", "--vault-restore-worker"], {
    cwd: path.resolve(import.meta.dir, "../../.."), env: { ...process.env, DOKAN_DATA_DIR: dir },
    stdin: new Blob([JSON.stringify(request)]), stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, body: JSON.parse(stdout), stderr };
}

it("authenticates the current safety credential before native shutdown without changing current data", async () => {
  const current = temp();
  await fixture(current, "Original record", CURRENT.passphrase);
  const before = readBundle(current);
  expect((await nativeWorker(current, { action: "current", credential: INCOMING })).exit).toBe(1);
  const verified = await nativeWorker(current, { action: "current", credential: CURRENT });
  expect(verified.exit).toBe(0);
  expect(verified.body).toEqual({ ok: true });
  expect(readBundle(current).equals(before)).toBe(true);
});

it("pins native confirmation to authenticated preview bytes and installs through the one-shot process", async () => {
  const current = temp();
  await fixture(current, "Original record", CURRENT.passphrase);
  const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase, true);
  const selected = path.join(temp(), "chosen.dknvbak");
  fs.writeFileSync(selected, incoming.bundle);
  const preview = await nativeWorker(current, { action: "preview", path: selected, credential: INCOMING });
  expect(preview.exit).toBe(0);
  expect(preview.body.preview).toMatchObject({ schemaVersion: 0, compatible: true });
  expect(preview.body.preview.fileModifiedAt).toBe(fs.statSync(selected).mtime.toISOString());
  const before = readBundle(current);
  const request = { action: "install", path: selected, credential: INCOMING, currentCredential: CURRENT, expectedSha256: preview.body.preview.sha256 };
  expect((await nativeWorker(current, request)).exit).toBe(1);
  const changed = Buffer.from(incoming.bundle);
  changed[changed.length - 1] = 0;
  fs.writeFileSync(selected, changed);
  expect((await nativeWorker(current, { ...request, confirmed: true })).exit).toBe(1);
  expect(readBundle(current).equals(before)).toBe(true);
  fs.writeFileSync(selected, incoming.bundle);
  expect((await nativeWorker(current, { ...request, confirmed: true })).exit).toBe(0);
  expect((await names(current, INCOMING.passphrase)).names).toContain("Replacement record");
}, 15000);

it("restores the original after a real post-install migration error", async () => {
  const current = temp();
  await fixture(current, "Original record", CURRENT.passphrase);
  const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase, true, (conn) => {
    conn.raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE invoices; CREATE TABLE invoices (id TEXT PRIMARY KEY)");
  });
  let installed = false;
  await expect(replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: INCOMING, currentCredential: CURRENT,
    onProgress: (step) => { if (step === "header") installed = true; },
  })).rejects.toThrow();
  expect(installed).toBe(true);
  expect((await names(current, CURRENT.passphrase)).names).toContain("Original record");
});

it("refuses a newer schema before installation and accepts recovery-key authorization", async () => {
  const current = temp();
  const original = await fixture(current, "Original record", CURRENT.passphrase);
  const newer = await fixture(temp(), "Future record", INCOMING.passphrase, false, (conn) => conn.raw.exec("PRAGMA user_version = 999"));
  const before = readBundle(current);
  await expect(replaceVaultOffline({ dataDir: current, bundle: newer.bundle, credential: INCOMING, currentCredential: CURRENT })).rejects.toThrow();
  expect(readBundle(current).equals(before)).toBe(true);
  const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase);
  await replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: { recoveryKey: incoming.recoveryKey }, currentCredential: { recoveryKey: original.recoveryKey } });
  expect((await names(current, INCOMING.passphrase)).names).toContain("Replacement record");
});

it("refuses a live writer and refuses bad credentials or ciphertext without mutating current data", async () => {
  const current = temp();
  await fixture(current, "Original record", CURRENT.passphrase);
  const incoming = await fixture(temp(), "Replacement record", INCOMING.passphrase);
  const before = readBundle(current);
  const lock = acquireVaultLock(current);
  try {
    await expect(replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, credential: INCOMING, currentCredential: CURRENT })).rejects.toBeInstanceOf(VaultAlreadyLockedError);
  } finally { lock.release(); }
  for (const credentials of [
    { credential: { passphrase: "wrong backup key" }, currentCredential: CURRENT },
    { credential: INCOMING, currentCredential: { passphrase: "wrong current key" } },
  ]) {
    await expect(replaceVaultOffline({ dataDir: current, bundle: incoming.bundle, ...credentials })).rejects.toThrow();
    expect(readBundle(current).equals(before)).toBe(true);
  }
  const damaged = Buffer.from(incoming.bundle);
  const last = damaged.length - 1;
  damaged[last] = (damaged[last] ?? 0) ^ 0xff;
  await expect(replaceVaultOffline({ dataDir: current, bundle: damaged, credential: INCOMING, currentCredential: CURRENT })).rejects.toThrow();
  expect(readBundle(current).equals(before)).toBe(true);
  expect((await names(current, CURRENT.passphrase)).names).toContain("Original record");
});

