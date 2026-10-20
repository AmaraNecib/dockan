# Test-audit lens — PR #297, the `red-on-parent` gate at `8a618ed9`

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

**Base** `bff7a1a9d9d15b59470bd2452a61e180b90c4b6a` · **Head reviewed** `8a618ed9` · **Files** `scripts/red-on-parent.ts` (the gate), `scripts/red-on-parent.test.ts` (its suite), `apps/desktop/scripts/ci-workflow.test.ts` (the workflow invariants).

**Method.** Three sub-agents, each read-only, each on the review model, each reading the **commit** `8a618ed9` and not the working tree: an edge-case hunter, a coverage analyst and a quality reviewer. None of them wrote a file or ran a mutating git command; the parent ran every measurement they asked for.

**Grades as reported.** Edge hunter: **C** (1 🔴, 8 🟠, 2 🟡). Coverage analyst: **B** (3 🔴, 4 🟠, 1 🟡). Quality reviewer: **B** (2 🔴, 5 🟠, 4 🟡). The three 🔴 from the edge hunter and the coverage analyst, and one of the two 🔴 from the quality reviewer, are false-pass shapes — the gate printing PASS over a test it never judged. Those were the reason for this round of work.

**Disposition in this commit.** Seventeen of the thirty findings are closed here or in the round 14/15 work that landed in the same tree, four are partly closed, eight are deferred with a stated reason, and one stays open with a measured analysis. The table of mutants grew from 27 to 42, and every one of them is RED.

---

## The edge-case hunter

### 1 · 🔴 a change-side run that registers zero tests is accepted — **CLOSED** (round 14)

`changeSideResults` only checked that a junit *file* existed, never that it held a testcase, so a file whose tests stopped registering produced an empty change-side list: the parent's verdicts carried the run alone and the gate printed PASS for a file that contributes no test.

Closed by the `NOT_ON_CHANGE` verdict: the change's own test list is compared with the parent's, test for test, and a test the parent's run registered and the change's did not is a test the change does not execute. `notRegisteredOnChange` counts rather than deduplicates, so a test registered twice is judged twice. Mutant **A28** dies on it.

### 2 · 🟠 a waived parent-side load failure plus a test skipped on the change passes — **CLOSED** (round 15)

`changeSideVerdicts` raised `SKIPPED_ON_CHANGE` only for a `RIGHT_REASON_RED` parent verdict, so the common waived verdict — `WRONG_REASON_RED`, the rename case — skipped the change-side check entirely, and a `test.skip(...)` on the change left the test running nowhere while the gate printed `PASS (1 waived)`.

The verdict is now raised for any parent verdict that does not already fail the run on its own. Mutant **A32** dies on it.

### 3 · 🟠 the only concurrency test is not a regression detector — **PARTIAL**

The test's own comment admitted it was a smoke check, and deleting the lock left it green. It is renamed to "two concurrent runs both reach a verdict", which is what it proves. The lock's own behaviour is now covered by other tests: the token distinguishes a replaced lock from a stale one (A18), the reclaim verifies before it renames (A19), the tombstone name carries a random suffix (A22), a refused reclaim falls through to the deadline (A24) and the wait has a deadline (A27). What no test asserts is that the lock is held for the **whole** run — a waiter that starts after the holder's last file is judged would not be caught. **Deferred**: the assertion needs a run whose length the test controls, which the current fixtures do not offer.

### 4 · 🟠 the pid is written after the lock is taken — **OPEN, deferred**

The lock directory is created first and the pid file written into it a moment later, so a lock with no pid file is briefly reclaimable, and the reclaim treats a pid-less lock older than the grace period as stale. Nothing bounds the window between the two writes.

The reclaim now verifies the holder before it renames (A19), so a lock with a pid file is never taken from under a live holder; the residual window is the holder that has taken the name and not yet written its pid. **Deferred**, because the fix is not a small one: writing the pid file before the lock exists means the lock acquisition is no longer a single atomic `mkdir`, and a staging directory renamed into place has its own windows (a rename over an existing name behaves differently on Windows and on Linux). The cheap version — a longer grace — trades a stale lock for a long wait. Recorded here rather than shipped.

