/**
 * #252 ablation proof, run against the FINAL HEAD.
 *
 * For each mutation it patches one production file, runs the named test files,
 * and records whether they redden. It is a GATE, not just a log: it exits non-zero
 * if a mutation does not redden, if an anchor is missing, or if a file is not
 * restored. A `try/finally` restores the file even when the test spawn throws, and
 * every mutated file is compared to a pre-mutation sha256 at the end.
 *
 * The gate refuses to score a mutation on an unhealthy test run (PR #267 round 4,
 * findings #252-1 and #252-2):
 *
 *   1. A GREEN BASELINE runs first — every named suite, unmutated. A red or
 *      crashed baseline stops the script before the first mutation, because no
 *      mutation result means anything while the suites are unhealthy.
 *   2. A NON-ZERO EXIT WITH NO NAMED "(fail)" LINE is a problem, not a catch: a
 *      suite that cannot load its dependencies never ran an assertion, so it
 *      cannot stand as evidence that the mutation was caught.
 *
 * Run:   bun .scratch/reviews/252/mutation-proof.ts            (cwd = repo root)
 * Drill: MUTATION_PROOF_DRILL=1 bun .scratch/reviews/252/mutation-proof.ts
 *        appends two deliberately bad mutations (a crash, and a change no chosen
 *        suite asserts) and must exit 1 naming D1 and D2. That is the proof the
 *        gate bites.
 *
 * Verdict logic + its regression tests: mutation-proof-gate.ts,
 * mutation-proof-gate.test.ts (same directory).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { gateProblem, runSuites } from "./mutation-proof-gate";

const WEB = "apps/web";
const API = "apps/api";

interface Mutation {
  readonly id: string;
  /** repo-relative file to patch */
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  /** cwd the test command runs in */
  readonly cwd: string;
  /** test file args, relative to `cwd` */
  readonly tests: readonly string[];
  /** what the mutation is */
  readonly what: string;
  /** drill-only entries: their suites are deliberately broken, so keep them out of the baseline */
  readonly excludeFromBaseline?: boolean;
}

