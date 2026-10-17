/**
 * #252 rebase gate — the five bullets from the brief, asserted on whatever tree
 * this file finds itself in. Run it BEFORE the rebase (on c67c641) and AFTER, so
 * the same script is the invariant that must survive the conflict resolution.
 *
 *   bun run .scratch/reviews/252/rebase-verify-direction-labels.ts
 *
 * Exit 0 = every bullet holds. Exit 1 = at least one broke (each is printed).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `.pathname`. `pathname` leaves percent-encoding in place, so a checkout under
// a path with a space or a non-ASCII character yields `...%20...` and the readFileSync calls below
// throw before a single check runs. `fileURLToPath` decodes properly and is the supported API.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB = join(ROOT, "apps/web/src");
const API = join(ROOT, "apps/api/src");
const CONTRACTS = join(ROOT, "packages/contracts/src");

const WE_OWE_WORD = "يسالنا"; // he asks us   -> we owe him
const THEY_OWE_WORD = "نسالوه"; // we ask him  -> he owes us
const WE_OWE_HINT_GLOSS = "نحن ندين له"; // "we owe him"
const THEY_OWE_HINT_GLOSS = "هو يدين لنا"; // "he owes us"

const results: string[] = [];
let failed = 0;

function check(bullet: string, ok: boolean, detail: string): void {
  if (!ok) failed += 1;
  results.push(`${ok ? "PASS" : "FAIL"}  ${bullet}\n        ${detail}`);
}

const read = (p: string): string => readFileSync(p, "utf8");

/** Every .ts/.tsx under a dir, excluding tests and generated output. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The line that assigns an i18n key, with its quoted value. */
function i18nLine(source: string, key: string): { line: number; value: string } | null {
  const lines = source.split("\n");
  const index = lines.findIndex((l) => new RegExp(`\\b${key}:`).test(l));
  if (index === -1) return null;
  const match = /:\s*"([^"]*)"/.exec(lines[index]);
  return { line: index + 1, value: match ? match[1] : "" };
}

const i18n = read(join(WEB, "lib/i18n.ts"));

// ── bullet 1 & 2 — the two literals, on the right values ─────────────────────
const weOwe = i18nLine(i18n, "supplierAdjustDirectionWeOwe");
const theyOwe = i18nLine(i18n, "supplierAdjustDirectionTheyOwe");
check(
  "1. supplierAdjustDirectionWeOwe === «يسالنا»",
  weOwe?.value === WE_OWE_WORD,
  `apps/web/src/lib/i18n.ts:${weOwe?.line} = ${JSON.stringify(weOwe?.value)}`,
);
check(
  "2. supplierAdjustDirectionTheyOwe === «نسالوه»",
  theyOwe?.value === THEY_OWE_WORD,
  `apps/web/src/lib/i18n.ts:${theyOwe?.line} = ${JSON.stringify(theyOwe?.value)}`,
);

// ── bullet 3 — each label sits beside a hint that agrees with it ─────────────
const weOweHint = i18nLine(i18n, "supplierAdjustDirectionWeOweHint");
const theyOweHint = i18nLine(i18n, "supplierAdjustDirectionTheyOweHint");
const weOweAdjacent = weOweHint !== null && weOwe !== null && Math.abs(weOweHint.line - weOwe.line) <= 2;
const theyOweAdjacent = theyOweHint !== null && theyOwe !== null && Math.abs(theyOweHint.line - theyOwe.line) <= 2;
check(
  "3a. the WE_OWE hint sits beside its label and agrees («نحن ندين له»)",
  weOweHint !== null && weOweHint.value.includes(WE_OWE_HINT_GLOSS) && weOweAdjacent,
  `i18n.ts:${weOweHint?.line} = ${JSON.stringify(weOweHint?.value)} (label at ${weOwe?.line})`,
);
check(
  "3b. the THEY_OWE hint sits beside its label and agrees («هو يدين لنا»)",
  theyOweHint !== null && theyOweHint.value.includes(THEY_OWE_HINT_GLOSS) && theyOweAdjacent,
  `i18n.ts:${theyOweHint?.line} = ${JSON.stringify(theyOweHint?.value)} (label at ${theyOwe?.line})`,
);

