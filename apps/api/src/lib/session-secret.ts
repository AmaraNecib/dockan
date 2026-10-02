import { randomBytes } from "node:crypto";

import type { StorePort } from "../store/port";

/** settings key holding this install's session-signing secret. */
export const SESSION_SECRET_SETTING_KEY = "auth_secret";

/** Entropy floor: 32 random bytes (256 bits), 43 base64url characters. */
export const SESSION_SECRET_BYTES = 32;

/**
 * Minimum acceptable stored secret, matching the removed per-customer floor.
 * Generated secrets are 43 chars; anything shorter (or non-base64url) is a
 * damaged or hand-edited row and is regenerated with a warning.
 */
export const SESSION_SECRET_MIN_LENGTH = 32;

/** A stored value is usable only when long enough and URL-safe. */
export function isStrongSessionSecret(value: string): boolean {
  return value.length >= SESSION_SECRET_MIN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

/** The slice of AppLogger this module needs (avoids a logger import cycle). */
export type SessionSecretLogger = {
  warn(event: string, message: string): void;
};

/** A fresh, URL-safe session-signing secret (256 bits of entropy). */
export function generateSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString("base64url");
}

/**
 * The session-signing secret for this install, generated on first use.
 *
 * A fresh database — or a pre-universal one that predates the setting — has no
 * `auth_secret` row; one is generated and stored inside one BEGIN IMMEDIATE
 * unit, so two processes opening the same database converge on a single value.
 * An existing STRONG value is returned untouched: copying or restoring the
 * database keeps sessions valid, and a migrated database invalidates old
 * sessions exactly once. A missing, empty, short or malformed value is
 * regenerated (and warned about) because such a row cannot sign sessions
 * safely. No recovery credential is ever produced here.
 */
export async function ensureSessionSecret(store: StorePort, logger?: SessionSecretLogger): Promise<string> {
  const existing = await store.getSetting(SESSION_SECRET_SETTING_KEY);
  if (existing !== undefined && isStrongSessionSecret(existing)) return existing;
  return store.withTransactionImmediate(async (tx) => {
    const current = await tx.getSetting(SESSION_SECRET_SETTING_KEY);
    if (current !== undefined && isStrongSessionSecret(current)) return current;
    if (current !== undefined) {
      logger?.warn(
        "SESSION_SECRET_REGENERATED",
        `stored ${SESSION_SECRET_SETTING_KEY} is empty, short or malformed (${current.length} chars); generating a new one (existing sessions invalidate once)`,
      );
    }
    const generated = generateSessionSecret();
    await tx.setSetting(SESSION_SECRET_SETTING_KEY, generated);
    return generated;
  });
}
