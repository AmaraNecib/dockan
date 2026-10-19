# Code review — PR #289 (`e72e688`) for issue #287

Reviewer model: glm-5.3-flash-free
Author model: deepseek-v4.1-flash-free

Read-only review. Nothing committed, nothing pushed, no e2e run.

## Scope and base correction

The local `develop` ref is stale at `b16dfbb` (the pre-#288 commit). The real
merge base of this branch with `origin/develop` is `fe8d7f7`, the #288 merge
(`fix-281-read-error-vs-theft`). So the reviewable PR diff is three files, not
the twenty the stale-base diff shows:

```bash
git merge-base origin/develop HEAD           # fe8d7f758389cd2f92ef251fce6e29aef2d5feb9
git diff origin/develop...HEAD --stat
#  .scratch/implementation/287-design.md |  64 ++
#  apps/api/src/lib/vault/lock.test.ts   | 212 +++++++++++++++---
#  apps/api/src/lib/vault/lock.ts        | 127 +++++++++-----
#  3 files changed, 333 insertions(+), 70 deletions(-)
```

The web (`apps/web/**`), `tests/e2e/vault.spec.ts` and the rest of
`lock.test.ts` belong to #281/#288 already on `origin/develop`; they are not
#289's to review. Everything below is judged against `fe8d7f7`.

## Commands run and counts

```bash
cd apps/api
bun test src/lib/vault/lock.test.ts   # 65 pass, 0 fail, 201 expect() calls, 6.68s
bun test src/lib/vault/               # 188 pass, 0 fail, 660 expect() calls, 100.78s
../../node_modules/.bin/tsc --noEmit  # exit 0
```

Probe suite (in the OS temp dir, imports `lock.ts` directly; not added to the repo):

```
PROBE-B: persistent EBUSY on a stale record -> VaultAlreadyLockedError, owner=undefined, 14 reads, file intact
PROBE-C: empty record -> acquisition reclaimed it; assertHeld on the same bytes lost after 9 reads
PROBE-A: release() called unlinkLockFile once after a `gone` read
4 pass, 0 fail
```

## Hunt results, one line each

- (a) read failure causing an unattested eviction/unlink — **one residual path**, `release()`'s `gone` branch (P3-3). The eviction this issue targets is closed.
- (b) sticky `blocked` latch locking the owner out of a free folder — **yes for a stale-but-unreadable record** (P2-1), not for a genuinely absent one.
- (c) classifier vs the #288 owed-release chain disagreeing on ownership — they agree on every terminal decision; **they disagree on `malformed`'s meaning** by design (P3-1).
- (d) transient EACCES/EBUSY treated as gone — **no**. `ENOENT` is the only `gone` (`lock.ts:248`).
- (e) 287-design.md still accurate — **no**, it describes the pre-#288 branch (P2-2, P3-2).

## Findings

### P1 — none

The failure mode #287 was chartered for is fixed. A spent read can no longer
reach the unlink: `readOwner` propagates `blocked` (`lock.ts:314-334`),
`reclaimStaleLock` returns `retry` before any rename (`lock.ts:664-671`), and the
`expected === undefined` arm of `isSameStaleOwner` now requires `!moved.blocked`
(`lock.ts:684-687`). No path in the changed acquisition code unlinks a record a
failed read left unattested. I could not construct a two-writer reachable through
the #287 guard.

### P2-1 — a persistent non-ENOENT read failure on an existing stale record is an indefinite boot refusal with the wrong diagnosis and no recovery

`readOwner` sets `blocked` on every non-ENOENT read error (`lock.ts:328-331`),
`reclaimStaleLock` refuses with `retry` while `blocked` (`lock.ts:664-671`), and
`acquireVaultLock` runs the whole loop three times then throws
`VaultAlreadyLockedError(readOwner(lockPath).owner)` (`lock.ts:780`). With every
read failing, that `owner` is `undefined`, so the caller throws
`VaultAlreadyLockedError(undefined)`, whose message is "another Dokan instance is
using this data folder" (`lock.ts:166-172`) and whose refusal page falls back to
`unknownOwner` / `fallbackHost` (`lock.ts` page copy; `main.ts:148`,
`main.ts:889`). No instance holds the folder. The file is never renamed or
unlinked, so nothing self-heals, and there is no operator-facing hint to delete
it — only a `VAULT_LOCK_RECLAIM_RACED` warn line the refusal page does not read
(`lock.ts:665-668`).

On `origin/develop` the same state booted: `readOwner` folded every non-owner
read into `undefined`, so `reclaimStaleLock` with `expected === undefined` and
`moved === undefined` returned `isSameStaleOwner === true` and unlinked the
stale record. #287 changes errno-unreadable from "reclaim" to "refuse", which is
the intended safety trade, but it also removes the only recovery and mislabels
the state. A user whose antivirus keeps `vault.lock` locked at boot gets told to
close an instance that does not exist, on every boot, forever.

Falsification (probe B): write a stale record, inject `readLockFile` throwing
`EBUSY`, call `acquireVaultLock({ readRetries: 1, readRetryDelayMs: 1,
stealSettleMs: 1 })` → throws `VaultAlreadyLockedError`, `.owner === undefined`,
`vault.lock` still present, 14 reads. The adapted tests
(`lock.test.ts:1026-1060`) assert exactly this (`toThrow(VaultAlreadyLockedError)`
and the file still `{ not json`), so the behavior is pinned — the diagnostic and
the missing recovery are the findings, not the refusal itself.

Cause: the guard conflates "unreadable because a live holder owns it" with
"unreadable and provably nobody does". Fix options: refuse with
`VaultLockUnavailableError` carrying the errno (a distinct refusal page that says
the lock file could not be read), or allow a bounded forced reclaim after N
consecutive boots, or at minimum log the record's own untaken path.

### P2-2 — `.scratch/implementation/287-design.md` describes the pre-rebase branch, including the held-path contract that is now the opposite

The High-assurance design record is the document a future maintainer reads to
learn who may unlink. Post-#288 it is wrong on the facts that matter:

| Claim | Post-rebase reality |
|---|---|
| "Base: `b16dfbb` (merge-base with `origin/develop`)" (line 9) | merge-base with `origin/develop` is `fe8d7f7` |
| `readOwnerFile` classifies one read (line 33) | the function is `readOwnerOnce` (`lock.ts:229`); no `readOwnerFile` exists |
| "The held-lock reads (`assertHeld`, heartbeat, `release`) keep the previous owner-or-undefined contract through `readOwnerOnce`" (line 44-45) | `assertHeld` and `heartbeat` go through `readHeldLock` (`lock.ts:474`, `lock.ts:494`): bounded retry, wait-on-`malformed`, then fail closed. Only `release` still uses `readOwnerOnce` |
| "Three new tests" (line 54) | the diff adds 5 (`git diff origin/develop...HEAD \| grep -c '^+  it('` = 5) |
| "`lock.test.ts` 34 → 37 pass; vault dir 160 pass" (line 63) | 60 → 65 (lock), 188 (vault dir) |
| The whole document never mentions the #288 wait-on-`malformed` held path | it is the dominant behavior of `assertHeld`/`heartbeat` in the merged tree |

`tsc --noEmit` clean is confirmed; the other four counts are not.

Falsification:

```bash
git merge-base origin/develop HEAD
grep -n "readOwnerFile\|Three new tests\|held-lock reads\|b16dfbb\|160 pass" .scratch/implementation/287-design.md
git diff origin/develop...HEAD -- apps/api/src/lib/vault/lock.test.ts | grep -c '^+  it('
bun test src/lib/vault/lock.test.ts    # 65
bun test src/lib/vault/                # 188
```

The design file is in the commit, so it ships with the PR and will be the
record of a High-assurance change that misstates the fail-closed contract.
It needs a rebase-adaptation pass, not a rewrite.

### P3-1 — the classifier and the #288 owed-release chain disagree on what `malformed` means

This is deliberate (the type comment at `lock.ts:207-214` says so) but the
asymmetry is sharper than the comment admits. `malformed` means "possibly a live
writer mid-write": the held path retries it and never stops on it
(`readHeldLock`, `lock.ts:410-418`), while the acquisition path retries it and
then, on exhaustion, treats it as staleness evidence and reclaims it
(`readOwner`, `lock.ts:327-331`; `reclaimStaleLock` proceeds because
`settled.blocked` is false). The owed-release chain (`armOwedRelease`,
`lock.ts:613-621`) treats `malformed` as unremovable and retries forever, which
matches the held path, not the acquisition path.

Both paths do wait (`readRetries × readRetryDelayMs` ≈ 1s at defaults, then the
200ms settle) before differing, so the practical window needs a writer stalled
through ~1.2s on a zero-byte or partial record. When that happens, acquisition
renames the record aside, reads the copy as `malformed` with
`!moved.blocked` true (a successful read of non-record bytes), unlinks it, and
creates its own record. The stalled writer then holds an fd to an unlinked inode
and fails closed on its next heartbeat — an eviction of a conforming holder,
which is #281/#288's failure class. A boot refusing instead of progressing is
the counter-pressure, so this is residual, not a blocker.

Falsification (probe C): `readOwner` sees `""` → acquisition reclaimed the
record; the same bytes through `readHeldLock` → `assertHeld` threw
`VaultLockLostError` after 9 reads (`lock.test.ts:800` pins the held direction).
Fix: reuse the held path's terminal posture (refuse this boot, log the code) for
`malformed` too, or state in the acquisition comment that the asymmetry is
intended because a boot must make progress.

### P3-2 — the module header still calls a mid-write record `unreadable`

`lock.ts:43` ("a record caught mid-write are `unreadable`") and the option
doc at `lock.ts:121` ("or a record caught mid-write") were not updated when
`readOwnerOnce` split `malformed` out (`lock.ts:255-263`) and `readOwner`
stopped setting `blocked` for it (`lock.ts:327-331`). A maintainer who trusts
the header will believe a mid-write record blocks a reclaim; the code says the
opposite. The authoritative contract paragraph for the very behavior this PR
changes is the one place that still describes the old behavior.

Falsification: `grep -n "mid-write" apps/api/src/lib/vault/lock.ts` vs
`sed -n '251,266p;324,334p' apps/api/src/lib/vault/lock.ts`.

### P3-3 — `release()` unlinks after a `gone` read without attesting the record that may now be there

`release()` reads once; on `gone` it falls through to
`this.unlinkRecord()` (`lock.ts:549-560`). "Gone" means the read saw `ENOENT`,
not that the path is still absent at unlink time. Another process can acquire
between the read and the unlink (`openSync(wx)` succeeds precisely because the
file was absent), and `release()` then deletes the new owner's record. The new
owner fails closed on its next heartbeat read (it sees a disappearance), so this
is an eviction of a legitimate holder, not yet a second writer. This is the same
read→unlink window `armOwedRelease` documents as unavoidable
(`lock.ts:583-592`); `release()`'s `gone` path has no such note, and #287
rewrote the enclosing function without closing it. Pre-existing on
`origin/develop` (same `readOwnerOnce() === undefined → unlinkSync` shape), so
out of the #287 charter, but it is an instance of hunt (a) and should be
recorded.

Falsification (probe A): acquire a lock, force `readLockFile` to throw `ENOENT`,
inject `unlinkLockFile`, call `lock.release()` → the injected unlink is called
once (`PROBE-A: unlink called after gone read = 1`). Fix: after a `gone` read,
do not unlink; ENOENT from the unlink is the same outcome, and skipping it
removes the window.

## What is correct

- `ENOENT` is the sole `gone`; EACCES/EBUSY/EPERM/EIO are `unreadable`
  (`lock.ts:243-253`). Hunt (d) clean.
- `blocked` is per-`readOwner`-window, not module state, so a genuinely absent
  folder recovers on the next `openSync(wx)`. The test at `lock.test.ts:1026`
  proves the persistent-failure direction; `readOwner`'s early `gone` return
  (`lock.ts:319-321`) would otherwise burn the window on an absent file.
- Malformed stale records are still reclaimed (probe B probe 2), so the
  corrupt-lock recovery path the design promised is intact.
- The `blocked` guard is reached before the rename and before the unlink, so
  the expensive failure (two writers) is closed even though the cheap one (a
  refused boot) is now possible.

## Recommendation

Do not merge as-is for the design record and the P2 diagnostic: fix or annotate
the stale `287-design.md` (it is part of the commit), update the header comment,
and give the unreadable-stale-lock refusal its own error/diagnosis so a user is
not told to close an instance that does not exist. P3-1 and P3-3 can be
documented or deferred.
