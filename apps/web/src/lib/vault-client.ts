import { MIN_VAULT_PASSPHRASE_LENGTH, type PlaintextCleanupStatus } from "@dokan/contracts";
import { z } from "zod";

import { tError } from "./i18n";
import { brokerAvailable, brokerCommands, invokeBroker, invokeBrokerVoid, type BrokerInvokeArgs, type BrokerReply } from "./vault-broker";

/**
 * The vault gate's browser client (ADR-0008 §4.6). All vault routes are plain
 * JSON under /api/vault/* because the gate must work before the RPC router
 * exists.
 *
 * The unlocked owner session rides ONE of two transports (issue #319), and the
 * API's mode picks which: the browser path hands it over in an `HttpOnly`
 * cookie, which every window of the browser shares — one unlock serves them
 * all, and this page's JavaScript never holds the secret. The broker path
 * (the packaged desktop) carries it in the `x-vault-session` header, because
 * there the secret crosses the native bridge by design.
 */

export type VaultState = "unconfigured" | "locked" | "unlocked" | "invalid";

/** what the BOOT reader may get: a vault status, or a build that has none */
export type VaultBootStatus = VaultStatus | { mode: "disabled" };

export type VaultStatus = {
  mode: "vault" | "disabled";
  state: VaultState;
  legacyDatabase: boolean;
  recoveryKeyCount: number;
  lockedForMs: number;
  unlocked: boolean;
  /** whether THIS request's credential is the live session (#319) */
  session: boolean;
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
const vaultStatusSchema = z.object({
  mode: z.literal("vault"),
  state: z.enum(["unconfigured", "locked", "unlocked", "invalid"]),
  legacyDatabase: z.boolean(),
  recoveryKeyCount: z.number(),
  lockedForMs: z.number(),
  unlocked: z.boolean(),
  // whether this request's credential is the live session. Absent on a build
  // older than #319: those fall back to "the server will tell us at the first
  // refused call", which is the behaviour that build has.
  session: z.boolean().default(false),
  // absent on a build older than issue #141: those keep the HTTP transport
  broker: z.boolean().default(false),
});

/**
 * Both honest answers. A build with no vault says so in one field (#341 round 7),
 * and the boot reader has to accept that answer rather than fail its own boot on
 * it — which is what a full-status schema did, turning a plaintext build into a
 * retry screen.
 */
const statusSchema = z.union([vaultStatusSchema, z.object({ mode: z.literal("disabled") })]);
const setupResponseSchema = z.object({
  recoveryKey: z.string().min(1),
  // the browser path carries no token in the body: the cookie is the
  // credential (#319). A broker-mode build still returns one.
  sessionToken: z.string().min(1).optional(),
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
  // absent in browser mode: the cookie carries the credential (#319)
  sessionToken: z.string().min(1).optional(),
  sessionGeneration: z.number().int().nonnegative().optional(),
});
const recoveryKeysSchema = z.object({
  keys: z.array(z.object({ id: z.string().min(1), kind: z.literal("recovery"), label: z.string().optional(), createdAt: z.string() })),
});
const addedKeySchema = z.object({ id: z.string().min(1), code: z.string().min(1) });
const errorEnvelopeSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      retryAfterMs: z.number().optional(),
      /**
       * The lock refusal's recycled-pid discriminator (#283): an alive pid whose
       * recorded heartbeat is many windows stale, so there may be no other
       * Dokan copy. Absent on every other refusal, so it never widens the copy.
       */
      staleHeartbeat: z.boolean().optional(),
    })
    .optional(),
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
    /** set only by the lock refusal's recycled-pid envelope (#283) */
    readonly staleHeartbeat = false,
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
 *
 * No substitutions: the origin refusal names no address (round 5). `tError`
 * renders a sentence, and the page's own origin is the address that just
 * refused it.
 */
export function vaultErrorCopy(error: Error | undefined): string {
  if (error instanceof VaultRequestError) return tError(error.code);
  if (error !== undefined) return tError(error.message);
  return tError(undefined);
}

