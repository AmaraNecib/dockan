import { randomBytes } from "node:crypto";

import type { StorePort } from "../store/port";

/** settings key holding this install's session-signing secret. */
export const SESSION_SECRET_SETTING_KEY = "auth_secret";

/** Entropy floor: 32 random bytes (256 bits), 43 base64url characters. */
export const SESSION_SECRET_BYTES = 32;

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
 * An existing value is returned untouched: copying or restoring the database
 * keeps sessions valid, and a migrated database invalidates old sessions
 * exactly once. No recovery credential is ever produced here.
 */
export async function ensureSessionSecret(store: StorePort): Promise<string> {
  const existing = await store.getSetting(SESSION_SECRET_SETTING_KEY);
  if (existing !== undefined && existing !== "") return existing;
  return store.withTransactionImmediate(async (tx) => {
    const current = await tx.getSetting(SESSION_SECRET_SETTING_KEY);
    if (current !== undefined && current !== "") return current;
    const generated = generateSessionSecret();
    await tx.setSetting(SESSION_SECRET_SETTING_KEY, generated);
    return generated;
  });
}
