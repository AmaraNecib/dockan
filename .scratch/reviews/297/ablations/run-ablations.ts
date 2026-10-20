/**
 * The ablations behind this commit.
 *
 * Every fix in `scripts/red-on-parent.ts` is proved by removing it and seeing
 * the test that pins it go red. This script does the removal, runs the pinned
 * test, and writes what it saw next to this file.
 *
 * Run it from the repo root: `bun .scratch/reviews/297/ablations/run-ablations.ts`
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Derived from this file's own location, so the evidence can be re-run in
// whatever checkout it is read in. A hard-coded worktree path only worked on
// the machine that wrote it, and on a machine that still had that path it
// edited a tree nobody was looking at.
const REPO = resolve(import.meta.dir, "../../../..");
const GATE = join(REPO, "scripts/red-on-parent.ts");
// Outside the repo: the file below is a byte-for-byte copy of the gate, and a
// second copy of it in the tree is only noise for a reader.
const BASELINE = join(tmpdir(), "red-on-parent-ablations-baseline.ts");
const OUT = join(REPO, ".scratch/reviews/297/ablations");

type Ablation = {
  name: string;
  /** The test name filter: the test that must go red. */
  test: string;
  /** What the fix says, in one line. */
  claim: string;
  /** The text the fix added, which the ablation removes. */
  from: string;
  /** The text that puts the old behaviour back. */
  to: string;
};

const ablations: Ablation[] = [
  {
    name: "A1-F1-red-on-change",
    test: "red on the change as well",
    claim: "F1: a test that fails on the change as well is reported as RED_ON_CHANGE",
    from: `        if (changeResult.status !== "failed") continue;`,
    to: `        if (changeResult.status !== "failed") continue;\n        continue;`,
  },
  {
    name: "A2-F2-no-timeout",
    test: "a hung test run is RUN INCOMPLETE",
    claim: "F2: a hung test is stopped and reported as RUN_INCOMPLETE",
    from: `    here.cwd,\n    testTimeoutMs(),\n  );`,
    to: `    here.cwd,\n    999_999_999,\n  );`,
  },
  {
    name: "A3-F3-unused-waiver",
    test: "waiver that match",
    claim: "F3: a waiver that matches no test is reported as WAIVER-MISFILED",
    from: `    .filter((waiver) => !used.has(waiver.line))`,
    to: `    .filter(() => false)`,
  },
  {
    name: "A4-C1-uncommitted",
    test: "an uncommitted test file fails the gate",
    claim: "C1: an uncommitted test file fails the run instead of warning",
    from: `  const uncommitted = uncommittedTestFiles(repo);`,
    to: `  const uncommitted: string[] = [];`,
  },
  {
    name: "A4b-C1-staged",
    test: "a staged test file fails the gate too",
    claim: "C1: a staged test file fails the run instead of warning",
    from: `  const uncommitted = uncommittedTestFiles(repo);`,
    to: `  const uncommitted: string[] = [];`,
  },
  {
    name: "A5-C2-waiver-scope",
    test: "a waiver excuses only the test it names",
    claim: "C2: a waiver excuses the test it names, and only that test",
    from: `      const matching = waivers.filter((candidate) => matches(candidate, result));`,
    to: `      const matching = waivers.length > 0 ? [waivers[0]!] : [];`,
  },
  {
    name: "A6-C3-skipped",
    test: "outside the gate's scope is named",
    claim: "C3: a test file the gate does not gate is named in the report",
    from: `  const skipped = skippedTestFiles(repo, baseSha, head);`,
    to: `  const skipped: SkippedTestFile[] = [];`,
  },
  {
    name: "A7-C4-manifest",
    test: "the manifest names a copied file as soon as it is copied",
    claim: "C4: the manifest is written on every copy, so a half-dead run leaves no orphan",
    from: `  copied.push(file);\n  writeManifest(manifest, copied);`,
    to: `  copied.push(file);`,
  },
  {
    name: "A8-C5-containment",
    test: "a manifest path that escapes the worktree",
    claim: "C5: a manifest path that leaves the worktree names nothing and deletes nothing",
    from: "  return target.startsWith(`${root}${sep}`) ? target : null;",
    to: "  return target;",
  },
  {
    name: "A9-R1-file-level-waiver",
    test: "a shared waiver over the parent's tests is not a file-level skip",
    claim: "R1: the file-level waiver rule judges the change's test list, not the parent's",
    from: `  const waiverProblems = fileLevelWaiverProblems(run.file, waivers, changeSideList);`,
    to: `  const waiverProblems = fileLevelWaiverProblems(run.file, waivers, results);`,
  },
  {
    name: "A10-R2-exact-file",
    test: "a sibling whose name extends the added file's is never run",
    claim: "R2: the run imports exactly the added file, so a same-prefix sibling never runs",
    from: `["test", entry, `,
    to: `["test", file, `,
  },
  {
    name: "A11-R3-lock-budget",
    test: "the lock wait budget covers both runs of every file",
    claim: "R3: the lock wait budget covers the parent-side and change-side run of each file",
    from: `fileCount * 2 * testTimeoutMs()`,
    to: `fileCount * testTimeoutMs()`,
  },
  {
    name: "A12-R4-cache-reset",
    test: "a reused worktree is restored, not judged as the last run left it",
    claim: "R4: a reused worktree is reset to its commit before the next run judges it",
    from: `      resetBaseWorktree(worktree);\n`,
    to: ``,
  },
  {
    name: "A13-R4-index-reset",
    test: "a reused worktree is restored, not judged as the last run left it",
    claim: "R4b: the reset discards the index too, so a staged write is not restored from it",
    from: `  gitText(worktree, ["reset", "--hard", "HEAD"]);`,
    to: `  gitText(worktree, ["checkout", "--", "."]);`,
  },
  {
    name: "A14-R4-deleted-file",
    test: "a reused worktree is restored, not judged as the last run left it",
    claim: "R4c: a file a test deleted is restored, not left missing for the next run",
    from: `  gitText(worktree, ["reset", "--hard", "HEAD"]);\n`,
    to: ``,
  },
  {
    name: "A15-F1-imported-test-file",
    test: "a file that imports another test file is named, not judged",
    claim: "F1: a file that imports another test file is named, not judged on a mixed report",
    from: `      const imports = importedTestFiles(source);`,
    to: `      const imports: string[] = [];`,
  },
  {
    name: "A16-R4-clean",
    test: "a reused worktree is restored, not judged as the last run left it",
    claim: "R4d: an untracked file a test left behind is removed, not left for the next run",
    from: `  gitText(worktree, ["clean", "-fd"]);\n`,
    to: ``,
  },
  {
    name: "A17-F1-type-only-import",
    test: "the import that names another test file is found in the source",
    claim: "F1b: a type-only import is erased before the file runs, so it names no test file",
    from: `  if (isTypeOnlyClause(match[1] ?? "")) continue;`,
    to: `  if (isTypeOnlyClause("")) continue;`,
  },
];

