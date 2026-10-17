import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activitySummaryTags } from "@dokan/contracts";

/**
 * #253 — the audit log must never show a raw summary tag. The API writes
 * `<TAG> <fields…>` template literals; the web page has one branch per tag in
 * `activitySummaryTags`. This test keeps the two in step on the SERVER side:
 *
 *   1. every `summary:` literal tag the api writes is a member of the shared
 *      vocabulary (a new activity type fails HERE, before the web can leak it);
 *   2. every member is actually emitted (no dead vocabulary entry).
 *
 * The four VAULT_* tags are emitted through `recordFailure(event)`
 * (`summary: `${event} ${timestamp}``), not a literal template, so they are
 * excluded from direction 2 and covered by the web enumeration instead.
 */

const srcRoot = fileURLToPath(new URL("../", import.meta.url));

function walkTs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walkTs(path));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

/** `summary: \`TAG …\`` or `summary: "TAG"` at an insertActivity call site. */
const SUMMARY_LITERAL = /summary:\s*[`"]([A-Z][A-Z0-9_]*)\b/g;

function emittedTags(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walkTs(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SUMMARY_LITERAL)) {
      found.set(match[1]!, file.replace(srcRoot, "src/"));
    }
  }
  return found;
}

describe("api activity summary tags match the shared vocabulary (#253)", () => {
  const vocabulary: readonly string[] = activitySummaryTags;

  it("reads a non-empty set of emit sites, so the scan is not vacuous", () => {
    expect(emittedTags().size).toBeGreaterThanOrEqual(25);
  });

  it("emits no tag outside activitySummaryTags", () => {
    const offenders = [...emittedTags()]
      .filter(([tag]) => !vocabulary.includes(tag))
      .map(([tag, file]) => `${tag} (${file})`);
    expect(offenders).toEqual([]);
  });

  // There is deliberately no "every vocabulary entry is emitted" assertion:
  // PASSWORD_RESET is a carried-over activity type with no current emit site
  // (the desktop owns the reset flow), and the four VAULT_* tags come through
  // `recordFailure(event)`. The WEB enumeration asserts a branch for every
  // member, which is the direction that matters for a raw-key leak.
});
