/**
 * Per-customer release pipeline (ticket 15 / PR #51 findings 2 & 5, issue
 * 64; PR #117). Run via `bun run portable` (default target) or
 * `bun run installer` (see package.json).
 *
 * Flow:
 *   1. resolve BOTH per-customer secrets: an explicit environment value wins,
 *      otherwise this customer's gitignored env file (`apps/desktop/.env`, or
 *      `.env.<slug>` when DOKAN_CUSTOMER_SLUG is set), otherwise generate and
 *      persist them there. A present but weak value is fatal; a missing one is
 *      created once (see secrets.ts) — a shared default is never used.
 *   2. compile the api sidecar with both secrets inlined (--define) and write
 *      the freshness stamp build.rs checks before reusing it.
 *   3. build the requested target:
 *      - portable (default, `--portable`): `tauri build --no-bundle` (the
 *        nsis installer is NEVER produced on this path), then assemble
 *        `bundle/portable/Dokan-portable/` (folder) + `Dokan-portable.zip`
 *        (portable.mjs). The folder runs in place anywhere: data lives next
 *        to the exe under `data/` (Rust portable marker, issue 64).
 *      - installer (`--installer`): `tauri build --bundles nsis`, then
 *        rename the installer with the customer slug when DOKAN_CUSTOMER_SLUG
 *        is set (lower-case letters, digits and dashes only).
 *
 * Documented per-customer commands (issue 64):
 *   portable zip + folder (uses the customer-less `.env`):
 *     bun run --filter @dokan/desktop portable
 *   per-customer installer (uses `.env.<slug>`):
 *     DOKAN_CUSTOMER_SLUG='shop-slug' bun run --filter @dokan/desktop installer
 *   one-off override, without rewriting the file:
 *     DOKAN_AUTH_SECRET='<unique-per-shop-signing-secret (>=32 chars)>' \
 *     DOKAN_CUSTOMER_SLUG='shop-slug' bun run --filter @dokan/desktop installer
 */

import fs from "node:fs";
import path from "node:path";

import { assemblePortable } from "./portable.mjs";
import { compileSidecar } from "./sidecar";
import { ensureReleaseSecrets, type ResolvedReleaseSecrets } from "./secrets";

const BUNDLE_DIR = path.resolve("src-tauri/target/release/bundle/nsis");
/** Matches ONLY the pristine tauri NSIS artifact `Dokan_<version>_<arch>-setup.exe`
 * (arch is a single token, never an underscore) — an already slug-renamed
 * file like `Dokan_0.1.0_acme-shop_x64-setup.exe` must not be re-renamed. */
const SETUP_GLOB = /^Dokan_\d+\.\d+\.\d+_[a-zA-Z0-9]+-setup\.exe$/;

const FLAG_INSTALLER = "--installer";
const FLAG_PORTABLE = "--portable";

/** Find the pristine installer artifact among the bundle-dir entries. */
export function findInstallerName(names: string[]): string | undefined {
  return names.find((name) => SETUP_GLOB.test(name));
}

/** Sanitize an optional customer slug: `[a-z0-9][a-z0-9-]*` or undefined. */
export function customerSlug(raw: string | undefined): string | undefined {
  const slug = raw?.trim();
  if (slug === undefined || slug === "") return undefined;
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : undefined;
}

/**
 * Insert the slug into the tauri artifact name:
 * `Dokan_0.1.0_x64-setup.exe` → `Dokan_0.1.0_<slug>_x64-setup.exe`.
 */
export function renamedInstaller(fileName: string, slug: string): string {
  const secondUnderscore = fileName.indexOf("_", fileName.indexOf("_") + 1);
  return `${fileName.slice(0, secondUnderscore)}_${slug}${fileName.slice(secondUnderscore)}`;
}

/**
 * Which distribution the pipeline should produce. Portable (folder + zip) is
 * the default; `--installer` opts into the nsis installer. An explicit
 * `--portable` is accepted for symmetry (and wins over `--installer`). Any
 * OTHER flag fails loudly so a typo'd `--instaler` can never silently
 * produce the wrong deliverable.
 */
export function requestedTarget(argv: string[]): "portable" | "installer" {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const unknown = flags.filter((flag) => flag !== FLAG_INSTALLER && flag !== FLAG_PORTABLE);
  if (unknown.length > 0) {
    throw new Error(`[dokan] unknown release flag(s): ${unknown.join(", ")} — use --installer or --portable`);
  }
  if (argv.includes(FLAG_INSTALLER) && !argv.includes(FLAG_PORTABLE)) return "installer";
  return "portable";
}

