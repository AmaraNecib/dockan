/**
 * API sidecar compile with the per-customer secrets inlined (ticket 15 / PR
 * #51 findings 2 & 5). Run via `bun run sidecar` (see package.json), and from
 * `release.ts` / `build.ts` before every release build.
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
 * Each customer's sidecar is staged in its own directory (`binaries/<slug>/`)
 * and carries a freshness stamp (customer + API-source hash + binary hash +
 * secret hashes). Two customer releases from one checkout therefore never
 * overwrite each other's binary or stamp, and `build.rs` refuses to use a
 * sidecar whose stamp does not match the binary on disk (PR #117 findings
 * 1, 2 and 5).
 */

import fs from "node:fs";
import path from "node:path";

import { acquireFileLock, ensureReleaseSecrets, type ResolvedReleaseSecrets } from "./secrets";
import { withCheckoutReleaseLock } from "./release-lock";
import { stagedSidecarPath, writeSidecarStamp } from "./sidecar-freshness";
// re-exported so callers and tests can keep importing the rules from here
export {
  MIN_AUTH_SECRET_LEN,
  MIN_BUILD_SECRET_LEN,
  validateAuthSecret,
  validateBuildSecret,
} from "./secret-rules";
export type { SecretValidation } from "./secret-rules";

/** Repository root; cwd is apps/desktop under `bun run`. */
const REPO_ROOT = path.resolve("../..");

/** Tauri appends the target triple to `bundle.externalBin` entries. */
const SIDECAR_STEM = "dokan-api";
const SIDECAR_TRIPLE = "x86_64-pc-windows-msvc";

/** Directory this customer's sidecar is staged in. */
export function sidecarStageDir(customerSlug: string | undefined): string {
  return customerSlug === undefined
    ? path.resolve("src-tauri/binaries")
    : path.resolve("src-tauri/binaries", customerSlug);
}

/** `bun build --outfile` value (without the executable suffix bun appends). */
export function sidecarOutfile(customerSlug: string | undefined): string {
  return path.join(sidecarStageDir(customerSlug), `${SIDECAR_STEM}-${SIDECAR_TRIPLE}`);
}

/** `bundle.externalBin` entry for this customer, relative to `src-tauri`. */
export function sidecarExternalBin(customerSlug: string | undefined): string {
  const folder = customerSlug === undefined ? "" : `${customerSlug}/`;
  return `binaries/${folder}${SIDECAR_STEM}`;
}

/**
 * `tauri build --config` override pointing the bundler at this customer's
 * staged sidecar. Without it the bundler would fall back to the shared
 * `binaries/dokan-api` path, where another customer's binary could sit.
 */
export function tauriExternalBinOverride(customerSlug: string | undefined): string {
  return JSON.stringify({ bundle: { externalBin: [sidecarExternalBin(customerSlug)] } });
}

/**
 * Compile the sidecar with both secrets inlined via `bun build --define`.
 * cwd is the package root (apps/desktop) when invoked through `bun run`.
 *
 * The per-customer lock serializes the binary write and the stamp write for
 * the same customer, so a reader can never see a torn binary/stamp pair.
 */
export async function compileSidecar(
  buildSecret: string,
  authSecret: string,
  customerSlug: string | undefined,
): Promise<void> {
  const outfile = sidecarOutfile(customerSlug);
  const staged = stagedSidecarPath(outfile);
  // Refresh the per-customer lock while compiling: a slow compile must not be
  // stolen as stale by a second same-customer compile (PR #117 re-review
  // finding 4).
  const release = acquireFileLock(`${staged}.lock`, { refreshMs: 30_000 });
  try {
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
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
    writeSidecarStamp(REPO_ROOT, staged, customerSlug, buildSecret, authSecret);
  } finally {
    release();
  }
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
  // Standalone staging takes the checkout-wide release lock too: it must not
  // restage a customer between build.rs validating the stamp and the bundler
  // copying the binary (PR #117 re-review finding 6).
  await withCheckoutReleaseLock(async () => {
    await compileSidecar(
      resolved.secrets.DOKAN_BUILD_SECRET,
      resolved.secrets.DOKAN_AUTH_SECRET,
      resolved.customerSlug,
    );
  });
  console.log(
    `[dokan] sidecar compiled with a ${resolved.secrets.DOKAN_BUILD_SECRET.length}-char build secret and ${resolved.secrets.DOKAN_AUTH_SECRET.length}-char auth secret inlined`,
  );
}

if (import.meta.main) {
  await main();
}
