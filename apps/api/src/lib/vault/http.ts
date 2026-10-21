import { MIN_VAULT_PASSPHRASE_LENGTH, type VaultErrorCode } from "@dokan/contracts";
import { Hono, type Context } from "hono";

import type { NodeRequestEnv } from "../overlay";
import { z } from "zod";

import { tokenMatches } from "../boot-token";
import type { AppLogger } from "../logger";
import { classifyPlaintextCleanup } from "./cleanup-status";
import { UnsupportedSchemaVersionError } from "../schema-version";
import { MissingVaultDatabaseError, VaultCorruptionError } from "../../db/encrypted-connection";
import { VaultAuthenticationError, normalizePassphrase } from "./crypto";
import {
  VaultAlreadyConfiguredError,
  VaultLockedError,
  VaultManager,
  VaultNotUnlockedError,
  VaultSetupInProgressError,
  type VaultSession,
} from "./manager";
import { VaultFormatError } from "./format";
import {
  clearedVaultSessionCookie,
  resolveVaultCredential,
  vaultOriginGate,
  vaultSessionPayload,
  type VaultSessionPayload,
} from "./session";
import type { AppConfig } from "../../config";

/**
 * The pre-boot vault gate over HTTP (dev/e2e and rotation from settings). The
 * desktop shell uses the stdin broker instead, but both drive the same
 * VaultManager, so the passphrase/recovery rules cannot drift between them.
 *
 * All responses are JSON with a stable `error.code` (plus structured extras
 * such as `retryAfterMs`). The API never ships display copy: the web owns
 * every sentence through its i18n layer (locale-neutral guard). Secrets never
 * appear in URLs, logs or error text.
 *
 * The session token is the only credential and it rides ONE of two
 * transports, chosen by this server's mode and not by the request (issue
 * #319): a browser-mode server hands it to the browser in an `HttpOnly`
 * cookie — never in the response body — and a broker-mode server (the
 * packaged desktop) returns it in the body because the secret crosses the
 * native bridge there by design. See `lib/vault/session.ts`.
 */

export type VaultBootstrapInput = {
  masterKey: Buffer;
  vaultId: string;
  /** true only for the first-run flow: the snapshot may need migration seeds */
  fresh: boolean;
};

/** Paths still readable in the clear after a setup/unlock sweep. */
export type VaultCleanupResult = { plaintextRemaining: string[] };

/** What prepareSetup hands to the commit step. */
type PreparedSetup = { recoveryKey: string; vaultId: string };

export type VaultHttpDeps = {
  manager: VaultManager;
  config: AppConfig;
  logger: AppLogger;
  /** Build the store/app once the vault is open; must persist the first snapshot. */
  bootstrap: (input: VaultBootstrapInput) => Promise<void>;
  /** Called only after the header is committed: encrypt/remove the migrated plaintext files. */
  onSetupCommitted?: () => Promise<VaultCleanupResult>;
  /** Called after the header commit, with the app live (e.g. the first daily backup). */
  afterSetup?: () => Promise<void>;
  /**
   * Called after any credential change (add/remove recovery key, change/reset
   * passphrase): the daily backup embeds the header wraps, so it must be
   * refreshed or the owner could not restore it with their current credentials
   * (round-7 finding 3).
   */
  afterCredentialChange?: () => Promise<void>;
};

const setupSchema = z.object({ passphrase: z.string().min(1), setupToken: z.string().optional() });
const unlockSchema = z.object({ passphrase: z.string().min(1), setupToken: z.string().optional() });
const recoveryUnlockSchema = z.object({ recoveryKey: z.string().min(1), setupToken: z.string().optional() });
const changePassphraseSchema = z.object({
  currentPassphrase: z.string().min(1),
  newPassphrase: z.string().min(MIN_VAULT_PASSPHRASE_LENGTH),
});
const resetPassphraseSchema = z.object({
  recoveryKey: z.string().min(1),
  newPassphrase: z.string().min(MIN_VAULT_PASSPHRASE_LENGTH),
});