### 5 · 🟠 the wait budget comes from the waiter's file count, not the holder's — **CLOSED** (round 15)

A waiter judging one file waited its own budget while a holder judging twenty files was still working, then said "delete that directory if no run is alive" — advice that breaks a live holder's lock. The holder now publishes its file count in the pid file, `lockWaitBudget` takes it, and the contention message says how many files the holder is judging. Mutants **A34** and **A35** die on it.

### 6 · 🟠 the cached worktree is keyed by the base SHA alone — **DEFERRED**

With `RED_ON_PARENT_CACHE` set, `wt-<baseSha>` carries no repo identity, so two clones of the same base share one parent checkout and one lock.

The consequence is smaller than it looks: the same base SHA is the same commit and therefore the same tree, so the second clone judges the same parent sources, and the lock serialises the two runs, and the reset at the start of the second run clears the first run's copies. The case that would hurt — a shared cache root across two unrelated repositories — needs the same SHA, which git's content addressing makes impossible. The one-line fix (a repo fingerprint in the worktree name) is available and is **deferred** to a change that also moves the lock path, because the tests name `wt-<sha>.lock` in four places and the two should change together.

### 7 · 🟠 the reclaim's restore path orphans a live lock in a tombstone — **DEFERRED**

If the rename to a tombstone succeeds and the rename back fails because a third run took the name, the live holder's lock stays in the tombstone and its release does nothing. The tombstone leaks; the verdict is not affected, because the run that took the name is the one that judges. Reproducing the window needs a third run to take the name between two renames, and the test would have to time that window. **Deferred** as a known leak, not a wrong verdict.

### 8 · 🟠 the worktree directory is deleted recursively with no ownership check — **DEFERRED**

`rmSync(worktree, { recursive: true, force: true })` removes `<cacheRoot>/wt-<sha>` outright. The path is derived, not user-supplied, and — as in finding 6 — only a repository with the same base SHA can be there, which means the same tree. What is destroyed is a rebuildable checkout of a commit the gate can check out again. The manifest guard that protects the *copy* does not protect the *removal*, and that asymmetry is worth closing; **deferred** because the check (is this directory a linked worktree of this repository?) is a separate guard with its own test, and the current risk is a rebuild, not a loss.

### 9 · 🟠 `runGate` is exported and unguarded — **CLOSED** (round 14)

The bun check lived in `main`, so a library caller skipped it: under node every parent-side run is a whole-file load failure, and a waiver turns that into a PASS. The check now happens inside `runGate`, whoever calls it. Mutant **A33** dies on it.

### 10 · 🟡 the non-ASCII path is only ever listed, never run — **CLOSED** (round 16)

The suite proved a non-ASCII name reaches the gated set and nothing else. A new end-to-end test adds `packages/core/src/café.test.ts` and runs it through the whole gate, asserting `RIGHT-REASON-RED` and exit 0.

### 11 · 🟡 the waiver suite has no case for a bare-name pattern or a pathological pattern — **DEFERRED**

`matches` accepts the display name or the bare name, so a pattern anchored to the bare name also excuses a same-named test in another `describe`; and a pattern like `(a+)+$` is compiled and run against every test name, which hangs the gate with no timeout around it. The ReDoS case is **deferred** on the ground that the gate already runs the change's own test code under `bun test`, so a hostile change can hang CI without the waiver pattern — the waiver is not the cheapest way in. The bare-name case is a documented behaviour of `matches`, and a test that pins it would pin a shape the design has not chosen; that is a decision for the next round, not a bug fix.

---

## The coverage analyst

### 1 · 🔴 `VERDICT_GUIDE` is never imported or asserted — **CLOSED** (round 14)

The guide is filtered by exact name, so a typo silently deleted that verdict's fix text from the report. The suite now imports the guide and asserts that every verdict the gate can print has an entry, and that every entry has fixes. Mutant **A30** dies on it.

### 2 · 🔴 `changeSideVerdicts` has no unit test — **CLOSED** (round 14)

