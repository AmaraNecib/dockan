/**
 * #252 ablation proof, run against the FINAL HEAD.
 *
 * For each mutation it patches one production file, runs the named test files,
 * records whether they redden, and restores the file byte-for-byte. The script
 * asserts its own cleanliness at the end: every mutated file is compared to a
 * pre-mutation hash, so a botched restore cannot be mistaken for a clean tree.
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
    tests: ["src/lib/supplier-entry-display.test.ts", "src/pages/debts.test.tsx", "src/pages/supplier-opening-balance.test.tsx"],
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
    find: `      rendersSelectValue(node) &&\n      !hasItemsAttribute(node.openingElement)`,
    replace: `      rendersSelectValue(node) &&\n      false`,
    cwd: WEB,
    tests: ["src/lib/select-trigger-label.test.ts"],
  },
];

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(id: string, cwd: string, tests: readonly string[]): { exit: number; failures: string[] } {
  const proc = Bun.spawnSync(["bun", "test", ...tests], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const failures = out
    .split("\n")
    .filter((line) => line.includes("(fail)") || /^\d+ tests? failed/.test(line) || /^\s*\d+ fail$/.test(line))
    .map((line) => line.trim());
  console.log(`--- ${id} exit=${proc.exitCode}`);
  for (const failure of failures) console.log(`      ${failure}`);
  return { exit: proc.exitCode, failures };
}

const originals = new Map<string, string>();
for (const mutation of MUTATIONS) {
  if (!originals.has(mutation.file)) originals.set(mutation.file, readFileSync(mutation.file, "utf8"));
}
const hashes = new Map([...originals.keys()].map((file) => [file, hash(file)]));

console.log(`# ablation proof on HEAD (${MUTATIONS.length} mutations)\n`);
for (const mutation of MUTATIONS) {
  const original = originals.get(mutation.file)!;
  // these files are CRLF; the anchors are written LF so they stay readable
  const crlf = original.includes("\r\n");
  const find = crlf ? mutation.find.replace(/\n/g, "\r\n") : mutation.find;
  const replace = crlf ? mutation.replace.replace(/\n/g, "\r\n") : mutation.replace;
  if (!original.includes(find)) {
    console.log(`--- ${mutation.id} ANCHOR MISSING — mutation not applied (${mutation.what})`);
    continue;
  }
  writeFileSync(mutation.file, original.replace(find, replace));
  console.log(`\n--- ${mutation.id}: ${mutation.what}`);
  run(mutation.id, mutation.cwd, mutation.tests);
  writeFileSync(mutation.file, original);
}

console.log("\n# restore check");
let clean = true;
for (const [file, before] of hashes) {
  const after = hash(file);
  const ok = before === after;
  if (!ok) clean = false;
  console.log(`${ok ? "OK  " : "DIRTY"} ${file}`);
}
console.log(clean ? "\nALL FILES RESTORED BYTE-IDENTICAL" : "\nRESTORE FAILED");
process.exit(clean ? 0 : 1);
