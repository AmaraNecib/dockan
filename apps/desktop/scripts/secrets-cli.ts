/**
 * `bun run desktop:secrets` — create the release secrets if they are missing and
 * report where each one came from. `--show` also prints the values, for the
 * moment you copy them into your per-customer records.
 *
 * The values themselves live in the gitignored `apps/desktop/.env`; edit that
 * file to change one. Nothing here is ever committed, logged at build time, or
 * passed to the running app.
 */

import { ensureReleaseSecrets, RELEASE_ENV_PATH } from "./secrets";

const KEYS = ["DOKAN_BUILD_SECRET", "DOKAN_AUTH_SECRET"] as const;
const show = Bun.argv.includes("--show");

const resolved = ensureReleaseSecrets();

console.log(`[dokan] release secrets file: ${RELEASE_ENV_PATH}`);
for (const key of KEYS) {
  console.log(`[dokan]   ${key}: ${resolved.sources[key]}`);
}
if (resolved.generated.length > 0) {
  console.log(`[dokan] generated ${resolved.generated.join(" and ")} — this file is gitignored`);
}
if (show) {
  for (const key of KEYS) {
    console.log(`[dokan]   ${key}=${resolved.secrets[key]}`);
  }
} else {
  console.log("[dokan] pass --show to print the values");
}
