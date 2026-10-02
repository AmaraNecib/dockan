import { createDrizzleStore } from "../store/drizzle-store";
import type { StoreLogger, StorePort } from "../store/port";
import { createEncryptedConnection, type EncryptedConnection } from "./encrypted-connection";

/**
 * Open an encrypted store from a vault id and master key: the connection and
 * the StorePort are built together so main.ts, the gate tests, and the backup
 * round-trip all exercise the same bootstrap path (no test-local re-creation).
 */
export type OpenVaultStoreInput = {
  vaultId: string;
  masterKey: Uint8Array;
  snapshotPath: string;
  headerPath: string;
  /** first-run semantics; unlock paths must omit it */
  fresh?: boolean;
  /** decrypted legacy image to adopt on first run */
  seedBytes?: Uint8Array;
  logger?: StoreLogger;
};

/** The two seams one encrypted-store bootstrap produces. */
export type OpenVaultStore = { conn: EncryptedConnection; store: StorePort };

export function openVaultStore(input: OpenVaultStoreInput): OpenVaultStore {
  const options: Parameters<typeof createEncryptedConnection>[0] = {
    vaultId: input.vaultId,
    masterKey: input.masterKey,
    snapshotPath: input.snapshotPath,
    headerPath: input.headerPath,
  };
  if (input.fresh === true) options.fresh = true;
  if (input.seedBytes !== undefined) options.seedBytes = input.seedBytes;
  const conn = createEncryptedConnection(options);
  return { conn, store: createDrizzleStore(conn, input.logger) };
}
