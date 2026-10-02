import { MIN_VAULT_PASSPHRASE_LENGTH, type PlaintextCleanupStatus } from "@dokan/contracts";
import { z } from "zod";

import { tError } from "./i18n";
import { brokerAvailable, brokerCommands, invokeBroker, invokeBrokerVoid, type BrokerInvokeArgs, type BrokerReply } from "./vault-broker";

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
  /** the shell owns the pre-boot credential prompt over its stdin pipe */
  broker: boolean;
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
  // absent on a build older than issue #141: those keep the HTTP transport
  broker: z.boolean().default(false),
});
const setupResponseSchema = z.object({
  recoveryKey: z.string().min(1),
  sessionToken: z.string().min(1),
  // absent only when talking to a build older than round-7
  sessionGeneration: z.number().int().nonnegative().optional(),
  // the sweep outcome: absent on older builds, which must read as unknown
  plaintextStatus: z.enum(["clean", "remaining", "unknown"]).optional(),
  plaintextRemaining: z.array(z.string()).optional(),
});

/**
 * The three outcomes of the legacy-plaintext sweep (round-4 finding). An
 * unknown outcome must never be presented as the clean story: plaintext data
 * may still be on disk.
 */
export type VaultCleanupOutcome =
  | { status: "clean" }
  | { status: "remaining"; paths: string[] }
  | { status: "unknown" };
const sessionResponseSchema = z.object({
  sessionToken: z.string().min(1),
  sessionGeneration: z.number().int().nonnegative().optional(),
});
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
const SESSION_GENERATION_KEY = "dokan.vault.session-generation";

