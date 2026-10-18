# #275 — test-audit lens, round 3, head `375788b`

Separate sub-agent on `zen-proxy/glm-5.3-flash-free` (not the author's model). Read-only: test runs
and temporary ablation patches, every one reverted with `git checkout --`. The worktree was left
clean at `375788b`.

Verdict as returned: **no blockers — 3 majors, 3 minors.** The production behaviour is right; what
is wrong is that several tests would stay green if it stopped being right.

Runs at head: 76 light tests across the four changed unit files, plus 4 heavy integration tests.
No failures, no skips, no crashes.

## Ablations — the ones the suite does catch

Every ablation is a deliberate re-break of the shipped behaviour, then a revert.

| Ablation | Result |
|---|---|
| `holderIsLive` collapsed to `return true` (the original `EPERM = alive` bug) | **4 failures** — the three-clause rule is genuinely pinned |
| Post-settle second `holderIsLive` check deleted (round-1 C2) | C2 test fails as intended |
| `encrypted-connection.ts` raises `persistedVersion` above the post-write guard (C1) | C1 test fails — ordering is pinned by the "later persist has work to do" assertion, not just the throw |
| `main.ts` `onLost` reverted to `process.exit(1)` | Heavy integration test fails — refusal-instead-of-exit is pinned |

The round-2 hazard is gone too: no remaining site depends on the OS handing out a dead pid; `pid 4242`
is injected-probe or mocked-kill everywhere.

## M1 — the shutdown skip is vacuous as written (major)

`lock.integration.test.ts`, "loser neither exits nor checkpoints": the refusal handler intercepts the
second mutation *before* it reaches the store, so the abandoned connection is never dirty.
`checkpoint()` then hits the `mutationVersion === persistedVersion` early return and `close()`
succeeds silently. No "store close failed" line, bytes unchanged, test green — and it would be just
as green with the skip removed.

Only the pure `connectionToCloseAtShutdown` unit actually works. A swap that kept the same branch
would stay hidden by the very scenario it walks through.

**Fix:** POST the mutation ~50ms after the theft but before the 10s heartbeat flips the port over.
The mutation commits in SQLite, the guarded persist refuses, and the abandoned store is now genuinely
dirty (`mutationVersion` 2, `persistedVersion` 1). Only then does
`not.toContain("store close failed during shutdown")` mean anything: reverting the skip makes
`checkpoint()`'s guard throw through `close()` and the line appears. The bytes-equal-SIGTERM pin
stays, and also only differentiates once a dirty state exists.

## M2 — `lockLost` is never actually asserted (major)

`broker.test.ts:232-238` (the round-1 C4 test): `lockLost: true` is never asserted, `unlocked: false`
after a loss is never asserted, and the check runs in state `unconfigured`, where `lockLost` is
permanently `false`. A `main.ts` that never sets the flag passes the whole suite while the shell goes
on reporting a healthy unlocked vault.

**Fix:** in the spawned-child harness, after `setup`, forge the lock file to a foreign host/token,
wait one heartbeat cadence (poll the record, do not sleep a fixed 10s), send `action: "status"`, and
assert `status.lockLost === true` and `status.unlocked === false`.

This is the same code region as the debate's finding A (the broker never checks `lockLost`), so the
fix and the test belong in one change.

## M3 — the boot-theft branch is untested (major)

`main.ts:301-309` (`if (lockLost) return;`, C1's boot-theft guard): with it reverted, a theft between
`acquireVaultLock()` and `appReady` installs the live app, a mutation commits in SQLite, its persist
refuses, and a retry re-executes against the real app — a divergent commit the client never sees.

**Fix:** extract the decision into something pure (`readyHandlerFor`) and unit-pin it — returns the
refusal handler, installs no live app, skips the cleanup/backup tail. Or cover it in the integration
harness by forging the lock file after `waitForHealth` but before setup completes.

## Minors

- **The 60s heartbeat boundary is never probed.** Tests use "now" and −10min, so a window 5× wrong or
  a backwards comparison passes everything. With `probePid: () => "unknown"`, pin `now − 59s` →
  refuse, `now − 61s` → reclaim, and a future stamp → refuse. Note this last case is the debate's
  finding D: `heartbeatAt = now + 5min` should hold conservative refusal, and the current comparison
  flips it to reclaim.
- **`assertHeld()`: only the "replaced" branch is exercised.** The "file vanished" branch, the
  `released` early-throw, and never-held are not directly tested. One unit test with an `onLost`
  counter that drops the lock file and asserts `VaultLockLostError` covers all three.
- **"No port-record write" only checks the canonical `.dokan-port` path.** The loser's per-process
  registry entry is never compared. Snapshot the registry dir listing before the theft and assert it
  unchanged after.

## Flake review

- `reapedPid()` on Windows can see the OS reuse an exited pid between the exit and the probe. Rare,
  mitigated by asserting `probePidLiveness(pid) === "gone"` right after the reap and re-spawning on
  `"alive"` if it ever bites.
- Three `await ... 80ms` heartbeat polls prefer a deadline poll; `waitForFreshHeartbeat` already
  proves the pattern.
- `waitForFreshHeartbeat` returns silently at its 15s deadline.

## Cost as estimated by the lens

M1-M3: ~30-45 min for the `broker` harness (two of the three are one integration-heavy test); M1's
and M3's integration contributions are ~1-2h end to end.
