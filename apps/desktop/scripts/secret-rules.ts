/**
 * The rules both release-secret consumers share: the minimum lengths and the
 * validators. Kept in their own module so `sidecar.ts` (which compiles the
 * binary) and `secrets.ts` (which resolves the values) can both use them
 * without importing each other.
 */

/** Minimum acceptable length for a per-customer build secret. */
export const MIN_BUILD_SECRET_LEN = 16;
/** Minimum acceptable length for the better-auth session-signing secret. */
export const MIN_AUTH_SECRET_LEN = 32;

export type SecretValidation = { ok: true; secret: string } | { ok: false; reason: string };

export function validateBuildSecret(env: NodeJS.ProcessEnv = process.env): SecretValidation {
  const secret = env.DOKAN_BUILD_SECRET;
  if (secret === undefined || secret === "") {
    return { ok: false, reason: "DOKAN_BUILD_SECRET is not set — refusing to ship a default secret" };
  }
  if (secret.length < MIN_BUILD_SECRET_LEN) {
    return {
      ok: false,
      reason: `DOKAN_BUILD_SECRET is only ${secret.length} chars — must be at least ${MIN_BUILD_SECRET_LEN}`,
    };
  }
  return { ok: true, secret };
}

/**
 * Validate the per-customer session-signing secret (PR #51 finding 5).
 * Better-Auth signs session cookies with this key; a shared or short default
 * would let any reader of the binary/source forge admin sessions, so a
 * release build without a strong DOKAN_AUTH_SECRET must fail loudly.
 */
export function validateAuthSecret(env: NodeJS.ProcessEnv = process.env): SecretValidation {
  const secret = env.DOKAN_AUTH_SECRET;
  if (secret === undefined || secret === "") {
    return { ok: false, reason: "DOKAN_AUTH_SECRET is not set — refusing to ship a default session-signing secret" };
  }
  if (secret.length < MIN_AUTH_SECRET_LEN) {
    return {
      ok: false,
      reason: `DOKAN_AUTH_SECRET is only ${secret.length} chars — must be at least ${MIN_AUTH_SECRET_LEN}`,
    };
  }
  return { ok: true, secret };
}
