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
 * off the UI; the single admin is provisioned by first-run setup.
 *
 * The session-signing secret is read from the database at boot (ADR-0008
 * §4.2): one universal build, generated per install on first run, so copying
 * or restoring the data folder keeps sessions valid.
 */
/**
 * The extra origins better-auth must accept, derived from config.
 *
 * One entry, and only for a loopback API: the dev server the browser actually
 * talks to. A packaged app is same-origin with its sidecar, so its `baseURL`
 * already covers it, and nothing is added there.
 */
export function authTrustedOrigins(config: AppConfig, env: Record<string, string | undefined> = process.env): string[] {
  // A deployment can name its own origins; this is the only way a cross-host
  // install (api on one host, web on another) can accept a cookie-bearing write.
  // Only absolute http(s) origins are kept: a bare hostname or a wildcard would
  // turn a config mistake into a blanket allow.
  const configured = (env.DOKAN_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      try {
        const url = new URL(entry);
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
      } catch {
        return null;
      }
    })
    .filter((origin): origin is string => origin !== null);

  // The dev server's origin, and only on a loopback API: a packaged sidecar is
  // same-origin with the web it serves, so it needs nothing here. When it IS a
  // loopback API the entry is inert for access — every spelling below is loopback
  // — and it is what lets a developer sign out through the vite proxy at all.
  //
  // EVERY loopback spelling, not just the API's own (#356 review): the webview
  // loads `http://localhost:5173` while the API defaults to `127.0.0.1`, and a
  // trusted list that only carried the API's spelling still refused the desktop
  // window's sign-out. These are the same machine twice, never a wider trust.
  if (!isLoopbackHostname(config.host)) return configured;
  const webPort = Number(env.DOKAN_WEB_PORT ?? 5173);
  if (!Number.isInteger(webPort) || webPort <= 0) return configured;
  const loopbackSpellings = ["127.0.0.1", "localhost"];
  return [...configured, ...loopbackSpellings.map((host) => `http://${host}:${webPort}`)];
}

/** loopback by literal address, not by name resolution: no DNS in an auth check */
function isLoopbackHostname(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export function createAuth(db: DrizzleDb, config: AppConfig, sessionSecret: string) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: false,
      // SAFETY: the adapter resolves models by these keys; the consts are the
      // drizzle table definitions in db/schema.ts (table name "user" etc.)
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    baseURL: `http://${config.host}:${config.port}`,
    /**
     * The origins this API is legitimately reached through (#347).
     *
     * better-auth refuses a request whose `Origin` is not `baseURL` — but only
     * when the request carries a cookie (`api/middlewares/origin-check.mjs`:
     * `if (!(forceValidate || useCookies)) return`). That is why sign-IN worked
     * through the dev proxy and sign-OUT did not: by sign-out the browser holds
     * the session cookie, so the check engages and compares `:5173` against the
     * API's own `:4317`:
     *
     *     POST /api/auth/sign-out -> 403 Invalid origin: http://127.0.0.1:5173
     *
     * So the dev server's origin joins the list, derived from the same env var the
     * dev server itself reads (`DOKAN_WEB_PORT`, default 5173) rather than
     * hardcoded. It is only ever a loopback origin, and only when the API is
     * itself on loopback — a deployment serving the app from its own origin needs
     * nothing here, and nothing is widened for it.
     */
    trustedOrigins: authTrustedOrigins(config),
    secret: sessionSecret,
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