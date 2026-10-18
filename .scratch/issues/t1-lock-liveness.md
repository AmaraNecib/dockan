## Parent

#274

## What to build

After a Dokan sidecar dies without releasing the data folder, the next start takes the folder and opens normally. When the folder is genuinely held by a live copy, the start refuses and says the folder is in use. When a running copy loses the folder to another copy, it stops writing and serves that same refusal instead of exiting.

The observed failure this ends: a dead sidecar's pid was absent from the OS process list, the liveness probe still reported `EPERM`, the lock read that as "held by a live process", and every later start refused with `VAULT_LOCK_REFUSED` — permanently, with no in-app way back and no need for a restart to be attempted.

## Acceptance criteria

- [ ] A lock held by a pid that no longer runs is reclaimed, whichever way the probe reports it: a definitively gone pid (ESRCH) as today, and an inconclusive probe (EPERM, which on Windows covers a pid that no longer runs) once the recorded heartbeat is older than the staleness window.
- [ ] An inconclusive probe with a fresh heartbeat is refused: a live copy is never stolen from merely because the probe cannot confirm it.
- [ ] A pid that answers as alive is refused however old its heartbeat — the round-5 rule survives, and only the unknowable case changes.
- [ ] One shared helper decides pid liveness for both the vault lock and the port record's recorded-pid check, so the second site cannot drift back.
- [ ] The liveness probe is injectable through the lock's existing options object, so tests can force the inconclusive outcome without needing an OS level that produces it.
- [ ] A copy that loses the lock writes nothing further and serves the in-use refusal on the port it already owns — `503` with `VAULT_LOCKED_BY_OTHER_INSTANCE` on the status route — instead of exiting.
- [ ] That refusal opens no second listener and never publishes or overwrites the owner's port record.
- [ ] The log names the holder (machine and pid) on every reclaim and on every loss.
- [ ] Tests: dead-pid reclaim, inconclusive-probe reclaim, inconclusive-probe-with-fresh-heartbeat refusal, alive-pid refusal, lost-lock fail-stop, and the shared liveness helper.
- [ ] The lock record's shape, and the lock file's name and location, are unchanged.

## Blocked by

None (can start immediately). Lands first: the other two tickets touch the refusal path it changes.
