# Code-review lens, round 2 — PR #281 at `05c4b44`

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

Head verified: `git rev-parse --short HEAD` = `05c4b44`, branch `fix-281-read-error-vs-theft`.

## Verdict: merge — no blocking findings

**Spec and Standards: 9/10.**
**Blocking: no.** Everything below is nits.

## Tests I ran myself

- `bun test src/lib/vault/lock.test.ts`: **55 pass / 0 fail, 155 expect calls** (4.6 s).
- `bun test src/lib/vault/lock.integration.test.ts`: **4 pass / 0 fail, 20 expect calls** (22.7 s).

Both on this machine, in `apps/api`, at restored HEAD. The first `lock.test.ts` run returned 54/1; that single failure was caused by a UFO mutation sitting in the worktree, not by the branch (see "Mutant caught in the tree" below) — restored, it passes, and the count above is the valid one.

## The seam (`now`/`sleep` options)

- **Minimal.** Used at exactly two lines (`lock.ts:331-332`), read once per `readHeldLock` call. No other call site in `lock.ts` takes the seam; `heartbeatIsFresh` keeps `Date.now()` and the heartbeat timer keeps `setInterval`, which is right — the seam only needs to cover the loop whose bounds the tests assert by arithmetic.
- **Default path unchanged.** `realNow` is `Date.now()`, `realSleep` is `Bun.sleepSync(ms)` — the same calls the pre-`05c4b44` code inlined. The sleep amount expression is byte-identical (`min(delayMs, max(0, budgetEndsAt - now()))`), so the re-read of the clock between the window check and the sleep exists in both versions. No behaviour moves when the defaults are used; the wall-clock test "keeps its patience at the default budget for most of a second" still runs on the default seam and passes at ~0.8 s of real sleeping.
- **Reachability.** Grep over `apps/api/src` excluding tests: no production caller passes `now` or `sleep`. Anything reaching in would have to name the options explicitly; the doc marks them `@internal`. The only loose edge: the type is public, so a caller that supplies only `sleep` and not `now` halves the mixed clock domains (`sleep` driven, `now` real). Nobody does, and both supply-or-omit is coherent, so I rate this a nit: **[nit] the seam harnesses no runtime fence — a mixed `sleep`-only injection is blocked by the `@internal` doc alone.**

## Rebase integrity

The PR diff vs develop (`696178b..HEAD`) touches only `lock.ts`, `lock.test.ts` and the branch's own `.scratch` artifacts. `main.ts`, `boot-loss.ts`, `boot-loss.test.ts`, `broker.test.ts`, `lock.integration.test.ts`, `port-record.test.ts` and ADR-0012 are byte-identical to develop — #279 arrived through the merge base, not through this branch, and nothing of it was dropped. Inside `lock.ts` the merged state carries all the liveness work I checked for: `probePid` injection, `holderIsLive`'s round-5 rule (alive probe beats stale heartbeat), the future-dated-heartbeat refusal, `requireHeldLock`, and the acquisition path's two-check settle. The integration suite exercises the "loser neither exits nor checkpoints" behaviour and passes.

## Driven-clock tests

- NaN clamp test asserts `readsAtLoss = 11` and `sleeps` = ten exact `100` entries. Traced: `retryBudget(NaN → fallback)` gives 10 × 100 ms against a 1 000 ms window, so the attempt ceiling fires first at read 11; the assertions are pure arithmetic on the driven clock, no wall clock anywhere. Static race from the last round closed.
- Window test asserts `sleeps = [500, 500]` and `readsAtLoss = 3`: attempt 0 and 1 each sleep 500, attempt 2 lands at `now() === 1000` and the window ends it. Exact.
- The dedupe assertion slices `reason` between `(` and `" after"`; traced against the real reason format, it pins `seenCodes` as intended for these codes: **[nit] the slice is positional — an errno-style code literal containing `" after"` (any string passes `thrownCodeSchema`) would truncate the slice on a hostile-code test, though the production reason stays bounded and correct.**
- The header comment's new sentence is true of the code, on the argument I checked rather than took: a theft between the holder's read and its heartbeat rewrite cannot be written over by the holder, because the rewrite is `fd`-bound (`ftruncateSync`/`writeSync` on the open descriptor) — in the rename-aside case it lands on the displaced inode, in the delete case deletion is blocked by the open fd on Windows and the write lands on the unlinked inode — so the path keeps the new owner's record and the next read (next store write via `assertHeld`, or the next heartbeat) fails closed. The claim matches the mechanism.

## Findings

- **[high, for the site rather than the diff] a mutant for `retryBudget` sat uncommitted in the worktree mid-review** — see next section; on HEAD the guard is present and sane.
- **[low] comment precision in the NaN clamp test**: "only the 1 s window stops it, thousands of reads later" — I measured the window-bounded exit of exactly that mutant at 1 002 reads, not thousands; "about a thousand reads" would be accurate.
- **[nit] the `@internal` seam has no runtime fence** (mixed `sleep`-only injection possible; doc-only guard, no callers).
- **[nit] positional slice in the dedupe assertion** (code literal containing `" after"`).

## Mutant caught in the tree

The tree was clean when I started (`git status --porcelain` empty at `05c4b44`). Part-way through the review, `lock.ts` acquired an uncommitted edit: `retryBudget`'s `!Number.isFinite(configured)` guard removed, i.e. a NaN knob passed `Math.trunc(NaN)` raw through both knobs. `git show 05c4b44:...lock.ts` has the guard; the worktree briefly did not. This matches the exact hazard named in the brief — an earlier lens left a mutant in this tree and a lane committed it. My first `bun test` run failed on it (1001 reads driven by one-millisecond mutation sleeps); after ~2.5 min of polling it did not self-revert, so I restored the single file with `git checkout -- apps/api/src/lib/vault/lock.ts` (single-path, no other path touched), re-ran the suites above, and verified `grep` shows the guard again. The mutant's full diff is preserved here:

```diff
-  if (configured === undefined || !Number.isFinite(configured)) return fallback;
+  if (configured === undefined) return fallback;
```

## What I could not verify

- No e2e run, no full api suite — my scope was the two lock files. Nothing in this diff touches anything else.
- Which process produced the mutant, or whether it is still operating in this worktree. If a debate or test-audit lane is running here concurrently, it should be told that its `retryBudget` ablation is dead.
- `Bun.sleepSync`'s behaviour in the mutant scenario (`sleepSync(NaN)`) in production — moot on HEAD, where the guard makes the input finite by construction.

Final `git status` output is stated in my reply to the parent.

## Postscript, same session

Minutes after my restore, a **second** ablation landed in the tree: the `seenCodes` dedupe block in `readHeldLock` removed (mtime 00:21:40). So a concurrent ablation process is operating in this worktree, sequencing mutants — my earlier restore was not the last word and the two processes collided once. I left the second mutant in place: reverting it mid-ablation would corrupt the other lens's run, and its owner is responsible for restoring it. The mutant was:

```diff
-    if (!seenCodes.has(code)) {
-      seenCodes.add(code);
-      if (codes.length < MAX_REASON_CODES) codes.push(code);
-      else omittedCodes += 1;
-    }
+    if (codes.length < MAX_REASON_CODES) codes.push(code);
+    else omittedCodes += 1;
```

The other lens restored it itself: a final `git status` minutes later shows `lock.ts` clean, the only change in the tree being this report (untracked). Whoever reads a dirty copy of this tree in future: the observable effect of that mutant, if it ever survives again, is the flapping test's dedupe assertion failing with "EBUSY, EACCES, EBUSY, EACCES" in the reason — that is the mutant speaking, not the branch.
