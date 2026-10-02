import { MIN_VAULT_PASSPHRASE_LENGTH } from "@dokan/contracts";
import { z } from "zod";

import { tError } from "./i18n";

/**
 * The vault gate's browser client (ADR-0008 §4.6). All vault routes are plain
 * JSON under /api/vault/* because the gate must work before the RPC router
 * exists; the unlocked owner session rides the `x-vault-session` header, never
 * a cookie, so a cross-origin page cannot act as the owner.
 */

export type VaultState = "unconfigured" | "locked" | "unlocked" | "invalid";

export type VaultStatus = {
  mode: "vault" | "disabled";
  state: VaultState;
  legacyDatabase: boolean;
  recoveryKeyCount: number;
  lockedForMs: number;
  unlocked: boolean;
};

export type VaultRecoveryKey = {
  id: string;
  kind: "recovery";
  label?: string;
  createdAt: string;
};

/** External JSON is decoded at the boundary; no raw cast reaches a caller. */
const statusSchema = z.object({
  mode: z.enum(["vault", "disabled"]),
  state: z.enum(["unconfigured", "locked", "unlocked", "invalid"]),
  legacyDatabase: z.boolean(),
  recoveryKeyCount: z.number(),
  lockedForMs: z.number(),
  unlocked: z.boolean(),
});
const setupResponseSchema = z.object({
  recoveryKey: z.string().min(1),
  sessionToken: z.string().min(1),
  plaintextRemaining: z.array(z.string()).optional(),
});
const sessionResponseSchema = z.object({ sessionToken: z.string().min(1) });
const recoveryKeysSchema = z.object({
  keys: z.array(z.object({ id: z.string().min(1), kind: z.literal("recovery"), label: z.string().optional(), createdAt: z.string() })),
});
const addedKeySchema = z.object({ id: z.string().min(1), code: z.string().min(1) });
const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string().optional(), retryAfterMs: z.number().optional() }).optional(),
});

/**
 * A refusal with the API's stable code. The API is locale-neutral (round-6):
 * the web owns the copy, so callers translate `code` through tError() and
 * never render a message that came over the wire.
 */
export class VaultRequestError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    // the raw code only: UI code must translate via tError(err.code)
    super(code);
    this.name = "VaultRequestError";
  }
}

/**
 * Copy for a failed vault call. The API returns stable codes and no display
 * copy (locale-neutral guard), so the web translates the code here — no raw
 * code can ever reach the owner.
 */
export function vaultErrorCopy(error: Error | undefined): string {
  if (error instanceof VaultRequestError) return tError(error.code);
  if (error !== undefined) return tError(error.message);
  return tError(undefined);
}

const SESSION_STORAGE_KEY = "dokan.vault.session";

/** The in-process session token minted at unlock; sessionStorage dies with the tab. */
export function readVaultSessionToken(): string | undefined {
  try {
    const value = sessionStorage.getItem(SESSION_STORAGE_KEY);
    return value === null || value === "" ? undefined : value;
  } catch {
    // storage can be blocked by the webview (private modes); the owner simply
    // has to unlock again on the next request
    return undefined;
  }
}

export function storeVaultSessionToken(token: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    /* non-fatal: the session lives in memory for this page only */
  }
}

export function clearVaultSessionToken(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Read the Arabic setup token the desktop shell put in the URL fragment. */
export function readSetupTokenFromHash(): string | undefined {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const token = params.get("setup_token");
  return token === null || token === "" ? undefined : token;
}

/** The vault session token the shell passed in the navigation fragment. */
export function readSessionTokenFromHash(): string | undefined {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const token = params.get("vault_session");
  return token === null || token === "" ? undefined : token;
}

/** Strip the one-time fragment secrets from the visible URL. */
export function stripVaultFragment(): void {
  if (window.location.hash === "") return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

type VaultErrorBody = { error?: { code?: string; retryAfterMs?: number } };

async function request<T>(path: string, init: RequestInit, authenticated: boolean, schema: z.ZodType<T>): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (authenticated) {
    const token = readVaultSessionToken();
    if (token !== undefined) headers.set("x-vault-session", token);
  }
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    let parsed: VaultErrorBody = {};
    try {
      parsed = errorEnvelopeSchema.parse(JSON.parse(text));
    } catch {
      /* non-JSON failure: fall through to the generic refusal */
    }
    const code = parsed.error?.code ?? "VAULT_UNEXPECTED";
    throw new VaultRequestError(code, parsed.error?.retryAfterMs);
  }
  const decoded = schema.safeParse(JSON.parse(text));
  if (!decoded.success) throw new VaultRequestError("VAULT_MALFORMED_RESPONSE");
  return decoded.data;
}