function errorResponse(code: VaultErrorCode, status: number, extra: Record<string, string | number> = {}): Response {
  return Response.json({ error: { code, ...extra } }, { status });
}

/**
 * Pre-auth vault mutations require a JSON content type. A browser cross-site
 * `no-cors` POST can only send a simple content type (text/plain etc.), and
 * this server sends no CORS headers, so requiring application/json closes the
 * CSRF path that could otherwise burn unlock attempts from a visited page.
 * Native local callers (curl, the shell) can set the header freely.
 */
function isJsonRequest(contentType: string | undefined): boolean {
  return contentType !== undefined && contentType.startsWith("application/json");
}

/**
 * Credential-bearing vault routes are loopback-only: a passphrase, recovery
 * key or session token must never cross a LAN in cleartext HTTP, and setup
 * also returns the recovery key (round-7 finding 6). `/api/vault/status`
 * carries no secret and stays reachable for the shell's readiness probes.
 */
function requiresLoopback(path: string): boolean {
  return (
    path === "/api/vault/setup" ||
    path === "/api/vault/unlock" ||
    path === "/api/vault/unlock-recovery" ||
    path === "/api/vault/reset-passphrase" ||
    path === "/api/vault/change-passphrase" ||
    path === "/api/vault/logout" ||
    path.startsWith("/api/vault/recovery-keys")
  );
}

