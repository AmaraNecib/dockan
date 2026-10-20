# The eleven open Greptile findings at 8a618ed9 — one verdict each

Head reviewed: `8a618ed9` (the head the findings were written against).
Base: `bff7a1a9d9d15b59470bd2452a61e180b90c4b6a`.

Each finding is located by function, not by line number, because the fixes moved
the lines. Every quote below is from `git show 8a618ed9:scripts/red-on-parent.ts`
unless the verdict says otherwise.

| # | Finding | Verdict |
|---|---|---|
| 1 | `fileLevelWaiverProblems` uses the parent's test list | REJECTED |
| 2 | stale-lock reclaim race (two reclaimers) | VALID |
| 3 | change-side results vs parent-side waivers | VALID |
| 4 | stale-lock reclaim race (reclaim vs live holder) | VALID |
| 5 | `changeSideResults` reads the checkout, not the commit | VALID |
| 6 | `lockWaitBudget` counts one run per file | STALE |
| 7 | a cached parent tree is reused as it was left | STALE |
| 8 | `runFrom` hands bun a substring filter | STALE |
| 9 | the ablation runner derives its repo from its own path | STALE |
| 10 | the ablation runner restores the gate only on the normal path | STALE |
| 11 | the signing fixture | STALE |

---

## 1 — REJECTED: the change-side list is what `fileLevelWaiverProblems` is given

The function takes a list; the callers choose it, and both callers choose the
change's list.

`classifyFileRun`, the load-failure branch:

```ts
    const waiverProblems = fileLevelWaiverProblems(run.file, waivers, changeResults);
```

`classifyFileRun`, the branch that has a junit report:

```ts
  const changeSideList = changeResults.length > 0 ? changeResults : results;
  const waiverProblems = fileLevelWaiverProblems(run.file, waivers, changeSideList);
```

`changeResults` is the change side's own run, and `results` is the parent's.
The fallback picks the parent's list only when the change side enumerated
nothing, and the two ways that can happen both push a problem that fails the
run — a dirty working tree, or a change-side run that wrote no junit report:

```ts
  if (dirty.length > 0) {
    ...
    problems.push(...);
    return [];
  }
```

So a run that passes never judges the file-level waiver against the parent's
list. The reading is wrong: the third argument is the change's.

## 2 — VALID: two reclaimers, one dead pid

At `8a618ed9` the reclaim compared pids alone and renamed before it checked:

```ts
  const sameLock =
    observed.kind === "holder"
      ? moved.kind === "holder" && moved.pid === observed.pid
      : moved.kind === "unclaimed" && moved.mtimeMs === observed.mtimeMs;
```

Two waiters observed the same dead pid. The first renamed the lock aside,
removed it, and took the name. The second, holding its earlier observation,
renamed the first waiter's **live** lock away and deleted it, because the only
identity it compared was the pid — and the first waiter's pid is the pid the
dead holder had.

**Fixed.** The pid file now carries a token only the run that wrote it knows,
and the reclaim checks the lock it is about to move before it moves it:

```ts
  if (!sameLock(observeLockHolder(lockPath), observed)) return "refused";
```

A lock that is not the one observed is left exactly where it is, and the
reclaim says `refused`. Mutants: `A18-R5-lock-identity`,
`A19-R5-verify-before-rename`. Test: *a reclaim that judged a dead pid does
not touch the lock that took it*.

## 3 — VALID: the change side's own results were read through the parent's waivers

At `8a618ed9` the change-side results were read in a loop that only knew how
to say `failed`:

```ts
      for (const changeResult of changeResults) {
        if (changeResult.status !== "failed") continue;
```

Two holes:

1. A test the change **skips** was invisible. `test.skipIf(feature)` runs on
   the parent — where the feature is absent — and is skipped on the change,
   where it is present. The parent's red then says nothing about a test the
   change never executes, and the gate called it a right-reason red.
2. The change side's status was read next to the parent's waivers rather than
   on its own.

**Fixed.** `changeSideVerdicts` reads the change side's results on their own
and adds two verdicts the old loop could not produce:

```ts
    if (changeResult.status !== "skipped") continue;
    ...
      name: "SKIPPED_ON_CHANGE",
```

