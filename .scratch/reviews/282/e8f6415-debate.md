# #282 — debate lens, round 3 on head `e8f6415` (the round-2 pin commit)

Base `375788b`, stacked fix chain `3efdd42` → `cd22773` → `e8f6415`. Reviewer:
`zen-proxy/glm-5.3-flash-free` (provider `pi`), read-only. Rounds 1–2 are in
`7ad9627-debate.md` and `3efdd42-debate.md`.

Attack question this round: **can a copy that has LOST the lock still write into
that folder through any path — a hook, a callback, a cleanup step, or an async
continuation that resumes after the check?** Every write site in the restore
path was enumerated by search (`mkdirSync`/`writeFileAtomic`/`openSync`/
`renameSync`/`unlinkSync`/`linkSync`/`ftruncateSync`/`writeSync` over
`lib/vault/backup.ts` plus everything it transitively calls: `lib/vault/lock.ts`
acquire/heartbeat/release, `lib/atomic-file.ts`).

## Critic (4 findings, VERDICT: FINDINGS (3 + 1 out-of-scope))

### Write-site inventory of the restore path

| # | Site | Where | Guarded? |
| --- | --- | --- | --- |
| W1 | `acquireVaultLock` internals: `vault.lock` O_EXCL create + record write, reclaim `renameSync`/`linkSync`/`unlinkSync`/temp file, `fs.mkdirSync(dataDir)` | `lock.ts:358`, `lock.ts:295-355` | Pre-guard by design — these establish or refuse the guard |
| W2 | `fs.mkdirSync(vaultDir, { recursive: true })` | `backup.ts:127` | **No `assertHeld` covers it** (runs before the first one at `backup.ts:136`) |
| W3 | `await writeFileAtomic(snapshotPath, decoded.snapshot)` — temp `.dokan.db.enc.tmp-*` create + write + fsync (`atomic-file.ts:91-97`) + rename (`atomic-file.ts:100`) | `backup.ts:137` | Checked before (`backup.ts:136`) and after (`backup.ts:138`) — **not during**; see F1 |
| W4 | `await writeFileAtomic(headerPath, decoded.headerText)` | `backup.ts:139` | Same shape as W3: before `backup.ts:139`, after `backup.ts:142` |
| W5 | `lock.release()` in `finally` — `fs.unlinkSync(this.path)` of `vault.lock` | `backup.ts:145` → `lock.ts:280` | Identity-checked (`lock.ts:279`); a no-op after any loss because `lost()` already released (`lock.ts:260` → `released` flag at `lock.ts:267`) — except F4 |
| W6 | heartbeat timer `ftruncateSync` + `writeSync` on the held fd | `lock.ts:240-242` | While held, by design; cleared on release (`lock.ts:270`), refused when released (`lock.ts:226`) |
| W7 | failure cleanup `cleanupPartial(partial)` — unlink of the temp the write itself created | `atomic-file.ts:85` and `atomic-file.ts:103` area | Not identity-guarded, but it deletes only the file `partialPathFor` created for this call (`atomic-file.ts:91`) — the losing copy's own bytes |
| W8 | caller hook `options.onLockLost?.(reason, holder)` | `backup.ts:116` | Runs **after** the lock is released; nothing checks whatever the hook itself writes — F3 |

