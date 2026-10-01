/**
 * `bun run desktop:secrets` — create the release secrets if they are missing
 * and report where each one came from. `--show` also prints the values, for
 * the moment you copy them into your per-customer records. `--customer <slug>`
 * selects that customer's `.env.<slug>` instead of the customer-less `.env`
 * (PR #117 finding 1), or set `DOKAN_CUSTOMER_SLUG` in the environment.
 *
 * The values themselves live in the gitignored env files; edit the right file
 * to change one. Nothing here is ever committed, logged at build time, or
 * passed to the running app.
 */

import { ensureReleaseSecrets, type ResolvedReleaseSecrets } from "./secrets";

const KEYS = ["DOKAN_BUILD_SECRET", "DOKAN_AUTH_SECRET"] as const;

function customerArg(argv: string[]): string | undefined {
  const index = argv.indexOf("--customer");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--customer needs a slug, e.g. `bun run desktop:secrets --customer acme`");
  }
  return value;
}

function main(): void {
  const customer = customerArg(Bun.argv);
  const resolved: ResolvedReleaseSecrets = ensureReleaseSecrets(
    customer === undefined ? {} : { customerSlug: customer },
  );

  console.log(`[dokan] release secrets file: ${resolved.envFilePath}`);
  for (const key of KEYS) {
    console.log(`[dokan]   ${key}: ${resolved.sources[key]}`);
  }
  if (resolved.generated.length > 0) {
    console.log(`[dokan] generated ${resolved.generated.join(" and ")} — this file is gitignored`);
  }
  if (Bun.argv.includes("--show")) {
    for (const key of KEYS) {
      console.log(`[dokan]   ${key}=${resolved.secrets[key]}`);
    }
  } else {
    console.log("[dokan] pass --show to print the values");
  }
}

try {
  main();
} catch (error) {
  console.error(`[dokan] release secrets failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