function readStoredGeneration(): number | undefined {
  try {
    const raw = sessionStorage.getItem(SESSION_GENERATION_KEY);
    if (raw === null || raw === "") return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

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

/**
 * Persist a session token. Rotating endpoints return a monotonic generation;
 * a response that arrives out of order carries an older generation and must
 * never revive an already-revoked token (round-7 finding 5). A call without a
 * generation (the fragment handoff, or an older server) stores the token but
 * leaves the recorded generation untouched.
 */
export function storeVaultSessionToken(token: string, generation?: number): void {
  try {
    if (generation !== undefined) {
      const stored = readStoredGeneration();
      if (stored !== undefined && generation < stored) return;
      sessionStorage.setItem(SESSION_GENERATION_KEY, String(generation));
    }
    sessionStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    /* non-fatal: the session lives in memory for this page only */
  }
}

/** Adopt the session carried by a minting response through the generation guard. */
function adoptSession(response: { sessionToken: string; sessionGeneration?: number }): string {
  storeVaultSessionToken(response.sessionToken, response.sessionGeneration);
  return response.sessionToken;
}

export function clearVaultSessionToken(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_GENERATION_KEY);
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

/**
 * Map a broker refusal to the same error the HTTP path throws, so the gate UI
 * and its i18n codes cannot tell the transports apart.
 */
function brokerRefusal(reply: BrokerReply): VaultRequestError {
  return new VaultRequestError(reply.code ?? "VAULT_UNEXPECTED", reply.retryAfterMs ?? undefined);
}

/** Invoke a broker command; a dead bridge becomes the generic refusal. */
async function callBroker(command: string, args?: BrokerInvokeArgs): Promise<BrokerReply> {
  try {
    return await invokeBroker(command, args);
  } catch {
    throw new VaultRequestError("VAULT_UNEXPECTED");
  }
}

export async function fetchVaultStatus(): Promise<VaultStatus> {
  // Inside the desktop shell the broker is the authoritative gate transport:
  // try it first (no secret involved) and fall back to HTTP when the shell has
  // no sidecar (dev window) or the bridge is absent (browser)
  if (brokerAvailable()) {
    try {
      const reply = await invokeBroker(brokerCommands.status);
      const decoded = statusSchema.safeParse(reply.status);
      if (reply.ok && decoded.success) return decoded.data;
    } catch {
      /* no broker child yet: the HTTP gate below is the fallback */
    }
  }
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
  broker = false,
): Promise<{ recoveryKey: string; sessionToken: string; plaintextRemaining: string[]; plaintextStatus: PlaintextCleanupStatus }> {
  if (broker) {
    const reply = await callBroker(brokerCommands.setup, { passphrase });
    if (!reply.ok || reply.sessionToken == null || reply.recoveryKey == null) throw brokerRefusal(reply);
    adoptSession({ sessionToken: reply.sessionToken, sessionGeneration: reply.sessionGeneration ?? undefined });
    // the key reply deliberately carries no cleanup verdict: it follows on
    // vault_setup_warning, so until then the outcome is UNKNOWN (round-4)
    return {
      recoveryKey: reply.recoveryKey,
      sessionToken: reply.sessionToken,
      plaintextRemaining: reply.plaintextRemaining ?? [],
      plaintextStatus: "unknown",
    };
  }
  const result = await request(
    "/api/vault/setup",
    { method: "POST", body: JSON.stringify({ passphrase, setupToken }) },
    false,
    setupResponseSchema,
  );
  adoptSession(result);
  return {
    recoveryKey: result.recoveryKey,
    sessionToken: result.sessionToken,
    plaintextRemaining: result.plaintextRemaining ?? [],
    // an older build that omits the status cannot confirm clean
    plaintextStatus: result.plaintextStatus ?? (result.plaintextRemaining !== undefined && result.plaintextRemaining.length > 0 ? "remaining" : "unknown"),
  };
}

/**
 * Tell the shell the owner acknowledged the one-time recovery key, so the
 * sidecar can leave its key screen. Non-fatal: the app already serves.
 */
export async function acknowledgeVaultSetup(broker: boolean): Promise<void> {
  if (!broker) return;
  try {
    await invokeBrokerVoid(brokerCommands.setupSaved);
  } catch {
    /* the vault is committed; a lost ack only leaves the child on the key screen */
  }
}

/**
 * The setup follow-up (round-3 finding 1, round-4 finding): after the key has
 * safely reached the owner, ask how the plaintext sweep ended. Failures — a
 * timeout, a broken pipe, a replied error — are UNKNOWN, never "clean": the
 * owner must be told to verify by hand instead of being reassured.
 */
export async function fetchVaultSetupWarning(broker: boolean): Promise<VaultCleanupOutcome> {
  if (!broker) return { status: "clean" };
  let reply: BrokerReply;
  try {
    reply = await invokeBroker(brokerCommands.setupWarning);
  } catch {
    // timeout / dead pipe / restart: the sweep result is unknown
    return { status: "unknown" };
  }
  const paths = reply.plaintextRemaining ?? [];
  if (paths.length > 0) return { status: "remaining", paths };
  if (reply.plaintextStatus === "clean") return { status: "clean" };
  if (reply.plaintextStatus === "remaining" || reply.plaintextStatus === "unknown") {
    return reply.plaintextStatus === "remaining" ? { status: "remaining", paths } : { status: "unknown" };
  }
  // no verdict on the wire (older build): unknown, never clean
  return { status: "unknown" };
}

/** Revoke the in-process vault session server-side (logout). */
export async function revokeVaultSession(): Promise<void> {
  await request("/api/vault/logout", { method: "POST" }, true, z.object({ ok: z.literal(true) }));
}

export async function vaultUnlock(passphrase: string, broker = false): Promise<string> {
  if (broker) {
    const reply = await callBroker(brokerCommands.unlock, { passphrase });
    if (!reply.ok || reply.sessionToken == null) throw brokerRefusal(reply);
    adoptSession({ sessionToken: reply.sessionToken, sessionGeneration: reply.sessionGeneration ?? undefined });
    return reply.sessionToken;
  }
  const result = await request("/api/vault/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }, false, sessionResponseSchema);
  return adoptSession(result);
}

export async function vaultUnlockWithRecovery(recoveryKey: string, broker = false): Promise<string> {
  if (broker) {
    const reply = await callBroker(brokerCommands.recovery, { recoveryKey });
    if (!reply.ok || reply.sessionToken == null) throw brokerRefusal(reply);
    adoptSession({ sessionToken: reply.sessionToken, sessionGeneration: reply.sessionGeneration ?? undefined });
    return reply.sessionToken;
  }
  const result = await request(
    "/api/vault/unlock-recovery",
    { method: "POST", body: JSON.stringify({ recoveryKey }) },
    false,
    sessionResponseSchema,
  );
  return adoptSession(result);
}

export async function listRecoveryKeys(): Promise<VaultRecoveryKey[]> {
  const result = await request("/api/vault/recovery-keys", { method: "GET" }, true, recoveryKeysSchema);
  return result.keys;
}

export async function addRecoveryKey(): Promise<{ id: string; code: string }> {
  return request("/api/vault/recovery-keys", { method: "POST" }, true, addedKeySchema);
}

const removedOrChangedSchema = z.object({
  ok: z.literal(true),
  sessionToken: z.string().min(1),
  sessionGeneration: z.number().int().nonnegative().optional(),
});

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
  return adoptSession(result);
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
  return adoptSession(result);
}

/**
 * Recovery-authorised reset (finding C4): the recovery key replaces the
 * forgotten passphrase without needing the current one. In broker mode the
 * settings UI routes this through the shell's pipe (round-2 finding 2), since
 * the HTTP route is refused there.
 */
export async function resetVaultPassphrase(recoveryKey: string, newPassphrase: string, broker = false): Promise<string> {
  if (broker) {
    const reply = await callBroker(brokerCommands.reset, { recoveryKey, newPassphrase });
    if (!reply.ok || reply.sessionToken == null) throw brokerRefusal(reply);
    adoptSession({ sessionToken: reply.sessionToken, sessionGeneration: reply.sessionGeneration ?? undefined });
    return reply.sessionToken;
  }
  const result = await request(
    "/api/vault/reset-passphrase",
    { method: "POST", body: JSON.stringify({ recoveryKey, newPassphrase }) },
    false,
    removedOrChangedSchema,
  );
  return adoptSession(result);
}
