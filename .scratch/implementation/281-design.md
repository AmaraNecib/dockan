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
`ownerSchema`. `MALFORMED` covers a *replacing* instance's window: a reclaim
renames our file away and creates its own, and a read that lands between its
`openSync("wx")` and its first `writeSync` sees an empty record. (It is not the
holder's own heartbeat — that read and write are synchronous on one thread —
which the first draft of this doc got wrong: the reviewer's F2 stands, the code
is unchanged because a 250 ms delay before naming the new holder is still
timely, and the reason now names the holder when the record lands.)

Two readers over that classification:

- `readOwner()` — the acquisition path, semantics unchanged: retry `unreadable`
  up to `readRetries`, then return `undefined` so a stale/unreadable lock stays
  reclaimable.
- `readHeldLock(lockPath, token, options)` — the holder path (`assertHeld` and
  `heartbeat`). `gone` is a loss now, a different token is a loss now, and
  `unreadable` is **held-and-retry**: up to `transientReadRetries` extra reads
  (default 10 × 100 ms = 1 s), and only after the budget is spent a fail-stop
  whose reason names every code it saw and the attempt count. Bounded, so a
  persistent error still fails closed rather than reporting ownership we cannot
  attest to.

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
7. `MALFORMED` once, then another owner's complete record → one retry, then
   "replaced" with that holder named (a reclaim's create-before-write window
   must not read as a disappearance).
8. heartbeat: one `EBUSY` then readable → no `onLost`, record still ours.
9. heartbeat: `EBUSY` forever → `onLost` fires with `EBUSY` in the reason.
10. `release()` over an unreadable record → one read, file kept.
11. flapping `EBUSY`/`EACCES` → the reason names both codes, on one line.
12. a non-Error `{ code: "ENOENT" }` thrown through the seam → gone at once.
13. a hostile `{ code }` with a newline and 5 kB of padding → the reason stays
    one short line.
14. `transientReadRetries: -1` / `Number.NaN` → no retries / the default.
15. the default budget rides out 8 × 100 ms of read failure, which the old
    5 × 50 ms default failed closed on.
16. `transientReadRetries: 10_000` with a 3 s delay → held after 3 reads inside
    the window cap, and an always-failing read stops at the 101-read ceiling.

## Round-2 fixes (debate on 9a6a30c)

- **N1 (6):** the reason now names *every* code the window hit (`EBUSY, EACCES`)
  and the OS sentence is folded to one line, capped at 200 chars, so a JSONL
  line cannot be broken by a multi-line or hostile error message.
- **N2 (5):** a synchronous loop must stay bounded even when a caller
  misconfigures it. `retryBudget` clamps a knob to `[0, ceiling]` (100 attempts,
  500 ms delay) and the held-lock retry sequence additionally stops after
  `MAX_HELD_RETRY_WINDOW_MS` = 1 s, because it runs inside `writeGuard`.
- **N3 (4):** `release()` keeps its single read — deliberately best-effort, and
  now says so: it runs from the exit hook, where sleeping to chase a file this
  process is about to stop caring about is worse than leaving a stale file the
  next boot reclaims.
- **N4 (3):** the errno is read off the thrown value with a schema, so a
  non-Error thrown through the read seam still classifies by its code.
- **N5 (3):** documented — a reclaim's rename can surface as `ENOENT`, so a
  replacement may lose as "the lock file disappeared". The outcome is the same
  prompt fail-stop; only the holder goes unnamed.

## Round-3 fixes (debate on d93e550)

- **r3-1 (4):** the *code* was the last unbounded piece of the reason. It is now
  folded and capped like the message, so no throwing reader can smuggle a line
  break or a megabyte into the JSONL (classification still compares the raw
  code; only the log copy is folded).
- **r3-2 (4):** the production default was the attenuated failure:
  `main.ts` passes no knob, so the live budget was 5 × 50 ms = 250 ms, which a
  real Windows scanner hold outlasts. Default is now 10 × 100 ms = 1 s, which
  costs nothing on the fail-stop path — a replacement record or a missing file
  is judged on the first read.
- **r3-4 (2):** the `-1`/`NaN` half of the clamp now has a test, and the window
  test fails in seconds instead of after its unclamped budget.
- **r3-3 (3), not fixed — #275's knob:** `stealSettleMs` still goes into
  `Bun.sleepSync` unclamped, and `readOwner`'s 100 × 500 ms ceiling is a boot
  worst case. Both are pre-existing, boot-path only, and outside #281; reported
  as a follow-up for the parent.

## Risks

- The retry block is synchronous (`Bun.sleepSync`), 1 s per check in the worst
  case at the default, and it runs inside the write guard. That stall is the
  price of not killing a healthy holder, and it only happens while the file is
  genuinely unreadable.
  worst case. A persistent error makes the first check fail closed, which is
  terminal for the write path, so the process pays it once; a flapping error
  can pay it per check (up to twice per business unit plus the checkpoint). The
  50 ms delay matches `readOwner`'s, and both knobs are options.
- The loss reason carries the OS's own sentence (`... after 6 attempts: EACCES:
  permission denied, open 'vault.lock'`), so the log names the syscall and the
  path, not only the errno. Read failures that *recover* log nothing (see the
  vocabulary note above).
- A permanently unreadable lock still fail-stops, only 250 ms later. Raising
  `transientReadRetries` is the knob; a *longer* grace would need the write to
  be refused without releasing the lock, which is the ADR's fail-stop contract.

## Deferred (for the parent)

- **ADR-0012's consequences line** still lists #281 as an open hole
  ("an unreadable lock file is indistinguishable from a stolen one, which
  fail-stops a healthy holder (#281)"). This diff closes it. `docs/**` is
  outside this lane's stated scope, so the two-line amendment waits for the
  parent's call.
- **`release()` TOCTOU (pre-existing, untouched).** Between the read answering
  `gone`/ours and `unlinkSync`, a third instance can create its own record and
  we delete it. The unreadable-skip narrows the reachable set but does not close
  the window; it needs a token-checked unlink (rename aside first, or unlink
  only the fd we verified).
- **Two log events** (`VAULT_LOCK_READ_RETRY`, `VAULT_LOCK_RELEASE_SKIPPED`):
  each needs a `logEvents` entry in `packages/contracts` plus an Arabic badge
  key in `apps/web/src/lib/i18n.ts`, both outside scope.
- **The seam replaces every read**, including acquisition; the acquisition
  scenarios in the existing suite use the default reader, and the new tests use
  the seam only for held-path cases.
