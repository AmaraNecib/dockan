// Disposable encrypted fixtures for the Rust/native process-boundary test.
import fs from "node:fs";
import path from "node:path";
import { createEncryptedConnection } from "../db/encrypted-connection";
import { createDrizzleStore } from "../store/drizzle-store";
import { AppLogger } from "../lib/logger";
import { createVaultBackupBundle, extractVaultBackup } from "../lib/vault/backup";
import { VaultManager } from "../lib/vault/manager";

const root = process.argv[2];
const action = process.argv[3];
if (root === undefined) throw new Error("fixture root required");
const passphrase = "native fixture passphrase";
const kdf = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 } as const;
function manager(dir: string) { return new VaultManager({ dataDir: dir, legacyDbPath: path.join(dir, "dokan.db"), logger: new AppLogger(dir), kdf }); }
if (action === "create" || action === "create-webview") {
  const cases = [["current", "Original native record"], ["incoming", "Restored native record"]];
  if (action === "create-webview") cases.push(["newer", "Future native record"], ["broken", "Broken migration record"]);
  for (const [folder, name] of cases) {
    if (folder === undefined || name === undefined) throw new Error("fixture incomplete");
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    const vault = manager(dir);
    const fixturePassphrase = action === "create-webview" && folder !== "current" ? "incoming native fixture passphrase" : passphrase;
    const { vaultId } = await vault.prepareSetup(fixturePassphrase);
    const conn = createEncryptedConnection({ vaultId, masterKey: vault.setupMasterKey(), snapshotPath: vault.snapshotPath, headerPath: vault.headerPath, fresh: true });
    try {
      const store = createDrizzleStore(conn);
      await store.setup();
      await store.createCategory({ name });
      if (action === "create-webview") {
        conn.raw.exec("INSERT INTO user (id, name, created_at, updated_at) VALUES ('owner', 'Native fixture owner', 1, 1)");
        conn.markDirty();
        await store.setSetting("adminUserId", "owner");
        await store.setSetting("storeName", "Native restore fixture");
      }
      if (action === "create-webview" && folder !== "current") {
        conn.raw.exec(`PRAGMA user_version = ${folder === "newer" ? 999 : 0}`);
        if (folder === "broken") conn.raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE invoices; CREATE TABLE invoices (id TEXT PRIMARY KEY)");
        conn.markDirty();
        await conn.flush();
      }
      await vault.commitSetup();
    } finally { await conn.close(); vault.close(); }
    if (folder !== "current") fs.writeFileSync(path.join(root, folder === "incoming" ? "selected.dknvbak" : `${folder}.dknvbak`), createVaultBackupBundle(fs.readFileSync(vault.headerPath, "utf8"), fs.readFileSync(vault.snapshotPath)));
  }
  console.log(JSON.stringify({ ok: true }));
} else {
  let dir = path.join(root, "current");
  if (action === "safety") {
    dir = path.join(root, "safety-reopen");
    const safety = process.argv[4];
    if (safety === undefined) throw new Error("safety path required");
    await extractVaultBackup(fs.readFileSync(safety), dir);
  }
  const credential = process.argv[action === "safety" ? 5 : 4] ?? passphrase;
  const vault = manager(dir);
  await vault.unlock(credential);
  const conn = createEncryptedConnection({ vaultId: vault.metadata().vaultId, masterKey: vault.requireMasterKey(), snapshotPath: vault.snapshotPath });
  try {
    const store = createDrizzleStore(conn);
    console.log(JSON.stringify({ names: (await store.listCategories()).map((c) => c.name) }));
  } finally { await conn.close(); vault.close(); }
}
