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
 */
export const CURRENT_SCHEMA_VERSION = 2;

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
