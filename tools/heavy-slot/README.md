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

Capacity is recomputed on every acquire from free RAM and CPU load. `HEAVY_SLOT_MAX` is a safety
ceiling, not the value you get: a tight machine narrows itself, an idle machine widens. A wait
budget (`HEAVY_SLOT_WAIT_MS`, default 30 minutes) exits `75` having run nothing, so a caller can
fall back to focused tests.

## Failure mode prevented

Several agents on one box each running a full suite pin every core: every lane's timing tests
flake and the machine thrashes. The queue admits a bounded number at a time, measured from the
machine, so lanes stop fighting for cores. A slot is released automatically when its holder dies,
so a crashed lane does not strand a slot.