const MUTATIONS: readonly Mutation[] = [
  {
    id: "M1",
    what: "swap the two i18n label values back (the original #252 bug)",
    file: `${WEB}/src/lib/i18n.ts`,
    find: `      supplierAdjustDirectionWeOwe: "يسالنا",\n      supplierAdjustDirectionTheyOwe: "نسالوه",`,
    replace: `      supplierAdjustDirectionWeOwe: "نسالوه",\n      supplierAdjustDirectionTheyOwe: "يسالنا",`,
    cwd: WEB,
    tests: [
      "src/lib/supplier-entry-display.test.ts",
      "src/pages/debts.test.tsx",
      "src/pages/supplier-opening-balance.test.tsx",
      "src/components/parties/supplier-adjust-panel.test.tsx",
    ],
  },
  {
    id: "M2",
    what: "swap the two hints instead of the labels (a fake fix)",
    file: `${WEB}/src/lib/i18n.ts`,
    find: `supplierAdjustDirectionWeOweHint: "نحن ندين له — يزيد ما علينا"`,
    replace: `supplierAdjustDirectionWeOweHint: "هو يدين لنا — ينقص ما علينا"`,
    cwd: WEB,
    tests: ["src/lib/supplier-entry-display.test.ts"],
  },
  {
    id: "M3",
    what: "drop items={directionItems} from the typed-row direction Select",
    file: `${WEB}/src/pages/supplier-opening-balance.tsx`,
    find: `<Select items={directionItems} value={typedRow.direction} onValueChange={(next) => setTypedRow(typedRow.id, { direction: asDirection(next) })}>`,
    replace: `<Select value={typedRow.direction} onValueChange={(next) => setTypedRow(typedRow.id, { direction: asDirection(next) })}>`,
    cwd: WEB,
    tests: ["src/pages/supplier-opening-balance.test.tsx", "src/lib/select-trigger-label.test.ts"],
  },
  {
    id: "M4",
    what: "drop the items map from the linked-invoice Select in the adjust panel",
    file: `${WEB}/src/components/parties/supplier-adjust-panel.tsx`,
    find: ` items={openInvoices.map((invoice) => ({ value: invoice.id, label: invoice.invoiceNumber }))}`,
    replace: ``,
    cwd: WEB,
    tests: ["src/components/parties/supplier-adjust-panel.test.tsx", "src/lib/select-trigger-label.test.ts"],
  },
  {
    id: "M5",
    what: "reverse the shared direction→label map",
    file: `${WEB}/src/lib/supplier-entry-display.ts`,
    find: `  return direction === "THEY_OWE" ? "supplierAdjustDirectionTheyOwe" : "supplierAdjustDirectionWeOwe";`,
    replace: `  return direction === "THEY_OWE" ? "supplierAdjustDirectionWeOwe" : "supplierAdjustDirectionTheyOwe";`,
    cwd: WEB,
    tests: ["src/lib/supplier-entry-display.test.ts"],
  },
  {
    id: "M6",
    what: "neuter the guard's items check (does the guard bite?)",
    file: `${WEB}/src/lib/select-trigger-label.test.ts`,
    find: `rendersSelectValue(node) && !isUsableMap(itemsExpression(node.openingElement), emptyBindings)`,
    replace: `rendersSelectValue(node) && false`,
    cwd: WEB,
    tests: ["src/lib/select-trigger-label.test.ts"],
  },
  {
    id: "M7",
    what: "accept a statically empty items map (the guard's near-miss case)",
    file: `${WEB}/src/lib/select-trigger-label.test.ts`,
    find: `  if (ts.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length === 0) return false;`,
    replace: `  if (ts.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length === 0) return true;`,
    cwd: WEB,
    tests: ["src/lib/select-trigger-label.test.ts"],
  },
  {
    id: "M8",
    what: "reverse the signed-balance→direction rule",
    file: `${WEB}/src/lib/supplier-entry-display.ts`,
    // PR #267 round 4, finding 1: the anchor kept the old
    // `supplierDirectionKey(balance >= 0 …)` call while the helper now returned
    // the label keys directly, so the gate reported M8 ANCHOR MISSING.
    find: `  return supplierDirectionKey(balance > 0 ? "THEY_OWE" : "WE_OWE");`,
    replace: `  return supplierDirectionKey(balance < 0 ? "THEY_OWE" : "WE_OWE");`,
    cwd: WEB,
    tests: ["src/lib/supplier-entry-display.test.ts", "src/pages/supplier-opening-balance.test.tsx"],
  },
  {
    id: "M9",
    what: "pair each direction with the other's hint",
    file: `${WEB}/src/lib/supplier-entry-display.ts`,
    find: `  return direction === "THEY_OWE" ? "supplierAdjustDirectionTheyOweHint" : "supplierAdjustDirectionWeOweHint";`,
    replace: `  return direction === "THEY_OWE" ? "supplierAdjustDirectionWeOweHint" : "supplierAdjustDirectionTheyOweHint";`,
    cwd: WEB,
    tests: ["src/components/parties/supplier-adjust-panel.test.tsx"],
  },
  {
    id: "M10",
    what: "swap the two labels inside the picker's own map",
    file: `${WEB}/src/pages/supplier-opening-balance.tsx`,
    find: `    { value: "WE_OWE", label: t(supplierDirectionKey("WE_OWE")) },\n    { value: "THEY_OWE", label: t(supplierDirectionKey("THEY_OWE")) },`,
    replace: `    { value: "WE_OWE", label: t(supplierDirectionKey("THEY_OWE")) },\n    { value: "THEY_OWE", label: t(supplierDirectionKey("WE_OWE")) },`,
    cwd: WEB,
    tests: ["src/pages/supplier-opening-balance.test.tsx"],
  },
  {
    id: "M11",
    what: "stop resolving a name bound to an empty array (items={EMPTY})",
    file: `${WEB}/src/lib/select-trigger-label.test.ts`,
    find: `  if (ts.isIdentifier(unwrapped) && (unwrapped.text === "undefined" || unwrapped.text === "null" || emptyBindings.has(unwrapped.text))) return false;`,
    replace: `  if (ts.isIdentifier(unwrapped) && (unwrapped.text === "undefined" || unwrapped.text === "null")) return false;`,
    cwd: WEB,
    tests: ["src/lib/select-trigger-label.test.ts"],
  },
  {
    id: "M12",
    what: "accept a map whose label is the raw value it names",
    file: `${WEB}/src/lib/select-trigger-label.test.ts`,
    find: `  return !labelsAreRawValues(unwrapped);`,
    replace: `  return true;`,
    cwd: WEB,
    tests: ["src/lib/select-trigger-label.test.ts"],
  },
  {
    id: "M13",
    what: "point the 'we owe him' button at THEY_OWE",
    file: `${WEB}/src/components/parties/supplier-adjust-panel.tsx`,
    find: `onClick={() => setDirection("WE_OWE")}`,
    replace: `onClick={() => setDirection("THEY_OWE")}`,
    cwd: WEB,
    tests: ["src/components/parties/supplier-adjust-panel.test.tsx"],
  },
  {
    id: "M14",
    what: "blind the guard's positive control (it sees no roots)",
    file: `${WEB}/src/lib/select-trigger-label.test.ts`,
    find: `    if (ts.isJsxElement(node) && tagNameOf(node.openingElement.tagName) === "Select" && rendersSelectValue(node)) seen += 1;`,
    replace: `    if (false) seen += 1;`,
    cwd: WEB,
    tests: ["src/lib/select-trigger-label.test.ts"],
  },
  {
    id: "M15",
    what: "stop reading a quoted property name in the items map",
    file: `${WEB}/src/lib/select-trigger-label.test.ts`,
    find: `  if (ts.isStringLiteral(name)) return name.text;`,
    replace: `  if (ts.isStringLiteral(name)) return null;`,
    cwd: WEB,
    tests: ["src/lib/select-trigger-label.test.ts"],
  },
  {
    id: "M16",
    what: "invert the page's value narrowing (asDirection)",
    file: `${WEB}/src/pages/supplier-opening-balance.tsx`,
    find: `const asDirection = (value: string | null): SupplierAdjustmentDirection => (value === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");`,
    replace: `const asDirection = (value: string | null): SupplierAdjustmentDirection => (value === "WE_OWE" ? "THEY_OWE" : "WE_OWE");`,
    cwd: WEB,
    tests: ["src/pages/supplier-opening-balance.test.tsx"],
  },
];

