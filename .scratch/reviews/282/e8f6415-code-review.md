# #282 — code-review lens, head `e8f6415`

Base `origin/fix-275-vault-lock-liveness`. Read-only reviewer
(`zen-proxy/deepseek-v4.1-flash-free` family, author-owned for fixing). Focused
run: `bun test apps/api/src/lib/vault/backup.test.ts` — 11 pass, 0 fail,
36 expect() calls, ~1s.

Diff: `apps/api/src/lib/vault/backup.ts` (+89/−11) and
`apps/api/src/lib/vault/backup.test.ts` (+159/−3). Four commits
(`7ad9627` guard, `3efdd42` lost-lock fail-stop removal, `cd22773` hook
isolation, `e8f6415` pin the hook actually fires).

## Scores

**Spec 9/10. Standards 9/10.** Both acceptance criteria are met with tests
that would fail if the guard regressed. The point off each axis is cosmetic
formatting in the test file (C1) and one doc over-claim the seam already
narrows (C2).

## Spec — against issue #282

AC1 "either the function takes the same guard, or a comment and a test state
why it is safe unguarded." It takes the guard, and the comment states why:

- `backup.ts:110` — `const lock = acquireVaultLock(dataDir, {` inside
  `extractVaultBackup`. This is the write site the issue named (`backup.ts:73`
  at the time); the two `writeFileAtomic` calls (`backup.ts:137`,
  `backup.ts:139`) now sit inside the lock's `try`.
- `backup.ts:136`, `backup.ts:138`, `backup.ts:142` — `lock.assertHeld()` before
  each write and once after the pair. Same instant-of-write discipline as the
  existing path: `apps/api/src/db/encrypted-connection.ts:216` calls
  `options.writeGuard?.()` immediately before its snapshot rename.
- `backup.ts:144-145` — `finally { lock.release(); }`, so the lock never
  outlives the function.

AC2 "if it stays unguarded, a test asserts it refuses when a lock is held by
another instance." Not by the letter (the function is guarded, so the letter is
the first branch) but by the intent: the refusal test exists anyway.
`backup.test.ts` "refuses while another instance holds the folder, and writes
nothing" takes the lock with `acquireVaultLock(target)` in a live same-process
holder, asserts `rejects.toThrow(VaultAlreadyLockedError)`, and then asserts
both `dokan.db.enc` and the `vault/` dir are absent — the empty-folder failure
mode. With the guard removed this test restores successfully instead of
throwing, so it is a real ablation, not a shape check.

Verified clean by inspection:

- **No new `VaultErrorCode`.** `git diff origin/fix-275-vault-lock-liveness..e8f6415`
  greps empty for `errorcode`; the guard throws the lock module's own
  `VaultAlreadyLockedError` / `VaultLockLostError` (`backup.test.ts` imports
  both from `./lock`; no error taxonomy was touched).
- **Nothing under `packages/` changed.** The same diff against `packages/` is
  empty.
- **No callers added.** `extractVaultBackup` still has zero production callers
  (only `gate.test.ts:1026` and `manager.test.ts:275` call it, both tests), so
  the issue's "not a live hole" status stands.
- **Nothing out of scope.** The diff's name-only list is the two `apps/api`
  files above; a name-only grep excluding `apps/api` is empty.

## Standards — comment accuracy, line by line

The doc comment is load-bearing for this change (the alternative branch of AC1
relied on prose), so I checked each claim against `lock.ts`:

- "refuses (VaultAlreadyLockedError) while a live owner holds the folder —
  another instance, or this same process" (`backup.ts:86-88`). Backed:
  `lock.ts:381` `if (existing !== undefined && holderIsLive(existing, options))
  throw new VaultAlreadyLockedError(existing, lockPath)`, and `holderIsLive`
  (`lock.ts:164-172`) returns true for an alive same-host PID regardless of
  heartbeat, so the same process is caught too. The refusal test exercises it.
- "reclaims a stale lock exactly as the next boot would" (`backup.ts:88-89`).
  Backed: `lock.ts:390-396` settles, re-checks, then `reclaimStaleLock`; the
  "dead holder's stale lock" test proves restore succeeds over a lock whose PID
  is gone (`Bun.spawn` + `await child.exited`, then a live `pid` override).
- "`assertHeld()` runs before each write and once after the pair" matches
  `backup.ts:136`/`138`/`142` exactly — three calls, not two claimed, which is
  what the comment says.
- "The loss raises VaultLockLostError ... it never ends the caller's process"
  (`backup.ts:92-93`). Backed two ways: `lock.ts:259-262` exits only when no
  `onLost` handler was supplied, and `backup.ts:114` always supplies one; and
  the hook wrapper `try { ... } catch {}` (`backup.ts:115-123`) keeps a
  throwing caller handler from replacing the error or escaping the heartbeat
  timer. Both are pinned: the theft test expects `VaultLockLostError`, never an
  exit, and the throwing-handler test (final test in the file, `e8f6415`)
  asserts `hookRan` was true — so it pins the wrapper forwards to the caller's
  handler, not just the helper's own callback — `losses.length === 1`, and
  `error.message` not containing "handler boom".
- "decode BEFORE locking" (`backup.ts:109-110`): the golden-bundle check
  (`decode.ts`-shaped read via `readVaultBackupBundle` at `107`) precedes the
  acquire, and the garbage-bundle test asserts `vault.lock` never exists in the
  garbage target afterwards.
- The quiet-holder test comment ("the PID wins over the heartbeat on the local
  host ... a quiet holder is never stolen from") matches `holderIsLive`:
  `lock.ts:168-169` returns `true` unconditionally on `liveness === "alive"`.
- The theft test's spy point is real: `writeFileAtomic` awaits
  `fs.promises.rename(partial, filePath)` (`atomic-file.ts:94`), and the spy
  targets `fs.promises.rename` filtered on `to` ending `dokan.db.enc` — the
  snapshot write at `backup.ts:137`, not the header. So the interleave is the
  steal-happens-mid-write case, hit deterministically.

## Findings

**C1 — 1 — formatting glitch, test file.** The `it(...)` title for "releases
the folder lock when a write fails, and does not lock a bundle it cannot
decode" runs the first statement onto the same line as `async () => {`
(`backup.test.ts`, mid-file, the `const header = await headerText();` sits
after two spaces on the arrow line). Cosmetic; a pre-commit format pass
catches it.

**C2 — 1, not fixed, recorded — the doc says "Restore is an OFFLINE write"
but the function cannot enforce that.** `backup.ts` doc, first line of the
restore rationale: offline-ness is the caller's decision, not something this
function can observe. What the function actually enforces is exclusivity at
the instant of the writes, which it does. I record this so nobody later quotes
"OFFLINE write" as a property the code guarantees. Not a defect in the guard.

**Verified clean:** no `settle` loop added inside the write path (the
acquire's settle lives in `acquireVaultLock`, `lock.ts:387+`); `release()` in
the `finally` is idempotent and leaves a thief's record alone
(`lock.ts` release: early return if `released`, and the unlink is skipped when
`current.token !== this.owner.token`); the post-pair `assertHeld` at
`backup.ts:142` catches a theft during the header write, so a lost folder can
never be reported as a completed restore; no cached `host`/`pid` arithmetic
introduced anywhere in the diff.

## Verdict

VERDICT: CLEAN. Both AC branches of issue #282 are satisfied by code plus
tests that fail without them (`7ad9627`-family commits), the guard throws the
pre-existing lock-module errors, `packages/` is untouched, and every doc claim
I could check against `lock.ts`/`atomic-file.ts` at a line number held up.
The two findings are a formatting glitch and one doc nuance; neither blocks.
