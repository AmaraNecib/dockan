# Test audit — PR #288 (issue #281), head d318dc3

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model: zen-proxy/deepseek-v4.1-flash-free

Audited: `git diff 0c9aa7a..HEAD` and `git diff develop...HEAD` in `D:/worktrees/mani-project/t3-517123ff` (`fix-281-owed-release`). Every mutation below was applied, run, and reverted; the tree is byte-clean afterwards (`git status --short` empty, both source files re-checked out from the index). Read-only apart from this report and the transient mutation runs.

## Verdict up front

The two new tests genuinely pin what their commit says — both ablations fail on the exact assertion the pin exists for, and the commit's byte-identical claim is true. The gap is elsewhere: **the retry loop the whole feature is named after — the chain running past its first attempt — is not observed by any test.** A mutant that stops the chain after one attempt passes all 58 tests, as do the floor, the cap, and the arming condition. One P2 to fix, three P3s to note; none contradicts a claim the PR body makes.

## 1. The test-only claim — verified

`git diff 4f17ba6 d318dc3` is exactly two files: `apps/api/src/lib/vault/lock.test.ts` (+34) and `.scratch/reviews/281/4f17ba6-debate.md` (new, +66). `git diff 4f17ba6 d318dc3 -- apps/api/src/lib/vault/lock.ts` is empty. The commit message's claim holds as stated.

## 2. The two ablations — both red, both the right red