const CRASH_FIXTURE = fileURLToPath(new URL("./fixtures/crashes-on-load.test.ts", import.meta.url));
const HINT_ANCHOR = `supplierAdjustDirectionWeOweHint: "نحن ندين له — يزيد ما علينا"`;

/**
 * Known-bad mutations, only under MUTATION_PROOF_DRILL=1. Each one MUST be named
 * as a problem; if either one is silently accepted, the gate has regressed.
 */
const DRILL_MUTATIONS: readonly Mutation[] = [
  {
    id: "D1",
    what: "drill: the named suite cannot load a dependency, so no assertion ran (must NOT count as caught)",
    file: `${WEB}/src/lib/i18n.ts`,
    find: HINT_ANCHOR,
    replace: `supplierAdjustDirectionWeOweHint: "drill: the anchor only has to exist"`,
    cwd: WEB,
    tests: [CRASH_FIXTURE],
    excludeFromBaseline: true,
  },
  {
    id: "D2",
    what: "drill: a change none of the chosen suites asserts (must report did NOT redden)",
    file: `${WEB}/src/lib/i18n.ts`,
    find: HINT_ANCHOR,
    replace: `supplierAdjustDirectionWeOweHint: "drill: the anchor only has to exist"`,
    cwd: WEB,
    tests: ["src/lib/select-trigger-label.test.ts"],
  },
];

