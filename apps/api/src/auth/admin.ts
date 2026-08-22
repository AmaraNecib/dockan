import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { AppConfig } from "../config";
import type { DrizzleDb } from "../db/connection";
import { accounts, users } from "../db/schema";
import { AppError } from "../lib/errors";
import { type AppLogger } from "../lib/logger";
import { normalizeAlgerianPhone, phoneToUsername } from "../lib/phone";
import type { StorePort } from "../store/port";
import type { BetterAuthInstance } from "./auth";

export type ResetPasswordInput = {
  secret: string;
  newPassword: string;
  phoneNumber: string;
};

/**
 * The issuer better-auth writes for local credential accounts
 * (createLocalAccountIssuer("credential") in @better-auth/core).
 */
const CREDENTIAL_ISSUER = "local:credential";

/**
 * Provision or rotate the single admin account via the build secret.
 * Rows are written through our typed drizzle tables with the same column
 * names and values better-auth's username-plugin login reads (providerId
 * "credential", accountId equal to the user id, issuer local:credential).
 * The password uses better-auth's own hash format, so sign-in works unchanged.
 */
export async function resetAdminPassword(deps: {
  db: DrizzleDb;
  auth: BetterAuthInstance;
  store: StorePort;
  config: AppConfig;
  logger: AppLogger;
}, input: ResetPasswordInput): Promise<{ ok: true }> {
  const phone = normalizeAlgerianPhone(input.phoneNumber);
  if (phone === null) throw new AppError("INVALID_PHONE_NUMBER", "INVALID_PHONE_NUMBER");
  if (deps.config.buildSecret === undefined) {
    throw new AppError("BUILD_SECRET_NOT_CONFIGURED", "BUILD_SECRET_NOT_CONFIGURED");
  }
  if (input.secret !== deps.config.buildSecret) {
    throw new AppError("WRONG_BUILD_SECRET", "WRONG_BUILD_SECRET");
  }
  const username = phoneToUsername(phone);

  const ctx = await deps.auth.$context;
  const hashed = await ctx.password.hash(input.newPassword);

  // user: create when missing, else reuse
  const existing = await deps.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  let userId = existing[0]?.id;
  if (userId === undefined) {
    await deps.db
      .insert(users)
      .values({
        id: randomUUID(),
        name: "مالك المتجر",
        image: null,
        username,
        phoneNumber: phone,
        phoneNumberVerified: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const inserted = await deps.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    const row = inserted[0];
    if (row === undefined) throw new Error("admin user was not created");
    userId = row.id;
  }

  // credential account: upsert the password (and issuer on first insert)
  const account = await deps.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);
  const accountRow = account[0];
  if (accountRow !== undefined) {
    await deps.db
      .update(accounts)
      .set({ password: hashed, updatedAt: new Date() })
      .where(eq(accounts.id, accountRow.id))
      .run();
  } else {
    await deps.db
      .insert(accounts)
      .values({
        id: randomUUID(),
        userId,
        accountId: userId,
        providerId: "credential",
        issuer: CREDENTIAL_ISSUER,
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: null,
        password: hashed,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
  }

  await deps.store.insertActivity({ type: "PASSWORD_RESET", summary: `إعادة تعيين كلمة المرور (${phone})` });
  // the guard cross-checks sessions against this identity (single-admin rule)
  await deps.store.setSetting("adminUserId", userId);
  deps.logger.info("PASSWORD_RESET", "admin credentials provisioned or rotated via build secret");
  return { ok: true };
}