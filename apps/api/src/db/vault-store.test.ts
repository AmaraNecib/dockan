import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openVaultStore } from "./vault-store";

/**
 * What `openVaultStore` is for: one bootstrap call yields the connection AND
 * the store standing on it, so main.ts, the gate tests and the backup
 * round-trip all share one pair instead of each composing their own.
 *
 * Field forwarding is deliberately NOT tested here. `OpenVaultStoreInput` IS
 * `EncryptedConnectionOptions` and the whole input object is passed unchanged,
 * so there is no per-field copy left to drop. A test per field could only prove
 * the adapter forwards what its own parameter type already carries, and the
 * failure that matters — a capability the connection supports silently not
 * arriving — can no longer be introduced by adding a field, because the object
 * is passed whole.
 *
 * That protection is the spread, not the compiler. A field-by-field copy would
 * still compile while omitting an optional field such as `writeStamp`,
 * `writeGuard` or `logger`. #280 and #291 both shipped fully green with exactly
 * that line deleted, which is why there is no copy left to delete.
 */

let dir: string;
const vaultId = "11111111-2222-3333-4444-555555555555";
const masterKey = Buffer.alloc(32, 7);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const snapshotPath = (): string => path.join(dir, "dokan.db.enc");
const headerPath = (): string => path.join(dir, "vault.json");

describe("openVaultStore composes the connection and the store", () => {
  it("serves a store write back from the encrypted snapshot on the next open", async () => {
    const first = openVaultStore({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: headerPath(),
      fresh: true,
    });
    await first.store.setup();
    await first.store.setSetting("composition-probe", "written-through-the-store");
    // flush, not persistIfDirty: the write is only real once it is on disk
    await first.conn.flush();
    await first.conn.close();

    // the connection's snapshot is the store's only copy of that row
    expect(fs.existsSync(snapshotPath())).toBe(true);

    const second = openVaultStore({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: headerPath(),
    });
    expect(await second.store.getSetting("composition-probe")).toBe("written-through-the-store");
    await second.conn.close();
  });

  it("main.ts hands the store the lock's own token", () => {
    // main.ts boots the whole app when imported, so its half of the #280 wiring
    // cannot be reached from a unit test. The source scan is what pins it: the
    // stamp must come from the lock, through the helper whose branches (a held
    // lock, no lock) are unit tested in lib/vault/lock.test.ts.
    //
    // This is NOT a forwarding test: it constrains what production puts in the
    // input, not what the adapter does with it. Deleting it would let main.ts
    // ship an unfenced stamp source with every test still green.
    const source = fs.readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    // a boolean, not a string compare: a failed `toContain` on a whole file
    // prints the file, and the failure line is the only useful part
    expect(source.includes("storeInput.writeStamp = () => holderToken(vaultLock);")).toBe(true);
  });
});