**Ablation A — drop the token guard in `armOwedRelease`** (line 549 inside `attempt`, `!==` guard disabled, `release()`'s own guard left intact):

```
lock.test.ts:1105  expect(fs.existsSync(lockPath())).toBe(true)
Expected: true     Received: false
[fail] never unlinks a record that comes back naming another owner (Greptile P1) [58.43ms]
```

The right red: the chain read the stranger's record, the guard was gone, the invariant the test documents was violated on disk. It is an assertion failure in the tested path, not a load error or hook throw. One incidental check this test also earns: `expect(reads.state.reads).toBe(readsAtResolution)` (line 1103) did **not** fail under this mutant — the count assertion catches a different mutant (a guard that treats a foreign owner as `unreadable` and re-arms), so the two assertions are complementary, not redundant. Sequence note: a mutant that unlinks on foreign token goes red on 1105; a mutant that re-arms on foreign token goes red on 1103. Both behaviours are pinned.

**Ablation B — `heartbeat()` returns after its read, before its write** (early `return` after `readHeldLock`, before the `ftruncate`/write block):

```
lock.test.ts:1014  expect(Date.parse(owner.heartbeatAt)).toBeGreaterThan(Date.parse(acquiredHeartbeatAt))
Expected: > 1792371574354     Received: 1792371574354
[fail] heartbeats through a transient read error instead of declaring the lock lost [73.36ms]
```

The right red, and it is the red the commit added the assertion for: the stamp froze at exactly acquisition's value while `reads > 1` and the token assertion stayed green — confirming the old form (token only) would indeed have survived a skipping holder.

## 3. Surviving mutants — the unpinned half

Full-file runs (`bun test apps/api/src/lib/vault/lock.test.ts`, all 58 tests) with each mutation applied:

| Mutant | Change applied | Full file outcome | Test that should have caught it |
|---|---|---|---|
| M5 | re-arm deleted from `attempt`'s unreadable branch — the chain is limited to exactly one attempt | **58 pass, 0 fail [2.85s]** — survives the entire suite | none |
| M1 | `Math.max(1, …)` floor removed from the first owed-retry delay | 58 pass, 0 fail | none |
| M2 | 30 s cap removed (`Math.min(MAX_OWED_RELEASE_DELAY_MS, …)` → bare `Math.max(delay + 1, delay * 2)`) | 58 pass, 0 fail | none |
| M3 | `armOwedRelease()` armed unconditionally, `onLost === undefined` no longer gates it | 58 pass, 0 fail | none |
| M4 | token comparison direction in `attempt` reversed (`!==` → `===`) | chain test red at line 1105 (unlink outcome) — caught | ✓ |

**P2 — the chain's retry itself is unpinned (M5).** "removes its own abandoned record once reads recover" passes only because `failingReads = fastRead.transientReadRetries + 2` lands recovery exactly on the chain's **first** attempt: acquire spends calls 1–4 (`retries = 3`), release spends call 5, and call 6 is the first recovery — so one attempt suffices and a chain that never re-arms is indistinguishable from the real one in both chain tests. The feature is "retry the release"; the number of retries > 1 is nowhere observed. Fix is cheap and count-based, no new timing exposure: in "removes its own abandoned record", fail one more read (`failingReads = fastRead.transientReadRetries + 3`, recover on call 7) and keep the existing `waitUntil(() => !fs.existsSync(...))` — M5 then dies because the record never disappears within the 1 s poll and M2/delay-growth mutants stay affordable through the existing count assertions.

**P3 — floor, cap, and arming are unpinned (M1, M2, M3), and the reason is structural.** `readHeldLock` got an injectable `now`/`sleep` seam, which is what lets "caps the whole retry window…" and "caps the attempt ceiling…" prove the held-path bounds by arithmetic. `armOwedRelease` runs on a real `setTimeout` with no seam, so pins for the floor and the 30 s cap can only be measured in real seconds (a 30 s+ test is not worth writing; a spinning 0 ms chain is not assertable by count). Same for the growth formula. If a future round touches the chain, giving it the same injectable clock `readHeldLock` has converts M1/M2/growth from unpin-nable to one-line arithmetic pins — the same move eba2633 already made for the held path. M3 is the mildest: arming without `onLost` is behaviourally invisible to every test (a timer armed inside an exit-hook `release()` never runs), and "release never deletes a lock file it could not read" is the test that would carry it if it ever matters (assert `reads` stays 1 after a settle).

`read.kind === "gone"` overloading in `attempt` (falls through to the unlink, ENOENT swallowed) was checked and left alone: a mutant that early-returns on `gone` is a semantic no-op (the path is already gone), not a miss.

## 4. Real-timer margins — measured, no fragile bound

| Test | Time across three clean runs | Reads on the relevant path |
|---|---|---|
| "never unlinks a record that comes back naming another owner" | 47–63 ms | 6 total: acquire 4 (3 × 1 ms sleeps, driven by the *real* fastRead delay), release 1, chain attempt 1 |
| "heartbeats through a transient read error…" | 73–81 ms | ~6 total: 1 failing + 1 recovering inside the first heartbeat, then 1 per tick for ~5 ticks in the 60 ms window |
| full file | 2.84 s / 2.90 s / 2.98 s | — |

- The heartbeat test's strict-greater assertion cannot flake on equal millisecond stamps: the earliest tick is ≥10 ms after the acquisition write (interval 10 ms; timers never fire early; ISO stamps resolve to 1 ms), so the compared values are ≥10 ms apart. Its only failure mode is zero successful heartbeats in 60 ms, which requires a >60 ms event-loop stall — the same stall that makes the pre-existing `reads > 1` red first. No new exposure added by this commit.
- The chain test's bounds are all "absence" bounds: `waitUntil` polls at 5 ms with a 1 s budget, and the 30 ms settle only expects nothing to happen. A loaded machine delays attempts; it never invents extra reads. Real risk skews the other way: under a stall a *mutant* that re-arms late could slip past the 30 ms absent-attempt window — an argument for the count-based P2 fix, which is stall-blind, not for any code change.
- The 60 ms hard sleeps are the file's only fixed waits plus a `1507 ms` boot-path test (deliberate, borrowed `stealSettleMs`), and the suite sits under 3 s.

## 5. Leaked timer containment — confirmed by read and by measurement

"fail-stops the heartbeat once the read error outlasts the budget" leaves the only unref'd never-stopping chain in the file (acquisition and release reads both fail; it re-arms toward the 30 s cap from a 1 ms start). Containment re-verified against this head's code: the chain re-reads through `lockFileReader(this.options)`, whose `readLockFile` is the per-test `countingReader` that throws before any `fs` access; `dir` is a per-test `mkdtemp` removed in `afterEach`, and the post-teardown attempts never touch the filesystem at all. Arithmetic on the leak's cost: delays 1 → 2 → 4 → 8…, cumulative >2.9 s by attempt ~13, so the leaked chain performs roughly a dozen no-op throws during the rest of the file's ~2.9 s — invisible in the measured runtimes above (three runs within 140 ms of each other). The reported ~2.76 s and my 2.84–2.98 s are the same number on different machines. No test's runtime is affected.

## 6. Quality of the two new tests

A−. Names state the invariant; the foreign-comment explains why the swap must precede the chain's first firing; the `SAFETY:` markers correctly record that the record JSON is test-authored. The foreign-owner stop now has three pins — "release never deletes a lock file it could not read" (unreadable, no `onLost`), "fail-stops when the lock file is replaced by another owner" (held heartbeat, immediate), and the new chain stop — on three different actors, so none of the three is duplicate coverage. The only structure an extra-rigorous reviewer would flag: the two new tests pin the first-attempt behaviour and the stop, while the multi-attempt behaviour (P2 above) survives on no test — one added failing read closes that.

## Synthesis

| Verdict | Count |
|---|---|
| Fix it (P2: observe the chain past its first attempt — M5 runs green) | 1 |
| Note (P3: M1/M2/M3 survive; pin requires injectable clock or new assertions) | 3 |
| Clean — ablations A and B, byte-identical claim, margins, leak containment, test quality | — |

No finding contradicts the PR body or the commit message; the strongest test-only statement the branch makes ("the chain always stops on a foreign token" / "the heartbeat stamp strictly advances") is now both claimed and pinned with red proof on both. The P2 stays open on M5: the *retrying* half of "retry the release" is looser than the body reads until one more failing read is counted.
