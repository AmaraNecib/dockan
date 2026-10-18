// #244 round 4 — the failing-first probe for findings 1-3, and (round 5) the
// probe-harness fix for Greptile finding 2.
//
// Run from anywhere:
//   bun run .scratch/reviews/244/round4-before-probe.ts
//
// It extracts the PRE-FIX scanner with `git show <sha>:…` into a PRIVATE temp
// directory, imports it from there, and prints each shape's result on the
// round-3 scanner (1af565f), the round-4 scanner (ef32177) and the working tree.
// It NEVER writes the scanner file, so an uncommitted scanner edit cannot be
// lost — it hashes the real file before and after and exits 1 if the bytes
// changed at all.
//
// `ROUND4_PROBE_TARGET` overrides the file that is hashed and imported, so
// `probe-safety-demo.sh` can add a marker edit to a COPY and prove the probe
// leaves it byte-identical without touching the worktree.
//
// The round-4 version of this file printed reproduction steps that overwrote the
// scanner and restored it with `git checkout --`, which destroys uncommitted
// edits. That is the third variant of one lesson in this PR's history (the round-3
// mutation proof did it, and a lane did it to itself with a dropped restore in
// round 4), so the fix is structural: the target is read-only here, not "handled
// carefully".
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url)); // .scratch/reviews/244/
const repoRoot = join(here, "..", "..", "..");
const PROBE_FILE = "apps/web/src/tests/blankness-gates.ts";
const target = process.env.ROUND4_PROBE_TARGET ?? join(repoRoot, PROBE_FILE);
const PRE_FIX_SHA = "1af565f"; // round 3 head: flat backticks, no frame stack
const REGRESSED_SHA = "ef32177"; // round 4 head: `${}` frames, JSX read as code

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const before = digest(target);

const cases: Array<[string, string]> = [
  [
    "appended draft escapes (round 4 finding 1)",
    [
      "export function f(prefix: string, draft: string) {",
      "  const trimmed = normalizeArabicIndicDigits(prefix).concat(draft).trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n"),
  ],
  [
    "block comment joins tokens (round 4 finding 2)",
    ["export function f(draft: string) {", "  const/* note */trimmed = draft.trim();", '  if (trimmed === "") return null;', "  return trimmed;", "}"].join("\n"),
  ],
  [
    "nested template mis-scopes (round 4 finding 3)",
    ["export function f(draft: string, flag: boolean) {", "  const trimmed = `${flag ? `;` : draft}`.trim();", '  if (trimmed === "") return null;', "  return trimmed;", "}"].join("\n"),
  ],
  [
    "JSX child text `)` discarded (round 5 finding 1)",
    ["export function f(flag: boolean, draft: string) {", "  const trimmed = `${flag ? <span>)</span> : draft}`.trim();", '  if (trimmed === "") return null;', "  return trimmed;", "}"].join("\n"),
  ],
  [
    "JSX child text `]` discarded (round 5 finding 1)",
    ["export function f(flag: boolean, draft: string) {", "  const trimmed = `${flag ? <span>]</span> : draft}`.trim();", '  if (trimmed === "") return null;', "  return trimmed;", "}"].join("\n"),
  ],
];

const dir = mkdtempSync(join(tmpdir(), "round4-before-probe-"));
try {
  const extract = (sha: string, name: string) => {
    const path = join(dir, name);
    writeFileSync(path, execFileSync("git", ["-C", repoRoot, "show", `${sha}:${PROBE_FILE}`]));
    return path;
  };
  const { findBlanknessGates: findFixed } = await import(pathToFileURL(target).href);
  const { findBlanknessGates: findPreFix } = await import(pathToFileURL(extract(PRE_FIX_SHA, "pre-fix.ts")).href);
  const { findBlanknessGates: findRegressed } = await import(pathToFileURL(extract(REGRESSED_SHA, "regressed.ts")).href);

  const verdict = (gates: string[]) => (gates.length === 0 ? "[] (ESCAPES)" : "caught");
  console.log(`${"shape".padEnd(46)} ${"round-3".padEnd(13)} ${"round-4".padEnd(13)} fixed`);
  for (const [name, source] of cases) {
    const preFix = findPreFix(source, "s.tsx").map((gate) => gate.signature);
    const regressed = findRegressed(source, "s.tsx").map((gate) => gate.signature);
    const fixed = findFixed(source, "s.tsx").map((gate) => gate.signature);
    console.log(
      `${name.padEnd(46)} ${verdict(preFix).padEnd(13)} ${verdict(regressed).padEnd(13)} ${verdict(fixed)}`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const after = digest(target);
if (after !== before) {
  console.error(`FAIL: ${target} changed during the probe (${before} -> ${after})`);
  process.exit(1);
}
console.log(`\ntarget untouched: ${target} is byte-identical (sha256 ${before})`);
