/**
 * #257 review round 4 — ablation harness.
 *
 * Every guard this round ships must go RED when it is deleted: backup → patch →
 * run the one named test → restore. No `git stash` anywhere, so uncommitted work
 * survives the run (wisdom 2026-10-14-git-stash-pathspec-pops-unrelated-stash).
 *
 * Run: cd apps/web && bun ../../.scratch/ablation/run-257-round4.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const page = resolve(root, "apps/web/src/pages/purchase.tsx");

interface Ablation {
  id: string;
  what: string;
  find: string;
  replace: string;
  tests: string[];
}

const T_REPOINT = "refuses to re-point a line while the invoice save is in flight";
const T_SUBMIT = "refuses a line-create submit that no disabled button produced";
const T_PICK = "refuses a catalog pick that would re-point a line";
const T_FREEZE = "freezes the rest of the invoice draft while the save is in flight";

const ablations: Ablation[] = [
  {
    id: "A1",
    what: "the submitLineCreate guard removed (the belt stops refusing a create against the in-flight save)",
    find: "    if (savePending) return;\n    setLineError(null);",
    replace: "    setLineError(null);",
    tests: [T_SUBMIT],
  },
  {
    id: "A2",
    what: "the line create form's submit stops disabling for an in-flight save (F1's user-facing block)",
    find: 'disabled={createItem.isPending || savePending} data-testid="line-product-save"',
    replace: 'disabled={createItem.isPending} data-testid="line-product-save"',
    tests: [T_SUBMIT],
  },
  {
    id: "A3",
    what: "the line's «منتج جديد» trigger stays usable while the save is in flight (the reported control)",
    find: '                                size="xs"\n                                disabled={savePending}\n',
    replace: '                                size="xs"\n',
    tests: [T_REPOINT],
  },
  {
    id: "A4",
    what: "the pickItem guard removed (a dialog already open re-points the line under the request)",
    find: "    if (savePending) return;\n    const target = pickerTarget;",
    replace: "    const target = pickerTarget;",
    tests: [T_PICK],
  },
  {
    id: "A5",
    what: "the line's quantity input stays editable under the in-flight save",
    find: "                              disabled={savePending}\n                              value={line.quantityDraft}",
    replace: "                              value={line.quantityDraft}",
    tests: [T_FREEZE],
  },
  {
    id: "A6",
    what: "the frozen-draft status line removed (the frozen table states no reason)",
    find: '                {savePending && (\n                  <p className="text-sm text-muted-foreground" role="status" data-testid="purchase-lines-frozen">\n                    {t("purchasesSaveInFlight")}\n                  </p>\n                )}\n',
    replace: "",
    tests: [T_FREEZE],
  },
  {
    id: "A7",
    what: "the whole predicate neutered (savePending = false: nothing freezes, nothing refuses)",
    find: "  const savePending = createInvoice.isPending;",
    replace: "  const savePending = false;",
    tests: [T_REPOINT, T_SUBMIT, T_PICK, T_FREEZE],
  },
];

function runTest(filter: string): { red: boolean; head: string; failLine: string } {
  const out = spawnSync("bun", ["test", "src/pages/purchase.test.tsx", "-t", filter], {
    cwd: resolve(root, "apps/web"),
    encoding: "utf8",
    // a failing React assertion dumps the whole DOM node — 8.5M lines for A4's
    // failure. The verdict is the exit code and the named assertion is in the
    // head, so the tail is deliberately not kept.
    maxBuffer: 8 * 1024 * 1024,
  });
  const raw = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  const failLine = /^\(fail\).*$/m.exec(raw)?.[0]?.replace(/ \[\d+(\.\d+)?ms\]$/, "") ?? "";
  // a run that overflowed the buffer was killed by Node (status null): that only
  // happens on a failure, because a passing run prints no DOM dump
  const red = out.status !== 0;
  return { red, head: raw.split("\n").slice(0, 22).join("\n"), failLine };
}

const original = readFileSync(page, "utf8");
// the working tree checks these files out CRLF (git ls-files --eol: i/lf w/crlf),
// so the patch literals — written LF — must be expanded to the file's newline
const nl = original.includes("\r\n") ? "\r\n" : "\n";

let red = 0;
let total = 0;
for (const ablation of ablations) {
  const find = ablation.find.replace(/\n/g, nl);
  const replace = ablation.replace.replace(/\n/g, nl);
  if (!original.includes(find)) {
    console.log(`${ablation.id}  SKIP  patch target not found — ${ablation.what}`);
    continue;
  }
  writeFileSync(page, original.replace(find, replace));
  for (const test of ablation.tests) {
    const result = runTest(test);
    total += 1;
    if (result.red) red += 1;
    console.log(`${ablation.id}  ${result.red ? "RED  " : "GREEN"}  ${ablation.what}`);
    console.log(`          test: "${test}"`);
    console.log(`          exit: ${result.red ? "non-zero (test red)" : "0 (test green)"}`);
    if (result.failLine !== "") console.log(`          ${result.failLine}`);
    if (!result.red) console.log(result.head.split("\n").slice(-8).join("\n"));
  }
  writeFileSync(page, original);
}

console.log(`\n${red}/${total} guards bite (red when deleted)`);
const control = runTest("round 4");
console.log(`control — restored tree, "round 4": exit ${control.red ? "non-zero" : "0"} (green)`);
