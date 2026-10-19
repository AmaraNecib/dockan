# #292 — the fence is checked lazily: detect a replaced snapshot on the holder's heartbeat

Base: `5941770` (`origin/t3/v3-envelope-lock-token-aad`, PR #291's head). This branch is
**stacked** on #291: the fence API it uses (`writeStamp`, `readSnapshotFence`,
`VAULT_SNAPSHOT_FENCE_FOREIGN`) exists only there. The PR's base is that branch, not
`develop`.

## Tier

**Standard.** The diff adds a read-only re-read of the snapshot fence and one log line. It
changes no envelope format, no write path and no durability decision: the repair a foreign
stamp triggers (a rewrite at the next persist) already happens today, because
`snapshotIsCurrent()` asks `diskFenceIsMine()` live. What changes is *when* the holder finds
out, so it cannot itself lose or corrupt data — failure mode (5) is not reachable from this
diff. #280, which changed the format, was High-assurance; this is the detection half of it.

## The gap #280 left

#280 fenced the envelope: the writer's lock token is stamped into the bytes and bound into
the AAD. The fence is read at four points — at open, after a write, at a checkpoint, and
through `diskFenceIsMine()` on every durability decision. All four are **activity-gated**: they
run when the holder acts. A holder that verified its write and went idle never looked again.

The sequence the issue names:

1. Holder A verifies its write (`fenceSatisfied = true`) and goes idle.
2. A zombie renames its envelope over `dokan.db.enc`.
3. A never persists, checkpoints or closes: no client traffic, then a crash.
4. The next holder opens the zombie's bytes, decrypts them (same key, same vault id), passes
   the quick check and serves the stale state.

#280's own debate recorded this as its P2 (`a57f450-debate.md` §1) and named the fix path:
"piggyback `diskFenceIsMine()`-shaped verification on the heartbeat". The heartbeat already
runs every 10s in `lock.ts`; it re-reads the **lock file** and knows nothing about the
snapshot.

## Decision implemented

**The holder's existing heartbeat tick re-reads the snapshot fence.** One timer, one cadence:
no second timer is introduced next to the heartbeat that already runs.

- `lock.ts` — `VaultLock.addHeartbeatCheck(check)` registers a check that runs on every
  heartbeat tick, after the lock's own identity check and heartbeat write. A check that throws
  is logged (`SERVER_ERROR`) and skipped: the lock is still ours, and a failed diagnostic must
  never fail-stop a healthy instance.
- `encrypted-connection.ts` — `EncryptedConnection.recheckFence()` reads the fence prefix on
  disk and acts on the answer:
  - **our stamp** → the bytes on disk are ours; the version is durable again;
  - **a foreign stamp** (the legacy envelope carries none, so it counts as foreign too) → the
    bytes are not ours, so the version is **not durable** (`fenceSatisfied = false`);
  - **anything else** (no file, bytes that are not an envelope, a prefix that could not be
    read) → the disk is not verifiably ours, so the version is not durable and the next write
    repairs it.
- `main.ts` — the vault bootstrap registers `() => conn.recheckFence()` on the lock, once, when
  the connection is born.

**One log line per theft, whichever site notices it.** The disk is read from three places —
open, a write, the heartbeat — and a single replacement is seen by all of them. A shared
`noteDiskStamp` remembers the last stamp read and reports only a *change* to a foreign one, so
the first site to notice names the theft and the rest stay quiet. Without that rule the same
replacement would be reported two or three times; and reporting at every site would report a
theft that repeats on every tick ten thousand times.

This also closes a hole the heartbeat alone leaves: a holder that writes (or checkpoints)
*before* the next tick repairs the replacement without noticing it, and the theft would be
silent. The write path reads the fence too, so it names the replacement when it is first to
see it.

The event code is the existing `VAULT_SNAPSHOT_FENCE_FOREIGN`, not a new one: the shared
vocabulary lives in `packages/contracts`, which this ticket does not touch, and the diagnostics
viewer already renders that badge in Arabic ("a snapshot from a former writer"). The two
fence events #280 named are still the two fence events; this lane adds a *site*, not a code.

### What this does not do

- **It does not prevent the rename.** #280's wording stands: detected, not impossible.
- **It does not rewrite on the tick.** The detection marks the version not-durable; the next
  write repairs it. Rewriting on a heartbeat would serialize and encrypt a multi-megabyte
  snapshot on a timer, for a case the next write handles anyway.
- **It does not refuse to serve.** A foreign fence is a warning, exactly as at open: an
  unverifiable snapshot is rewritten rather than rejected (#280's decision).
- **It does not say a missing snapshot was a theft.** A deleted `dokan.db.enc` is not a
  foreign stamp, and the shared vocabulary has no code for it; the version is marked
  not-durable and the next write recreates the file.

## Public interfaces

- `lock.ts` — `VaultLock.addHeartbeatCheck(check: () => void): void`.
- `encrypted-connection.ts` — `EncryptedConnection.recheckFence(): void`.
- `main.ts` — wires the two together in `bootstrapVault`.

No contract change, no envelope-version change, no new log event code.

## Tests

`apps/api/src/lib/vault/fence-heartbeat.test.ts` (new):

1. **The issue's sequence.** The holder verifies its write, the fence rides the heartbeat, the
   zombie renames its envelope over `dokan.db.enc` while the holder is idle, and the foreign
   stamp is observed **within one heartbeat** and logged as `VAULT_SNAPSHOT_FENCE_FOREIGN`.
   The version is then not durable: the holder's bytes are back on disk only because it
   rewrote them.
2. **One event, not one per tick.** The same foreign stamp over ten further ticks is still one
   log line.
3. **The write path names it too.** A checkpoint that runs before the next tick is the first to
   notice the replacement, and it names it: a theft is not silent just because the tick was
   late.
4. **A throwing check is not a lost lock.** The lock is still held, `assertHeld()` still
   passes, and the failure is logged.

Ablation: removing the single line that runs the registered checks from the heartbeat turns
tests 1, 2 and 4 red (`0 pass, 3 fail`); removing the write path's `noteDiskStamp` call turns
test 3 red (`3 pass, 1 fail`). Restoring either turns it green. The "within one heartbeat"
bound is asserted with a 20ms test cadence against a 2s deadline — a hundred ticks of slack
over a bound the issue states as one.

No Playwright case: the sequence is a filesystem race inside one process, with no user-facing
surface to click. The e2e suite owns the user flows; this has none.

## Risks

- **A false "foreign" reading costs a rewrite.** The re-read asks twice before calling a
  prefix unreadable, and an unreadable file is not a foreign stamp — but a *readable* file
  carrying a different stamp is a foreign stamp, whatever the reason. That is the same
  decision `diskFenceIsMine()` already makes on every write, so the exposure is unchanged.
- **A check that throws must not fail-stop the instance.** Covered by the third test; the
  lock's own loss path is untouched by this diff.
- **The check runs on the heartbeat thread.** `recheckFence()` reads a 76-byte prefix and does
  no write, so the tick stays short. A future check that writes would not belong on this tick.
