# Code review — PR #288 (issue #281), head e34783e

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

Read-only lens. No commits, no pushes, no edits to the tracked tree; the only file this review
wrote is the one you are reading; nothing tracked was touched. The verified commands are
listed at the end.

## Scope

`git diff develop...HEAD -- apps/api/src/lib/vault/lock.ts` (+298 lines net), and the two
committed tests that pin the last fix (d318dc3, 526d322, both `lock.test.ts`-only —
`git diff d318dc3 HEAD -- lock.ts` is empty, byte-for-byte, so the e34783e/526d322/d318dc3
commits changed no production code). 4f17ba6's `lock.ts` hunk was re-read commit-by-commit:
its only source changes are the owed-release chain (field + `release()` arm +
`armOwedRelease` + `MAX_OWED_RELEASE_DELAY_MS`) and `realNow` → `performance.now()`. Those
are exactly the two claims in its message; nothing else rode along.

Wisdom read first: `process/a-lens-is-evidence-not-a-verdict.md` and
`process/name-the-lens-model-in-its-own-report.md` (they are on `develop`
(`b16dfbb`), not on this worktree's older base — read via `git show develop:...`,
before acting on anything this report says). The applied rules: every load-bearing claim
below was checked against the tree with one command, and the two model lines above carry
nothing between them.

Prior coverage (not re-derived, as instructed): the test-audit at d318dc3 verified both new
tests pin their claims and the ablation is red on the exact assertion; the debate at 4f17ba6
walked five interleavings and found none unsafe. This report assumes those, and re-checked
only the arithmetic that the P2 fold depends on (below). The two named process-wisdom files
did not exist in this worktree's checkout (`process/` is newer than the branch base); both
were read from `develop` — noted here so the gate can see the evidence trail honestly.

## Verdict

No P1, no P2. Three P3s, all diagnosability/testing-gaps, none blocking, none a
correctness regression against either of the two claims. The owed-release chain
specifically survives the four hunts below; the falsification paths that would have been
P1s are closed by the record geometry the chain itself documents.

## Findings

### P3-1 — the owed chain's read→unlink window is a (microscopic) stranger-record deletable race

`armOwedRelease.attempt()` compares the token on a successful read and calls
`fs.unlinkSync(this.path)` immediately after. Between the read and the unlink, a foreign
reclaim can rename this record aside and create its own; the chain then deletes a live
holder's record and the new holder fail-stops (`readHeldLock` sees `gone`) on a lock it
actually holds.

Why it is P3 and not a correctness bug, and why no deterministic falsification exists
without a new seam: the only non-token-matching record the chain can see at the path is the
chain owner's own abandoned record, and the reclaim geometry that would displace it with a
live holder's record while the token still matches is unreachable —

- same-host reclaim requires `holderIsLive()` → the pid probe answers `alive` for the
  still-running refusal process, so no same-host instance touches the record;
- a foreign-host reclaim requires the heartbeat to be older than `staleHeartbeatMs` (60 s),
  and the thief's `reclaimStaleLock` verifies the moved record still names the SAME stale
  owner before deleting — the sequence in which the chain's read succeeds *and* the thief
  wins the rename-create-unlink in the same microseconds is real but sub-scheduling-quantum.

It is the same window the pre-existing `release()` read→unlink pair has always had; the
chain adds a third copy of it, not a new kind. Concrete falsification attempt: a
`countingReader` that succeeds with the own token, then a `writeLock()` of a stranger's
record injected *between* the read and the unlink — there is no seam there (`attempt` reads
and unlinks back-to-back on one timer tick), so a deterministic red test would need a
test-only `beforeUnlink` hook in `lock.ts`. Cheaper and adequate: a comment at the unlink
site naming the window, so the next reader does not re-derive it. If the author prefers a
test to a comment, `beforeUnlink` is the seam to ask the parent for.

### P3-2 — the borrowed `attempt` ceiling claim in `readHeldLock`'s worst-case reason is accurate, but the owed chain quits silently on a failed unlink

