import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LogEvent } from "@dokan/contracts";

import { openVaultStore } from "./vault-store";
import { readSnapshotFence } from "../lib/vault/format";

/**
 * The production wiring of the snapshot fence (#280). Every other fence test
 * calls `createEncryptedConnection` directly, so none of them proves that the
 * seam PRODUCTION uses — `openVaultStore` -> `createEncryptedConnection` — ever
 * passes the holder's token down. Deleting that pass-through would leave
 * production writing unfenced legacy envelopes forever, with every test in
 * the repository still green. This file is that missing link.
 */

let dir: string;
const vaultId = "11111111-2222-3333-4444-555555555555";
const masterKey = Buffer.alloc(32, 7);
const tokenA = "a".repeat(32);
const tokenB = "b".repeat(32);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const snapshotPath = (): string => path.join(dir, "dokan.db.enc");
const headerPath = (): string => path.join(dir, "vault.json");

describe("openVaultStore wires the snapshot fence (#280)", () => {
  it("stamps the holder's token into the snapshot the store writes", async () => {
    const { conn } = openVaultStore({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: headerPath(),
      fresh: true,
      writeStamp: () => tokenA,
    });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    await conn.persistIfDirty();

    const fence = readSnapshotFence(fs.readFileSync(snapshotPath()));
    expect(fence?.stamp).toBe(tokenA);
    await conn.close();
  });

  it("forwards the logger, so a fence the connection cannot verify still reports", async () => {
    // The shared vocabulary in packages/contracts/src/core.ts is the only place
    // a fence code may come from; a literal here would let the test invent one.
    const foreignFenceEvent: LogEvent = "VAULT_SNAPSHOT_FENCE_FOREIGN";

    // a former holder's snapshot: their token, so it is not ours to verify
    const former = openVaultStore({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: headerPath(),
      fresh: true,
      writeStamp: () => tokenA,
    });
    former.conn.raw.exec("CREATE TABLE t(a TEXT)");
    former.conn.markDirty();
    await former.conn.persistIfDirty();
    expect(readSnapshotFence(fs.readFileSync(snapshotPath()))?.stamp).toBe(tokenA);
    await former.conn.close();

    // The opening fence is reported by the CONNECTION, not the store. Dropping
    // the logger pass-through in openVaultStore therefore loses the one record
    // that this holder is rewriting bytes it cannot verify, while every other
    // test here — which never supplies a logger — stays green.
    const events: string[] = [];
    const current = openVaultStore({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: headerPath(),
      writeStamp: () => tokenB,
      logger: {
        warn: (event) => events.push(`warn:${event}`),
        info: (event) => events.push(`info:${event}`),
      },
    });
    // info, not warn: a restart always leaves the previous session's stamp, so
    // the routine case is information (a warn per boot hides the real incident)
    expect(events).toEqual([`info:${foreignFenceEvent}`]);
    await current.conn.close();
  });

  it("leaves the snapshot unfenced when the caller passes no stamp", async () => {
    const { conn } = openVaultStore({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: headerPath(),
      fresh: true,
    });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    await conn.persistIfDirty();

    const fence = readSnapshotFence(fs.readFileSync(snapshotPath()));
    expect(fence?.stamp).toBeUndefined();
    await conn.close();
  });

  it("main.ts hands the store the lock's own token, through the tested helper", () => {
    // main.ts boots the whole app when imported, so its half of the wiring
    // cannot be reached from a unit test. The source scan is what pins it:
    // the stamp must come from the lock, and it must come from the helper
    // whose two branches (a held lock, no lock) are unit tested above.
    const source = fs.readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    // a boolean, not a string compare: a failed `toContain` on a whole file
    // prints the file, and the failure line is the only useful part
    expect(source.includes("storeInput.writeStamp = () => holderToken(vaultLock);")).toBe(true);
  });
});
