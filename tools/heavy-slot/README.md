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
  `HEAVY_SLOT_STATE_DIR/base`, written atomically: a temp file lands with
  `renameSync` over the record, so a reader never sees the file absent or torn, and a stale
  record is replaced the same way - only by a process that re-read it as unusable just
  before the write. After every write the content on disk is re-read and that value is
  what the process activates: last atomic write wins, everybody re-reads.
- A base that worked yesterday can be reserved today: a persisted base that no longer binds
  is re-decided the same way. If every candidate is excluded, the process refuses loudly
  (exit 76) instead of burning the wait budget, and the refusal clears the record when it
  still names the refused base - a range proven broken (EACCES is machine-global) must not
  be inherited by every later process.

`HEAVY_SLOT_BASE` is a preference, not a promise. A recorded, still-binding base outranks it, so
two processes with different `HEAVY_SLOT_BASE` values agree on the recorded one.

The invariant, in one sentence: **no process may run on a base it did not read from the record.**
A process therefore re-reads the record immediately before its first bind and adopts what the file
says (`confirmBase`), which closes the window between resolving a base and taking a port.

What the record cannot fix, and what to do about it: a condition like `EACCES` is **machine-global**,
so a range reserved here is reserved for every process here. A test or a caller that reports one
port refused for one process while another binds it is describing a machine that cannot exist; the
queue answers such contradictory observations by refusing loudly, not by splitting into two ranges.
That distinction is why the race test marks one shared stale range unusable for both children
instead of giving each child its own private refusal.

## Failure mode prevented

Several agents on one box each running a full suite pin every core: every lane's timing tests
flake and the machine thrashes. The queue admits a bounded number at a time, measured from the
machine, so lanes stop fighting for cores. A slot is released automatically when its holder dies,
so a crashed lane does not strand a slot.

Known edges, stated so a caller is never surprised by them:

- A child command that itself exits `75` or `76` is indistinguishable at the CLI boundary from
  "queue full" / "range refused": `run` reports the child's exit code as its own.
- `status` is not read-only: it calls `resolveBase()`, which can write the shared record.
- The refusal banner names the full span `preferred..preferred+8000`, but the walk skips
  candidates at `65536` and above - treat the banner as "up to", not "through".