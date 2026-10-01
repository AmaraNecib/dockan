/**
 * API sidecar compile with the per-customer secrets inlined (ticket 15 / PR
 * #51 findings 2 & 5). Run via `bun run sidecar` (see package.json), and from
 * `release.ts` before every release build.
 *
 * BOTH per-customer secrets must NOT be shared committed values: they are
 * resolved from the gitignored per-customer env file (or an explicit env
 * override) and baked into the compiled exe with `bun build --define`, where
 * the api reads them as `process.env.DOKAN_BUILD_SECRET` and
 * `process.env.DOKAN_AUTH_SECRET` (see apps/api/src/main.ts). A PRESENT but
 * weak secret is a hard failure; a missing one is generated once into the env
 * file (see secrets.ts) — a shared default is never used.
 *
 * - DOKAN_BUILD_SECRET (>= 16 chars): provisioning secret for the first-run
 *   setup / password reset path (PR #51 finding 2).
 * - DOKAN_AUTH_SECRET (>= 32 chars): better-auth session-signing secret (PR
 *   #51 finding 5). A committed or weak signing key would let anyone who
 *   reads the binary/source forge admin sessions, so this is per-customer at
 *   build time, exactly like the build secret — never in the packaged app's
 *   environment, never in logs, port-record or app-data.
 *
 * A successful compile writes a freshness stamp next to the binary; `build.rs`
 * reuses the sidecar only when that stamp matches the current API sources and
 * the secrets supplied to this build (PR #117 finding 5).
 */

import path from "node:path";

import { ensureReleaseSecrets, type ResolvedReleaseSecrets } from "./secrets";
import { stagedSidecarPath, writeSidecarStamp } from "./sidecar-freshness";
// re-exported so callers and tests can keep importing the rules from here
export {
  MIN_AUTH_SECRET_LEN,
  MIN_BUILD_SECRET_LEN,
  validateAuthSecret,
  validateBuildSecret,
} from "./secret-rules";
export type { SecretValidation } from "./secret-rules";

/** API package root; cwd is apps/desktop under `bun run`. */
const API_DIR = path.resolve("../api");

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
  // The sidecar is only trustworthy while it is newer than its inputs; record
  // what went into it so build.rs can prove that instead of assuming any
  // staged .exe is current (PR #117 finding 5).
  writeSidecarStamp(API_DIR, stagedSidecarPath(outfile), buildSecret, authSecret);
}

async function main(): Promise<void> {
  let resolved: ResolvedReleaseSecrets;
  try {
    // DOKAN_CUSTOMER_SLUG selects `.env.<slug>`; an unset slug uses `.env`.
    resolved = ensureReleaseSecrets();
  } catch (error) {
    console.error(`[dokan] release secret rejected: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (resolved.generated.length > 0) {
    console.log(`[dokan] generated ${resolved.generated.join(" and ")} into ${resolved.envFilePath} (gitignored)`);
  }
  await compileSidecar(resolved.secrets.DOKAN_BUILD_SECRET, resolved.secrets.DOKAN_AUTH_SECRET);
  console.log(
    `[dokan] sidecar compiled with a ${resolved.secrets.DOKAN_BUILD_SECRET.length}-char build secret and ${resolved.secrets.DOKAN_AUTH_SECRET.length}-char auth secret inlined`,
  );
}

if (import.meta.main) {
  await main();
}
