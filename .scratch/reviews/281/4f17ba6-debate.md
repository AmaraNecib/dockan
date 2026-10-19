# Debate — PR #288 (issue #281), head 4f17ba6

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model: zen-proxy/deepseek-v4.1-flash-free

Diff reviewed: `git diff 0c9aa7a..HEAD` (the two-stage 0c9aa7a→4f17ba6 tail of the branch) plus `develop...HEAD` for context. Full read of `apps/api/src/lib/vault/lock.ts` and `lock.test.ts`, plus `main.ts:69-77` for the reachability premise and commit 2059677 (#287's head) for the cross-lane overlap. Read-only; nothing outside this report was touched.

## Verdict up front

The fix is sound. Every path the three attacks name resolves to a safe ending, and I could not construct an interleaving where the owed-release chain deletes a record it should not. The two findings below are real but both are cheap: one unpinned load-bearing guard, one rebase trap. Clock change and the heartbeat pin are correct as written.

What I verified before disagreeing with anything:

- The P1 premise is reachable in production: `main.ts:69-77` sets `onLost` and keeps the process alive to serve the refusal page, and the lost-path `lost()` → `release()` performs exactly one production read (`release()` stays one `readOwnerOnce`, lock.ts:499, unchanged by this commit). A sustained unreadable record then stranded a live-pid file — the stranding class the commit message claims is real, and the fix reaches it.
- Commit-message claims check against the code: armed only when `onLost !== undefined` (lock.ts:508) ✓; delay floored at 1 ms (533-536) ✓; capped at 30 s (lock.ts:100, 544) ✓; unref'd on every arm (546, 557) ✓; the "topped at 500 ms initial delay via `retryBudget`'s ceiling" holds (535) so the backoff sequence is 1→2→4→…→500→30 000. No overstatement found in the commit body.

## Findings

### P2 — the chain's "another owner's token → stop, never unlink" guard is unpinned

**Where:** lock.ts:549-555 (`attempt`'s owner branch); no test exercises it. The nearest existing pin, `lock.test.ts:369` ("fail-stops when the lock file is replaced by another owner"), covers the heartbeat's read, not the owed-release chain.

**Sequence that makes this load-bearing, not hypothetical:** within this head, an unreadable record held by a *live* process is still reclaimable by a second instance — `readOwner` answers `undefined` for it (readOwner loops `readOwnerOnce`, all reads error, returns `undefined`, lock.ts:319-333), the acquire path's holderIsLive check is skipped because there is no owner to probe (414), the settle read repeats it, and `reclaimStaleLock(…, undefined)` sees `expected === undefined && moved === undefined` (unsettled EBUSY reads count as `undefined` both before and after the rename, 588-591) → "reclaimed" → the second instance unlinks the displaced record and creates its own. So after the reclaim, `this.path` holds a **stranger's live record**, and the old chain's next fired attempt reads exactly that. The guard then sends a stranger's token → return → the new owner's file survives. Remove that guard (or the whole `owner` branch) and the chain unlinks a second owner's live lock file while that owner writes its snapshot — two writers, the exact outcome the whole module exists to prevent. A one-mutation test is all this costs: arm the chain against a never-recovering reader, replace the record with a foreign token behind the reader's back, let the chain resolve, assert the file still exists and still names the foreign token.

Defender note (and it stands): the guard is present and correct; this is a pin-not-code finding. The classification lands in test-audit's lane too — flagged here because it is the safety-critical half of the feature this commit adds.

### P2 — #287 rebase collisions (process, not this head's code)

#287's head (2059677) touches the same functions from an older base and is waiting on this branch. Three specific collision points for the rebase to not lose:

1. **The name `readOwnerOnce` survives both branches with different signatures.** This head: `(lockPath, reader) → LockFileRead` — classified, with #281's injectable seam, and it is the seam `release()` (466, 503) and the new chain (542) depend on. #287: `(lockPath) → VaultLockOwner | undefined` — a wrapper whose classification moved into a new `readOwnerFile`. Git can merge this textually while dropping this head's `reader` parameter, which removes the injectable seam from production signatures and breaks every test that injects `readLockFile`. The rebase must land this head's signature and #287's four-way kinds (`owner/gone/malformed/unreadable`) in the same function.
2. **`armOwedRelease`'s attempt must survive the kind split.** This head treats `malformed` as `unreadable` and waits. Post-rebase with #287's split, that conservative reading is still the right one for the chain — wait on `unreadable`, and on any finite-looking `malformed` wait too, because a reclaim caught between its create and its write surfaces as malformed content, and a *permanent* malformed record is handled anyway by #287's `blocked` guard at the reclaim site. If the rebase maps `malformed` to "stop", a torn write in the reclaim window strands the record again.
3. **The stranding closure stays #287's job.** This commit's own body and #287's body agree on the division: this head removes the *stranding* (the record no longer outlives a live refused process), it does not close the *reclaim race unlink* (a second instance can still rename a live holder's unreadable record aside — finding-1's sequence is the same reachability). The rebase of #287 onto this head must carry #287's `blocked` flag through `readOwner` without this head's chain needing any change — the chain never consults `reclaimStaleLock`.

### P3 — teardown: the exit hook does not cancel a pending chain, and that is fine

If the process exits while a chain is pending, the "exit" hook's `release()` early-returns on `released` (the chain was armed by that same complete release) and nothing cancels `owedReleaseTimer`. It dies with the VM because it is unref'd — the "beforeExit"→"exit" window never fires another timer callback, and `process.exit` (the no-`onLost` path, lock.ts:484) tears down unreferenced handles. No `fs.unlinkSync` runs at teardown. Documented intent ("it never keeps a closing process alive") holds.

### P3 — the 30-second-cap containment is real; one test leaks a chain for the file's remainder

The mechanism under the cap is a re-read of the same path, not a resource: no temp file, no second dir, no FD held across attempts (the fd was closed before `release()` armed anything). Verified against `lock.test.ts:1013` ("fail-stops the heartbeat once the read error outlasts the budget"): `onLost` is set, the injected reader never recovers, so the armed chain re-arms forever at the capped cadence. Containment checked property by property: (a) the chain reads its own per-test `mkdtemp` dir, deleted by `afterEach` — its first post-teardown read hits the injected reader, which throws before any fs access; (b) it is unref'd, so the bun test process exits with the leaked timer, and the leaked chain never touches a later test's path or a shared tmpdir (`dir` is fresh per test, lock.test.ts:13); (c) `countingReader`'s state is per-test, so post-assertion increments land in a closure nobody re-reads. Residual cost: one no-op throw every ≤30 s during the remainder of the file run. A `waitUntil`-style drain only becomes worth writing if a future runner starts flagging open handles — not now.

### P3 — clock change: verified clean; the deliberately-untouched line verified untouched

`realNow` → `performance.now()` (lock.ts:223). The retry path's only time-bearing values are `budgetEndsAt` and the sleep clamp `Math.min(delayMs, Math.max(0, budgetEndsAt - now()))` — both from the same monotonic source, both in-memory, and the interval check (`now() >= budgetEndsAt`, 380) runs before the clamp, so no negative sleep sneaks through. Nothing in the retry path reads, writes, or compares a persisted value: `heartbeatAt` is touched only by `heartbeatIsFresh`, which the diff does not go near. Old file line 282 (`const age = Date.now() - heartbeat;`) is now lock.ts:301 — byte-unchanged, and leaving it is correct: the stamp is a persisted ISO wall-clock string, and swapping it to a monotonic reading would make `age` roughly the process uptime, so foreign-heartbeat and EPERM-path reclaims would answer "fresh" forever — a liveness break in the direction no current test watches. The commit's "Not touched, deliberately" framing matches the code.

### P3 — the heartbeat pin's timing slack is the same slack it already had

lock.test.ts:990-1017. Strictly-greater catches the "recovered-then-skipped-its-write" holder: acquisition wrote `T`; every subsequent successful heartbeat writes a fresh `new Date().toISOString()` strictly after `T` (first tick fires ≥10 ms after it), so a skipping holder leaves the file stamp frozen at `T` and the assertion goes red — the ablation in the commit body ("heartbeat() returns after its read, before its write" → Doctored: expected > received equal) demonstrates exactly that shape. Flake surface: the test's 60 ms window vs 10 ms interval gives six tick chances, and the assertion shares its failure mode with `reads > 1`, which the test already carried before this commit — no new timing assumption was added. The `ftruncate → write` tear is unreachable because both heartbeat and the test's `readFileSync` run on one thread with no yield between them. Only real exposure: a runner with multi-second GC pauses inside the 60 ms window, which is the pre-existing test condition, not a regression.

### Dismissed (argued, then dropped)

- **"The timer that unlinks files" — five interleavings named in the brief, each walked:** (1) timer in the shutdown window: attempt is synchronous, and unreferenced timers do not fire past the exit event — safe; (2) file replaced read→unlink: the only module-internal actor that can rewrite the path while the record is *readable* must first get past holderIsLive on our own live pid, which `acquireVaultLock` refuses and `reclaimStaleLock` never reaches (`reclaimStaleLock`'s actor checks the *record's* pid, and our record names ourselves, which cannot answer "gone" while we run) — the TOCTOU is closed by pid identity rather than atomicity, which is the strongest defense this module has; a *manual* replacement is outside the module's threat model; (3) two chains: `release()` is idempotent and `armOwedRelease` is reachable only through it — one chain per instance; two instances (lost + re-acquire) each hold their own token, and the stale chain reads the new token and stops; (4) re-acquire then chain fire: within one process, `acquireVaultLock` is fully synchronous (`openSync`+`writeSync`, no await), so the event loop is blocked and the timer cannot interleave into the create→write window; across processes the attempt sees either torn content (malformed → keep waiting) or the finished new token (stop) — it never unlinks the new record, and reclaim's rename removes our record before its unlink touches anything (any ENOENT is swallowed, 554-555 → 558-560); (5) `onLost` firing twice: after the first `lost()`, `released` short-circuits `heartbeat()` and `assertHeld()`, and the second `release()` returns at the top (486) — impossible.
- **Owed-release chain silent on its outcome (no log on deferred-unlink success or token-mismatch stop).** A diagnosability gap an operator could notice from the log alone — but adding an event would step on the module's own stated rule that the log vocabulary is a shared contract ("a new event code is not this module's to add", readHeldLock's comment). Dismissed; the parent can revisit it as its own issue if it wants a JSONL breadcrumb for the deferred cleanup.
- **The initial owed-retry delay reuses the held-read knob (`transientReadRetryDelayMs`).** Both mean "how long to wait before re-reading an unreadable lock", the floor stops the 0 ms spin, and the ceiling is shared with `MAX_RETRY_DELAY_MS`, so a hostile knob cannot out-stall one or the other. Cost of separation exceeds value.

## Synthesis counts

| Verdict | Count |
|---|---|
| Fix it (P2 pin for the chain's token guard) | 1 |
| Fix on rebase, not here (#287 collision notes) | 1 |
| Dismissed with reasons | 3 |
| Sound as written (clock, heartbeat pin, teardown, containment) | — |

No finding required calling the author wrong about anything the commit message claims; the only statement that would overstate this head ("closes the stranding class" is accurate; it does not, and does not claim to, close the reclaim-or-live-unlink — that is #287's lane).