A skipped-on-change test now fails the run, and a `RED_ON_CHANGE` row is
suppressed only by a *failing* `NOT_ON_PARENT` row — the same one that already
fails the run. The claim that a waived `NOT ON PARENT` suppressed the row was
already closed at `8a618ed9`, which built that set from the rows that fail:

```ts
      const unexcusedNotOnParent = new Set(
        unregistered.verdicts
          .filter((verdict) => !verdictPasses(verdict))
          .map((verdict) => verdict.test),
      );
```

Mutant: `A20-R6-skipped-on-change`. Test: *a test the change skips is not a
right-reason red*.

**Since.** Two later mutants cover the same area, and both are RED:
`A32-R15-skipped-on-change` (the verdict is raised even when the parent's own
verdict was a waived wrong-reason red, the hole the edge audit found) and
`A28-R14-not-on-change` (a test the parent's run registered and the change's
run did not is a test the change does not execute).

## 4 — VALID: a reclaim that moved a live lock

The same function, the other half of the race. The check ran **after** the
rename, so a live lock was already out from under the run that held it; the
restore only put it back while the name was free, and a third run that took the
name in between left the live lock orphaned.

**Fixed.** The check now runs before the rename, and a refusal means the lock
is not touched at all — see the `refused` branch quoted under finding 2. Two
further holes in the same area were closed with it:

- A read error on the pid file is no longer read as a missing one. Only
  `ENOENT` is evidence that the writer died before it wrote anything; a sharing
  violation or a permission problem says nothing about the holder, and reading
  it as a dead one let a reclaimer take a live lock away from its holder.
- A reclaim that could not move the lock — the rename failed, the directory is
  another process's working directory — is waited out instead of retried
  immediately. The old `continue` skipped both the deadline check and the
  sleep, so a lock that could not be reclaimed spun the run at full speed until
  somebody killed it. The deadline check now also runs *before* the reclaim, so
  every path through the wait is bounded by it and a reclaim that keeps
  succeeding cannot hold the run past the budget.
- The tombstone the reclaim renames the lock to carries a random suffix, so a
  tombstone left behind by an earlier run cannot block the rename.

Mutants: `A22-R8-tombstone-name`, `A23-R9-unreadable-pid`,
`A24-R10-no-spin`, `A27-R10-deadline`. Tests: *a tombstone left behind does
not block the reclaim*, *a pid file that cannot be read is not evidence of a
dead holder*, *a reclaim that cannot rename the lock is waited out, not spun
on*.

## 5 — VALID: the change side ran against the checkout, not the commit

`changeSideResults` ran the added file in the author's checkout. The file
itself was checked against HEAD, but the **sources it imports** were not:

```ts
  if (modifiedInWorkingTree(repo, file)) {
    problems.push(
      `${file}: has uncommitted changes, so the gate cannot tell which tests this change registers — commit it and run again`,
    );
    return [];
  }
```

An uncommitted edit to a source the test guards on can stop the file
registering a test — a `if ("brandNew" in mod)` guard the edit satisfies, say —
and the change side then enumerates a list no commit holds. The test the
commit registers is invisible to the gate, and the run passes over it.

**Fixed.** A dirty working tree is a problem, not a detail:

```ts
  const dirty = modifiedTrackedFiles(repo);
  if (dirty.length > 0) {
```

Mutant: `A21-R7-dirty-tree`. Test: *an uncommitted source cannot hide a test
from the change side*.

## 6 — STALE: the budget already counted both runs

`lockWaitBudget` at `8a618ed9`:

```ts
  return INSTALL_TIMEOUT_MS + fileCount * 2 * testTimeoutMs() + LOCK_WAIT_SLACK_MS;
```

Two runs per file, which is what the lock covers: the parent-side run and the
change-side run the classifier compares it against. The finding was written
against an earlier head.

**Since.** The budget also grew a second term: the holder publishes how many
files it is judging in the pid file, and a waiter waits for that work rather
than for its own guess. Mutants `A34-R15-holder-count` and
`A35-R15-wait-deadline`.

## 7 — STALE: a reused worktree is reset before it is judged

`ensureBaseWorktree` at `8a618ed9`:

```ts
    if (head.ok && head.stdout.trim() === baseSha) {
      clearPreviousCopies(repo, worktree, baseSha);
      resetBaseWorktree(worktree);
      return { path: worktree, created: false };
    }
```

