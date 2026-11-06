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
async function bootAndStop(dir: string) {
  const port = await new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: listening on a TCP port returns AddressInfo, not a pipe name.
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
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