/**
 * The vault session token: in memory, and on the broker path only, in
 * `sessionStorage` (issue #319).
 *
 * The browser path's credential is an `HttpOnly` cookie this page cannot read,
 * so there is nothing to hold: the browser sends it with every same-origin
 * request, and every window of the browser shares it. Storage there is exactly
 * what must not exist — a token in storage is a token any script on the page
 * can steal, and the cookie is the whole reason none is needed.
 *
 * The broker path is the other case, and it is NOT a loosening: the packaged
 * desktop's page already holds this token in memory to sign its RPC calls
 * (`rpc.ts` puts it in `x-vault-session`), so a script in that shell can read
 * it either way and storage adds no exposure it did not have. What storage
 * buys there is survival of a webview reload — which mattered, because the
 * broker refuses further commands once it has been served, so a reload that
 * forgot the token could not be recovered even with the right passphrase. The
 * ADR's "the desktop broker transport is unchanged" is true again.
 */
let memorySessionToken: string | undefined;
let memorySessionGeneration: number | undefined;

/** Where the broker path's token persists across a webview reload. */
const BROKER_TOKEN_KEY = "dokan.vault.session";
const BROKER_GENERATION_KEY = "dokan.vault.session-generation";

/**
 * The storage the broker path may use, or undefined on the browser path.
 *
 * `brokerAvailable()` is the Tauri bridge probe: outside the desktop shell
 * there is no broker, so there is no path that may persist a token and the
 * browser path keeps every byte of the credential out of JavaScript.
 */
function brokerStorage(): Storage | undefined {
  if (!brokerAvailable()) return undefined;
  try {
    return window.sessionStorage;
  } catch {
    // a locked-down profile that refuses storage is not a reason to fail: the
    // token still lives in memory for this page's lifetime
    return undefined;
  }
}

/**
 * Read from the broker path's storage, best-effort. `brokerStorage()` guards
 * the PROPERTY; a profile can also refuse the call — a partitioned store throws
 * on access. A throw here would fail the read that signs an RPC call, so a
 * read that cannot happen is simply no value.
 */
function readStore(key: string): string | null | undefined {
  try {
    return brokerStorage()?.getItem(key);
  } catch {
    return undefined;
  }
}

/**
 * Write to the broker path's storage, best-effort (round-4 P2). The GETTER was
 * guarded and the writes were not, so a quota or a partitioned profile threw
 * straight out of `storeVaultSessionToken` — out of `adoptSession`, inside a
 * successful unlock — and turned an open vault into a reported failure whose
 * retry rotated the token. The token is assigned to memory BEFORE this runs, so
 * a refused write costs the reload survival and nothing else.
 */
function writeStore(key: string, value: string): void {
  try {
    brokerStorage()?.setItem(key, value);
  } catch {
    /* the reload survival is lost; the page's credential is not */
  }
}

function removeStore(key: string): void {
  try {
    brokerStorage()?.removeItem(key);
  } catch {
    /* nothing to remove when nothing could be written */
  }
}

