/**
 * #257 review round 2 — ablation harness.
 *
 * Every guard this round ships must go RED when it is deleted: backup → patch →
 * run the one named test → restore. No `git stash` anywhere, so uncommitted work
 * survives the run (wisdom 2026-10-14-git-stash-pathspec-pops-unrelated-stash).
 *
 * Run: cd apps/web && bun ../../.scratch/ablation/run-257-round2.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const page = resolve(root, "apps/web/src/pages/purchase.tsx");

interface Ablation {
  id: string;
  what: string;
  file: string;
  find: string;
  replace: string;
  test: string;
}

const F1_EFFECT = `  const lineDraftTarget = lineDraft?.target ?? null;
  const linePendingTarget = lineCreatePending?.target ?? null;
  useEffect(() => {
    const target = lineDraftTarget ?? linePendingTarget;
    if (target === null) return;
    if (lines.some((line) => line.item.id === target)) return;
    abandonLineCreate();
    setLineDraft(null);
    setLineError(null);
  }, [lines, lineDraftTarget, linePendingTarget]);
`;

const ablations: Ablation[] = [
  {
    id: "A1",
    what: "the deleted-target effect removed (F1: the form no longer goes with its line)",
    file: page,
    find: F1_EFFECT,
    replace: "",
    test: "does not let a create in flight re-point",
  },
  {
    id: "A2",
    what: "the effect keeps clearing the form but stops abandoning the attempt (F1's landing half)",
    file: page,
    find: `    if (lines.some((line) => line.item.id === target)) return;\n    abandonLineCreate();\n`,
    replace: `    if (lines.some((line) => line.item.id === target)) return;\n`,
    test: "does not let a create in flight re-point",
  },
  {
    id: "A3",
    what: "the in-flight create no longer arms the save gate (F2: nothing blocks the save)",
    file: page,
    find: `    setLineCreatePending({ target, attempt });\n`,
    replace: "",
    test: "blocks the invoice save while a line create is in flight",
  },
  {
    id: "A4",
    what: "the cancel no longer releases the save gate (F2's explicit-cancel half)",
    file: page,
    find: `  function abandonLineCreate() {\n    lineAttemptRef.current += 1;\n    setLineCreatePending(null);\n  }`,
    replace: `  function abandonLineCreate() {\n    lineAttemptRef.current += 1;\n  }`,
    test: "frees the invoice save when the owner cancels",
  },
  {
    id: "A5",
    what: "the save button stops disabling for a pending placement (F2's user-facing block)",
    file: page,
    find: "disabled={createInvoice.isPending || lineCreatePending !== null}",
    replace: "disabled={createInvoice.isPending}",
    test: "blocks the invoice save while a line create is in flight",
  },
];

function runTest(filter: string): { red: boolean; head: string; failLine: string } {
  const out = spawnSync("bun", ["test", "src/pages/purchase.test.tsx", "-t", filter], {
    cwd: resolve(root, "apps/web"),
    encoding: "utf8",
    // a failing React assertion dumps the whole DOM node — tens of MB and 23M
    // lines for the F1 failure. The verdict is the exit code, and the named
    // assertion is in the head, so the tail is deliberately not kept.
    maxBuffer: 8 * 1024 * 1024,
  });
  const raw = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  const failLine = /^\(fail\).*$/m.exec(raw)?.[0] ?? "";
  // a run that overflowed the buffer was killed by Node (status null): that only
  // happens on a failure, because a passing run prints no DOM dump
  const red = out.status !== 0;
  return { red, head: raw.split("\n").slice(0, 22).join("\n"), failLine };
}

let red = 0;
for (const ablation of ablations) {
  const original = readFileSync(ablation.file, "utf8");
  // the working tree checks these files out CRLF (git ls-files --eol: i/lf w/crlf),
  // so the patch literals — written LF — must be expanded to the file's newline
  const nl = original.includes("\r\n") ? "\r\n" : "\n";
  const find = ablation.find.replace(/\n/g, nl);
  const replace = ablation.replace.replace(/\n/g, nl);
  if (!original.includes(find)) {
    console.log(`${ablation.id}  SKIP  patch target not found — ${ablation.what}`);
    continue;
  }
  writeFileSync(ablation.file, original.replace(find, replace));
  const result = runTest(ablation.test);
  writeFileSync(ablation.file, original);
  if (result.red) red += 1;
  console.log(`${ablation.id}  ${result.red ? "RED  " : "GREEN"}  ${ablation.what}`);
  console.log(`          test: "${ablation.test}"`);
  console.log(`          exit: ${result.red ? "non-zero (test red)" : "0 (test green)"}`);
  if (result.failLine !== "") console.log(`          ${result.failLine}`);
  if (!result.red) console.log(result.head.split("\n").slice(-8).join("\n"));
}

console.log(`\n${red}/${ablations.length} guards bite (red when deleted)`);
const control = runTest("round 2");
console.log(`control — restored tree, "round 2": exit ${control.red ? "non-zero" : "0"} (green)`);
