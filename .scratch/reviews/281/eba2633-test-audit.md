# Test-audit lens — PR #281 fix lane, re-run after clock fix

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

Head: `eba2633` on `fix-281-read-error-vs-theft`, verified with `git rev-parse --short HEAD`.
`git status` before I started: clean, nothing untracked.

## 1. `lock.ts` byte-identical to its parent — confirmed

`git diff 05c4b44 eba2633 -- apps/api/src/lib/vault/lock.ts` returns empty (exit 0, no
output). The only changes on top of `05c4b44` are the two prior round's review reports
under `.scratch/reviews/281/` and `lock.test.ts`. The author's claim holds.

## 2. No `readHeldLock` test rides the real clock against its window — confirmed, with one honest residue

Read the whole `lock.test.ts`, not a count. All five tests whose sequence could end on a
window comparison (now/min-sleep arithmetic inside `readHeldLock`) inject
`controlledClock()`: `clamps a negative or non-finite knob`, `keeps its patience…`,
`caps the held sequence…`, `caps the number of distinct codes…`, `caps the whole retry
window…` (hours knob), and `caps the attempt ceiling…`. None of them asserts a wall time
any more; every bound is asserted as a `clock.sleeps` array, and the hours-knob test lost
its last `Date.now()` comparison.

Residue, disclosed rather than hidden: the small-knob tests (`fastRead`: 3 retries × 1 ms)
and the two heartbeat tests still call `readHeldLock` with the default real `now()`/`sleep`
because `budgetEndsAt` is computed from `now()` unconditionally. They never assert wall
time, and their sequences total 3 driven ms against a 1 000 ms window, so ending early on
the window would need a ~997 ms mid-test pause — the same defect class F1 was, but with an
order of magnitude more margin than the ~200 ms slack that finding had. Their assertions
(count of reads at loss) could still be truncated by a loaded machine. Not blocking; the
commit's literal wording "no readHeldLock test in the file reads the real clock any more"
is true of the clock-compared set, not of every `readHeldLock` call site. A `now`/`sleep`
seam defaulting to real time in the `fastRead` tests is the remaining step if this class
comes back, and it is a test-only change.

The author also correctly leaves the boot-path tests (`bounds the boot-path read attempts…`,
`bounds the boot-path read delay…`) on the real clock: they go through `readOwner`, which
has no clock seam, and they are not `readHeldLock`. Their wall assertions are generous
(< 3 s against actual ~1.5 s).

## 3. Ablations, each applied alone to `lock.ts`, run, red recorded, restored, tree verified

Method: `cp lock.ts /tmp/lock.ts.bak`, single-constant `sed`, run the one filtered test,
restore from the backup, `git status --porcelain` + `git diff --stat` clean between every
mutation. The commit message claims five ablations (the brief named three); I ran all five.

| Mutation | Test | Result | Time |
|---|---|---|---|
| `DEFAULT_TRANSIENT_READ_RETRIES` 10→5 | keeps its patience… | RED: `VaultLockLostError` at `expect(...).not.toThrow()` | 13.49 ms |
| `MAX_RETRY_DELAY_MS` 500→3 000 | caps the whole retry window… (hours knob) | RED: `VaultLockLostError` at the same assertion | 19.54 ms |
| `MAX_RETRY_ATTEMPTS` 100→50 | caps the attempt ceiling… | RED: Expected 101 / Received 51 | 12.81 ms |
| `MAX_REASON_CODES` 5→3 | caps the number of distinct codes… | RED: Expected to contain "+96 more" / received "…+98 more after 101 attempts" | 12.93 ms |
| side claim: ceiling condition dropped to `if (now() >= budgetEndsAt)` | caps the attempt ceiling… | RED: Expected 101 / Received 1001, terminated at the window in 16 ms — no hang, the clock-step property observed | 16.33 ms |

All quoted failure shapes and temperatures match the commit message's own ablation log
(12/20/13/28 ms claimed; I measured 13.5/19.5/12.8/12.9/16.3 ms). Each mutation was a clean
1 insertion/1 deletion diff, so no over-reach, and the tree was byte-identical after every
restore (verified with `git status --porcelain` and `git diff --stat` after each one).

## 4. Wall times of the three tests when driven (bun-reported, filtered single-test run)

- `keeps its patience…`: **19.36 ms**
- `caps the whole retry window…`: **20.38 ms**
- `caps the attempt ceiling…` (the third driven test whose ablation the commit names): **12.39 ms**

Full-suite confirmation of the same three: 8.99 / 21.48 / 5.05 ms. Compare the author's
"before" figures for the two that raced: ~950 and ~1 150 ms. The ~1 s of real sleeping is
gone — the `bounds the boot-path read delay…` test still spends 1 512 ms in the suite, and
that one is documented, out of `readHeldLock`'s scope, and stable.

## 5. Suite and typecheck

- `bun test apps/api/src/lib/vault`: **169 pass, 0 fail, 585 expect() calls** across 11
  files — matches the brief's expectation exactly.
- `tsc --noEmit` (`-p apps/api`): exit 0, no output.

## 6. Findings from the last round, closed?

1. **F1 — `keeps its patience…` rode the real clock (~200 ms slack): closed.** The clock is
   driven, the eight 100 ms asks are asserted as an array, and the ablation proves the test
   is bound by the attempt constant, not the wall. Wall time dropped ~950 → ~19 ms.
2. **The second low finding from the 05c4b44 round** (the hours-knob test racing the
   window): also closed — same mechanism, 20 ms measured, `MAX_RETRY_DELAY_MS` ablation red.
   The two additional tests Greptile flagged in this class are also driven, plus the two
   0 ms-delay tests the author drove proactively, and all five ablations red on isolated
   mutations.

New work this round: none blocking. The `fastRead` residue in §2 is an observation, not a
finding — the sequence margin is ~997 ms within a window of 1 000 ms against a 3 ms
sequence, and the author's scoped claim was about the clock-compared tests.

## Verdict: MERGE

Spec 10/10 — every window/ceiling/cap claim in `readHeldLock` is now either arithmetic on a
driven clock or covered by a red ablation at the constant that enforces it, and the
mutation evidence reproduces exactly as written.
Standards 9/10 — measuring discipline was honest (five ablations, per-mutation tree
verification, boot-path carve-out named in the commit); a point off for the small-knob and
heartbeat `readHeldLock` callers still holding the real default clock seam, which is the
only place this defect class can return from.

Nothing I could not verify, with the one deliberate boundary: I did not re-run the
`fastRead` residue analysis under mutation (only read it), because its exposure is a load
pause, not a constant, so no ablation applies cleanly.

Final tree state: `git status --porcelain` empty except this report file
(`.scratch/reviews/281/eba2633-test-audit.md`, untracked); `git diff --stat` empty; head
still `eba2633`. `lock.ts` restored from a byte-for-byte backup taken before the first
mutation. The lens left the tree exactly as found apart from this report.
