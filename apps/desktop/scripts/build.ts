/**
 * `bun run build` — compile the sidecar for the selected customer and run a
 * plain `tauri build` pointed at that customer's staged sidecar.
 *
 * `release.ts` performs the same preparation and then assembles the portable
 * folder or renames the installer. This wrapper exists so the package `build`
 * script cannot bypass the per-customer secret resolution, the per-customer
 * staging path or the freshness stamp (PR #117 findings 1–3).
 */

import { adoptReleaseSecrets } from "./release";
import { withCheckoutReleaseLock } from "./release-lock";
import { ensureReleaseSecrets, type ResolvedReleaseSecrets } from "./secrets";
import { compileSidecar, tauriExternalBinOverride } from "./sidecar";

async function main(): Promise<void> {
  // Cargo's target dir and the bundler output are shared by every customer,
  // so a build holds the checkout-wide release lock through bundling
  // (PR #117 re-review finding 2).
  await withCheckoutReleaseLock(runBuild);
}

async function runBuild(): Promise<void> {
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

  adoptReleaseSecrets(resolved);
  await compileSidecar(
    resolved.secrets.DOKAN_BUILD_SECRET,
    resolved.secrets.DOKAN_AUTH_SECRET,
    resolved.customerSlug,
  );

  const tauri = Bun.spawn(
    ["bunx", "tauri", "build", "--config", tauriExternalBinOverride(resolved.customerSlug)],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await tauri.exited;
  if (code !== 0) {
    console.error(`[dokan] tauri build failed with exit code ${code}`);
    process.exit(code);
  }
}

if (import.meta.main) {
  await main();
}