export async function fetchVaultStatus(): Promise<VaultStatus> {
  let response: Response;
  try {
    response = await fetch("/api/vault/status");
  } catch {
    // the server is unreachable (booting, proxy blip): the caller shows RETRY,
    // never the legacy login screen
    throw new VaultRequestError("VAULT_UNREACHABLE");
  }
  if (response.status === 404) {
    // no vault route at all: this is the legacy plaintext build
    throw new VaultRequestError("VAULT_UNSUPPORTED");
  }
  if (!response.ok) throw new VaultRequestError("VAULT_UNREACHABLE");
  const decoded = statusSchema.safeParse(JSON.parse(await response.text()));
  if (!decoded.success) throw new VaultRequestError("VAULT_MALFORMED_RESPONSE");
  return decoded.data;
}

export async function vaultSetup(
  passphrase: string,
  setupToken?: string,
): Promise<{ recoveryKey: string; sessionToken: string; plaintextRemaining: string[] }> {
  const result = await request(
    "/api/vault/setup",
    { method: "POST", body: JSON.stringify({ passphrase, setupToken }) },
    false,
    setupResponseSchema,
  );
  return { recoveryKey: result.recoveryKey, sessionToken: result.sessionToken, plaintextRemaining: result.plaintextRemaining ?? [] };
}

/** Revoke the in-process vault session server-side (logout). */
export async function revokeVaultSession(): Promise<void> {
  await request("/api/vault/logout", { method: "POST" }, true, z.object({ ok: z.literal(true) }));
}

export async function vaultUnlock(passphrase: string): Promise<string> {
  const result = await request("/api/vault/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }, false, sessionResponseSchema);
  return result.sessionToken;
}

export async function vaultUnlockWithRecovery(recoveryKey: string): Promise<string> {
  const result = await request(
    "/api/vault/unlock-recovery",
    { method: "POST", body: JSON.stringify({ recoveryKey }) },
    false,
    sessionResponseSchema,
  );
  return result.sessionToken;
}

export async function listRecoveryKeys(): Promise<VaultRecoveryKey[]> {
  const result = await request("/api/vault/recovery-keys", { method: "GET" }, true, recoveryKeysSchema);
  return result.keys;
}

export async function addRecoveryKey(): Promise<{ id: string; code: string }> {
  return request("/api/vault/recovery-keys", { method: "POST" }, true, addedKeySchema);
}

const removedOrChangedSchema = z.object({ ok: z.literal(true), sessionToken: z.string().min(1) });

/**
 * The passphrase floor is checked on the NORMALIZED value: eight spaces trim
 * to empty and a padded short phrase must not slip past the server either.
 */
export function isVaultPassphraseLongEnough(value: string): boolean {
  return value.normalize("NFC").trim().length >= MIN_VAULT_PASSPHRASE_LENGTH;
}

export async function removeRecoveryKey(id: string): Promise<string> {
  // deleting a credential rotates the session: keep the fresh token
  const result = await request(`/api/vault/recovery-keys/${encodeURIComponent(id)}`, { method: "DELETE" }, true, removedOrChangedSchema);
  return result.sessionToken;
}

export async function changeVaultPassphrase(currentPassphrase: string, newPassphrase: string): Promise<string> {
  // the old passphrase is refused from now on, so the server rotates the
  // in-process token and returns the one this client must keep using
  const result = await request(
    "/api/vault/change-passphrase",
    { method: "POST", body: JSON.stringify({ currentPassphrase, newPassphrase }) },
    true,
    removedOrChangedSchema,
  );
  return result.sessionToken;
}

/**
 * Recovery-authorised reset (finding C4): the recovery key replaces the
 * forgotten passphrase without needing the current one.
 */
export async function resetVaultPassphrase(recoveryKey: string, newPassphrase: string): Promise<string> {
  const result = await request(
    "/api/vault/reset-passphrase",
    { method: "POST", body: JSON.stringify({ recoveryKey, newPassphrase }) },
    false,
    removedOrChangedSchema,
  );
  return result.sessionToken;
}