function readStoredGeneration(): number | undefined {
  const raw = readStore(BROKER_GENERATION_KEY);
  if (raw === null || raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The newest generation this page knows, from memory or from the broker path's storage. */
function knownGeneration(): number | undefined {
  return memorySessionGeneration ?? readStoredGeneration();
}

/** The session token this page holds; undefined in the browser path. */
export function readVaultSessionToken(): string | undefined {
  if (memorySessionToken !== undefined) return memorySessionToken;
  const stored = readStore(BROKER_TOKEN_KEY);
  if (stored === null || stored === undefined || stored === "") return undefined;
  // a reload only keeps the token, never the error state around it
  memorySessionToken = stored;
  return stored;
}

/**
 * Keep a session token. Rotating endpoints return a monotonic generation; a
 * response that arrives out of order carries an older generation and must
 * never revive an already-revoked token (round-7 finding 5). A call without a
 * generation (the fragment handoff, or an older server) stores the token but
 * leaves the recorded generation untouched.
 */
export function storeVaultSessionToken(token: string, generation?: number): void {
  if (generation !== undefined) {
    const known = knownGeneration();
    if (known !== undefined && generation < known) return;
  }
  // MEMORY FIRST: the credential this page uses is decided here, and the
  // storage write below is a convenience for the next reload. A refused write
  // must never keep the token out of memory (round-4 P2).
  memorySessionToken = token;
  if (generation !== undefined) {
    memorySessionGeneration = generation;
    writeStore(BROKER_GENERATION_KEY, String(generation));
  }
  writeStore(BROKER_TOKEN_KEY, token);
}

/** Adopt the session a minting response carried, when it carried one. */
function adoptSession(response: { sessionToken?: string; sessionGeneration?: number }): void {
  if (response.sessionToken === undefined) return;
  storeVaultSessionToken(response.sessionToken, response.sessionGeneration);
}

export function clearVaultSessionToken(): void {
  memorySessionToken = undefined;
  memorySessionGeneration = undefined;
  // a cleared session must not survive a reload on the broker path either
  removeStore(BROKER_TOKEN_KEY);
  removeStore(BROKER_GENERATION_KEY);
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

/**
 * The envelope type comes from the schema, not a hand copy: the schema is the
 * one place that decides which fields a refusal may carry.
 */
type VaultErrorBody = z.infer<typeof errorEnvelopeSchema>;

/**
 * The error envelope of a failed response, or undefined when the body is not
 * one — an HTML refusal page from a build older than #275, a proxy error page,
 * a truncated body. The API ships stable codes and no display copy, so the code
 * is the only thing on the wire worth reading.
 */
function errorEnvelopeIn(text: string): VaultErrorBody["error"] {
  try {
    return errorEnvelopeSchema.parse(JSON.parse(text)).error;
  } catch {
    return undefined;
  }
}

/**
 * How long the absence probe may take before the caller treats it as a refusal.
 *
 * `logout` awaits this probe before it clears the local token and calls
 * `signOut()`, so a stalled status hop would leave a sign-out that never
 * finishes: no clear, no sign-out, no reload, no gate. A timeout throws a
 * non-`UNSUPPORTED` error, which the caller holds on — the safe side.
 */
const STATUS_PROBE_TIMEOUT_MS = 3_000;

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
    // a body with no envelope (HTML, empty, truncated) is the generic refusal
    const refusal = errorEnvelopeIn(text);
    // A 404 with no envelope is not a refusal at all: the route is not mounted,
    // which is the legacy plaintext build (DOKAN_VAULT=disabled). It is the same
    // answer `fetchVaultStatus` reads, and it must not read as a generic failure
    // — logout has to tell "this build has no vault" from "the revoke failed"
    // (round-4 P1). A vault route that answers 404 WITH an envelope (a missing
    // recovery key) is a real refusal and keeps its own code.
    if (response.status === 404 && refusal === undefined) throw new VaultRequestError("VAULT_UNSUPPORTED");
    throw new VaultRequestError(refusal?.code ?? "VAULT_UNEXPECTED", refusal?.retryAfterMs, refusal?.staleHeartbeat ?? false);
  }
  return decodeReply(text, schema);
}

/**
 * Decode a reply body, naming both failures in the vault's own vocabulary: a
 * body that is not JSON at all, and a body that does not match the schema.
 *
 * A 200 whose body is not JSON — a proxy's interstitial, an HTML page, an empty
 * reply — used to throw a bare `SyntaxError` out of here, so the caller saw a
 * native error with no code and had to guess (`unconfirmed`) (round-5 P3). A
 * malformed reply is a vault refusal like any other and now says so.
 */
function decodeReply<T>(text: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new VaultRequestError("VAULT_MALFORMED_RESPONSE");
  }
  const decoded = schema.safeParse(value);
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

/**
 * Invoke a broker command. A present-but-failing bridge (the child died
 * mid-call, the command was rejected without an envelope) becomes the generic
 * refusal; a missing bridge never reaches here — vaultTransport rejects it as
 * VAULT_BROKER_REQUIRED first.
 */
async function callBroker(command: string, args?: BrokerInvokeArgs): Promise<BrokerReply> {
  try {
    return await invokeBroker(command, args);
  } catch {
    throw new VaultRequestError("VAULT_UNEXPECTED");
  }
}

/**
 * The one place that decides a vault call's transport. `brokerRequested` is
 * the API's broker flag; the bridge's presence is the only thing that can
 * actually carry the secret, so broker is used only when BOTH agree. When the
 * API says broker mode but the webview has no bridge — e.g. a capability that
 * does not list the remote loopback origin, the shipped VAULT_UNEXPECTED bug —
 * every secret-bearing call fails with VAULT_BROKER_REQUIRED: handing the
 * passphrase to HTTP would defeat broker mode (the API refuses those routes
 * anyway), and handing it to a missing IPC would lie about what happened.
 * Call sites cannot bypass this: they pass the API flag, never the bridge.
 */
function vaultTransport(brokerRequested: boolean): "broker" | "http" {
  if (brokerRequested && brokerAvailable()) return "broker";
  if (brokerRequested) throw new VaultRequestError("VAULT_BROKER_REQUIRED");
  return "http";
}

/**
 * Ask a refused instance to re-check the data folder now (#277).
 *
 * The status route deliberately does NOT do this. When every request also ran a
 * reclaim attempt, the attempt cancelled the instance's armed backoff tick and
 * re-armed it at the cap, so a client polling faster than the cap kept the
 * automatic reclaim from ever firing and set the retry rate itself (greptile P2
 * on #298). Only the screen's retry posts here. The reply is `{ ok, taken }`;
 * the status read that follows is what the screen shows, so a reply this build
 * cannot use is not worth surfacing as an error.
 */
export async function requestVaultReclaim(): Promise<void> {
  try {
    await fetch("/api/vault/reclaim", { method: "POST" });
  } catch {
    /* the retry's outcome is the status read that follows, not this reply */
  }
}

export async function fetchVaultStatus(): Promise<VaultBootStatus> {
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
    // A bounded probe: `logout` awaits this before clearing the local token and
    // signing out, so a status hop that stalls must resolve into a refusal the
    // caller holds on, never into a sign-out that never finishes (#341 round 5).
    response = await fetch("/api/vault/status", { signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS) });
  } catch {
    // the server is unreachable (booting, proxy blip): the caller shows RETRY,
    // never the legacy login screen
    throw new VaultRequestError("VAULT_UNREACHABLE");
  }
  const text = await response.text();
  if (response.status === 404) {
    // The SAME rule `request()` applies: a 404 with an envelope is a real refusal
    // (a gateway that answers unknown paths with {"error":{"code":"NOT_FOUND"}}),
    // and only a 404 with no envelope at all means the route is not mounted — the
    // legacy plaintext build. Reading the status alone here re-opened the round-4
    // defect one hop over: `absent` reloads, and a live cookie then walks the
    // owner back into the app.
    const refusal = errorEnvelopeIn(text);
    if (refusal === undefined) throw new VaultRequestError("VAULT_UNSUPPORTED");
    throw new VaultRequestError(refusal.code ?? "VAULT_UNEXPECTED", refusal.retryAfterMs, refusal.staleHeartbeat ?? false);
  }
  if (!response.ok) {
    // A refusal that names its cause arrives as JSON with the API's stable
    // code: the other-instance lock answers 503 + VAULT_LOCKED_BY_OTHER_INSTANCE
    // on this route (#275). A body that names no code names no cause — an HTML
    // refusal page, a proxy 502 — so it stays the honest "unreachable" (#276).
    // The lock's `staleHeartbeat` flag rides along when the API has one (#283).
    const refusal = errorEnvelopeIn(text);
    throw new VaultRequestError(refusal?.code ?? "VAULT_UNREACHABLE", refusal?.retryAfterMs, refusal?.staleHeartbeat ?? false);
  }
  return decodeReply(text, statusSchema);
}

