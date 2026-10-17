/**
 * #257 review round 3 — ablation harness for the stale invoice-number expectation.
 *
 * The acceptance criterion is "the spec would still fail if the purchase number
 * lost its prefix entirely", so the assertion must be proven non-vacuous by
 * mutation: backup → patch → run the one spec → restore. No `git stash` anywhere
 * (wisdom 2026-10-14-git-stash-pathspec-pops-unrelated-stash).
 *
 * Run (inside a held e2e slot):
 *   cd <worktree> && bun .scratch/ablation/run-257-round3.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const spec = "tests/e2e/purchase-inline-product.spec.ts";

interface Ablation {
  id: string;
  what: string;
  file: string;
  find: string;
  replace: string;
}

const documentNumber = resolve(root, "apps/api/src/lib/document-number.ts");

const ablations: Ablation[] = [
  {
    id: "A1",
    what: "the number loses its prefix entirely (formatDocumentNumber returns digits only)",
    file: documentNumber,
    find: "  return `${prefix}-${String(sequence).padStart(4, \"0\")}`;",
    replace: "  return String(sequence).padStart(4, \"0\");",
  },
  {
    id: "A2",
    what: "a purchase takes the sale prefix (PURCHASE: SUP -> INV)",
    file: documentNumber,
    find: '  PURCHASE: "SUP",',
    replace: '  PURCHASE: "INV",',
  },
];

function runSpec(logPath: string): { red: boolean; failed: string[]; received: string[] } {
  const out = spawnSync(`npx playwright test ${spec}`, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  writeFileSync(logPath, raw);
  const failed = [...raw.matchAll(/^\s+\d+\) .*$/gm)].map((m) => m[0].trim());
  const received = [...raw.matchAll(/^\s+Received string:\s+(.*)$/gm)].map((m) => m[1].trim());
  return { red: out.status !== 0, failed, received };
}

let red = 0;
for (const ablation of ablations) {
  const original = readFileSync(ablation.file, "utf8");
  // the working tree checks some files out CRLF, so the patch literals (LF) must
  // be expanded to whatever newline the file actually carries
  const nl = original.includes("\r\n") ? "\r\n" : "\n";
  const find = ablation.find.replace(/\n/g, nl);
  const replace = ablation.replace.replace(/\n/g, nl);
  if (!original.includes(find)) {
    console.log(`${ablation.id}  SKIP  patch target not found — ${ablation.what}`);
    continue;
  }
  writeFileSync(ablation.file, original.replace(find, replace));
  const result = runSpec(resolve(root, `.scratch/reviews/257/ablation-${ablation.id}.log`));
  writeFileSync(ablation.file, original);
  if (result.red) red += 1;
  console.log(`${ablation.id}  ${result.red ? "RED  " : "GREEN"}  ${ablation.what}`);
  console.log(`     exit: ${result.red ? "non-zero (spec red)" : "0 (spec green)"}`);
  for (const line of result.failed) console.log(`     ${line}`);
  for (const line of result.received) console.log(`     Received string: ${line}`);
}

console.log(`\n${red}/${ablations.length} mutants red. Restored every file.`);
