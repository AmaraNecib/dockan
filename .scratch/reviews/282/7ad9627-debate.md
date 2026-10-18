# #282 — debate lens, head `7ad9627` (guard commit, before the fixes)

Base `375788b` (stacked on #275). Both reviewers ran on
`zen-proxy/glm-5.3-flash-free` (provider instance `pi`), read-only, in
`D:/worktrees/mani-project/t3-f09e6466`.

## Critic (6 findings, VERDICT: FINDINGS (6))

**F1 — 10 — `assertHeld()` can kill the whole process, silently.** `backup.ts:90`
acquired with a bare `acquireVaultLock(dataDir)` — no `options`, so no `onLost`
and no logger. On lock loss, `assertHeld` → `lost()` → handler undefined →
`process.exit(1)`. The API server dies inside the request handler, the restore UI
gets no error to catch, and the caller's `finally` never runs. The doc comment
claimed "a lost lock stops the writes"; it stops the process. `VaultLockLostError`
is unreachable in practice. Fix: pass `onLost`, or thread the caller's guard.

**F2 — 8 — a failed restore can corrupt the previous state.** The two writes are
atomic per file but not as a pair. On a folder that already holds a vault, a
failure between them leaves the old `vault.json` over the new `dokan.db.enc`, and
a later boot fails authentication. The "leaves an unconfigured dir" comment holds
only for a fresh dir.

**F3 — 7 — reentrancy error names the caller itself as "another instance".**
`acquireVaultLock` probes the caller's own live pid, so a future restore path
that forgets to release the lock gets `VaultAlreadyLockedError` naming its own
pid, with no hint that it is itself the holder.

**F4 — 6 — no options pass-through.** Every other vault consumer owns its lock
with a logger (`main.ts`) or a caller-supplied guard
(`encrypted-connection.ts`); this embeds a second acquisition idiom with no
logging and no injection.

**F5 — 4 — sync sleeps inside an async function, and refusal side effects.**
`Bun.sleepSync` up to ~1.2 s on the stale/malformed paths; `acquireVaultLock`
`mkdirSync`s `dataDir` before the liveness check, so a refused restore still
creates an empty dir.

**F6 — 3 — UNC/portable stick.** `O_EXCL` create is the same dependency as boot;
the post-pair `assertHeld` is a reasonable theft check. No blocker.

## Defender (VERDICT: SOLID)

Folder-bound ownership is the strongest shape on the table (9/10): clause 3 asks
at the instant of the write, and the write targets *this* folder, so an untyped
caller-supplied guard can pass while writing a different one. Refusal beats
silent folder-picking (8/10). Reclaiming a stale lock like boot, instead of a
bespoke "is `vault.lock` there" check, reuses the round-5 atomic-reclaim race
handling (9/10). Decode-before-lock keeps garbage from touching the folder
(7/10). Three `assertHeld` calls mirror `writeGuard`'s cadence (8/10). `finally`
release mirrors `closeVaultThenReleaseLock` (9/10). Comment-only rejected (9/10):
ADR-0012's thesis is a mechanical guarantee, not intent. Could not defend: the
in-flight-write window after a theft (ADR-0012's deferred #280) and the fact that
the function still has no production caller.

## Synthesis

| Finding | Class | Action |
| --- | --- | --- |
| F1 (10) | blocker, in scope | **Fixed** in `3efdd42`: `onLost` is always wired, the new `onLockLost` option receives the reason, the writes stop with `VaultLockLostError`. Ablation B (drop the handler) kills the test runner, so the test is not vacuous. |
| F2 (8) | pre-existing, out of scope | **Deferred**, comment corrected in `3efdd42` (the pair is not swapped atomically). Follow-up ticket proposed, not filed by this lane. |
| F3 (7) | judgement call | **Dismissed**: `VaultAlreadyLockedError` carries `owner.pid` / `owner.host`, so the restore UI that owns the copy can distinguish self from another instance; rewording it inside the vault layer would trade a typed error for a string. |
| F4 (6) | in scope, partially fixed | **Fixed** by `onLockLost`; no logger field added (the caller has the reason and its own logger). |
| F5 (4) | judgement call | **Dismissed**: offline path; a bespoke pre-check would duplicate the lock module's liveness rules. |
| F6 (3) | no action | Noted. |