The whole decision surface — the unexcused `NOT_ON_PARENT` skip, the `RIGHT_REASON_RED` guard, the fall-through — was reachable only through two 60-second fixtures. It is now called directly with hand-built verdicts, for each shape.

### 3 · 🔴 the zero-added-files report path returns before any PASS/FAIL line — **CLOSED** (round 14)

A report that judged nothing printed neither PASS nor FAIL, and the exit code could not be read off the report. Every report now ends with `red-on-parent: PASS` or `red-on-parent: FAIL`, and the waived case says `PASS (n waived)`. Mutant **A29** dies on it.

### 4 · 🟠 six false-pass guards have no mutant — **PARTIAL**

The list was: the base already contains the head; `--head` is not the checked-out commit; `enumerateChange`; the `RUN_INCOMPLETE` branch; the bun check; the duplicate display-name counting. Four now have mutants — **A36**, **A37**, **A33** and **A41** (added in round 16) — and `enumerateChange` and the duplicate-name counting are covered by end-to-end fixtures. The last two have no dedicated mutant; **deferred**, because each of them needs a fixture that the current shape does not provide.

### 5 · 🟠 the ablation's pinning test is selected by a substring filter — **CLOSED** (round 16)

`-t` matches a substring, so A3's filter selected three tests and a red could be attributed to the wrong one. The summary now names the failing test on every line, and the attribution is visible in `summary.txt` rather than inferred from a count.

### 6 · 🟠 no test asserts the gate's core invariant — **PARTIAL**

The gate's worst failure is a test that is never judged, and every defence was a per-shape fixture. The change side is now compared test-for-test against the parent's list (finding 1 of the edge audit), which is the invariant in the shape that mattered. A blanket "the number of verdicts equals the number of change-side testcases" assertion is still missing; **deferred**, because the count is not stable by design: a waived test is one verdict, and a file-level waiver is one verdict for a file.

### 7 · 🟠 the e2e fixtures are one shape — **PARTIAL**

Every fixture was `packages/core/src/` in a `core` package, so the workspace-relative path handling was only unit-tested. Round 14 added a fixture with the added file under `apps/`, judged like any other. A fixture with added files in two packages at once is still missing; **deferred**.

### 8 · 🟡 the "NOT JUDGED" banner is unpinned — **CLOSED**

The banner is now asserted in the uncommitted-file fixture, which is the one a reader sees first.

---

## The quality reviewer

### 1 · 🔴 an assertion that fails inside a hook is read as `RIGHT_REASON_RED` — **OPEN, with a measured analysis**

A hook that *asserts* reports `AssertionError`, exactly like a test body, so the gate reads the file's red as the test's own. A hook that *throws* reports `Error` and is read as a wrong-reason red. The suite proved the thrown case and never the asserting one.

The parent measured both on bun 1.4.2 before deciding:

```
hook:  <testcase name="the body never runs" file="hook.test.ts" line="7">
         <failure type="AssertionError" ...>  at hook.test.ts:4:13
body:  <testcase name="the body fails"       file="body.test.ts" line="3">
         <failure type="AssertionError" ...>  at body.test.ts:4:13
```

The two reports differ only in whether the failing line is before or after the testcase's line. That is not a rule: a helper a test body calls fails at the helper's line, which is also before the testcase's line, so the rule would call a legitimate red wrong-reason. The honest discriminator needs the **enclosing function** of the failing line, which a line-based source scan does not give.

So the behaviour is not changed. Instead it is **stated**: the gate's header now says that a hook that asserts is read as the test's own red and why, the design doc's "Known limit of the red's attribution" records the measurement, and the round-14 test "a hook that asserts is read as the test's own red" pins it in executable form. The residual hole — a test whose body would have been green on the parent, behind an asserting hook — is real and is not closed.

### 2 · 🔴 the `verdictPasses` branches are untested — **CLOSED**

`verdictPasses` is now asserted for `RED_ON_CHANGE`, `SKIPPED_ON_CHANGE`, `NOT_ON_CHANGE` and `RUN_INCOMPLETE`, each with and without a waiver. Mutant **A41** (added in round 16) makes a run that did not finish pass, and the unit test dies on it.

