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
if (action === "create") {
  for (const [folder, name] of [["current", "Original native record"], ["incoming", "Restored native record"]]) {
    if (folder === undefined || name === undefined) throw new Error("fixture incomplete");
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    const vault = manager(dir);
    const { vaultId } = await vault.prepareSetup(passphrase);
    const conn = createEncryptedConnection({ vaultId, masterKey: vault.setupMasterKey(), snapshotPath: vault.snapshotPath, headerPath: vault.headerPath, fresh: true });
    try {
      const store = createDrizzleStore(conn);
      await store.setup();
      await store.createCategory({ name });
      await vault.commitSetup();
    } finally { await conn.close(); vault.close(); }
    if (folder === "incoming") fs.writeFileSync(path.join(root, "selected.dknvbak"), createVaultBackupBundle(fs.readFileSync(vault.headerPath, "utf8"), fs.readFileSync(vault.snapshotPath)));
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
  const vault = manager(dir);
  await vault.unlock(passphrase);
  const conn = createEncryptedConnection({ vaultId: vault.metadata().vaultId, masterKey: vault.requireMasterKey(), snapshotPath: vault.snapshotPath });
  try {
    const store = createDrizzleStore(conn);
    console.log(JSON.stringify({ names: (await store.listCategories()).map((c) => c.name) }));
  } finally { await conn.close(); vault.close(); }
}
