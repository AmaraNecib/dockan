#!/usr/bin/env bun
// Decide which Playwright specs a diff needs.
//
// Three outcomes:
//   full     — run the whole suite. Any critical path, or any path the map
//              does not know. This is the fail-closed default.
//   affected — run only the mapped specs.
//   skip     — nothing in the diff can reach a browser.
//
// The point of this file is that no model and no human "judges" a diff. The
// diff is an input; the map is a checked-in artifact; a missing map entry
// costs minutes, never coverage.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAP_PATH = join(HERE, "..", "tests", "e2e-selection.map.json");

export type Scope =
  | { mode: "full"; specs: string[]; reason: string }
  | { mode: "affected"; specs: string[]; reason: string }
  | { mode: "skip"; specs: string[]; reason: string };

type FeatureRule = { $comment?: string; match: string[]; specs: string[] };

export type SelectionMap = {
  always_full: string[];
  skip_e2e: string[];
  features: FeatureRule[];
};

// `**`, `*` and `?` only. Deliberately not a glob library: the patterns above
// are written by hand and a dependency-free matcher is the one that cannot
// change behaviour under a lockfile bump. The two private-use sentinels stand
// in for the `**/` and `**` cases between escaping and the single-character
// replacements, so a later `*` cannot rewrite them.
export function globToRegExp(pattern: string): RegExp {
  const out = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\uE000")
    .replace(/\*\*/g, "\uE001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\uE000/g, "(?:.*/)?")
    .replace(/\uE001/g, ".*");
  return new RegExp(`^${out}$`);
}

// `$comment` entries document a block without becoming a glob that can never
// match (and would otherwise fail the "every pattern still matches" guard).
const commented = (patterns: string[]) => patterns.filter((p) => !p.startsWith("$comment"));

export function loadMap(path = MAP_PATH): SelectionMap {
  // SAFETY: the map is a checked-in artifact and the next lines validate the
  // shape selectSpecs reads; a mismatch throws rather than classifying a path
  // as mapped.
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SelectionMap>;
  const wellFormed =
    Array.isArray(parsed.always_full) &&
    Array.isArray(parsed.skip_e2e) &&
    Array.isArray(parsed.features) &&
    // An empty `match` or `specs` is the fail-open shape: the file counts as a
    // feature hit and picks nothing, which selectSpecs turns into `skip`.
    parsed.features.every(
      (feature) =>
        Array.isArray(feature.match) &&
        feature.match.length > 0 &&
        Array.isArray(feature.specs) &&
        feature.specs.length > 0,
    );
  if (!wellFormed) {
    throw new Error(
      `e2e-selection map at ${path} must have always_full, skip_e2e and non-empty features arrays`,
    );
  }
  // SAFETY: the arrays checked above are the whole shape selectSpecs reads.
  return parsed as SelectionMap;
}

export function selectSpecs(changed: string[], map: SelectionMap = loadMap()): Scope {
  const full = commented(map.always_full).map(globToRegExp);
  const skip = commented(map.skip_e2e).map(globToRegExp);
  const features = map.features.map((f) => ({ match: f.match.map(globToRegExp), specs: f.specs }));

  const files = changed.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) return { mode: "full", specs: [], reason: "empty diff — cannot prove the change is inert" };

  const picked = new Set<string>();

  for (const file of files) {
    // 1. Critical path wins over everything. Checked first so a `skip_e2e`
    //    pattern can never swallow a shared module.
    const critical = full.find((re) => re.test(file));
    if (critical) return { mode: "full", specs: [], reason: `critical path: ${file}` };

    // 2. A feature rule beats a skip rule: `apps/web/src/pages/items.test.tsx`
    //    must not be skipped just because `**/*.test.tsx` matched it first.
    const hit = features.find((f) => f.match.some((re) => re.test(file)));
    if (hit) {
      for (const s of hit.specs) picked.add(s);
      continue;
    }

    // 3. Explicitly inert.
    if (skip.some((re) => re.test(file))) continue;

    // 4. Unknown path: fail closed. This is the whole safety argument —
    //    an unmaintained map degrades to expensive, never to unguarded.
    return { mode: "full", specs: [], reason: `unmapped path: ${file}` };
  }

  const specs = [...picked].sort();
  if (specs.length === 0) return { mode: "skip", specs: [], reason: "no browser-reachable path changed" };
  return { mode: "affected", specs, reason: `${specs.length} spec(s) mapped from ${files.length} file(s)` };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: bun scripts/e2e-selection.ts <changed-files.txt>");
    process.exit(2);
  }
  const scope = selectSpecs(readFileSync(file, "utf8").split("\n"));
  // `specs` is emitted as space-separated `tests/e2e/<name>` paths for the
  // Playwright CLI; empty for full and skip.
  const specs = scope.mode === "affected" ? scope.specs.map((s) => `tests/e2e/${s}`) : [];
  for (const [k, v] of [["mode", scope.mode], ["specs", specs.join(" ")], ["reason", scope.reason]]) {
    console.log(`${k}=${v}`);
  }
}
