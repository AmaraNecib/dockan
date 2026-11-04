import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXPECTED_CONTRACT_SOURCES = [
  "packages/contracts/src/app-contract.ts",
  "packages/contracts/src/app-host.ts",
  "packages/contracts/src/arabic-search.ts",
  "packages/contracts/src/core.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/phone.ts",
  "packages/contracts/src/return-refund.ts",
] as const;

export function missingContractSources(root: string): string[] {
  const absoluteRoot = resolve(root);
  const indexedModes = new Map<string, string>();
  for (const entry of execFileSync(
    "git",
    ["ls-files", "--cached", "--stage", "-z", "--", ...EXPECTED_CONTRACT_SOURCES],
    { cwd: absoluteRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\0")
    .filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator < 0) continue;
    const [mode, , stage] = entry.slice(0, separator).split(" ");
    if (stage === "0") indexedModes.set(entry.slice(separator + 1), mode ?? "");
  }

  return EXPECTED_CONTRACT_SOURCES.filter((source) => {
    const mode = indexedModes.get(source);
    if (mode !== "100644" && mode !== "100755") return true;
    try {
      const stats = lstatSync(join(absoluteRoot, source));
      return !stats.isFile() || stats.isSymbolicLink();
    } catch (error) {
      // SAFETY: fs.statSync throws Node filesystem errors with a `code` field.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return true;
      throw error;
    }
  });
}

function main(root: string): number {
  let missing: string[];
  try {
    missing = missingContractSources(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pre-commit: could not verify packages/contracts/src: ${message}`);
    return 1;
  }

  if (missing.length === 0) return 0;
  console.error(
    `pre-commit: missing expected contract source(s) from a regular Git index entry or regular worktree file: ${missing.join(", ")}. Restore them from Git and stage the required paths before committing.`,
  );
  return 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv[2] ?? process.cwd());
}
