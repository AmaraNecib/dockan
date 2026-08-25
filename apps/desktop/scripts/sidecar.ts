/**
 * API sidecar compile with the per-customer build secret inlined (ticket 15 /
 * PR #51 finding 2). Run via `bun run sidecar` (see package.json).
 *
 * The per-customer provisioning secret must NOT be a shared committed value:
 * it is supplied at build time by the vendor and baked into the compiled exe
 * with `bun build --define`, where the api reads it as
 * `process.env.DOKAN_BUILD_SECRET` (see apps/api/src/main.ts).
 *
 * A missing or weak (<16 chars) secret is a hard failure — a default must
 * never ship.
 */

import path from "node:path";

/** Minimum acceptable length for a per-customer build secret. */
export const MIN_BUILD_SECRET_LEN = 16;

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
 * Compile the sidecar with the secret inlined via `bun build --define`.
 * cwd is the package root (apps/desktop) when invoked through `bun run`.
 */
export async function compileSidecar(secret: string): Promise<void> {
  const outfile = path.resolve("src-tauri/binaries/dokan-api-x86_64-pc-windows-msvc");
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      "../api/src/main.ts",
      "--outfile",
      outfile,
      `--define=process.env.DOKAN_BUILD_SECRET=${JSON.stringify(secret)}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`sidecar compile failed with exit code ${code}`);
  }
}

async function main(): Promise<void> {
  const result = validateBuildSecret();
  if (!result.ok) {
    console.error(`[dokan] build secret rejected: ${result.reason}`);
    console.error("[dokan] set a unique per-customer secret, e.g.:");
    console.error("  DOKAN_BUILD_SECRET='<unique-per-shop-secret>' bun run --filter @dokan/desktop portable");
    process.exit(1);
  }
  await compileSidecar(result.secret);
  console.log(`[dokan] sidecar compiled with a ${result.secret.length}-char build secret inlined`);
}

if (import.meta.main) {
  await main();
}