// ── bullet 4 — the contract gloss + the refusal text use the labels' words ───
const core = read(join(CONTRACTS, "core.ts"));
const coreLines = core.split("\n");
const wrongGloss: string[] = [];
coreLines.forEach((line, i) => {
  const hasWe = line.includes("WE_OWE");
  const hasThey = line.includes("THEY_OWE");
  const hasWeWord = line.includes(WE_OWE_WORD);
  const hasTheyWord = line.includes(THEY_OWE_WORD);
  if (!hasWe && !hasThey) return;
  if (hasWe && hasThey) return; // a line naming both values ("the two words")
  if (hasWe && hasTheyWord) wrongGloss.push(`core.ts:${i + 1} ${line.trim()}`);
  if (hasThey && hasWeWord) wrongGloss.push(`core.ts:${i + 1} ${line.trim()}`);
});
check(
  "4a. every core.ts gloss pairs WE_OWE<->«يسالنا» and THEY_OWE<->«نسالوه»",
  wrongGloss.length === 0,
  wrongGloss.length === 0 ? `${coreLines.filter((l) => l.includes("WE_OWE") || l.includes("THEY_OWE")).length} WE_OWE/THEY_OWE lines scanned, 0 crossed` : wrongGloss.join(" | "),
);
const refusal = /message:\s*"(a linked adjustment[^"]*)"/.exec(core);
const refusalGuard = /value\.direction !== "THEY_OWE"/.test(core);
const refusalNames = refusal === null ? [] : [WE_OWE_WORD, THEY_OWE_WORD].filter((w) => refusal[1].includes(w));
check(
  "4b. the linked-reduction refusal names the word its own guard requires",
  refusalGuard && refusalNames.length === 1 && refusalNames[0] === THEY_OWE_WORD,
  `guard requires THEY_OWE (${refusalGuard}); refusal ${JSON.stringify(refusal?.[1])} names ${JSON.stringify(refusalNames)}`,
);

// ── bullet 5 — supplierDirectionKey() is the ONE map ────────────────────────
const display = read(join(WEB, "lib/supplier-entry-display.ts"));
const oneMap =
  /function supplierDirectionKey\(direction: SupplierAdjustmentDirection\): DirectionLabelKey \{/.test(display) &&
  /direction === "THEY_OWE" \? "supplierAdjustDirectionTheyOwe" : "supplierAdjustDirectionWeOwe"/.test(display);
const reDerived: string[] = [];
// The pairing literal, counted as OCCURRENCES across the tree — two maps in one
// file is the same drift as two maps in two files (ablation A proved that a
// per-file count misses it).
const PAIRING = /supplierAdjustDirectionTheyOwe"\s*:\s*"supplierAdjustDirectionWeOwe"/g;
let mapLiterals = 0;
const mapLiteralFiles: string[] = [];
for (const file of [...sources(WEB), ...sources(API)]) {
  const rel = file.slice(ROOT.length).split("\\").join("/");
  const text = read(file);
  const hits = [...text.matchAll(PAIRING)].length;
  if (hits > 0) {
    mapLiterals += hits;
    mapLiteralFiles.push(`${rel} x${hits}`);
  }
  if (rel === "apps/web/src/lib/i18n.ts" || rel === "apps/web/src/lib/supplier-entry-display.ts") continue;
  if (/supplierAdjustDirection(We|They)Owe\b/.test(text)) reDerived.push(rel);
}
check(
  "5. supplierDirectionKey() is the one label map; no surface re-derives the pairing",
  oneMap && reDerived.length === 0 && mapLiterals === 1,
  `map at apps/web/src/lib/supplier-entry-display.ts present=${oneMap}; label-pairing occurrences in the tree: ${mapLiterals} in ${JSON.stringify(mapLiteralFiles)} (must be exactly 1); label-key literals outside the map: ${reDerived.length === 0 ? "none" : reDerived.join(", ")}`,
);

console.log(results.join("\n"));
console.log(`\n${failed === 0 ? "ALL BULLETS HOLD" : `${failed} BULLET(S) BROKEN`}`);
process.exit(failed === 0 ? 0 : 1);