`attempt()`'s unlink is wrapped in `try { fs.unlinkSync } catch { /* already gone */ }`. A
non-ENOENT failure (the same persistent `EACCES`, say) ends the chain with no log line and
no re-arm — the exact "owed but dropped" shape 4f17ba6's own P1 was about, one layer down,
at a severity one class lower: the abandoned record is still recoverable (the next boot's
pid probe answers `gone` for the dead pid, and `readOwner` on an unreadable record still
returns `undefined` → reclaimable, unchanged from before #281), so it is a diagnosability
gap, not stranding. Fix is one line —
`catch (e) { this.options.logger?.warn("VAULT_LOCK_RECLAIMED", `the owed release at ${this.path} could not unlink: ${oneLine(e instanceof Error ? e.message : String(e))}`) }`
— or re-arm once more with the backoff and log on the way out. Falsification: this needs
the same missing seam (unlink is not injectable), so the prerequisite is routing the
`unlinkSync` through a field defaulting to `fs.unlinkSync` and documented `@internal` (the
same pattern as `readLockFile`); a test whose chain read succeeds while the path is a
directory held open is red today on the missing log line and green with it.

### P3-3 — the chain's `gone` branch is unpinned

`attempt()`'s chain resolves with a silent `unlinkSync` ENOENT on `read.kind === "gone"`.
The behavior is correct (nothing to delete, ENOENT caught) and the doc comment states it
("a gone file is left to the unlink's own ENOENT"), but no test drives it: grep confirms
two owed-release tests (`removes its own abandoned record`, `never unlinks a record that
comes back naming another owner`) cover the unreadable→own-token and unreadable→stranger
flow, and neither makes the file vanish *before* the chain's first attempt. Falsification
for the current code's comment-vs-code gap (i.e. the missing pin, not a missing behavior):
copy the first P1 test, add `fs.rmSync(lockPath(), { force: true })` right after the
`lost).toHaveLength(1)` assert, and keep the reader failing forever. To make it a pin that
could actually go red, add one more expect on the reader's call count after the `rm`: with
behavior as written, the count must stop growing entirely (the chain must not re-arm on
`gone`) — this pin against today's tree passes, so the finding is the absence of the
assertion, not a defect in the assertion.

### Explicitly checked and closed (with the grep/test that closes each)

- "A path where the owed-release chain unlinks a live holder's record", other than the
  P3-1 window: closed. `holderIsLive()` refuses every same-host reclaim while the refusal
  process is alive (its pid probe answers `alive`), and foreign-host reclaims verify the
  token of the record they are about to delete. `grep -n "token !== this.owner.token" lock.ts`
  shows the stop in both `release()` and `attempt()`.
- "An unbounded or duplicated chain": closed. `if (this.owedReleaseTimer !== undefined) return`
  guards arming; `release()` is idempotent on `this.released`, so the exit-hook/release
  pairing cannot arm a second chain; the field is per-instance; the interval is capped at
  `MAX_OWED_RELEASE_DELAY_MS` (30 s) and the timer is unref'd, so it never holds a closing
  process and never spins (the `Math.max(1, ...)` floor is the 0-ms-knob guard).
- "Whether the P2 fold really makes the re-arm load-bearing": closed by arithmetic and by
  the audit, not by assumption. With `fastRead` (`transientReadRetries: 3`),
  `failingReads = +3 = 6`: the held budget spends 4 (`readHeldLock`),
  `release()` spends 1, and the chain's first attempt spends 1 (6th) — which FAILS, so a
  single-attempt chain (no re-arm) would leave the record and `waitUntil` would time out;
  recovery lands on chain attempt 2 (read #7), so the re-arm is load-bearing in both tests:
  `removes its own abandoned record` needs it (re-arm), and the no-re-arm-world dies at the
  exact assertion the d318dc3 audit says it does (test-audit P2, verified red).
- "Error paths that swallow an ENOENT/EACCES distinction": no swallow found in the branch's
  own changes. `readOwnerOnce` classifies `ENOENT` on the raw thrown value (so the bare
  `{code}` seam keeps its errno), `readHeldLock`'s loss reason carries the distinct codes,
  and `VaultLockUnavailableError` wraps the original error at the only place an
  acquisition-side throw reaches a caller. The one real collapse is pre-branch and
  unchanged: `readOwner` on an unreadable record → `undefined` → reclaimable (its comment
  says so, and behavior predates #281), so an antivirus-held lock that 3 rename attempts
  also fail on surfaces as `VaultAlreadyLockedError` with `owner === undefined` and the
  misleading "another Dokan instance is using this data folder" message — blamed on
  nobody, framed as a rival instance. P3 residual wart, not this PR's finding; if the parent
  wants it, it is one follow-up issue with the same shape as P3-2.

## Commands run and their counts

```
git log --oneline develop..HEAD                  # 13 non-merge commits on the branch
git diff develop...HEAD --stat                   # 12 files, +2180/-30 (2 source/test files + reports)
git show develop:.agents/wisdom/process/         # the two named wisdom files, read via git show
git show 4f17ba6 -- apps/api/src/lib/vault/lock.ts   # owed-release + performance.now only; nothing else
git show d318dc3 --stat   # lock.test.ts +34, 4f17ba6-debate.md +66 — test-only confirmed
git show 526d322 --stat   # lock.test.ts +5/-3 — test-only confirmed
git show e34783e --stat   # test-audit doc only
git diff d318dc3 HEAD -- apps/api/src/lib/vault/lock.ts | wc -l   # 0 — lock.ts byte-identical since
git diff develop HEAD -- apps/api/src/lib/vault/lock.ts | grep -c "^+"   # 298 added lines

bun test apps/api/src/lib/vault/lock.test.ts     # 58 pass / 0 fail, 172 expects, 2.81 s
bun test apps/api/src/lib/vault                  # 172 pass / 0 fail, 599 expects, 83.39 s (11 files)
./node_modules/.bin/oxlint apps/api/src/lib/vault/lock.ts apps/api/src/lib/vault/lock.test.ts
                                                 # exit 0, no findings
bun run typecheck                                # 4/4 successful (api:tsc uncached run, 6.3 s)
```

No ablations were re-run here — the d318dc3/4f17ba6 audit evidence covers them, and doing
so would have required writing to the tracked tree this lens promises not to touch. The
arithmetic behind the one ablation that matters to this round (P2 fold, above) was
re-derived from the test body, as the audit instructs.

## For the parent

The gate inputs: no P1/P2, three P3s, one of which (P3-3) is a missing pin rather than
missing behavior, and two of which need a small injectable seam the author may prefer to
leave to a follow-up issue rather than add mid-review. Recommend folding P3-2's and
P3-3's one-line fixes into the branch if the author is still in the tree, and filing the
pre-existing `owner === undefined` message wart (P3-2 closable, the message one needs a
decision about who owns the copy) as its own issue either way.
