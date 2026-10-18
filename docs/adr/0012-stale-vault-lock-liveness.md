# A lock's liveness is the heartbeat when the pid probe cannot tell

The single-writer lock on the data folder decided liveness by host. On the same
host the recorded **pid** won, and the heartbeat was consulted only when the
record named another host. That rule was deliberate and pinned by a test: a
reused pid may look quiet, and stealing from a live holder is worse than
refusing, because two writers on one encrypted snapshot is corruption.

On Windows the probe cannot answer the question it is asked.
`process.kill(pid, 0)` returns `EPERM` for a pid that **no longer runs** — the
lock module read `EPERM` as "exists, owned by someone else" (the POSIX reading)
and therefore as proof of life. Observed on a shipped portable build: the
sidecar died, its pid was absent from the OS process list, the probe still threw
`EPERM`, so the lock looked held by a live process. Every later start served the
refusal page (`VAULT_LOCK_REFUSED`, port record untouched) and the owner was
locked out of their own data folder permanently. The only way back was deleting
`vault.lock` by hand. A cleanly reaped child returns `ESRCH` in the same
circumstances, which is why the existing dead-pid test passed and hid the case.

We now decide liveness in three clauses:

- **The probe proves liveness only when it does not throw.** No throw means the
  pid is running and ours. `ESRCH` means gone. **`EPERM` means the probe cannot
  tell** — it is also the honest reading for a live process owned by another OS
  user — so the recorded heartbeat decides, using the existing staleness window
  (a 10 s cadence against a 60 s window).
- **A pid that answers as alive still wins over an old heartbeat.** The
  round-5 rule stands: the probe is exact whenever it answers, so a quiet but
  live holder is never stolen from.
- **The holder checks on every heartbeat that the lock file still names it, and
  stops writing the moment it does not.** This already exists as the lock's
  `onLost` fail-stop (round-5). What changes is the caller's reaction: it serves
  the **in-use refusal on the port it already owns** instead of exiting. An
  exiting sidecar leaves the shell's broker with nothing to talk to, so the web
  falls back to "server unreachable" — the wrong diagnosis, and the one this ADR
  exists to stop repeating.

The same pid-probe rule governs the port record's check that a recorded pid is
still alive, so one shared helper decides both.

**Considered options**

- **(A) Keep `EPERM` = alive and add an absolute maximum lock age.** Rejected: a
  second clock on top of the heartbeat, whose expiry would still be a guess, and
  it would steal from a live holder that a fresh heartbeat had just vouched for.
- **(B) Drop the pid probe for the same host and trust the heartbeat alone.**
  Rejected: the probe is exact when it answers, and this would make a live
  holder stealable the moment it went quiet for one window.
- **(C) Probe the holder's recorded port to see if it answers.** Rejected: it
  couples the lock to the port record, and a holder that is live but not yet
  listening (or listening on another interface) would look dead.
- **(D) Compare the live process's start time against the lock's `startedAt` to
  detect pid reuse.** Rejected: no portable in-process way to read a start time;
  it would put a shell-out in the boot path.

**Consequences**

- A live-but-frozen holder — a hibernated laptop, a stopped VM — goes stale and
  can now be reclaimed after the window, but only where the probe cannot settle
  liveness. Clause two still protects a same-host process whose probe answers: it
  wins over any heartbeat age, so the widening is confined to the unknowable
  case.
- **The safety of that reclaim rests on the write path, not on the heartbeat.**
  Clause three's check runs in the heartbeat, so it can be up to one cadence
  late. A persist already queued when the lock is reclaimed would otherwise
  write the snapshot after another owner took it, which is the two-writer
  outcome the lock exists to prevent. The reclaim is safe only once the write
  path itself refuses on a lost lock: the persistence queue re-checks ownership
  as it drains, and `persistNow` in the encrypted connection never writes under
  a lock the instance no longer holds. Until that check exists, reclaiming from
  a frozen holder trades a refusal for a possible second writer.
- A live holder owned by another OS user keeps heartbeating, so it stays alive
  and is never reclaimed.
- An install already stuck on the EPERM reading cannot repair itself: the app is
  what refuses. Those installs recover from a build carrying this change, or by
  deleting `vault.lock` by hand.
