import { MIN_VAULT_PASSPHRASE_LENGTH, type VaultErrorCode } from "@dokan/contracts";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { tokenMatches } from "../boot-token";
import type { AppLogger } from "../logger";
import { UnsupportedSchemaVersionError } from "../schema-version";
import { MissingVaultDatabaseError, VaultCorruptionError } from "../../db/encrypted-connection";
import { VaultAuthenticationError, normalizePassphrase } from "./crypto";
import {
  VaultAlreadyConfiguredError,
  VaultLockedError,
  VaultManager,
  VaultNotUnlockedError,
  VaultSetupInProgressError,
} from "./manager";
import { VaultFormatError } from "./format";
import type { AppConfig } from "../../config";

/**
 * The pre-boot vault gate over HTTP (dev/e2e and rotation from settings). The
 * desktop shell uses the stdin broker instead, but both drive the same
 * VaultManager, so the passphrase/recovery rules cannot drift between them.
 *
 * All responses are JSON with a stable `error.code` (plus structured extras
 * such as `retryAfterMs`). The API never ships display copy: the web owns
 * every sentence through its i18n layer (locale-neutral guard). Secrets never
 * appear in URLs, logs or error text; the session token is the only credential
 * and it rides a header.
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
  // SAFETY: @hono/node-server sets env.incoming to the Node IncomingMessage;
  // app.request() (tests) has no env, and an absent address is trusted because
  // there is no socket to observe
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const address = env?.incoming?.socket?.remoteAddress;
  if (address === undefined) return true;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function createVaultHttpApp(deps: VaultHttpDeps): Hono {
  const app = new Hono();

  app.use("/api/vault/*", async (c, next) => {
    if (requiresLoopback(c.req.path) && !isLoopbackRequest(c)) return errorResponse("VAULT_LOOPBACK_REQUIRED", 403);
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

  const sessionOk = (request: Request): boolean => deps.manager.sessionMatches(request.headers.get("x-vault-session"));

  app.get("/api/vault/status", (c) => {
    const status = deps.manager.status();
    return c.json({
      mode: "vault" as const,
      state: status.state,
      legacyDatabase: status.legacyDatabase,
      // only expose the wrap inventory once the owner has unlocked; a locked
      // install should not advertise what credentials exist (finding C17)
      recoveryKeyCount: status.state === "unlocked" ? status.recoveryKeyCount : 0,
      lockedForMs: status.lockedForMs,
      unlocked: deps.manager.unlocked,
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
      let sessionToken: string | undefined;
      try {
        prepared = await deps.manager.prepareSetup(body.data.passphrase);
      } catch (error) {
        if (!(error instanceof VaultSetupInProgressError)) throw error;
        const recoveryKey = deps.manager.pendingRecoveryKey();
        if (recoveryKey === undefined) throw error;
        // only commits when the first attempt already wrote its snapshot AND
        // the submitted passphrase matches the pending wrap (round-4 security);
        // otherwise VaultSetupInProgressError (409) or wrong-passphrase (401)
        sessionToken = await deps.manager.resumeSetup(body.data.passphrase);
        prepared = { recoveryKey, vaultId: deps.manager.metadata().vaultId };
      }
      if (sessionToken === undefined) {
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
        sessionToken = await deps.manager.commitSetup();
      }
      let plaintextRemaining: string[] = [];
      try {
        plaintextRemaining = (await deps.onSetupCommitted?.())?.plaintextRemaining ?? [];
      } catch (error) {
        // the vault is committed and the recovery key must still reach the
        // owner; plaintext cleanup is best-effort (a later unlock retries)
        deps.logger.error(
          "VAULT_SETUP_CLEANUP_FAILED",
          "plaintext files could not be removed after vault setup",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      if (plaintextRemaining.length > 0) {
        deps.logger.warn("VAULT_PLAINTEXT_REMAINS", `plaintext files still readable after setup: ${plaintextRemaining.join(", ")}`);
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
      return c.json({
        ok: true as const,
        recoveryKey: prepared.recoveryKey,
        sessionToken,
        sessionGeneration: deps.manager.sessionEpoch(),
        plaintextRemaining,
      });
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
    if (!sessionOk(c.req.raw)) return errorResponse("VAULT_NOT_UNLOCKED", 401);
    // revoke the in-process session: a copied token stops authorising RPCs
    deps.manager.revokeSession();
    return c.json({ ok: true as const });
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
    if (!sessionOk(c.req.raw)) return errorResponse("VAULT_NOT_UNLOCKED", 401);
    const wraps = deps.manager.metadata().wraps.filter((wrap) => wrap.kind === "recovery");
    return c.json({ keys: wraps });
  });

  app.post("/api/vault/recovery-keys", async (c) => {
    if (!sessionOk(c.req.raw)) return errorResponse("VAULT_NOT_UNLOCKED", 401);
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
    if (!sessionOk(c.req.raw)) return errorResponse("VAULT_NOT_UNLOCKED", 401);
    try {
      const sessionToken = await deps.manager.removeRecoveryKey(c.req.param("id"));
      await refreshBackupAfterCredentialChange();
      return c.json({ ok: true as const, sessionToken, sessionGeneration: deps.manager.sessionEpoch() });
    } catch (error) {
      if (error instanceof Error && error.message === "VAULT_RECOVERY_NOT_FOUND") return errorResponse("VAULT_RECOVERY_NOT_FOUND", 404);
      if (error instanceof Error && error.message === "VAULT_LAST_RECOVERY_KEY") return errorResponse("VAULT_LAST_RECOVERY_KEY", 409);
      throw error;
    }
  });

  app.post("/api/vault/change-passphrase", async (c) => {
    if (!sessionOk(c.req.raw)) return errorResponse("VAULT_NOT_UNLOCKED", 401);
    const body = changePassphraseSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
    try {
      const sessionToken = await deps.manager.changePassphrase(body.data.currentPassphrase, body.data.newPassphrase);
      await refreshBackupAfterCredentialChange();
      return c.json({ ok: true as const, sessionToken, sessionGeneration: deps.manager.sessionEpoch() });
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
      const sessionToken = await deps.manager.setPassphraseFromRecovery(body.data.recoveryKey, body.data.newPassphrase);
      await refreshBackupAfterCredentialChange();
      return c.json({ ok: true as const, sessionToken, sessionGeneration: deps.manager.sessionEpoch() });
    } catch (error) {
      if (error instanceof VaultAuthenticationError) return errorResponse("VAULT_WRONG_RECOVERY", 401);
      if (error instanceof VaultLockedError) return errorResponse("VAULT_LOCKED", 429, { retryAfterMs: error.retryAfterMs });
      if (error instanceof Error && error.message === "VAULT_PASSPHRASE_TOO_SHORT") return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
      throw error;
    }
  });

  return app;
}

async function unlockResponse(
  c: { json: (body: { ok: true; sessionToken: string; sessionGeneration: number }, status: 200) => Response },
  deps: VaultHttpDeps,
  unlock: () => Promise<string>,
  wrongCode: VaultErrorCode,
): Promise<Response> {
  try {
    const sessionToken = await unlock();
    await deps.bootstrap({ masterKey: deps.manager.requireMasterKey(), vaultId: deps.manager.metadata().vaultId, fresh: false });
    return c.json({ ok: true as const, sessionToken, sessionGeneration: deps.manager.sessionEpoch() }, 200);
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