export async function vaultSetup(
  passphrase: string,
  setupToken?: string,
  broker = false,
): Promise<{ recoveryKey: string; plaintextRemaining: string[]; plaintextStatus: PlaintextCleanupStatus }> {
  if (vaultTransport(broker) === "broker") {
    const reply = await callBroker(brokerCommands.setup, { passphrase });
    if (!reply.ok || reply.sessionToken == null || reply.recoveryKey == null) throw brokerRefusal(reply);
    adoptSession({ sessionToken: reply.sessionToken, sessionGeneration: reply.sessionGeneration ?? undefined });
    // the key reply deliberately carries no cleanup verdict: it follows on
    // vault_setup_warning, so until then the outcome is UNKNOWN (round-4)
    return {
      recoveryKey: reply.recoveryKey,
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
  // the browser path's credential is the cookie the response set; nothing to
  // keep here (#319)
  adoptSession(result);
  return {
    recoveryKey: result.recoveryKey,
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
  // broker-only, best-effort: the bridge must actually exist, but a missing
  // one is not worth failing a setup that already committed
  if (!broker || !brokerAvailable()) return;
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
  // the API says broker mode but the bridge is gone: the sweep result is
  // unknowable here, and unknown must never be presented as clean
  if (!brokerAvailable()) return { status: "unknown" };
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

/**
 * Whether this build mounts no vault route at all, asked of the build rather
 * than inferred from one hop's 404.
 *
 * `fetchVaultStatus` is the same read the gate makes on boot, so the answer
 * cannot disagree with what the gate will do next. A mounted vault build answers
 * `mode: "vault"`, and anything it says other than "no such route" leaves the
 * question unanswered — an unreachable server or a lock refusal is not an
 * absent vault, so the caller keeps the failing-closed answer.
 *
 * This is the ONLY absence the sign-out accepts, and both halves of that are
 * deliberate (#319 round 5, round 6):
 *
 * - `VAULT_UNSUPPORTED` — "a 404 whose body did not parse into an envelope" —
 *   is a guess about one hop, and any proxy, renamed route or gateway answering
 *   `{}`/`null`/HTML produces it. Reading it as absence RELOADS, and with a live
 *   cookie that walks the owner straight back into the app.
 * - `VAULT_NOT_UNLOCKED` is not a proof either: the API answers it for an OLD
 *   token as readily as for no session at all, so a logout carrying a cookie
 *   another window already rotated reads as "nothing to revoke" while a live
 *   session exists. `isAbsentVaultSession` read exactly that way and was
 *   deleted with the round-6 finding rather than left as a trap.
 */
/** the one field a vault-less build answers, and the only one this probe reads */
const vaultModeSchema = z.object({ mode: z.enum(["vault", "disabled"]) });

export type VaultBuildMode = "vault" | "disabled" | "unknown";

/**
 * Which kind of build is answering: one with a vault, one without, or one that
 * could not say.
 *
 * A POSITIVE answer, never an inference (#341 round 7). A build with no vault
 * ANSWERS `{ mode: "disabled" }`, and a 404 is not evidence of one — a proxy, a
 * renamed route and a gateway answering `{}`/`null`/HTML all produce the same
 * bytes. The third answer is new and it matters: a probe that FAILED is not the
 * same as one that said "vault", and the sign-out has to tell them apart — it
 * holds the page for a vault, and must not hold it for a build that has none.
 *
 * It reads the mode alone rather than through `fetchVaultStatus`, which decodes a
 * whole vault status: a build without one has no state to report, and asking it
 * for one would turn its honest answer into a decode failure.
 */
export async function vaultBuildMode(): Promise<VaultBuildMode> {
  try {
    const response = await fetch("/api/vault/status", { signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS) });
    if (!response.ok) return "unknown";
    const decoded = vaultModeSchema.safeParse(JSON.parse(await response.text()));
    if (!decoded.success) return "unknown";
    return decoded.data.mode === "disabled" ? "disabled" : "vault";
  } catch {
    return "unknown";
  }
}

/** Whether this build has no vault at all; see `vaultBuildMode` for the thirds. */
export async function vaultRouteAbsent(): Promise<boolean> {
  return (await vaultBuildMode()) === "disabled";
}

/**
 * Unlock the vault.
 *
 * The browser path's credential is the cookie the response set, so this call
 * hands the page nothing to keep; the broker path's token crosses the native
 * bridge and is kept in memory (#319).
 */
export async function vaultUnlock(passphrase: string, broker = false): Promise<void> {
  if (vaultTransport(broker) === "broker") {
    const reply = await callBroker(brokerCommands.unlock, { passphrase });
    if (!reply.ok || reply.sessionToken == null) throw brokerRefusal(reply);
    adoptSession({ sessionToken: reply.sessionToken, sessionGeneration: reply.sessionGeneration ?? undefined });
    return;
  }
  const result = await request("/api/vault/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }, false, sessionResponseSchema);
  adoptSession(result);
}

export async function vaultUnlockWithRecovery(recoveryKey: string, broker = false): Promise<void> {
  if (vaultTransport(broker) === "broker") {
    const reply = await callBroker(brokerCommands.recovery, { recoveryKey });
    if (!reply.ok || reply.sessionToken == null) throw brokerRefusal(reply);
    adoptSession({ sessionToken: reply.sessionToken, sessionGeneration: reply.sessionGeneration ?? undefined });
    return;
  }
  const result = await request(
    "/api/vault/unlock-recovery",
    { method: "POST", body: JSON.stringify({ recoveryKey }) },
    false,
    sessionResponseSchema,
  );
  adoptSession(result);
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
  // absent in browser mode: the response set the cookie instead (#319)
  sessionToken: z.string().min(1).optional(),
  sessionGeneration: z.number().int().nonnegative().optional(),
});

/**
 * The passphrase floor is checked on the NORMALIZED value: eight spaces trim
 * to empty and a padded short phrase must not slip past the server either.
 */
export function isVaultPassphraseLongEnough(value: string): boolean {
  return value.normalize("NFC").trim().length >= MIN_VAULT_PASSPHRASE_LENGTH;
}

export async function removeRecoveryKey(id: string): Promise<void> {
  // deleting a credential rotates the session: the fresh one rides the cookie
  const result = await request(`/api/vault/recovery-keys/${encodeURIComponent(id)}`, { method: "DELETE" }, true, removedOrChangedSchema);
  adoptSession(result);
}

export async function changeVaultPassphrase(currentPassphrase: string, newPassphrase: string): Promise<void> {
  // the old passphrase is refused from now on, so the server rotates the
  // in-process token: the browser path's cookie is replaced, the broker
  // path's token is kept in memory
  const result = await request(
    "/api/vault/change-passphrase",
    { method: "POST", body: JSON.stringify({ currentPassphrase, newPassphrase }) },
    true,
    removedOrChangedSchema,
  );
  adoptSession(result);
}

/**
 * Recovery-authorised reset (finding C4): the recovery key replaces the
 * forgotten passphrase without needing the current one. In broker mode the
 * settings UI routes this through the shell's pipe (round-2 finding 2), since
 * the HTTP route is refused there.
 */
export async function resetVaultPassphrase(recoveryKey: string, newPassphrase: string, broker = false): Promise<void> {
  if (vaultTransport(broker) === "broker") {
    const reply = await callBroker(brokerCommands.reset, { recoveryKey, newPassphrase });
    if (!reply.ok || reply.sessionToken == null) throw brokerRefusal(reply);
    adoptSession({ sessionToken: reply.sessionToken, sessionGeneration: reply.sessionGeneration ?? undefined });
    return;
  }
  const result = await request(
    "/api/vault/reset-passphrase",
    { method: "POST", body: JSON.stringify({ recoveryKey, newPassphrase }) },
    false,
    removedOrChangedSchema,
  );
  adoptSession(result);
}
