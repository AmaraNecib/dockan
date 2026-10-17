import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvents } from "@dokan/contracts";

/**
 * #253 — the diagnostics viewer prints the api's JSONL log. Its event BADGE is
 * translated from `logEvents`; this test keeps the api's emit sites inside that
 * vocabulary so a new event code cannot ship as a raw English badge.
 *
 * The scan reads the real source (like `cell-ltr.test.ts` and
 * `activity-tags.test.ts`). It covers the common shapes: the logger call itself
 * and the two event-carrying helpers `recordFailure(event)` /
 * `rotateSession(event)`. Events passed through a variable (e.g.
 * `finishUnlock(…, "VAULT_UNLOCKED")`) are not scanned; direction 1 below — the
 * one that catches a raw leak — still holds for every literal call site.
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

const EMIT_SITES = [
  /logger\??\.(?:info|warn|error)\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /(?:rotateSession|recordFailure)\("([A-Z][A-Z0-9_]*)"\)/g,
];

function emittedEvents(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walkTs(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of EMIT_SITES) {
      for (const match of source.matchAll(pattern)) {
        found.set(match[1]!, file.replace(srcRoot, "src/"));
      }
    }
  }
  return found;
}

describe("api log events match the shared vocabulary (#253)", () => {
  const vocabulary: readonly string[] = logEvents;

  it("reads a non-empty set of emit sites, so the scan is not vacuous", () => {
    expect(emittedEvents().size).toBeGreaterThanOrEqual(25);
  });

  it("emits no log event outside logEvents", () => {
    const offenders = [...emittedEvents()]
      .filter(([event]) => !vocabulary.includes(event))
      .map(([event, file]) => `${event} (${file})`);
    expect(offenders).toEqual([]);
  });
});
