/**
 * Vault e2e port resolution (#202, #206).
 *
 * The vault spec runs its own API+web pair so it can coexist with the shared
 * suite (which boots with `DOKAN_VAULT=disabled`). #202 made that pair
 * env-driven; this module is the single place the variable names, the defaults
 * and the validation live, so the spec and its unit tests cross the same seam.
 *
 * Repo env convention: blank means unset. A set-but-invalid value (non-numeric,
 * fractional, or outside 1..65535) throws instead of resolving to port 0/NaN
 * and a silent 20 s poll timeout. Parsing is `Number()`, matching the api's own
 * DOKAN_PORT handling, so hex/exponent strings resolve as numbers.
 */

/** The port pair every existing run has used; changing these moves live runs. */
export const VAULT_API_PORT_DEFAULT = 4399;
export const VAULT_WEB_PORT_DEFAULT = 5174;

export type VaultPorts = { api: number; web: number };

/** Resolve `DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT`, defaulting to the pair above. */
export function resolveVaultPorts(env: NodeJS.ProcessEnv = process.env): VaultPorts {
  return {
    api: resolvePort(env, "DOKAN_VAULT_PORT", VAULT_API_PORT_DEFAULT),
    web: resolvePort(env, "DOKAN_VAULT_WEB_PORT", VAULT_WEB_PORT_DEFAULT),
  };
}

function resolvePort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a port number, got ${JSON.stringify(raw)}`);
  }
  return port;
}
