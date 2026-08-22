import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { username } from "better-auth/plugins";

import type { AppConfig } from "../config";
import type { DrizzleDb } from "../db/connection";
import { accounts, sessions, users, verifications } from "../db/schema";

/**
 * Dokan's auth instance. Username-password login where the username is the
 * shop owner's normalized Algerian phone (digits, no +). No email, no OTP;
 * local-first app (ADR-0001). The username plugin's sign-up endpoint stays
 * off the UI; the single admin is provisioned by the build secret.
 */
export function createAuth(db: DrizzleDb, config: AppConfig) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: false,
      // SAFETY: the adapter resolves models by these keys; the consts are the
      // drizzle table definitions in db/schema.ts (table name "user" etc.)
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    baseURL: `http://${config.host}:${config.port}`,
    secret: config.authSecret,
    plugins: [
      username({
        displayUsername: false,
        // SAFETY: phoneToUsername output; the plus sign is deliberately not
        // part of the username, so the validator is plain digits
        usernameValidator: (u) => /^213[5-7]\d{8}$/.test(u),
      }),
    ],
  });
}

export type BetterAuthInstance = ReturnType<typeof createAuth>;