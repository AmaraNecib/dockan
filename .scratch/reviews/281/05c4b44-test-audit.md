Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

# test-audit lens — PR #281 at `05c4b44`

Head verified: `05c4b44` (`git rev-parse --short HEAD`), branch
`fix-281-read-error-vs-theft`, worktree `/d/worktrees/mani-project/t3-081f9b4f`.

## Verdict: merge — no blocking findings

All three author ablation claims reproduce, each turning exactly one test red.
The clock/sleep seam is production-neutral with the defaults. Three non-blocking
findings, two of them about the test suite rather than the diff.

## Ablations, applied and run by me

Baseline first: `bun test apps/api/src/lib/vault` → **169 pass / 0 fail / 582
expect() calls**, matching the author's count.

Each ablation applied to `apps/api/src/lib/vault/lock.ts`, verified present with
`grep` **and** `git diff --stat` before the run, run, then restored from a saved
copy and diff-checked.

1. **Drop `!Number.isFinite`** in `retryBudget` (line 279) → `lock.test.ts`
   **54 pass / 1 fail**. Red:
   `clamps a negative or non-finite knob to the safe end` —
   `Expected: 11 / Received: 1001`. Matches the claim exactly. With the driven
   clock the mutant still terminates (non-finite sleep asks advance time by 1 ms),
   so the test cannot hang.
2. **Drop the window bound** (both the loop condition and the sleep clamp) →
   **54 pass / 1 fail**. Red:
   `caps the held sequence at the one-second window even when the attempt
   ceiling cannot do it` — `clock.sleeps` grew from `[500, 500]` to 100 entries
   of 500 (`Received + 98`). Matches "100 sleep entries instead of 2".
3. **Drop `seenCodes` dedupe** → **54 pass / 1 fail**. Red:
   `names every error code it hit, on one line` —
   `Expected: "EBUSY, EACCES" / Received: "EBUSY, EACCES, EBUSY, EACCES"`.
   Matches the claim exactly.

After each restore: `diff -q` against the saved original → byte-identical;
`git diff HEAD --stat` → empty; final `bun test apps/api/src/lib/vault` → **169
pass / 0 fail / 582 expects**. `apps/api` `tsc --noEmit` → exit 0.

## Production neutrality of the seam

Read, not assumed. In `readHeldLock`:

```
const now = options.now ?? realNow;
const sleep = options.sleep ?? realSleep;
```

with `realNow = () => Date.now()` and `realSleep = Bun.sleepSync`. Those are
resolved once per call and sit at the same three sites the old code used
`Date.now()` / `Bun.sleepSync` (`budgetEndsAt`, the loop condition, the sleep
clamp). No call site changed. With the defaults the behaviour is identical;
passing no `now`/`sleep` is what every existing test in the file does. Nothing
in `lock.ts` other than `readHeldLock` was moved onto the seam — `readOwner`
(boot path) and `heartbeatIsFresh` still use the real clock directly.

## Is the seam pinned?

Yes, both halves, though differently:

- `sleep` is pinned **directly**: both driven tests assert `clock.sleeps`
  contents; a loop that ignored `options.sleep` would leave the array empty and
  go red.
- `now` is pinned **indirectly**: the window test (retries clamped to 100,
  delay clamped to 500 ms, never-recovering reader) ends at read 3 only because
  `now()` advances with the driven sleep; on the real clock it either blows the
  default 5 s bun timeout or records 100 sleep entries, both red.

## Timing-dependent assertions the driven clock does *not* cover

The driven clock removed the race from the NaN-attempt and window tests, which
is what Greptile P2 asked for. Residual real-clock assertions in this file:

- `keeps its patience at the default budget for most of a second` — 8 real
  100 ms sleeps must complete inside the real 1 s window (it asserts read 9).
  That leaves roughly 200 ms of total overhead slack across 8 iterations; a GC
  pause or a slow runner can push the window over and cut the loop short.
  This is the same class of race as the old NaN assertion, at lower amplitude.
- Three real-elapsed backstops: `caps the whole retry window…` (`< 2000 ms`),
  `bounds the boot-path read attempts…` (`< 3000 ms`), `bounds the boot-path
  read delay…` (`< 3000 ms`). The read counts are deterministic; only the
  elapsed bounds ride the clock, with 2×–3× margin.
- Five real-timer async tests (`await 60–80 ms` with 10–20 ms heartbeat
  intervals) assert that the heartbeat fired. 4–6 firings of margin, but real
  time.

## Findings

- **F1 (low, non-blocking)** `keeps its patience…` still races the wall clock
  by ~200 ms; every adjudicated bound now uses the driven clock, this one does
  not. Drive it with `controlledClock()` and it becomes arithmetic like its
  siblings.
- **F2 (low, non-blocking)** `now`/`sleep` live on the exported
  `VaultLockOptions`, tagged `@internal` in JSDoc only. The public
  `acquireVaultLock` therefore accepts them, and a caller who passes a frozen
  `now` makes the one-second window never fire, leaving up to 101 attempts ×
  500 ms ≈ 50 s synchronous inside `assertHeld` (the write guard). No
  production caller does this — `main.ts` passes `{ logger, onLost }` — and the
  same caller could inject a blocking `readLockFile` or `sleep`, so the exposure
  is theoretical. It is an unenforced tag, not a reachable defect.
- **F3 (info)** The seam has no explicit assertion that the *defaults* are the
  real functions; equivalence is pinned behaviourally by every non-driven test
  in the file. Fine, worth knowing the pin is implicit.

## Spec / Standards

- **Spec 9/10** — all three ablation claims, the read count, the doc
  correction and the header comment are as described and reproduce. Nothing in
  the diff claims more than it holds. The one sentence added to the
  `transientReadRetries` doc (the stealing gap fails the holder closed, which is
  conservative rather than wrong) is accurate against the code.
- **Standards 8/10** — mutation-proof per guard, an exact reason slice instead
  of the old `toContain`, and a driven clock where it matters. Deductions for
  F1 (residual same-class race) and F2 (unenforced `@internal`).

## Not verified

- CI / Greptile / `test:e2e`: not run here, lane scope. The three real-elapsed
  backstops would be the shakiest under a loaded CI runner.
- The rebase onto `develop` was not audited for dropped `develop` content; that
  belongs to the code-review lens.

## Process note (this lane's hazard, not the diff's)

My first scripted A3 mutation (a multi-line `perl` regex) silently failed to
match because `lock.ts` has CRLF line endings, and the run reported **55 pass /
0 fail** — a green that looked like "the dedupe is unpinned". The guard is
asserting the mutation is on disk (`grep` + `git diff --stat`) before reading
any result; with that check A3 reproduces the claimed red. Worth recording
because a mutation that silently fails to apply is indistinguishable from a
surviving mutant, and an earlier lens here already had a mutation reach a
commit.

Lesson candidate: verify a mutation landed on disk before trusting its test
result — a no-op edit reads exactly like a surviving mutant, and CRLF files
break multi-line scripted mutations silently.

## Tree state at finish

`git status --porcelain` →
`?? .scratch/reviews/281/05c4b44-code-review.md` (the code-review lens's file,
not mine; left untouched).
No tracked modification: `git diff HEAD --stat` is empty and
`apps/api/src/lib/vault/lock.ts` is byte-identical to its pre-audit copy. My
only write is this report file; nothing pushed, no GitHub.
