/**
 * API sidecar compile with the per-customer secrets inlined (ticket 15 / PR
 * #51 findings 2 & 5). Run via `bun run sidecar` (see package.json).
 *
 * BOTH per-customer secrets must NOT be shared committed values: they are
 * supplied at build time by the vendor and baked into the compiled exe with
 * `bun build --define`, where the api reads them as
 * `process.env.DOKAN_BUILD_SECRET` and `process.env.DOKAN_AUTH_SECRET` (see
 * apps/api/src/main.ts). A missing or weak secret is a hard failure — a
 * default must never ship.
 *
 * - DOKAN_BUILD_SECRET (>= 16 chars): provisioning secret for the first-run
 *   setup / password reset path (PR #51 finding 2).
 * - DOKAN_AUTH_SECRET (>= 32 chars): better-auth session-signing secret (PR
 *   #51 finding 5). A committed or weak signing key would let anyone who
 *   reads the binary/source forge admin sessions, so this is per-customer at
 *   build time, exactly like the build secret — never in the shell's env,
 *   never written to logs, port-record or app-data.
 */

import path from "node:path";

/** Minimum acceptable length for a per-customer build secret. */
export const MIN_BUILD_SECRET_LEN = 16;
/** Minimum acceptable length for the better-auth session-signing secret. */
export const MIN_AUTH_SECRET_LEN = 32;

export type SecretValidation = { ok: true; secret: string } | { ok: false; reason: string };

export function validateBuildSecret(env: NodeJS.ProcessEnv = process.env): SecretValidation {
  const secret = env.DOKAN_BUILD_SECRET;
  if (secret === undefined || secret === "") {
    return { ok: false, reason: "DOKAN_BUILD_SECRET is not set — refusing to ship a default secret" };
  }
  if (secret.length < MIN_BUILD_SECRET_LEN) {
    return {
      ok: false,
      reason: `DOKAN_BUILD_SECRET is only ${secret.length} chars — must be at least ${MIN_BUILD_SECRET_LEN}`,
    };
  }
  return { ok: true, secret };
}

/**
 * Validate the per-customer session-signing secret (PR #51 finding 5).
 * Better-Auth signs session cookies with this key; a shared or short default
 * would let any reader of the binary/source forge admin sessions, so a
 * release build without a strong DOKAN_AUTH_SECRET must fail loudly.
 */
export function validateAuthSecret(env: NodeJS.ProcessEnv = process.env): SecretValidation {
  const secret = env.DOKAN_AUTH_SECRET;
  if (secret === undefined || secret === "") {
    return { ok: false, reason: "DOKAN_AUTH_SECRET is not set — refusing to ship a default session-signing secret" };
  }
  if (secret.length < MIN_AUTH_SECRET_LEN) {
    return {
      ok: false,
      reason: `DOKAN_AUTH_SECRET is only ${secret.length} chars — must be at least ${MIN_AUTH_SECRET_LEN}`,
    };
  }
  return { ok: true, secret };
}

/**
 * Compile the sidecar with both secrets inlined via `bun build --define`.
 * cwd is the package root (apps/desktop) when invoked through `bun run`.
 */
export async function compileSidecar(buildSecret: string, authSecret: string): Promise<void> {
  const outfile = path.resolve("src-tauri/binaries/dokan-api-x86_64-pc-windows-msvc");
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      "../api/src/main.ts",
      "--outfile",
      outfile,
      `--define=process.env.DOKAN_BUILD_SECRET=${JSON.stringify(buildSecret)}`,
      `--define=process.env.DOKAN_AUTH_SECRET=${JSON.stringify(authSecret)}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`sidecar compile failed with exit code ${code}`);
  }
}

async function main(): Promise<void> {
  const buildSecret = validateBuildSecret();
  if (!buildSecret.ok) {
    console.error(`[dokan] build secret rejected: ${buildSecret.reason}`);
    console.error("[dokan] set a unique per-customer secret, e.g.:");
    console.error("  DOKAN_BUILD_SECRET='<unique-per-shop-secret>' bun run --filter @dokan/desktop portable");
    process.exit(1);
  }
  const authSecret = validateAuthSecret();
  if (!authSecret.ok) {
    console.error(`[dokan] auth secret rejected: ${authSecret.reason}`);
    console.error("[dokan] set a unique per-customer session-signing secret, e.g.:");
    console.error("  DOKAN_AUTH_SECRET='<unique-per-shop-signing-secret (>=32 chars)>' bun run --filter @dokan/desktop portable");
    process.exit(1);
  }
  await compileSidecar(buildSecret.secret, authSecret.secret);
  console.log(
    `[dokan] sidecar compiled with a ${buildSecret.secret.length}-char build secret and ${authSecret.secret.length}-char auth secret inlined`,
  );
}

if (import.meta.main) {
  await main();
}