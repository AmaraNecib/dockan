import { Hono } from "hono";
import { z } from "zod";

import { tokenMatches } from "../boot-token";
import type { AppLogger } from "../logger";
import { UnsupportedSchemaVersionError } from "../schema-version";
import { VaultAuthenticationError } from "./crypto";
import {
  VaultAlreadyConfiguredError,
  VaultLockedError,
  VaultManager,
  VaultNotUnlockedError,
} from "./manager";
import { VaultFormatError } from "./format";
import { MIN_VAULT_PASSPHRASE_LENGTH, vaultErrorMessage } from "./messages";
import type { AppConfig } from "../../config";

/**
 * The pre-boot vault gate over HTTP (dev/e2e and rotation from settings). The
 * desktop shell uses the stdin broker instead, but both drive the same
 * VaultManager, so the passphrase/recovery rules cannot drift between them.
 *
 * All responses are JSON with a stable `error.code` and an Arabic
 * `error.message` the owner reads. Secrets never appear in URLs, logs or
 * error text; the session token is the only credential and it rides a header.
 */

export type VaultBootstrapInput = {
  masterKey: Buffer;
  vaultId: string;
  /** true only for the first-run flow: the snapshot may need migration seeds */
  fresh: boolean;
};

export type VaultHttpDeps = {
  manager: VaultManager;
  config: AppConfig;
  logger: AppLogger;
  /** Build the store/app once the vault is open; must persist the first snapshot. */
  bootstrap: (input: VaultBootstrapInput) => Promise<void>;
  /** Called only after the header is committed: delete the migrated plaintext files. */
  onSetupCommitted?: () => Promise<void>;
};

const setupSchema = z.object({ passphrase: z.string().min(1), setupToken: z.string().optional() });
const unlockSchema = z.object({ passphrase: z.string().min(1), setupToken: z.string().optional() });
const recoveryUnlockSchema = z.object({ recoveryKey: z.string().min(1), setupToken: z.string().optional() });
const changePassphraseSchema = z.object({
  currentPassphrase: z.string().min(1),
  newPassphrase: z.string().min(MIN_VAULT_PASSPHRASE_LENGTH),
});

function errorResponse(code: string, status: number, extra: Record<string, string | number> = {}): Response {
  return Response.json({ error: { code, message: vaultErrorMessage(code), ...extra } }, { status });
}

export function createVaultHttpApp(deps: VaultHttpDeps): Hono {
  const app = new Hono();

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
      recoveryKeyCount: status.recoveryKeyCount,
      lockedForMs: status.lockedForMs,
      unlocked: deps.manager.unlocked,
    });
  });

  app.post("/api/vault/setup", async (c) => {
    const body = setupSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_SETUP_FAILED", 400);
    if (!setupTokenOk(body.data.setupToken)) return errorResponse("VAULT_SETUP_TOKEN_REQUIRED", 403);
    if (body.data.passphrase.length < MIN_VAULT_PASSPHRASE_LENGTH) return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
    try {
      const prepared = await deps.manager.prepareSetup(body.data.passphrase);
      try {
        await deps.bootstrap({ masterKey: deps.manager.setupMasterKey(), vaultId: prepared.vaultId, fresh: true });
      } catch (error) {
        // the header was never committed; drop the prepared key so a retry
        // starts clean and the plaintext database stays as it was
        deps.manager.abortSetup();
        if (error instanceof UnsupportedSchemaVersionError) return errorResponse("VAULT_SCHEMA_TOO_NEW", 409);
        deps.logger.error("VAULT_SETUP_FAILED", "first snapshot could not be written", error instanceof Error ? error : new Error(String(error)));
        return errorResponse("VAULT_SETUP_FAILED", 500);
      }
      const sessionToken = await deps.manager.commitSetup();
      await deps.onSetupCommitted?.();
      deps.logger.info("VAULT_SETUP_DONE", "vault created; recovery key shown once");
      // the recovery key is the only time the plaintext code ever leaves the vault
      return c.json({ ok: true as const, recoveryKey: prepared.recoveryKey, sessionToken });
    } catch (error) {
      if (error instanceof VaultAlreadyConfiguredError) return errorResponse("VAULT_ALREADY_CONFIGURED", 409);
      throw error;
    }
  });

  app.post("/api/vault/unlock", async (c) => {
    const body = unlockSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_WRONG_PASSPHRASE", 400);
    return unlockResponse(c, deps, () => deps.manager.unlock(body.data.passphrase), "VAULT_WRONG_PASSPHRASE");
  });

  app.post("/api/vault/unlock-recovery", async (c) => {
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
      return c.json({ ok: true as const, id: added.id, code: added.code, createdAt: added.createdAt });
    } catch (error) {
      if (error instanceof Error && error.message === "VAULT_RECOVERY_LIMIT") return errorResponse("VAULT_RECOVERY_LIMIT", 409);
      throw error;
    }
  });

  app.delete("/api/vault/recovery-keys/:id", async (c) => {
    if (!sessionOk(c.req.raw)) return errorResponse("VAULT_NOT_UNLOCKED", 401);
    try {
      await deps.manager.removeRecoveryKey(c.req.param("id"));
      return c.json({ ok: true as const });
    } catch (error) {
      if (error instanceof Error && error.message === "VAULT_RECOVERY_NOT_FOUND") return errorResponse("VAULT_RECOVERY_NOT_FOUND", 404);
      throw error;
    }
  });

  app.post("/api/vault/change-passphrase", async (c) => {
    if (!sessionOk(c.req.raw)) return errorResponse("VAULT_NOT_UNLOCKED", 401);
    const body = changePassphraseSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return errorResponse("VAULT_PASSPHRASE_TOO_SHORT", 400);
    try {
      await deps.manager.changePassphrase(body.data.currentPassphrase, body.data.newPassphrase);
      return c.json({ ok: true as const });
    } catch (error) {
      if (error instanceof VaultAuthenticationError) return errorResponse("VAULT_WRONG_PASSPHRASE", 401);
      throw error;
    }
  });

  return app;
}

async function unlockResponse(
  c: { json: (body: { ok: true; sessionToken: string }, status: 200) => Response },
  deps: VaultHttpDeps,
  unlock: () => Promise<string>,
  wrongCode: string,
): Promise<Response> {
  try {
    const sessionToken = await unlock();
    await deps.bootstrap({ masterKey: deps.manager.requireMasterKey(), vaultId: deps.manager.metadata().vaultId, fresh: false });
    return c.json({ ok: true as const, sessionToken }, 200);
  } catch (error) {
    if (error instanceof VaultAuthenticationError) return errorResponse(wrongCode, 401);
    if (error instanceof VaultLockedError) return errorResponse("VAULT_LOCKED", 429, { retryAfterMs: error.retryAfterMs });
    if (error instanceof UnsupportedSchemaVersionError) return errorResponse("VAULT_SCHEMA_TOO_NEW", 409);
    if (error instanceof VaultFormatError) return errorResponse("VAULT_INVALID", 500);
    if (error instanceof VaultNotUnlockedError) return errorResponse("VAULT_NOT_UNLOCKED", 409);
    throw error;
  }
}
