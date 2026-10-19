# 287 — a spent lock read must not evict a live holder (`reclaimStaleLock`)

**Tier: High-assurance.** The diff decides who may unlink a live holder's lock
file; a wrong answer puts two writers on one encrypted snapshot. Same failure
mode #281 was tiered for (two writers on the vault), not a UI/API one.

## Base and scope

- Base: `fe8d7f7` (the #288 merge, `fix-281-read-error-vs-theft`) — the
  merge-base with `origin/develop`.
- Files: `apps/api/src/lib/vault/lock.ts`, `apps/api/src/lib/vault/lock.test.ts`.
  Nothing outside the lock module.
- The acquisition carve-out #281 deferred. #281 hardened the *evicted holder*
  (a conforming holder now fails closed and writes nothing); it did not close
  the unlink that evicts it. That is this issue.

## What is wrong

`readOwner` answered the same `undefined` for three different states:

1. a real ENOENT — nothing is there to hold;
2. a malformed or empty record — the bytes were read and hold no owner;
3. a read that failed (EBUSY/EACCES/EIO) — the file may well be live.

`reclaimStaleLock` renamed the record aside and read it back through the same
function, unlinking when both the pre-rename read and the post-rename read
agreed on `undefined`. Two spent reads in one window were enough to satisfy the
"same stale owner" test with state 3 on either end, so a sustained read error
(a scanner holding the file, a network drive, a rename in flight) could delete a
live holder's renamed-aside record and acquire over the folder.

## The fix (all inside the lock module)

- `readOwnerOnce` (`lock.ts:229`) classifies one read: `owner` | `gone` (real
  ENOENT) | `malformed` (bytes read, not a lock record) | `unreadable` (any
  other read error, with its errno).
- `readOwner` keeps a sticky `blocked` flag: true when ANY read in the window
  failed for a reason other than ENOENT. Malformed content does not set it, so
  the existing "reclaim a corrupt lock instead of blocking forever" behavior is
  unchanged.
- `reclaimStaleLock` refuses while `blocked`:
  - the settle read blocked → nothing is renamed; the attempt re-reads (`retry`);
  - the renamed copy blocked → the copy is re-linked to the path and the attempt
    reports `raced`, so the next read decides.
- The held-lock reads do NOT keep the old owner-or-undefined contract.
  `assertHeld` (`lock.ts:474`) and `heartbeat` (`lock.ts:494`) go through
  `readHeldLock` (`lock.ts:380`): bounded retry, wait on `malformed`, then fail
  closed. Only `release` still reads through `readOwnerOnce`, once, because it
  runs from the exit hook.

### The held path (#288, on the base this lane builds on)

The two paths answer `malformed` differently on purpose, and the acquisition
path is the strict one.

`malformed` is what a reclaim caught between its create and its write looks
like: bytes that were read fine and are not a lock record. `readHeldLock`
retries it exactly like an errno — `MALFORMED` rides in the loss reason with the
other codes — and never stops a holder on it, because a healthy holder can
catch a sibling's zero-byte record through no fault of its own. That is the
dominant behaviour of `assertHeld` and `heartbeat` on this tree, and it is
#288's, not this lane's.

The acquisition path wants the opposite answer: `malformed` is staleness
evidence a reclaim may act on (the corrupt-lock recovery the module promises),
while `unreadable` withholds the reclaim entirely (#287). The asymmetry is
deliberate, and it is why `blocked` is set only for `unreadable` — see
`readOwner` (`lock.ts:327-331`).

Deliberately not widened: the retry/budget knobs and the held-path retry seam
are #281's; this change only adds the absent-vs-unreadable distinction the
acquisition path needed.

## Evidence

Five new tests. Three of them pin a guard, and each was removed on its own, run,
restored, and the tree verified byte-identical (`sha256` of `lock.ts` before and
after every ablation):

| Test | Guard removed | Observed red |
|---|---|---|
| live record, every read EBUSY | both guards (base behavior) | `Received function did not throw`; returned a `VaultLock` |
| renamed-aside copy EBUSY | `&& !moved.blocked` | same, only that test red |
| record read EBUSY, copy reads empty | the `settled.blocked` early return | same, only that test red |

The other two pin the `blocked` flag against a readable retry inside the same
window: an intermittent errno followed by malformed content at `vault.lock`, and
the same at the renamed-aside copy.

Focused runs: `lock.test.ts` 60 → 65 pass; vault dir 188 pass; `tsc --noEmit`
clean; `bun run lint` clean.