and

```ts
export function resetBaseWorktree(worktree: string): void {
  gitText(worktree, ["reset", "--hard", "HEAD"]);
  gitText(worktree, ["clean", "-fd"]);
}
```

A matching base SHA is not the whole story, and the reset is what covers the
rest: tracked files go back to the commit and untracked files are removed.
`reset --hard` rather than `checkout -- .` because a test that ran `git add`
leaves the change in the index. The `clearPreviousCopies` call before it
removes the files the last run copied, by name, for the case `git clean` skips
(an ignored path).

## 8 — STALE: the file is selected exactly

`runFrom` at `8a618ed9` does not hand bun the file's path:

```ts
  const entry = join(dirname(junitPath), `${basename(junitPath, ".xml")}.entry.test.ts`);
  const absolute = join(root, file).split("\\").join("/");
  writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(absolute).href)};\n`);
  return run(
    BUN,
    ["test", entry, "--reporter=junit", `--reporter-outfile=${junitPath}`],
```

The entry imports the one file by absolute URL, so the run holds that file's
testcases and no sibling's. A positional path would be a substring filter over
the discovered files, which is what the finding describes; the code does not
do that.

## 9 — STALE: the ablation runner finds its own repo

`.scratch/reviews/297/ablations/run-ablations.ts` at `8a618ed9`:

```ts
const REPO = resolve(import.meta.dir, "../../../..");
```

Derived from the runner's own location, so the evidence can be re-run in
whatever checkout it is read in.

## 10 — STALE: the restore is in a `finally`

Same file, at `8a618ed9`:

```ts
} finally {
  // The whole point of the loop is to leave a deliberately broken gate in place
  // for the length of one test run. A throw between the mutation and the restore
  // — a failed write of the result file, say — must not leave it broken on disk
  // for whoever runs next.
  restoreBaseline();
}
```

The restore is on the `finally` path, so a throw between the mutation and the
restore still puts the gate back.

## 11 — STALE: the signing fixture asserts and cleans up

`scripts/red-on-parent.test.ts` at `8a618ed9`:

```ts
  test("a fixture commits with signing configured globally", () => {
    ...
      const fixture = createFixture([PKG], []);
      try {
        // The commit is the thing under test: a fixture whose commits silently
        // never landed would make this test green for no reason at all.
        const tree = execFileSync("git", ["ls-tree", "--name-only", "-r", "HEAD"], {
          cwd: fixture.repo,
          encoding: "utf8",
        });
        expect(tree).toContain("package.json");
      } finally {
        fixture.cleanup();
      }
```

The fixture asserts that the commit landed — the commit is the thing under
test — and the fixture is cleaned up in a `finally`.

---

## What the later rounds added

The three lenses re-run at `8a618ed9` found more than these eleven, and the
fixes landed after that head. The evidence for them is
`.scratch/reviews/297/8a618ed9-test-audit.md`,
`.scratch/reviews/297/8a618ed9-code-review.md` and
`.scratch/reviews/297/8a618ed9-debate.md`; the mutant table is
`.scratch/reviews/297/ablations/summary.txt` (42 mutants, all RED).

The new mutants since this file was written:

| Mutant | What it pins |
|---|---|
| A28 | a test the change's run did not register is not a right-reason red |
| A29 | the report ends with a verdict in every shape, including the one that judged nothing |
| A30 | every verdict the gate can print has a guide entry |
| A31 | a change-side failure is not reported twice |
| A32 | a test the change skips and the parent never judged runs nowhere |
| A33 | the gate asks whether it runs under bun before it does any work |
| A34 | the pid file says how many files the holder is judging |
| A35 | the waiter waits for the holder's work, not for its own guess |
| A36 | a base that already contains the head has nothing to gate |
| A37 | a head that is not checked out cannot have its tests enumerated |
| A38 | the reset clears what a test left behind and keeps the ignored files |
| A39 | a commented-out import is not an import |
| A40 | a refused file's waiver marker is still read |
| A41 | a run that did not finish fails the gate, waiver or no waiver |

None of the eleven verdicts above changed. Four of them (2, 3, 4, 5) name
mutants that were re-spelled when the code around them moved, and the mutant
names in this table are the ones that run now.
