# #281 — a transient lock-file read failure is not theft

Base: `origin/fix-275-vault-lock-liveness` @ `375788b` (the PR base; the develop
merge-base is `8515174`). Branch: `fix-281-read-error-vs-theft`.

**Tier: High-assurance.** The diff decides whether the single-writer lock keeps
holding; the wrong direction (treating an unreadable lock as held, or letting a
holder delete a record it cannot identify) is the two-writer outcome that
corrupts the encrypted snapshot, i.e. failure mode 5 in
`docs/engineering-workflow.md`.

## The defect

`readOwnerOnce` returns `VaultLockOwner | undefined`, so `ENOENT`, `EACCES`,
`EBUSY`, a half-written record and a schema-rejected record are one value.
`assertHeld()` and the heartbeat read `undefined` as "the lock file disappeared",
fail-stop, and `VaultLock.release()` then reads the same `undefined` and
**unlinks the path**. A Windows sharing violation (antivirus or the indexer
holding `vault.lock`) therefore makes a healthy holder throw away its own lock
and serve the refusal page — after which a third instance can take the folder.
`assertHeld()` runs that read up to twice per business unit plus once at
checkpoint, so #275 multiplied the exposure the old 10 s heartbeat had.

## Shape

Classification at the read site, one value per outcome:

```ts
type LockFileRead =
  | { kind: "owner"; owner: VaultLockOwner }
  | { kind: "gone" }                        // ENOENT: the path does not resolve
  | { kind: "unreadable"; code: string; error: Error };  // present, not attestable
```

`code` is the errno (`EACCES`, `EBUSY`, `EPERM`, …) or `MALFORMED` for a record
that is present and readable but does not parse or does not satisfy
`ownerSchema`. `MALFORMED` covers the holder's own truncate-then-write
heartbeat: a reader can see the empty file between `ftruncateSync` and
`writeSync`, which today also reads as "the lock disappeared".

Two readers over that classification:

- `readOwner()` — the acquisition path, semantics unchanged: retry `unreadable`
  up to `readRetries`, then return `undefined` so a stale/unreadable lock stays
  reclaimable.
- `readHeldLock(lockPath, token, options)` — the holder path (`assertHeld` and
  `heartbeat`). `gone` is a loss now, a different token is a loss now, and
  `unreadable` is **held-and-retry**: up to `transientReadRetries` extra reads
  (default 5 × 50 ms = 250 ms), and only after the budget is spent a fail-stop
  whose reason names the code and the attempt count. Bounded, so a persistent
  error still fails closed rather than reporting ownership we cannot attest to.

`release()` gets the same classification and one rule: an `unreadable` record is
**not deleted**. We cannot compare the token, so unlinking could delete a new
owner's file; a stale file left behind is still reclaimable by the pid probe.
`gone` and "not ours" behave as before.

**Where the diagnostic goes.** The errno and the attempt count ride in the loss
reason, which `lost()` already logs as `VAULT_LOCK_LOST` (the ADR's own event).
A dedicated `VAULT_LOCK_READ_RETRY` warn would be better for a recovered hiccup,
but the api's event codes are a cross-package contract: `logEvents` in
`packages/contracts` plus an Arabic badge key `logEvent_<EVENT>` in
`apps/web/src/lib/i18n.ts`, both enforced by tests. Neither file is this lane's
to touch (scope: lock.ts + tests; a sibling lane is in the web), so a recovered
retry logs nothing. Deferred to the parent as a two-event follow-up.

Seam: `VaultLockOptions.readLockFile?: (lockPath: string) => string`, default
`fs.readFileSync(path, "utf8")`, the `probePid` precedent. Tests force `EACCES`
and `ENOENT` through it and assert the two outcomes.

## Not changed

- No fail-open: after the bounded retry the holder still fail-stops. The retry
  window is the availability fix, not a policy change.
- Acquisition (`acquireVaultLock`) retry/reclaim semantics.
- The refusal page, its copy, `main.ts`.

## Tests (all in `lock.test.ts`)

Counter seam + logger capture (`reads`, `readsAtLoss` — the release that follows
a loss reads again, so the raw count alone cannot pin the budget).

1. one `EBUSY` then readable → `assertHeld()` returns, `reads === 2`, no
   `VAULT_LOCK_LOST`, record still ours.
2. `ENOENT` from the seam → loss at once, `readsAtLoss === 1`, reason is
   "the lock file disappeared".
3. real `rmSync` + `assertHeld()` → reason is exactly "the lock file
   disappeared" (default reader, no seam).
4. another owner's record → loss at once (`readsAtLoss === 1`), holder named.
5. `EBUSY` forever, `transientReadRetries: 3` → loss at `readsAtLoss === 4`,
   reason names `EBUSY` and the attempt count.
6. `{ not json` forever → loss reason names `MALFORMED`, not a disappearance.
7. `MALFORMED` once, then readable → held (the mid-write race).
8. heartbeat: one `EBUSY` then readable → no `onLost`, record still ours.
9. heartbeat: `EBUSY` forever → `onLost` fires with `EBUSY` in the reason.
10. `release()` over an unreadable record → one read, file kept.

## Risks

- The retry block is synchronous (`Bun.sleepSync`), 250 ms worst case inside
  `writeGuard`. Bounded and already the norm in this module (`readOwner` sleeps
  20 × 50 ms at acquisition).
- A permanently unreadable lock still fail-stops, only 250 ms later. Raising
  `transientReadRetries` is the knob; a *longer* grace would need the write to
  be refused without releasing the lock, which is the ADR's fail-stop contract.
- The ADR-0012 "consequences" line still lists #281 as an open hole. Out of
  scope for this diff (lock.ts + tests only); the parent decides whether to
  amend it.