const drill = process.env.MUTATION_PROOF_DRILL === "1";
const MUTATION_SET: readonly Mutation[] = drill ? [...MUTATIONS, ...DRILL_MUTATIONS] : MUTATIONS;

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const originals = new Map<string, string>();
for (const mutation of MUTATION_SET) {
  if (!originals.has(mutation.file)) originals.set(mutation.file, readFileSync(mutation.file, "utf8"));
}
const hashes = new Map([...originals.keys()].map((file) => [file, hash(file)]));

if (drill) {
  console.log("DRILL: D1 (crash, no named failure) and D2 (uncovered change) are deliberately bad.");
  console.log("       Passing this drill means exit 1 with both named as problems.\n");
}

// --- phase 1: the baseline must be green before any mutation can count -------
const baselineGroups = new Map<string, Set<string>>();
for (const mutation of MUTATION_SET) {
  if (mutation.excludeFromBaseline === true) continue;
  const suites = baselineGroups.get(mutation.cwd) ?? new Set<string>();
  for (const suite of mutation.tests) suites.add(suite);
  baselineGroups.set(mutation.cwd, suites);
}

console.log("# phase 1 — green baseline (unmutated suites)");
const baselineProblems: string[] = [];
for (const [cwd, suites] of baselineGroups) {
  const outcome = runSuites(cwd, [...suites].sort());
  console.log(`  ${cwd}: ${suites.size} suite(s) exit=${outcome.exit} named failures=${outcome.failures.length}`);
  for (const failure of outcome.failures) console.log(`      ${failure}`);
  const problem = gateProblem(outcome, "baseline");
  if (problem !== null) baselineProblems.push(`${cwd}: ${problem}`);
}
if (baselineProblems.length > 0) {
  console.log(`\nBASELINE IS NOT GREEN — no mutation result can count:\n  ${baselineProblems.join("\n  ")}`);
  process.exit(1);
}
console.log("  baseline green\n");

// --- phase 2: every mutation must be caught by a NAMED test failure ---------
console.log(`# phase 2 — ablation (${MUTATION_SET.length} mutations)\n`);
const problems: string[] = [];
for (const mutation of MUTATION_SET) {
  const original = originals.get(mutation.file)!;
  // these files are CRLF; the anchors are written LF so they stay readable
  const crlf = original.includes("\r\n");
  const find = crlf ? mutation.find.replace(/\n/g, "\r\n") : mutation.find;
  const replace = crlf ? mutation.replace.replace(/\n/g, "\r\n") : mutation.replace;
  console.log(`\n--- ${mutation.id}: ${mutation.what}`);
  if (!original.includes(find)) {
    problems.push(`${mutation.id} ANCHOR MISSING`);
    console.log("      ANCHOR MISSING — mutation not applied");
    continue;
  }
  try {
    writeFileSync(mutation.file, original.replace(find, replace));
    const outcome = runSuites(mutation.cwd, mutation.tests);
    for (const failure of outcome.failures) console.log(`      ${failure}`);
    console.log(`      exit=${outcome.exit} named failures=${outcome.failures.length}`);
    const problem = gateProblem(outcome, "mutation");
    if (problem !== null) {
      problems.push(`${mutation.id} ${problem}`);
      console.log(`      *** PROBLEM: ${problem} ***`);
    }
  } finally {
    writeFileSync(mutation.file, original);
  }
}

console.log("\n# restore check");
for (const [file, before] of hashes) {
  const after = hash(file);
  const ok = before === after;
  if (!ok) problems.push(`RESTORE FAILED ${file}`);
  console.log(`${ok ? "OK  " : "DIRTY"} ${file}`);
}
console.log(problems.length === 0 ? "\nALL MUTATIONS REDDENED, ALL FILES RESTORED BYTE-IDENTICAL" : `\nPROBLEMS: ${problems.join("; ")}`);
process.exit(problems.length === 0 ? 0 : 1);
