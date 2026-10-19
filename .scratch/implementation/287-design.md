# 287 — a spent lock read must not evict a live holder (`reclaimStaleLock`)

**Tier: High-assurance.** The diff decides who may unlink a live holder's lock
file; a wrong answer puts two writers on one encrypted snapshot. Same failure
mode #281 was tiered for (two writers on the vault), not a UI/API one.

## Base and scope

- Base: `b16dfbb` (merge-base with `origin/develop`).
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

- `readOwnerFile` classifies one read: `owner` | `gone` (real ENOENT) |
  `malformed` (bytes read, not a lock record) | `unreadable` (any other read
  error, with its errno).
- `readOwner` keeps a sticky `blocked` flag: true when ANY read in the window
  failed for a reason other than ENOENT. Malformed content does not set it, so
  the existing "reclaim a corrupt lock instead of blocking forever" behavior is
  unchanged.
- `reclaimStaleLock` refuses while `blocked`:
  - the settle read blocked → nothing is renamed; the attempt re-reads (`retry`);
  - the renamed copy blocked → the copy is re-linked to the path and the attempt
    reports `raced`, so the next read decides.
- The held-lock reads (`assertHeld`, heartbeat, `release`) keep the previous
  owner-or-undefined contract through `readOwnerOnce`; the fail-closed behavior
  there is #281's, not this lane's.

Deliberately not widened: the retry/budget knobs and the held-path retry seam
are #281's; this change only adds the absent-vs-unreadable distinction the
acquisition path needed.

## Evidence

Three new tests. Each guard removed on its own, run, restored, and the tree
verified byte-identical (`sha256` of `lock.ts` before and after every ablation):

| Test | Guard removed | Observed red |
|---|---|---|
| live record, every read EBUSY | both guards (base behavior) | `Received function did not throw`; returned a `VaultLock` |
| renamed-aside copy EBUSY | `&& !moved.blocked` | same, only that test red |
| record read EBUSY, copy reads empty | the `settled.blocked` early return | same, only that test red |

Focused runs: `lock.test.ts` 34 → 37 pass; vault dir 160 pass; `tsc --noEmit`
clean; `bun run lint` clean.
