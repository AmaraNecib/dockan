import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readSnapshotFence } from "../lib/vault/format";
import { openVaultStore } from "./vault-store";

/**
 * What `openVaultStore` is for: one bootstrap call yields the connection AND
 * the store standing on it, so main.ts, the gate tests and the backup
 * round-trip all share one pair instead of each composing their own. What it
 * actually owns is the pairing: the same `logger` reaches both halves, and the
 * caller gets both seams back.
 *
 * The connection's fields cannot be dropped here — `OpenVaultStoreInput` IS
 * `EncryptedConnectionOptions` and the whole object is passed unchanged. That
 * protection is the spread, not the compiler, and not a per-field test: a
 * field-by-field copy would still compile while omitting an optional field such
 * as `writeStamp`, `writeGuard` or `logger`. #280 and #291 both shipped fully
 * green with exactly that line deleted.
 *
 * The store's logger is the one explicit read left (`createDrizzleStore(conn,
 * input.logger)`), so it is not covered by the spread. The first test below is
 * what keeps the whole path honest: it asserts a `writeStamp` handed to the
 * adapter reaches the bytes on disk, which fails if the spread is ever turned
 * back into a re-listing.
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
    // The stamp is the assertion that matters: it is the only thing in this
    // suite tying what the adapter was HANDED to the bytes on disk. Turn the
    // spread back into a re-listing and this fails, instead of production
    // writing unfenced snapshots with every test green.
    const token = "f".repeat(32);
    const first = openVaultStore({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: headerPath(),
      fresh: true,
      writeStamp: () => token,
    });
    await first.store.setup();
    await first.store.setSetting("composition-probe", "written-through-the-store");
    // flush, not persistIfDirty: the write is only real once it is on disk
    await first.conn.flush();
    await first.conn.close();

    // the connection's snapshot is the store's only copy of that row
    expect(fs.existsSync(snapshotPath())).toBe(true);
    expect(readSnapshotFence(fs.readFileSync(snapshotPath()))?.stamp).toBe(token);

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

  it("main.ts rides the fence probe on the holder's heartbeat, and releases it on failure", () => {
    // The other half of the same wiring, and the half the integration test
    // cannot prove: `lock.integration.test.ts` re-creates this registration
    // inside the test, so it stays green if main.ts never registers at all —
    // the title of #292 ("the fence is re-read on the heartbeat") would then be
    // a description of a test, not of the app.
    //
    // A source scan rather than a race, deliberately: main.ts boots the whole
    // app when imported, and the assertion a race would need — "a probe ran on
    // a beat while a live lock held a live connection" — is only reachable
    // through the same wiring being tested, on a 10 s timer. The scan proves
    // the wiring is in the file, on the lock, calling the probe; the beat
    // itself, the once-per-change log and the no-write contract are pinned
    // against real time in `lock.integration.test.ts` and
    // `encrypted-connection.test.ts`.
    const source = fs.readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(/\.onHeartbeat\(\(\) => conn\.recheckFence\(\)\)/.test(source)).toBe(true);
    // and the unsubscribe is wired to the failure path: a bootstrap that throws
    // after the registration must not leave the beat reading a closed
    // connection for the lock's lifetime (Greptile, #292)
    expect(source.includes("stopHeartbeatProbe?.();")).toBe(true);
    // The fail-loud precondition sits BEFORE the connection is opened. It used
    // to sit after `openVaultStore` and before the `try`, so a missing lock
    // threw with `conn` already open, and its connection key was never zeroed
    // (architecture audit, PR #314). A scan can pin the ORDER, which is the
    // whole defect; a race cannot, because reaching that line needs the boot.
    const guardAt = source.indexOf(
      'if (vaultLock === undefined) throw new Error("the vault snapshot fence probe started without a held lock");',
    );
    const openAt = source.indexOf("const { conn, store } = openVaultStore(storeInput);");
    const tryAt = source.indexOf("stopHeartbeatProbe = heldLock.onHeartbeat(() => conn.recheckFence());");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(openAt);
    // and the registration is INSIDE the `try` that closes `conn` on failure,
    // so no throw stands between the open and its cleanup
    expect(openAt).toBeLessThan(tryAt);
    expect(source.indexOf("try {", openAt)).toBeLessThan(tryAt);
    expect(source.indexOf("stopHeartbeatProbe?.();", tryAt)).toBeGreaterThan(tryAt);
  });
});
