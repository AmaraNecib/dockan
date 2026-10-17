import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared source scan for the source-level guards (`lib/cell-ltr.test.ts`,
 * `lib/select-trigger-label.test.ts`). Extracted when the second guard needed
 * the same walk, so the two cannot disagree about which files a guard covers.
 */

/** Every non-test `.tsx` file under `dir`, recursively. A `.test.tsx` is a
 * fixture, not shipped source: a guard must not red-team itself. */
export function walkTsx(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walkTsx(path));
      continue;
    }
    if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) files.push(path);
  }
  return files;
}