### 3 · 🟠 the fixture's own timeout is longer than the test's — **CLOSED**

The fixture spawned the gate with a 120 s timeout inside a 60 s test, so a slow runner aborted the test while the child kept writing into a repo the `finally` had already deleted. The fixture's timeout is 45 s now, under the test's 60 s.

### 4 · 🟠 the concurrency test's name promises collision-safety and asserts reachability — **CLOSED** (renamed; see edge finding 3).

### 5 · 🟠 the reclaim fixture does not create the scenario its comment claims — **CLOSED**

The pid `999999` is not a running process, so the fixture never recreates a live holder taking the name. The comment now says exactly that: the fixture recreates what the code reads (the token, not the pid) and says it does not recreate the live half.

### 6 · 🟠 the async lock tests assert the helper's own phrase — **CLOSED**

Both tests assert the gate's own contention message and the exit code 2; the helper's phrase is no longer the assertion that carries them.

### 7 · 🟠 "main refuses under node" asserts only the exit code — **CLOSED** (round 16)

`bunOnlyRefusal` is now asserted to name the runtime to use, and to return nothing under bun.

### 8 · 🟡 the signing fixture asserts on itself — **DEFERRED** (cosmetic: it is a helper guard, correctly placed in the suite).

### 9 · 🟡 the lock tests leak temp directories — **CLOSED**: every lock fixture removes its directory in a `finally`.

### 10 · 🟡 the e2e timeouts are split across 60 s, 90 s and 120 s — **DEFERRED** (cosmetic; the fixtures' own timeout is 45 s and the tests' 60 s).

### 11 · 🟡 the `describe` blocks are named by review round — **DEFERRED** (the round names say which lens finding each block answers, which is useful while the rounds are the unit of work; renaming twelve blocks is churn with no change in what the suite proves).

---

## The mutant table

42 mutants, all RED. The full list, with the failing test named on every line, is in
`.scratch/reviews/297/ablations/summary.txt`; the per-mutant output is next to it.
| Range | What it covers | Added |
|---|---|---|
| A1–A8 | the first eight gate behaviours: red-on-change, timeouts, waivers, uncommitted files, waiver scope, skipped files, the manifest | — |
| A9–A17 | the file-level waiver, the exact file, the lock budget, the worktree reset, the import refusal, the type-only import | — |
| A18–A23 | the lock's identity token, the verify-before-rename reclaim, the skipped-on-change verdict, the dirty-tree refusal, the tombstone name, the unreadable pid file | — |
| A24–A27 | the bounded wait: no spin, the named module, the waived count in the last line, the deadline | — |
| A28–A31 | the round 14 verdicts: not-on-change, the verdict line, the guide entry, the not-on-parent suppression | round 14 |
| A32–A35 | the round 15 fixes: skipped-on-change, the bun check, the holder's file count, the wait deadline | round 15 |
| A36–A37 | the base that contains the head, the head that is not checked out | round 16 |
| A38–A40 | the ignored files the reset keeps, the comment strip, the waiver read before the refusal | round 16 |
| A41 | a run that did not finish failing the gate | round 16 |

## Commands

```
bun test scripts/red-on-parent.test.ts            # 124 pass, 0 fail
bun test apps/desktop/scripts/ci-workflow.test.ts  # 26 pass, 0 fail
tsc -p scripts/tsconfig.json --noEmit             # clean, exit 0
bun .scratch/reviews/297/ablations/run-ablations.ts # 42 mutants, all RED, exit 0
```

## Not checked

- The lenses read the commit `8a618ed9`, not the working tree that carries the round 14/15/16 fixes. Every "CLOSED" line above names the mutant that dies on the fix, so the closure is measured rather than asserted.
- The coverage analyst's and the quality reviewer's "could not verify" notes were not chased further: the `--base` message, the skipped-path notice and the `onlyFile` filter are each recorded in the design doc's limits section instead.
- No lens re-ran after this commit. The next round of the lenses runs on the head that carries these fixes.
