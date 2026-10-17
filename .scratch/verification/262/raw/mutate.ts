#!/usr/bin/env bun
// mutate.ts — the ablation half of the evidence: delete one guard, watch its case go red.
//
// A test that never failed proves nothing, and a guard with no case that reddens when the
// guard is removed is not a guard. Each mutation below is the smallest edit that removes
// exactly one decision, applied with a literal string replace (no regex, so nothing here
// can silently match the wrong line). The driver restores the file from a copy afterwards
// -- never `git stash push -- <path>`, which pops an unrelated stash (2026-10-14 wisdom).
const MUTATIONS: Record<string, [string, string, string]> = {
  "pickup-guard": [
    "scripts/crew/crew-pickup.ts",
    "const refusal = validateLaunch(message, brief, env.exists(brief));",
    'const refusal = "";',
  ],
  "clean-guard": [
    "scripts/crew/crew-clean.ts",
    "if (!options.force && wt.dirtySource.length > 0) {",
    "if (false) {",
  ],
  "loop-parse": ["scripts/crew/crew-loop.ts", "started = Number(match[1]);", "started = 0;"],
  "slot-atomic": [
    "scripts/crew/e2e-slot.ts",
    "mkdirSync(join(held, `slot${String(n)}`));",
    "mkdirSync(join(held, `slot${String(n)}`), { recursive: true });",
  ],
};

const name = process.argv[2] ?? "";
const mutation = MUTATIONS[name];
if (mutation === undefined) {
  console.error(`usage: mutate.ts <${Object.keys(MUTATIONS).join("|")}>`);
  process.exit(2);
}
const [file, from, to] = mutation;
const source = await Bun.file(file).text();
if (!source.includes(from)) {
  console.error(`PATTERN NOT FOUND in ${file}: ${from}`);
  process.exit(9);
}
await Bun.write(file, source.replace(from, to));
console.log(`${file}: ${from}  ->  ${to}`);
