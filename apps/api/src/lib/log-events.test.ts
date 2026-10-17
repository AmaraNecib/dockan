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

/**
 * The literal event codes the api passes to a log-writing call. `finishUnlock`
 * is included because it takes the code as a parameter
 * (`finishUnlock(core, masterKey, "VAULT_RECOVERY_UNLOCKED")`) and the
 * logger call inside it uses the parameter, so the scan cannot see the
 * literal without matching the caller (#253 round 2).
 */
const EMIT_SITES = [
  /logger\??\.(?:info|warn|error)\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /(?:rotateSession|recordFailure)\("([A-Z][A-Z0-9_]*)"\)/g,
  /finishUnlock\([^)]*?"([A-Z][A-Z0-9_]*)"\)/g,
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

  /**
   * The web's `logMessageCopy` maps `event::message` exactly. If the api rewords
   * a startup sentence the web silently falls back to raw English while the web
   * test (which re-hardcodes the same pair) stays green. Pin the pairs the web
   * translates against the real api literals.
   */
  const TRANSLATED_STARTUP_MESSAGES: [string, string][] = [
    ["FIRST_TIME_SETUP", "owner account created"],
    ["VAULT_CREATED", "vault created and unlocked"],
    ["VAULT_SETUP_DONE", "vault created; recovery key shown once"],
    ["SERVER_BOOT_DONE", "database and auth ready"],
    ["SERVER_BOOT_DONE", "vault store and auth ready"],
    ["SERVER_STARTED", "Dokan API booted"],
    ["VAULT_PASSPHRASE_CHANGED", "vault passphrase changed"],
    ["VAULT_PASSPHRASE_RESET", "vault passphrase set from a recovery key"],
  ];

  it("still logs the exact startup sentences the web translates", () => {
    const sources = walkTs(srcRoot).map((file) => readFileSync(file, "utf8")).join("\n");
    const missing = TRANSLATED_STARTUP_MESSAGES
      .filter(([event, message]) => !sources.includes(`"${event}", "${message}"`))
      .map(([event, message]) => `${event}: ${message}`);
    expect(missing).toEqual([]);
  });
});