function isLoopbackRequest(c: Context): boolean {
  // SAFETY: lib/overlay.ts forwards the server socket's peer env to this app;
  // app.request() (tests) passes an explicit env
  const env = c.env as NodeRequestEnv | undefined;
  const address = env?.incoming?.socket?.remoteAddress;
  // FAIL CLOSED: an address we cannot observe is not the same as loopback. If
  // the plumbing ever drops the peer (the round-7 guard trusted an absent
  // address and let LAN clients send passphrases over cleartext HTTP), the
  // credential routes refuse instead of trusting the caller.
  if (address === undefined || address === "") return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Pre-boot credential routes the shell owns through the stdin broker (issue
 * #141). In broker mode they must be unreachable over HTTP: the passphrase and
 * the setup recovery key travel on the shell's pipe only, never the network.
 * Post-unlock credential routes (change-passphrase, recovery-keys) stay HTTP:
 * they are authenticated and the vault is already open.
 */
function requiresBroker(path: string): boolean {
  return (
    path === "/api/vault/setup" ||
    path === "/api/vault/unlock" ||
    path === "/api/vault/unlock-recovery" ||
    path === "/api/vault/reset-passphrase"
  );
}

export function createVaultHttpApp(deps: VaultHttpDeps): Hono {
  const app = new Hono();

  app.use("/api/vault/*", async (c, next) => {
    if (deps.config.vaultBroker && requiresBroker(c.req.path)) return errorResponse("VAULT_BROKER_REQUIRED", 403);
    if (requiresLoopback(c.req.path) && !isLoopbackRequest(c)) return errorResponse("VAULT_LOOPBACK_REQUIRED", 403);
    // Every route that can carry a credential refuses a request from an origin
    // that is not this app's own — including the routes that run before any
    // cookie exists (#319). The rule itself lives in `session.ts`, one copy,
    // and the RPC seam asks the same one. See `vaultOriginGate` for why a
    // loopback origin is not enough and why broker mode is exempt.
    //
    // The code is the seam's code, not the peer's (#319 round 3): a foreign
    // origin is `VAULT_ORIGIN_FORBIDDEN`, the same string the RPC seam throws,
    // because it is the same rule and the same refusal. `VAULT_LOOPBACK_REQUIRED`
    // stays the answer to the OTHER question one line up — the peer address is
    // not loopback — which no origin can describe. One rule, one code, and one
    // sentence for each: a request from `127.0.0.1` on another port is loopback
    // and used to be told it was not.
    if (requiresLoopback(c.req.path) && vaultOriginGate(c.req.raw, { broker: deps.config.vaultBroker }) === "foreign-origin") {
      return errorResponse("VAULT_ORIGIN_FORBIDDEN", 403);
    }
    return next();
  });

  /** Refresh today's backup after a credential change; never fatal. */
  const refreshBackupAfterCredentialChange = async (): Promise<void> => {
    try {
      await deps.afterCredentialChange?.();
    } catch (error) {
      deps.logger.error(
        "VAULT_BACKUP_REFRESH_FAILED",
        "the daily backup could not be refreshed after a credential change",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  /** Packaged installs: only the shell's webview holds the one-time boot token. */
  const setupTokenOk = (provided: string | undefined): boolean => {
    if (deps.config.bootToken === undefined) return true;
    return provided !== undefined && tokenMatches(provided, deps.config.bootToken);
  };

  /**
   * The session check that can say WHY it refused (#319): a request with no
   * usable session is `VAULT_NOT_UNLOCKED`, and one that carries a credential
   * the server no longer holds is the same answer. One place, so every route
   * that needs the session refuses the same way.
   *
   * There is no foreign-origin arm: every route that asks this question
   * requires loopback, and the middleware above refuses a foreign-origin
   * request to those routes first. The rule has one copy (`vaultOriginGate`)
   * and one refusal; a second arm here could never fire.
   */
  const sessionRefusal = (request: Request): { code: VaultErrorCode; status: number } | undefined => {
    const resolution = resolveVaultCredential(request, { broker: deps.config.vaultBroker });
    if (resolution.kind !== "credential") return { code: "VAULT_NOT_UNLOCKED", status: 401 };
    if (deps.manager.sessionMatches(resolution.token)) return undefined;
    return { code: "VAULT_NOT_UNLOCKED", status: 401 };
  };

  app.get("/api/vault/status", (c) => {
    const status = deps.manager.status();
    // Whether THIS request's credential is the live session (#319). The gate
    // needs it: a browser window with no valid cookie must be sent to the
    // unlock screen before the app renders, instead of being sent there by its
    // first refused query — that is the page of failed queries the module
    // exists to prevent, only shorter. A boolean discloses nothing to a caller
    // that already holds (or lacks) the credential it describes.
    const resolution = resolveVaultCredential(c.req.raw, { broker: deps.config.vaultBroker });
    const session = resolution.kind === "credential" && deps.manager.sessionMatches(resolution.token);
    return c.json({
      mode: "vault" as const,
      state: status.state,
      legacyDatabase: status.legacyDatabase,
      // only expose the wrap inventory once the owner has unlocked; a locked
      // install should not advertise what credentials exist (finding C17)
      recoveryKeyCount: status.state === "unlocked" ? status.recoveryKeyCount : 0,
      lockedForMs: status.lockedForMs,
      unlocked: deps.manager.unlocked,
      // this request's own credential, and never another window's
      session,
      // the shell's stdin broker owns the credential prompt; the gate UI then
      // routes unlock/setup through Tauri IPC instead of these HTTP routes
      broker: deps.config.vaultBroker,
    });
  });

  app.post("/api/vault/setup", async (c) => {
    if (!isJsonRequest(c.req.header("content-type"))) return errorResponse("VAULT_SETUP_FAILED", 415);
    const body = setupSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_SETUP_FAILED", 400);
    if (!setupTokenOk(body.data.setupToken)) return errorResponse("VAULT_SETUP_TOKEN_REQUIRED", 403);
    // validate the NORMALIZED passphrase: eight spaces normalizes to empty and
    // a padded short passphrase must not slip past the floor
    if (normalizePassphrase(body.data.passphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) {
      return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
    }
    try {
      // Resume a previous attempt whose header write failed: leaving the
      // pending slot occupied would make every retry answer
      // VAULT_SETUP_IN_PROGRESS until the sidecar restarts (finding 3).
      let prepared: PreparedSetup;
      let session: VaultSession | undefined;
      try {
        prepared = await deps.manager.prepareSetup(body.data.passphrase);
      } catch (error) {
        if (!(error instanceof VaultSetupInProgressError)) throw error;
        const recoveryKey = deps.manager.pendingRecoveryKey();
        if (recoveryKey === undefined) throw error;
        // only commits when the first attempt already wrote its snapshot AND
        // the submitted passphrase matches the pending wrap (round-4 security);
        // otherwise VaultSetupInProgressError (409) or wrong-passphrase (401)
        session = await deps.manager.resumeSetup(body.data.passphrase);
        prepared = { recoveryKey, vaultId: deps.manager.metadata().vaultId };
      }
      if (session === undefined) {
        try {
          await deps.bootstrap({ masterKey: deps.manager.setupMasterKey(), vaultId: prepared.vaultId, fresh: true });
        } catch (error) {
          // the header was never committed; drop the prepared key so a retry
          // starts clean and the plaintext database stays as it was
          deps.manager.abortSetup();
          if (error instanceof UnsupportedSchemaVersionError) return errorResponse("VAULT_SCHEMA_TOO_NEW", 409);
          deps.logger.error(
            "VAULT_SETUP_FAILED",
            "first snapshot could not be written",
            error instanceof Error ? error : new Error(String(error)),
          );
          return errorResponse("VAULT_SETUP_FAILED", 500);
        }
        // the app came up: only now may another request resume-commit the
        // pending setup (round-7 finding 1)
        deps.manager.finishSetupBootstrap();
        session = await deps.manager.commitSetup();
      }
      // a sweep that throws reports UNKNOWN on the wire, never a clean empty
      // list: the owner must not be told "all clear" after a failed check
      const cleanup = await classifyPlaintextCleanup(
        async () => (await deps.onSetupCommitted?.()) ?? { plaintextRemaining: [] },
        (error) =>
          deps.logger.error("VAULT_SETUP_CLEANUP_FAILED", "plaintext files could not be removed after vault setup", error),
      );
      if (cleanup.status === "remaining") {
        deps.logger.warn("VAULT_PLAINTEXT_REMAINS", `plaintext files still readable after setup: ${cleanup.remaining.join(", ")}`);
      }
      try {
        await deps.afterSetup?.();
      } catch (error) {
        deps.logger.error(
          "VAULT_SETUP_BACKUP_FAILED",
          "the first daily backup could not be created after setup",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      deps.logger.info("VAULT_SETUP_DONE", "vault created; recovery key shown once");
      // the recovery key is the only time the plaintext code ever leaves the vault
      const payload = sessionResponse(deps, c.req.raw, session);
      return c.json(
        {
          ok: true as const,
          recoveryKey: prepared.recoveryKey,
          ...payload.body,
          plaintextStatus: cleanup.status,
          plaintextRemaining: cleanup.remaining,
        },
        200,
        payload.headers,
      );
    } catch (error) {
      if (error instanceof VaultAlreadyConfiguredError) return errorResponse("VAULT_ALREADY_CONFIGURED", 409);
      if (error instanceof VaultSetupInProgressError) return errorResponse("VAULT_SETUP_IN_PROGRESS", 409);
      // a resume attempt that fails the pending passphrase is an auth failure,
      // never a credential release
      if (error instanceof VaultAuthenticationError) return errorResponse("VAULT_WRONG_PASSPHRASE", 401);
      if (error instanceof VaultLockedError) return errorResponse("VAULT_LOCKED", 429, { retryAfterMs: error.retryAfterMs });
      if (error instanceof Error && error.message === "VAULT_PASSPHRASE_TOO_SHORT") return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
      throw error;
    }
  });

  app.post("/api/vault/logout", (c) => {
    const refusal = sessionRefusal(c.req.raw);
    if (refusal !== undefined) return errorResponse(refusal.code, refusal.status);
    // revoke the in-process session: a copied token stops authorising RPCs
    deps.manager.revokeSession();
    // the browser path's credential is the cookie, so it goes with the session
    if (deps.config.vaultBroker) return c.json({ ok: true as const });
    return c.json({ ok: true as const }, 200, { "set-cookie": clearedVaultSessionCookie(c.req.raw) });
  });

  app.post("/api/vault/unlock", async (c) => {
    if (!isJsonRequest(c.req.header("content-type"))) return errorResponse("VAULT_WRONG_PASSPHRASE", 415);
    const body = unlockSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_WRONG_PASSPHRASE", 400);
    return unlockResponse(c, deps, () => deps.manager.unlock(body.data.passphrase), "VAULT_WRONG_PASSPHRASE");
  });

  app.post("/api/vault/unlock-recovery", async (c) => {
    if (!isJsonRequest(c.req.header("content-type"))) return errorResponse("VAULT_WRONG_RECOVERY", 415);
    const body = recoveryUnlockSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_WRONG_RECOVERY", 400);
    return unlockResponse(c, deps, () => deps.manager.unlockRecovery(body.data.recoveryKey), "VAULT_WRONG_RECOVERY");
  });

  app.get("/api/vault/recovery-keys", (c) => {
    const refusal = sessionRefusal(c.req.raw);
    if (refusal !== undefined) return errorResponse(refusal.code, refusal.status);
    const wraps = deps.manager.metadata().wraps.filter((wrap) => wrap.kind === "recovery");
    return c.json({ keys: wraps });
  });

  app.post("/api/vault/recovery-keys", async (c) => {
    const refusal = sessionRefusal(c.req.raw);
    if (refusal !== undefined) return errorResponse(refusal.code, refusal.status);
    try {
      const added = await deps.manager.addRecoveryKey();
      await refreshBackupAfterCredentialChange();
      return c.json({ ok: true as const, id: added.id, code: added.code, createdAt: added.createdAt });
    } catch (error) {
      if (error instanceof Error && error.message === "VAULT_RECOVERY_LIMIT") return errorResponse("VAULT_RECOVERY_LIMIT", 409);
      throw error;
    }
  });

  app.delete("/api/vault/recovery-keys/:id", async (c) => {
    const refusal = sessionRefusal(c.req.raw);
    if (refusal !== undefined) return errorResponse(refusal.code, refusal.status);
    try {
      const session = await deps.manager.removeRecoveryKey(c.req.param("id"));
      await refreshBackupAfterCredentialChange();
      // return the token and the generation it was minted at TOGETHER: a
      // rotation during the awaited refresh must never pair our (now revoked)
      // token with a newer generation (round-8 finding 2)
      const payload = sessionResponse(deps, c.req.raw, session);
      return c.json({ ok: true as const, ...payload.body }, 200, payload.headers);
    } catch (error) {
      if (error instanceof Error && error.message === "VAULT_RECOVERY_NOT_FOUND") return errorResponse("VAULT_RECOVERY_NOT_FOUND", 404);
      if (error instanceof Error && error.message === "VAULT_LAST_RECOVERY_KEY") return errorResponse("VAULT_LAST_RECOVERY_KEY", 409);
      throw error;
    }
  });

  app.post("/api/vault/change-passphrase", async (c) => {
    const refusal = sessionRefusal(c.req.raw);
    if (refusal !== undefined) return errorResponse(refusal.code, refusal.status);
    const body = changePassphraseSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
    try {
      const session = await deps.manager.changePassphrase(body.data.currentPassphrase, body.data.newPassphrase);
      await refreshBackupAfterCredentialChange();
      const payload = sessionResponse(deps, c.req.raw, session);
      return c.json({ ok: true as const, ...payload.body }, 200, payload.headers);
    } catch (error) {
      if (error instanceof VaultAuthenticationError) return errorResponse("VAULT_WRONG_PASSPHRASE", 401);
      if (error instanceof VaultLockedError) return errorResponse("VAULT_LOCKED", 429, { retryAfterMs: error.retryAfterMs });
      if (error instanceof Error && error.message === "VAULT_PASSPHRASE_TOO_SHORT") return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
      throw error;
    }
  });

  /**
   * Recovery-authorised passphrase reset (finding C4): the recovery key is the
   * credential, so this route is pre-auth like unlock but shares the same
   * persisted throttle.
   */
  app.post("/api/vault/reset-passphrase", async (c) => {
    if (!isJsonRequest(c.req.header("content-type"))) return errorResponse("VAULT_RESET_FAILED", 415);
    const body = resetPassphraseSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_RESET_FAILED", 400);
    if (normalizePassphrase(body.data.newPassphrase).length < MIN_VAULT_PASSPHRASE_LENGTH) {
      return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
    }
    try {
      const session = await deps.manager.setPassphraseFromRecovery(body.data.recoveryKey, body.data.newPassphrase);
      await refreshBackupAfterCredentialChange();
      const payload = sessionResponse(deps, c.req.raw, session);
      return c.json({ ok: true as const, ...payload.body }, 200, payload.headers);
    } catch (error) {
      if (error instanceof VaultAuthenticationError) return errorResponse("VAULT_WRONG_RECOVERY", 401);
      if (error instanceof VaultLockedError) return errorResponse("VAULT_LOCKED", 429, { retryAfterMs: error.retryAfterMs });
      if (error instanceof Error && error.message === "VAULT_PASSPHRASE_TOO_SHORT") return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
      throw error;
    }
  });

  return app;
}

/**
 * How this server hands a freshly minted session to its caller (#319): the
 * cookie on the browser path, the body on the broker path. The rule itself
 * lives in `lib/vault/session.ts`, so the routes and the RPC guard cannot
 * disagree about it.
 */
function sessionResponse(deps: VaultHttpDeps, request: Request, session: VaultSession): VaultSessionPayload {
  // The server is the arbiter of the ONE live session (#319, greptile P1). A
  // minting reply carries a `Set-Cookie`, and the browser applies it whatever
  // this page decided: a reply that was slow enough to be overtaken by another
  // window's unlock would overwrite the LIVE credential with a revoked one and
  // lock every window out. So a reply whose session is no longer the live one
  // carries no credential at all — no cookie, no token — and reports the
  // generation that is actually in force. The caller's mutation already
  // happened; only the credential it would install is dropped.
  if (session.generation !== deps.manager.sessionEpoch()) {
    return { body: { sessionGeneration: deps.manager.sessionEpoch() }, headers: {} };
  }
  return vaultSessionPayload(deps.config.vaultBroker, request, session.token, session.generation);
}

async function unlockResponse(
  c: Context,
  deps: VaultHttpDeps,
  unlock: () => Promise<VaultSession>,
  wrongCode: VaultErrorCode,
): Promise<Response> {
  try {
    const session = await unlock();
    await deps.bootstrap({ masterKey: deps.manager.requireMasterKey(), vaultId: deps.manager.metadata().vaultId, fresh: false });
    // the token and its generation travel together: a rotation during the
    // bootstrap can never make this response claim a newer generation
    const payload = sessionResponse(deps, c.req.raw, session);
    return c.json({ ok: true as const, ...payload.body }, 200, payload.headers);
  } catch (error) {
    if (error instanceof VaultAuthenticationError) return errorResponse(wrongCode, 401);
    if (error instanceof VaultLockedError) return errorResponse("VAULT_LOCKED", 429, { retryAfterMs: error.retryAfterMs });
    if (error instanceof UnsupportedSchemaVersionError) return errorResponse("VAULT_SCHEMA_TOO_NEW", 409);
    if (error instanceof MissingVaultDatabaseError) return errorResponse("VAULT_DATABASE_MISSING", 409);
    if (error instanceof VaultCorruptionError) return errorResponse("VAULT_CORRUPT", 409);
    if (error instanceof VaultFormatError) return errorResponse("VAULT_INVALID", 500);
    if (error instanceof VaultNotUnlockedError) return errorResponse("VAULT_NOT_UNLOCKED", 409);
    throw error;
  }
}
