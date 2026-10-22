# heavy-slot

Measured admission control for CPU-heavy work. Two front doors, one queue:

- Inside a pi session: the `heavy_run` tool (and `heavy_status`).
- Otherwise: `bun tools/heavy-slot/heavy-slot.ts run "<label>" "<command>"` (and `... status`).

A slot is a bound loopback port. Two processes cannot bind one port, and the OS frees it the
instant the holder dies, including on a kill. That is why there is no lock file and no liveness
rule to get wrong.

## What counts as heavy

- A full test suite (`bun test`, `bun run test`, `vitest run`, a package-wide `bun run --filter ... test`).
- `test:e2e` / playwright runs.
- A production build (`bun run build`, `turbo run build`, `next build`, `cargo build`).
- A browser/headless-browser agent.
- `cargo test` / `cargo clippy`.

## What does not

- One test file (`bun test foo.spec.ts`).
- Lint, typecheck, a single grep, a read.

Light work runs directly. A queue on everything is a queue nobody respects.

## How the bound is measured

Capacity is recomputed on every acquire from free RAM and CPU load. Why `HEAVY_SLOT_MAX` is a
ceiling and not the number anyone gets is stated once, in `docs/development-workflow.md` §7
(Local verification tiers); this file does not restate it. A wait budget
(`HEAVY_SLOT_WAIT_MS`, default 30 minutes) exits `75` having run nothing, so a caller can fall
back to focused tests.

## Port ranges: EACCES is not "busy"

`EADDRINUSE` means another process holds the port: wait. `EACCES` (or `EADDRNOTAVAIL`) means the
port is not ours to use at all - on Windows, TCP port ranges the OS reserves
(`netsh int ipv4 show excludedportrange protocol=tcp`), and they move across reboots and
Hyper-V changes. Waiting never fixes a reserved range, so the two error families are kept apart:

- A range whose ports refuse to bind is never reported as "the queue is full" (or empty). `run`
  refuses immediately with exit `76` and names `HEAVY_SLOT_BASE` and the `netsh` command;
  `status` prints a one-line diagnostic instead of "the queue is empty".
- When the preferred base's first slot refuses with `EACCES`, the base shifts by a stride
  (+1000) at a time: the preferred base is probed first, then up to 8 shifts, so nine
  candidates in all. The first process that finds a working base records it in
  `HEAVY_SLOT_STATE_DIR/base` with flag `wx` - first writer wins, and a concurrent
  process reads the winner instead of overwriting it, so two processes never disagree.
- A base that worked yesterday can be reserved today: a persisted base that no longer binds is
  re-decided the same way. If every candidate is excluded, the process refuses loudly (exit 76)
  instead of burning the wait budget.

`HEAVY_SLOT_BASE` is a preference, not a promise. A recorded, still-binding base outranks it, so
two processes with different `HEAVY_SLOT_BASE` values agree on the recorded one.

## Failure mode prevented

Several agents on one box each running a full suite pin every core: every lane's timing tests
flake and the machine thrashes. The queue admits a bounded number at a time, measured from the
machine, so lanes stop fighting for cores. A slot is released automatically when its holder dies,
so a crashed lane does not strand a slot.