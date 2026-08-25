/**
 * Per-customer release pipeline (ticket 15 / PR #51 finding 2). Run via
 * `bun run portable` (see package.json).
 *
 * Flow:
 *   1. validate DOKAN_BUILD_SECRET (>= 16 chars) — fail loudly, never ship
 *      a default or a weak secret
 *   2. compile the api sidecar with the secret inlined (--define)
 *   3. `tauri build --bundles nsis`
 *   4. rename the installer with the customer slug when DOKAN_CUSTOMER_SLUG
 *      is set (lower-case letters, digits and dashes only)
 *
 * Documented per-customer release command:
 *   DOKAN_BUILD_SECRET='<unique-per-shop-secret>' \
 *   DOKAN_CUSTOMER_SLUG='shop-slug' \
 *   bun run --filter @dokan/desktop portable
 */

import fs from "node:fs";
import path from "node:path";

import { compileSidecar, validateBuildSecret } from "./sidecar";

const BUNDLE_DIR = path.resolve("src-tauri/target/release/bundle/nsis");
/** Matches ONLY the pristine tauri NSIS artifact `Dokan_<version>_<arch>-setup.exe`
 * (arch is a single token, never an underscore) — an already slug-renamed
 * file like `Dokan_0.1.0_acme-shop_x64-setup.exe` must not be re-renamed. */
const SETUP_GLOB = /^Dokan_\d+\.\d+\.\d+_[a-zA-Z0-9]+-setup\.exe$/;

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

async function main(): Promise<void> {
  const secret = validateBuildSecret();
  if (!secret.ok) {
    console.error(`[dokan] build secret rejected: ${secret.reason}`);
    console.error("[dokan] set a unique per-customer secret, e.g.:");
    console.error("  DOKAN_BUILD_SECRET='<unique-per-shop-secret>' bun run --filter @dokan/desktop portable");
    process.exit(1);
  }

  const slug = customerSlug(process.env.DOKAN_CUSTOMER_SLUG);

  await compileSidecar(secret.secret);
  console.log(`[dokan] sidecar compiled with a ${secret.secret.length}-char per-customer secret inlined`);

  const tauri = Bun.spawn(["bunx", "tauri", "build", "--bundles", "nsis"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await tauri.exited;
  if (code !== 0) {
    console.error(`[dokan] tauri build failed with exit code ${code}`);
    process.exit(code);
  }

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

if (import.meta.main) {
  await main();
}