**F1 — 2 — the guard's doc claim "a lock lost mid-restore stops the writes"
(`backup.ts:90-91`) overstates the mechanism, and the branch's own theft test
proves it.** The guard is check-before/check-after, never a stop: the spy at
`backup.test.ts:187-192` writes the thief's record *inside* the rename mock
(`backup.test.ts:190`) and then `return original(from, to)` (`backup.test.ts:192`)
— the rename to `dokan.db.enc` still executes and succeeds over the thief's
folder. Between each `assertHeld` and the rename there are four awaited yields
inside `writeFileAtomic` (`atomic-file.ts:92`, `:94`, `:95`, `:97-98`, then
`:100`); a theft during any of them lands the bytes. The post-write
`assertHeld` at `backup.ts:138`/`:142` catches it only after the file changed,
which is exactly the live write path's cadence (`encrypted-connection.ts:216`
before, `:229` after, comment `:227-228` "the bytes landed; report the version
durable"). So the code matches the codebase norm and the return value is right
(`backup.ts:140-141` "a theft during the writes is a failed restore, never a
silently successful one") — but the residue on disk is the partial pair the
file already names at `backup.ts:132-135` ("a failure between the two writes
leaves the old header over the new snapshot"), reached here by theft. Fix: one
comment edit at `backup.ts:90-91` — "stops the *subsequent* writes and fails
the restore" — no code change.

**F2 — 2 — W2 is a write site with no guard, reachable by a one-line swap.**
`fs.mkdirSync(vaultDir, { recursive: true })` at `backup.ts:127` runs before
the first `assertHeld` at `backup.ts:136`; a stale-lock restore whose folder
gets stolen out-of-band between acquire and the check creates an empty
`vault/` dir under the thief. Content-free, so not the two-writer hole — but
`backup.ts:79-80` claims "Every other path that writes into a data folder asks
the single-writer lock at the instant of the write", and this one doesn't.
`lock.ts:358` `fs.mkdirSync(dataDir, { recursive: true })` is the same shape on
the acquisition side (it runs even when a refusal follows — round-1 F5 already
recorded that). Fix: move the `mkdirSync` between `backup.ts:136` and `:137`;
both writes are then under a live `assertHeld`.

**F3 — 1 — the hook runs after the lock is gone, and the doc never says so.**
`lost()` releases *first*: `lock.ts:260` `this.release()`, then `:261`
`if (handler !== undefined) handler(reason, holder)`. The restore forwards into
the caller's hook at `backup.ts:116`. At that point `released` is true
(`lock.ts:267`), so nothing in the restore or the lock will refuse any write
the hook itself performs into the data folder — a callback that does its own
"cleanup" write is fully uncovered by construction. The doc at
`backup.ts:58-69` says the hook is "a notification, not the failure path"
(`backup.ts:66`) and pins down its throw behaviour, but never states the
post-release ordering or a no-writes contract. No production callers today
(`grep -rn extractVaultBackup` over `apps/api/src` returns only the definition
at `backup.ts:102`; the rest are `backup.test.ts`), so this is a contract note,
not a live hole. Fix: one sentence in the `onLockLost` doc block — "runs after
the lock is released; it must not write the folder."

**F4 — 1, out of scope for #282 — `release()` unlinks a file it did not
confirm is ours when the owner read comes back empty.** `lock.ts:278-280`:
`const current = readOwnerOnce(this.path); if (current !== undefined &&
current.token !== this.owner.token) return; fs.unlinkSync(this.path);` — a
`undefined` current (file vanished, or a second process is mid-create with the
JSON not yet landed) falls through to the unlink, so a real other process's
fresh `vault.lock` can be deleted in the cross-process gap between that
process's `openSync`+`writeSync` and our `readFileSync`. The new owner then
loses by identity check (`lock.ts:232-237`) and refuses — a denial, not a
two-writer outcome, and the restore can't reach it on its loss path because
`lost()` releases first (`lock.ts:260`) and the `finally` at `backup.ts:145`
returns early on the `released` flag (`lock.ts:267`). This is `#142`'s
`release()`, shared with every holder; parent-owner note, not this branch.

### Verified clean by the critic

- **No async continuation escapes the guarded region.** Both writes are awaited
  (`backup.ts:137`, `:139`) inside the `try` whose `finally` releases at
  `backup.ts:145`; no detached promise, no fire-and-forget. `assertHeld` is
  synchronous (`lock.ts:206-215`), so the check-immediately-after-write pairing
  has no JS-thread gap, and `assertHeld` rethrows unconditionally after the loss
  fires (`lock.ts:214`) — the round-2 fix at `backup.ts:115-122` (try/catch
  around the hook) keeps a throwing hook from replacing that error.
- **The heartbeat cannot write after release.** The timer is cleared before
  anything else in `release()` (`lock.ts:270`), and the callback returns early
  on the released flag (`lock.ts:226`). After a loss `lost()` releases first
  (`lock.ts:260`), so no post-theft heartbeat write exists.
- **Release never deletes the thief's record on the restore path.** Token
  mismatch returns early (`lock.ts:279`) — asserted by the theft test, which
  expects the thief's record intact (`backup.test.ts`, "the new owner's record
  is left alone").
- **The only post-theft delete is the losing copy's own temp.** `cleanupPartial`
  unlinks the `partial` this call created (`atomic-file.ts:91` → `:85`/`:85-contract`);
  leftovers from a crashed restore use the same `.dokan.db.enc.tmp-` prefix and
  are swept at next boot (`encrypted-connection.ts:165-167`), with no guard
  needed for that sweep.
- **Decode-before-lock holds.** `readVaultBackupBundle` (`backup.ts:107`) is
  pure, so garbage input takes no lock and performs no folder write.
- **The refusal paths write nothing into the data folder** beyond the
  acquisition machinery itself: the held-lock refusal test asserts neither
  `dokan.db.enc` nor `vault/` exists (`backup.test.ts`, "refuses while another
  instance holds the folder, and writes nothing").

## Synthesis

| Finding | Class | Action for the parent |
| --- | --- | --- |
| F1 (2) | doc claim overstates the guard's guarantee; code matches the codebase norm | **Comment edit** at `backup.ts:90-91`: writes are not "stopped", they are refused-before / failed-after; theft during a write lands it |
| F2 (2) | one real write site outside the guard, trivially foldable | **Move** `fs.mkdirSync(vaultDir, …)` below the first `assertHeld` (`backup.ts:136`); note `lock.ts:358` as the known round-1 F5 residue |
| F3 (1) | hook contract gap (runs post-release, writes unguarded) | **One doc sentence** in the `onLockLost` block at `backup.ts:58-69` |
| F4 (1) | lock-module release race; not restore-specific | **Parent note** for a future `#142` round, not this branch |

The core claim survives the attack in its defensible form: after a loss, the
restore's *content* writes are refused going forward, a restore that lost the
folder never reports success, and no hook, callback, cleanup step or async
continuation in the current code writes folder content past the guard. What
does not survive is the wording "stops the writes" (`backup.ts:90-91`) — the
in-flight write lands, as the branch's own theft test (`backup.test.ts:187-192`)
demonstrates by construction.
