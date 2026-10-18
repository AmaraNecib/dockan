# 91 — DB-heavy tests trip Bun's 5s default on contended runs

## Problem

`bun run --filter @dokan/api test` intermittently fails on tests that do real
database work (`setup + seed`, `auth column migration`, …) and passes on every
rerun/in isolation. Under load those tests exceed Bun's **5s default timeout**;
they are slow, not broken. #89 fixed the same class inside `backups.test.ts`
with an explicit per-test budget (`itCopyingDb`) and by giving every test its
own backups directory (a timed-out copy left a `.partial` file in a shared
`beforeAll` dir and failed the next two tests).

## Design

Tests, not production code.

- **`apps/api/src/test-support/heavy.ts`** exports `HEAVY_TEST_TIMEOUT_MS` (120s),
  `itHeavy(name, fn)`, and `setHeavyDefaultTimeout()`. One named budget,
  documented with why it exists.
- **Opt in only where the work is genuinely heavy.** Two forms:
  - `itHeavy` for files that mix heavy tests with trivial ones (`backups`,
    `session-secret`, `schema-refusal`, `schema-version`,
    `supplier-adjustment-migration`, `stock-ledger`, `preferences`,
    `supplier-account-zero`, `vault/backup`, `vault/gate`, `vault/manager`,
    `vault/core`, and the whole-repo scan in `opening-balance-resolver`).
  - `setHeavyDefaultTimeout()` where every test does the same heavy work:
    `drizzle-store` (the whole 79-test store-seam file), `encrypted-connection`,
    and the wire files `rpc/router` (238 tests), `auth`, `pagination-store`,
    `supplier-account-store`.
- **Hook budgets.** Bun applies the same 5s default to `beforeAll`. Every file
  whose hook opens a connection and runs `setup()` (plus the RPC/auth owner
  login) passes `HEAVY_TEST_TIMEOUT_MS` to `beforeAll`. A hook timeout fails
  *every* test in the file, so that was the worst cascade still open.
- **Process-spawning suites** (`vault/broker`, `vault/lock.integration`) reuse
  the same constant instead of their own 30s: a broker test hit 30s under a
  two-suite contended run and failed, and an explicit bound is still a bound.
- `backups.test.ts` drops its private `DB_COPY_TIMEOUT_MS` / `itCopyingDb` and
  uses the shared helper, so there is a single definition of the budget.

Why 120s and not 60s: under a full `bun run test` (turbo runs the api and web
suites together) with sibling worktrees active, a 60s budget was exceeded — one
legacy-migration test with four `setup()` calls was measured at 96s. 120s still
bounds a real hang.

## Second half of #89 — shared fixture dirs

Audit `beforeAll`-shared temp dirs for the cascade: one test's leftover *file*
failing the tests after it.

- `backups.test.ts` — already per-test (`freshDataDir`) + in-flight guard.
- `port-record.test.ts` — shared dir, but every test uses a distinct lock file
  name and its own dir for transient records; no cross-test file reads.
- `drizzle-store` / `pagination-store` / `stock-ledger` / `supplier-account*` /
  `auth` / `router` / `encrypted-*` — the shared dir holds one live database
  reached through the store; per-test legacy fixtures already `mkdtemp` their
  own dir; log files are append-only and not asserted across tests.

No new cascade found.

## Validation

All on the final head, with sibling worktrees active:

| run | result |
|---|---|
| `bun run test` (api 911, web 1057, desktop 59, e2e-support 22, scripts 38) | 0 fail, exit 0 |
| 2× concurrent `bun test --max-concurrency=2` | 911 pass / 0 fail each |

Individual tests cleared Bun's 5s default while merely being slow, so the budget
is load-bearing, not speculative:

| test | observed |
|---|---|
| `daily startup backup > rebuilds a header-valid file whose tail pages were truncated` | 13.1s / 9.3s / 6.1s |
| `first-time setup provisioning > refuses a non-empty database with no owner…` | 8.4s / 8.5s |
| `desktop shell vault broker > …` | up to 16.1s |
| `ensureSessionSecret > regenerates empty, short and malformed stored values…` | 6.5s / 6.4s |
| `databaseIsEmpty > is false when the return number sequence has been used` | 6.0s / 8.7s |
| `parties (issue 120) > backfills one party per distinct typed name…` | 96s (with a 60s budget; the reason for 120s) |

Logs: `.scratch/91-logs/gate-postgap.log`, `v4-1.log`, `v4-2.log`,
`final-single2.log`, `full-test-final.log`, `final2-*.log`, `v3-*.log`.

## Risks

- A loose budget can mask a real hang. Mitigated by the explicit named wrapper:
  only the audited heavy tests/hooks and the uniform heavy files opt in;
  pure-logic files (and the trivial tests inside mixed files) keep the strict
  default.
- The heavy/light split is structural (does the work touch a real database,
  KDF, or repo scan) plus an empirical ≥500ms warm cutoff. Review caught one
  gap (two `parties` tests in `drizzle-store`); the repair was to make that
  whole file uniform rather than patch the classifier again.