function restoreBaseline(): void {
  copyFileSync(BASELINE, GATE);
}

const summary: string[] = [];
copyFileSync(GATE, BASELINE);
try {
  for (const ablation of ablations) {
    restoreBaseline();
    const source = readFileSync(GATE, "utf8");
    // The gate is checked out with CRLF on Windows, so a mutation written with
    // LF newlines must be re-spelled in the file's own line ending.
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const from = ablation.from.replaceAll("\n", eol);
    const to = ablation.to.replaceAll("\n", eol);
    if (!source.includes(from)) {
      summary.push(`${ablation.name}: MUTATION DID NOT APPLY`);
      continue;
    }
    writeFileSync(GATE, source.replace(from, to));
    const result = spawnSync(
      "bun",
      ["test", "./scripts/red-on-parent.test.ts", "-t", ablation.test],
      { cwd: REPO, encoding: "utf8", timeout: 600_000 },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    writeFileSync(join(OUT, `${ablation.name}.txt`), output);
    const fails = (output.match(/^\(fail\)/gmu) ?? []).length;
    const passes = (output.match(/^\(pass\)/gmu) ?? []).length;
    const red = fails > 0;
    // A mutant that crashes the runner is not a green mutant: it is a broken
    // ablation, and the two have to read differently.
    const crashed = !red && result.status !== 0;
    summary.push(
      `${red ? "RED " : crashed ? "CRASHED" : "NOT RED"} ${ablation.name}: ${passes} pass, ${fails} fail, exit ${result.status} — ${ablation.claim}`,
    );
    restoreBaseline();
  }
  writeFileSync(join(OUT, "summary.txt"), `${summary.join("\n")}\n`);
  console.log(summary.join("\n"));
} finally {
  // The whole point of the loop is to leave a deliberately broken gate in place
  // for the length of one test run. A throw between the mutation and the restore
  // — a failed write of the result file, say — must not leave it broken on disk
  // for whoever runs next.
  restoreBaseline();
}
