import { createDrizzleStore } from "../store/drizzle-store";
import type { StorePort } from "../store/port";
import {
  createEncryptedConnection,
  type EncryptedConnection,
  type EncryptedConnectionOptions,
} from "./encrypted-connection";

/**
 * Open an encrypted store from a vault id and master key: the connection and
 * the StorePort are built together so main.ts, the gate tests, and the backup
 * round-trip all exercise the same bootstrap path (no test-local re-creation).
 *
 * The input IS the connection's options — spread through, never re-listed —
 * with the one field every bootstrap path has made required. A new connection
 * capability therefore costs one field on `EncryptedConnectionOptions` and no
 * statement here; anything that needs TRANSFORMING rather than forwarding
 * belongs in the connection, where the transform can be tested once.
 */
export type OpenVaultStoreInput = EncryptedConnectionOptions & {
  /** required here: every bootstrap path has a header to validate and bundle against */
  headerPath: string;
};

/** The two seams one encrypted-store bootstrap produces. */
export type OpenVaultStore = { conn: EncryptedConnection; store: StorePort };

export function openVaultStore(input: OpenVaultStoreInput): OpenVaultStore {
  const conn = createEncryptedConnection(input);
  // the same logger the connection got, now for the store's half of the seam
  return { conn, store: createDrizzleStore(conn, input.logger) };
}
