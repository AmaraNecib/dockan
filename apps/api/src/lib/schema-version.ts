import type { Database } from "bun:sqlite";

/**
 * The data format this build reads and writes. Bump on every forward schema
 * change; `PRAGMA user_version` stores it. A database with no version (0) is
 * treated as the oldest pre-universal format and migrated forward on open.
 *
 * Version 2 (issue 161, ADR-0009): the signed supplier account. An older
 * build accepts the version-1 shape but would record purchases and payments
 * without supplier entries, silently corrupting the balance, so this format
 * MUST be refused by a version-1 build (ADR-0008 §4.5).
 *
 * Version 3 (issue 176): the manual adjustment kind (تسوية) and the
 * `supplier_account_entries.direction` column that carries its sign. An older
 * build accepts the version-2 shape but signs an adjustment with no branch of
 * its own — it would read a «نسالوه» adjustment as a decrement — so a
 * version-2 build MUST refuse this format (ADR-0008 §4.5).
 *
 * Version 4 (issue 181): the `supplier_account_entries.dedup_key` column and
 * its partial unique index — the DB backstop for the #177 adjustment dedup, plus
 * the explicit client idempotency key. A version-3 build does not know the
 * column, so it writes every new ADJUSTMENT with a NULL `dedup_key`, which the
 * partial index exempts: those rows silently escape the new dedup, and the v4
 * backfill never re-keys them (it runs only when the column is missing). It MUST
 * therefore refuse the version-4 database (ADR-0008 §4.5).
 */
export const CURRENT_SCHEMA_VERSION = 4;

/**
 * A database written by a newer app. The older build cannot know what the
 * newer format changed, so it refuses instead of corrupting it. The message is
 * Arabic because it is shown to the shop owner at boot.
 */
export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly foundVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      "تعذّر فتح البيانات: هذه النسخة من التطبيق أقدم من قاعدة البيانات " +
        `(نسخة قاعدة البيانات ${foundVersion}، والمدعومة ${supportedVersion}). ` +
        "حدّث دكان ثم أعد المحاولة.",
    );
    this.name = "UnsupportedSchemaVersionError";
  }
}

/** The stored schema version; 0 means "never stamped" (the oldest format). */
export function readSchemaVersion(raw: Database): number {
  // SAFETY: PRAGMA user_version always returns exactly one object with the
  // integer column `user_version`
  const row = raw.query("PRAGMA user_version").get() as { user_version: number } | null;
  return row?.user_version ?? 0;
}

/**
 * Refuse a database this build cannot read. Returns the stored version so the
 * caller can log it. Older versions are accepted: `store.setup()` applies the
 * forward migrations and stamps the current version.
 */
export function assertSchemaVersionSupported(raw: Database, supportedVersion = CURRENT_SCHEMA_VERSION): number {
  const found = readSchemaVersion(raw);
  if (found > supportedVersion) {
    throw new UnsupportedSchemaVersionError(found, supportedVersion);
  }
  return found;
}

/**
 * Stamp the current schema version after the forward migrations ran. The value
 * is a trusted integer constant, never caller data, so it is safe to inline
 * (PRAGMA does not accept bound parameters).
 */
export function stampSchemaVersion(raw: Database, version = CURRENT_SCHEMA_VERSION): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`refusing to stamp an invalid schema version: ${version}`);
  }
  raw.exec(`PRAGMA user_version = ${version}`);
}

/**
 * Re-check and stamp as one write-locked unit. `store.setup()` may have been
 * migrating while a NEWER build opened the same file and stamped it; a bare
 * stamp would then overwrite the newer version with ours. BEGIN IMMEDIATE
 * holds the write lock across the read and the write, so a version that
 * advanced past what this build supports is refused and left untouched.
 */
export function stampSchemaVersionLocked(raw: Database, version = CURRENT_SCHEMA_VERSION): void {
  raw.exec("BEGIN IMMEDIATE");
  try {
    assertSchemaVersionSupported(raw, version);
    stampSchemaVersion(raw, version);
    raw.exec("COMMIT");
  } catch (error) {
    raw.exec("ROLLBACK");
    throw error;
  }
}
