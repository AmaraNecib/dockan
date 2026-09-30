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

import { ensureReleaseSecrets, RELEASE_ENV_PATH } from "./secrets";
// re-exported so callers and tests can keep importing the rules from here
export {
  MIN_AUTH_SECRET_LEN,
  MIN_BUILD_SECRET_LEN,
  validateAuthSecret,
  validateBuildSecret,
} from "./secret-rules";
export type { SecretValidation } from "./secret-rules";

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
  const resolved = ensureReleaseSecrets();
  if (resolved.generated.length > 0) {
    console.log(`[dokan] generated ${resolved.generated.join(" and ")} into ${RELEASE_ENV_PATH} (gitignored)`);
  }
  await compileSidecar(resolved.secrets.DOKAN_BUILD_SECRET, resolved.secrets.DOKAN_AUTH_SECRET);
  console.log(
    `[dokan] sidecar compiled with a ${resolved.secrets.DOKAN_BUILD_SECRET.length}-char build secret and ${resolved.secrets.DOKAN_AUTH_SECRET.length}-char auth secret inlined`,
  );
}

if (import.meta.main) {
  await main();
}