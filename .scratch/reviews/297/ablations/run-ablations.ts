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
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Derived from this file's own location, so the evidence can be re-run in
// whatever checkout it is read in. A hard-coded worktree path only worked on
// the machine that wrote it, and on a machine that still had that path it
// edited a tree nobody was looking at.
const REPO = resolve(import.meta.dir, "../../../..");
const GATE = join(REPO, "scripts/red-on-parent.ts");
// Outside the repo: the file below is a byte-for-byte copy of the gate, and a
// second copy of it in the tree is only noise for a reader. One scratch
// directory per run, because two worktrees running this at once shared a fixed
// path: the second run's copy of the gate replaced the first run's backup, and
// the first run's restore then wrote the other worktree's source over its own
// edits.
const SCRATCH = mkdtempSync(join(tmpdir(), "red-on-parent-ablations-"));
const BASELINE = join(SCRATCH, "baseline.ts");
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
    test: "a waived NOT ON PARENT does not suppress RED ON CHANGE",
    claim: "F1: a test that fails on the change as well is reported as RED_ON_CHANGE",
    from: `    if (changeResult.status === "failed") {`,
    to: `    if (false) {`,
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
  {
    name: "A18-R5-lock-identity",
    test: "does not touch the lock that took it",
    claim: "R5: the pid is not an identity — the token tells a replaced lock from the stale one",
    from: `    return a.pid === b.pid && (a.token ?? "") === (b.token ?? "");`,
    to: `    return a.pid === b.pid;`,
  },
  {
    name: "A19-R5-verify-before-rename",
    test: "does not touch the lock that took it",
    claim: "R5b: a reclaim refuses before it renames, so a live lock is never moved",
    from: `  if (!sameLock(observeLockHolder(lockPath), observed)) return "refused";`,
    to: `  if (false) return "refused";`,
  },
  {
    name: "A20-R6-skipped-on-change",
    test: "a test the change skips is not a right-reason red",
    claim: "R6: a test the change skips never runs there, so the parent's red says nothing about it",
    from: `      name: "SKIPPED_ON_CHANGE",
      detail:
        "the test is skipped on the change, so it never runs there and pins nothing — the parent's red was about a test the change does not execute",`,
    to: `      name: "GREEN_ON_PARENT",
      detail:
        "the test is skipped on the change, so it never runs there and pins nothing — the parent's red was about a test the change does not execute",`,
  },
  {
    name: "A21-R7-dirty-tree",
    test: "an uncommitted source cannot hide a test from the change side",
    claim: "R7: a dirty working tree fails the gate closed, because the change side reads it",
    from: `  const dirty = modifiedTrackedFiles(repo);`,
    to: `  const dirty: string[] = [];`,
  },
  {
    name: "A22-R8-tombstone-name",
    test: "a tombstone left behind does not block the reclaim",
    claim: "R8: the tombstone name carries a random suffix, so a leftover one cannot block the rename",
    from: "  const tombstone = `${lockPath}.stale-${process.pid}-${randomUUID()}`;",
    to: "  const tombstone = `${lockPath}.stale-${process.pid}`;",
  },
  {
    name: "A23-R9-unreadable-pid",
    test: "a pid file that cannot be read is not evidence of a dead holder",
    claim: "R9: a read error that is not ENOENT is not evidence of a dead holder",
    from: `    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "alive" };`,
    to: ``,
  },
  {
    name: "A24-R10-no-spin",
    test: "a reclaim that cannot rename the lock is waited out, not spun on",
    claim: "R10: the waiter is bounded — a reclaim that refused falls through to the deadline check and the sleep, so the run cannot spin at the lock",
    from: `      if (Date.now() > deadline) {
        throw new GateError(lockContentionMessage(lockPath, observed));
      }
      if (observed.kind !== "alive" && reclaimStaleLock(lockPath, observed) === "reclaimed") {
        // The stale lock is gone, so the next \`mkdirSync\` can take the name.
        continue;
      }`,
    to: `      if (observed.kind !== "alive") {
        reclaimStaleLock(lockPath, observed);
        continue;
      }
      if (Date.now() > deadline) {
        throw new GateError(lockContentionMessage(lockPath, observed));
      }`,
  },
  {
    name: "A25-R13-missing-module",
    test: "the report names what the parent was missing",
    claim: "R13: the verdict names the module or export the parent lacks",
    from: `  const module = missingModule(stdout);
  if (module !== null) {
    return \`the parent could not load the file (the parent has no \${module})\`;
  }`,
    to: ``,
  },
  {
    name: "A26-R13-waived-count",
    test: "a pass that rests on a waiver says so in the last line",
    claim: "R13b: a pass that rests on waivers says so in the last line, which is the one a reviewer reads",
    from: `    const waived = run.verdicts.filter((verdict) => verdict.waiver !== null && verdictPasses(verdict));`,
    to: `    const waived: Verdict[] = [];`,
  },
  {
    name: "A27-R10-deadline",
    test: "a reclaim that cannot rename the lock is waited out, not spun on",
    claim: "R10b: the wait has a deadline — the run gives up and says so instead of waiting forever",
    from: `      if (Date.now() > deadline) {
        throw new GateError(lockContentionMessage(lockPath, observed));
      }
`,
    to: ``,
  },
  {
    name: "A28-R14-not-on-change",
    test: "a test the change does not register is not a right-reason red",
    claim:
      "R14a: a test the parent's run registered and the change's run did not is a test the change does not execute, so it is not a right-reason red",
    from: `      const notOnChange = changeSideRan
        ? notRegisteredOnChange(file, parentResults, changeResults)
        : [];`,
    to: `      const notOnChange: Verdict[] = [];`,
  },
  {
    name: "A29-R14-verdict-line",
    test: "a run with nothing to gate still says what it decided",
    claim: "R14b: the report ends with a verdict in every shape, including the one that judged nothing",
    from: `    lines.push(problems.length > 0 ? "red-on-parent: FAIL" : "red-on-parent: PASS");`,
    to: ``,
  },
  {
    name: "A30-R14-guide-entry",
    test: "the verdict guide names every verdict, and says what to do about it",
    claim: "R14c: every verdict the gate can print has a guide entry with fixes",
    from: `  {
    name: "NOT_ON_CHANGE",
    title: "the parent's run registered this test and the change's run did not, so the change does not execute it",`,
    to: `  {
    name: "NOT_ON_CHANGE_UNDOCUMENTED",
    title: "the parent's run registered this test and the change's run did not, so the change does not execute it",`,
  },
  {
    name: "A31-R14-not-on-parent-suppression",
    test: "the change side's verdicts are decided on its own results",
    claim:
      "R14d: a change-side failure whose NOT ON PARENT row already fails the run is not reported twice",
    from: `      if (unexcusedNotOnParent.has(test)) continue;`,
    to: `      if (false) continue;`,
  },
  {
    name: "A32-R15-skipped-on-change",
    test: "a test the change skips and the parent never judged is not a pass",
    claim:
      "R15a: a test the change skips and the parent never judged runs nowhere, so it is not a pass",
    from: `    const alreadyFailing =
      parentVerdict !== undefined &&
      (parentVerdict.name === "WAIVER_MISFILED" ||
        parentVerdict.name === "RUN_INCOMPLETE" ||
        (parentVerdict.name === "NOT_ON_PARENT" && !verdictPasses(parentVerdict)));
    if (alreadyFailing) continue;`,
    to: `    if (parentVerdict === undefined || parentVerdict.name !== "RIGHT_REASON_RED") continue;`,
  },
  {
    name: "A33-R15-bun-check",
    test: "the gate refuses to run under node",
    claim: "R15b: the gate asks whether it is running under bun before it does any work, whoever calls it",
    from: `  const refusal = bunOnlyRefusal(versions);
  if (refusal !== null) {
    throw new GateError(
      "this gate has to run under bun, not node — every parent-side run spawns \`bun test\` from process.execPath, and under node each file reads as a whole-file load failure",
    );
  }
`,
    to: ``,
  },
  {
    name: "A34-R15-holder-count",
    test: "the holder's pid file says how many files it is judging",
    claim: "R15c: the pid file says how many files the holder is judging, so a waiter can wait for that work",
    from: "  return `${pid} ${token} ${fileCount}\\n`;",
    to: "  return `${pid} ${token}\\n`;",
  },
  {
    name: "A35-R15-wait-deadline",
    test: "a waiter waits past its own budget when the holder is judging more",
    claim: "R15d: the waiter waits for the work the holder says it is doing, not for its own guess",
    from: `      if (observed.kind !== "unclaimed" && observed.token !== countedHolder) {
        countedHolder = observed.token ?? null;
        deadline = effectiveWaitDeadline(deadline, observed, Date.now());
      }
`,
    to: ``,
  },
  {
    name: "A36-R16-base-contains-head",
    test: "--base that already contains head reports a problem, not a green run",
    claim:
      "R16a: a base that already contains the head has nothing to gate, so the run says so instead of passing having judged nothing",
    from: `    if (baseContainsHead) {
      problems.push(
        \`--base \${options.base} already contains \${head}: there is no change to gate, so this run would pass having judged nothing. Point --base at the branch this change targets.\`,
      );
    }`,
    to: `    if (false) {
      problems.push(
        \`--base \${options.base} already contains \${head}: there is no change to gate, so this run would pass having judged nothing. Point --base at the branch this change targets.\`,
      );
    }`,
  },
  {
    name: "A37-R16-head-not-checked-out",
    test: "an annotated tag on another commit is still reported",
    claim:
      "R16b: a head that is not checked out cannot have its tests enumerated, so the run says so instead of judging the wrong commit",
    from: `  if (checkoutDiffers) {
    problems.push(
      \`--head \${head} is not the checked-out commit, so the tests it registers cannot be enumerated — check that commit out, or drop --head\`,
    );
  }`,
    to: `  if (false) {
    problems.push(
      \`--head \${head} is not the checked-out commit, so the tests it registers cannot be enumerated — check that commit out, or drop --head\`,
    );
  }`,
  },
  {
    name: "A38-R16-ignored-files-kept",
    test: "a reused worktree is restored, not judged as the last run left it",
    claim: "R16c: the reset clears the untracked files a test left behind and keeps the ignored ones",
    from: `  gitText(worktree, ["clean", "-fd"]);`,
    to: `  gitText(worktree, ["clean", "-fdx"]);`,
  },
  {
    name: "A39-R16-comment-strip",
    test: "a commented-out import is not an import",
    claim: "R16d: a commented-out import is not an import, so the file is not refused for it",
    from: `  const code = withoutComments(source);`,
    to: `  const code = source;`,
  },
  {
    name: "A40-R16-waiver-before-refusal",
    test: "a refused file still has its waiver marker read",
    claim:
      "R16e: the waiver marker of a refused file is read before the refusal, so a malformed marker is still reported",
    from: `      const source = readAtRevision(repo, head, file);
      const parsed = parseWaivers(source);
      for (const problem of parsed.problems) problems.push(\`\${file}: \${problem}\`);
      // A file that imports another test file pulls that file's cases into its
      // own report, and bun names every case after the entry, so the report
      // cannot say whose test failed. Judging it would put the other file's
      // green case against this file — and demand a waiver for a test this
      // file does not contain. The gate names the import and judges nothing.
      const imports = importedTestFiles(source);
      if (imports.length > 0) {
        problems.push(
          \`\${file}: imports another test file (\${imports.join(", ")}), so one run would report that file's cases as well and the gate could not tell whose test failed — this file was not judged; keep each file's cases in its own file\`,
        );
        continue;
      }`,
    to: `      const source = readAtRevision(repo, head, file);
      // A file that imports another test file pulls that file's cases into its
      // own report, and bun names every case after the entry, so the report
      // cannot say whose test failed. Judging it would put the other file's
      // green case against this file — and demand a waiver for a test this
      // file does not contain. The gate names the import and judges nothing.
      const imports = importedTestFiles(source);
      if (imports.length > 0) {
        problems.push(
          \`\${file}: imports another test file (\${imports.join(", ")}), so one run would report that file's cases as well and the gate could not tell whose test failed — this file was not judged; keep each file's cases in its own file\`,
        );
        continue;
      }
      const parsed = parseWaivers(source);
      for (const problem of parsed.problems) problems.push(\`\${file}: \${problem}\`);`,
  },
  {
    name: "A41-R16-run-incomplete-passes",
    test: "a broken or unjudged test fails even with a waiver",
    claim:
      "R16f: a run that did not finish fails the gate, and a waiver cannot make an unjudged test pass",
    from: `    case "RUN_INCOMPLETE":
      return false;`,
    to: `    case "RUN_INCOMPLETE":
      return true;`,
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
    // The failing test's name, so a red can be attributed to the test the
    // entry names. The `-t` filter is a substring match, so it can select more
    // than one test; the name says which one died.
    const failedNames = [...output.matchAll(/^\(fail\)\s+(.+?)\s+\[\d/gsmu)]
      .map((match) => match[1] ?? "")
      .join(" | ");
    // A mutant that crashes the runner is not a green mutant: it is a broken
    // ablation, and the two have to read differently.
    const crashed = !red && result.status !== 0;
    summary.push(
      `${red ? "RED " : crashed ? "CRASHED" : "NOT RED"} ${ablation.name}: ${passes} pass, ${fails} fail, exit ${result.status}${failedNames ? ` — failing: ${failedNames}` : ""} — ${ablation.claim}`,
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
  // Only this run's own copy: the gate is restored, so nothing here can still
  // need it.
  rmSync(SCRATCH, { recursive: true, force: true });
}
