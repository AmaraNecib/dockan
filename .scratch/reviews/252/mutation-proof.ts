/**
 * #252 ablation proof, run against the FINAL HEAD.
 *
 * For each mutation it patches one production file, runs the named test files,
 * and records whether they redden. It is a GATE, not just a log: it exits non-zero
 * if a mutation does not redden, if an anchor is missing, or if a file is not
 * restored. A `try/finally` restores the file even when the test spawn throws, and
 * every mutated file is compared to a pre-mutation sha256 at the end.
 *
 * Run: bun .scratch/reviews/252/mutation-proof.ts   (cwd = repo root)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

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
    what: "drop items={directionItems} from the new-row direction Select",
    file: `${WEB}/src/pages/supplier-opening-balance.tsx`,
    find: `                    <Select\n                      items={directionItems}\n                      value={newDirection}`,
    replace: `                    <Select\n                      value={newDirection}`,
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
    find: `  return supplierDirectionKey(balance >= 0 ? "WE_OWE" : "THEY_OWE");`,
    replace: `  return supplierDirectionKey(balance < 0 ? "WE_OWE" : "THEY_OWE");`,
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

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

interface Outcome {
  readonly exit: number;
  readonly failures: string[];
}

function run(cwd: string, tests: readonly string[]): Outcome {
  const proc = Bun.spawnSync(["bun", "test", ...tests], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const failures = out
    .split("\n")
    .filter((line) => line.includes("(fail)"))
    .map((line) => line.trim());
  return { exit: proc.exitCode ?? -1, failures };
}

const originals = new Map<string, string>();
for (const mutation of MUTATIONS) {
  if (!originals.has(mutation.file)) originals.set(mutation.file, readFileSync(mutation.file, "utf8"));
}
const hashes = new Map([...originals.keys()].map((file) => [file, hash(file)]));

console.log(`# ablation proof on HEAD (${MUTATIONS.length} mutations)\n`);
const problems: string[] = [];
for (const mutation of MUTATIONS) {
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
    const outcome = run(mutation.cwd, mutation.tests);
    for (const failure of outcome.failures) console.log(`      ${failure}`);
    console.log(`      exit=${outcome.exit}`);
    if (outcome.exit === 0) {
      problems.push(`${mutation.id} did NOT redden`);
      console.log("      *** DID NOT REDDEN — this mutation is not covered ***");
    } else if (outcome.failures.length === 0) {
      console.log("      (failed without a named test line — check the log)");
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
