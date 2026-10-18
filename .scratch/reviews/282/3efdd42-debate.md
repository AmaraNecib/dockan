# #282 — debate lens, round 2 on head `3efdd42` (after the round-1 fixes)

Base `375788b`. Reviewers: `zen-proxy/glm-5.3-flash-free` (provider `pi`),
read-only. Round 1 (head `7ad9627`) is in `7ad9627-debate.md`.

## Critic (2 findings, VERDICT: FINDINGS (2))

**F1 — 4 — a throwing `onLockLost` can still kill the process, exactly the mode
the previous commit removed.** `backup.ts:117` wrapped the caller's hook with no
`try`/`catch`. On the write path the hook's throw propagates out of `assertHeld`
and replaces `VaultLockLostError`, breaking the doc promise. Worse, the lock
calls the hook from its **heartbeat timer**: a throw there lands in a
`setInterval` callback — an uncaught exception — reachable when a large snapshot
write on slow disk stretches the restore past one 10s heartbeat. Fix: `try { … }
catch {}` in the wrapper, and assert it with a throwing handler.

**F2 — 2 — the wrapper drops the `holder` argument.** `lost(reason, holder)`
passes the instance that took the folder; `ExtractVaultBackupOptions.onLockLost`
received only the reason.

**Verified clean by the critic:** the default exit is gone (`lost()` only exits
when no handler is supplied); a swallowing hook cannot mask the failure
(`assertHeld` throws unconditionally); `release()` is idempotent, catches every
syscall, and leaves the thief's record alone; the theft window is the same
accepted TOCTOU as the codebase's other write guards; the doc comment matches the
code. It also confirmed the theft test is not vacuous (`writeFileAtomic` really
does `await fs.promises.rename`).

## Defender (VERDICT: SOLID)

F1 (exit → exception) 9/10: `lost()` calls the handler when present, and only
otherwise `process.exit(1)`; the theft test would kill the runner if the wiring
regressed. `finally`/decode-before-lock 9/10, mirroring `writeGuard` and
`closeVaultThenReleaseLock`. Deferred F2 8/10: the comment no longer over-claims
and making the pair atomic is a distinct design problem. Refusal/quiet-live-holder
reclaim 9/10, matching ADR-0012 clause 2. Could not defend: it verified the
ablations structurally only; `onLockLost` has no production caller yet.

## Synthesis

| Finding | Class | Action |
| --- | --- | --- |
| F1 (4) | real hole in the round-1 fix | **Fixed** in `cd22773`: the hook is advisory, a throw from it is swallowed, the loss still surfaces as `VaultLockLostError`. New test with a throwing handler; ablation C (drop the `try`/`catch`) fails it. |
| F2 (2) | cheap, in scope | **Fixed** in `cd22773`: `onLockLost(reason, holder?)` threads the lock's own optional `VaultLockOwner` through. |