/** Run a tauri CLI command, inheriting stdio, and propagate failures. */
async function runTauri(args: string[]): Promise<void> {
  const tauri = Bun.spawn(["bunx", "tauri", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await tauri.exited;
  if (code !== 0) {
    console.error(`[dokan] tauri build failed with exit code ${code}`);
    process.exit(code);
  }
}

/** nsis installer target: build the installer and apply the optional slug. */
async function buildInstaller(slug: string | undefined): Promise<void> {
  await runTauri(["build", "--bundles", "nsis"]);

  if (slug !== undefined) {
    const setupName = findInstallerName(fs.readdirSync(BUNDLE_DIR));
    if (setupName === undefined) {
      console.error(`[dokan] installer artifact not found in ${BUNDLE_DIR}`);
      process.exit(1);
    }
    const renamed = renamedInstaller(setupName, slug);
    fs.renameSync(path.join(BUNDLE_DIR, setupName), path.join(BUNDLE_DIR, renamed));
    console.log(`[dokan] installer renamed to ${renamed} (customer slug "${slug}")`);
  }
}

/**
 * Portable target (issue 64): `--no-bundle` means the nsis installer is
 * never produced; the folder + zip come from portable.mjs. Data lives next
 * to the exe at runtime (portable.marker flips the Rust shell). A stale
 * `bundle/nsis` from an earlier installer run is removed so the portable
 * output can never ship installer leftovers.
 */
async function buildPortable(): Promise<void> {
  // the portable deliverable and its trusted-tar zip are Windows-only; fail
  // BEFORE a multi-minute tauri build instead of after it with a misleading
  // “missing dokan.exe” error on POSIX (where cargo emits `dokan`)
  if (process.platform !== "win32") {
    console.error(
      "[dokan] portable packaging is only supported on Windows hosts — use the installer target elsewhere",
    );
    process.exit(1);
  }

  await runTauri(["build", "--no-bundle"]);

  const nsisDir = path.resolve("src-tauri/target/release/bundle/nsis");
  if (fs.existsSync(nsisDir)) {
    // leftover from a previous `installer` run on this tree — never ship it
    fs.rmSync(nsisDir, { recursive: true, force: true });
    console.log("[dokan] removed stale nsis bundle dir from the portable output path");
  }

  const { portableDir, zipPath } = assemblePortable();
  console.log(`[dokan] portable folder ready at ${portableDir}`);
  console.log(`[dokan] portable zip ready at ${zipPath}`);
}

/**
 * Resolve both secrets, or exit loudly. A missing value is generated into the
 * customer's gitignored env file; only a weak one is fatal.
 */
function resolveSecretsOrExit(slug: string | undefined): ResolvedReleaseSecrets {
  try {
    return ensureReleaseSecrets({ customerSlug: slug });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[dokan] release secret rejected: ${reason}`);
    console.error("[dokan] fix the value in the customer env file, or pass a strong one for this build:");
    console.error("  DOKAN_AUTH_SECRET='<32+ chars>' bun run --filter @dokan/desktop portable");
    process.exit(1);
  }
}

/**
 * Make the resolved secrets the build environment for the tauri/cargo child.
 *
 * `bun run` pre-loads the customer-less `.env` into `process.env`. On a slugged
 * build those are a DIFFERENT customer's secrets, and build.rs would compare
 * them against the stamp, decide the sidecar is stale, and rebuild it with the
 * wrong values. Adopting the resolved pair keeps the environment, the compiled
 * sidecar and the stamp in agreement (PR #117 findings 1 & 5).
 */
export function adoptReleaseSecrets(
  resolved: ResolvedReleaseSecrets,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.DOKAN_BUILD_SECRET = resolved.secrets.DOKAN_BUILD_SECRET;
  env.DOKAN_AUTH_SECRET = resolved.secrets.DOKAN_AUTH_SECRET;
}

async function main(): Promise<void> {
  const rawSlug = process.env.DOKAN_CUSTOMER_SLUG;
  const slug = customerSlug(rawSlug);
  // A typo'd slug must not silently fall back to the customer-less `.env`,
  // sharing secrets across shops (PR #117 finding 1).
  if (slug === undefined && rawSlug !== undefined && rawSlug.trim() !== "") {
    console.error(
      `[dokan] DOKAN_CUSTOMER_SLUG ${JSON.stringify(rawSlug)} is invalid — use lower-case letters, digits and dashes`,
    );
    process.exit(1);
  }

  const resolved = resolveSecretsOrExit(slug);
  if (resolved.generated.length > 0) {
    console.log(`[dokan] generated ${resolved.generated.join(" and ")} into ${resolved.envFilePath} (gitignored)`);
    console.log("[dokan] keep that file: a rebuild for the same shop needs the same values");
  }
  for (const key of ["DOKAN_BUILD_SECRET", "DOKAN_AUTH_SECRET"] as const) {
    console.log(`[dokan] ${key}: ${resolved.sources[key]}`);
  }
  adoptReleaseSecrets(resolved);

  await compileSidecar(
    resolved.secrets.DOKAN_BUILD_SECRET,
    resolved.secrets.DOKAN_AUTH_SECRET,
    resolved.customerSlug,
  );
  console.log(
    `[dokan] sidecar compiled with a ${resolved.secrets.DOKAN_BUILD_SECRET.length}-char build secret and ${resolved.secrets.DOKAN_AUTH_SECRET.length}-char auth secret inlined`,
  );

  if (requestedTarget(Bun.argv) === "installer") {
    await buildInstaller(slug);
  } else {
    if (slug !== undefined) {
      console.log(
        `[dokan] note: DOKAN_CUSTOMER_SLUG selects the per-customer secrets (.env.${slug}); the portable folder name stays customer-neutral`,
      );
    }
    await buildPortable();
  }
}

if (import.meta.main) {
  await main();
}