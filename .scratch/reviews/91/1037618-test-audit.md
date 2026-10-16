# 91 — test audit

Head: `1037618`.

This change adds no product behaviour and no new test cases; it changes how the
existing API tests are time-bounded. The audit is therefore about coverage of
the defect class, not about new edge cases.

## What was audited

Every test body in `apps/api` was classified by whether it does heavy real work:
a direct hit on `openConnection` / `new Database` / `openTestConnection`, a call
to `store.setup()`, a forward migration, a database copy/rebuild, a production
Argon2 pass, or the whole-repo source scan. The list was cross-checked against
every test measured ≥500ms warm under contention (`final2-1.log`, `v3-1.log`).

The first pass was token-based and missed tests that reach the database through
a shared `beforeAll` store with no heavy token in the body. The full gate caught
two (`parties (issue 120)` in `drizzle-store`). The repair was to make whole
files uniform (`setHeavyDefaultTimeout`) wherever every test drives the same
heavy seam, rather than patch the classifier again:

- `setHeavyDefaultTimeout`: `drizzle-store` (79 tests), `encrypted-connection`,
  `rpc/router`, `auth`, `pagination-store`, `supplier-account-store`.
- `itHeavy` per test: `backups`, `session-secret`, `schema-refusal`,
  `schema-version`, `supplier-adjustment-migration`, `stock-ledger`,
  `preferences`, `supplier-account-zero`, `vault/backup`, `vault/gate`,
  `vault/manager`, `vault/core`, the whole-repo scan in
  `opening-balance-resolver`.
- Deliberately left strict: `config.test.ts`, `setup-throttle.test.ts`,
  `port-record.test.ts`, the pure logic halves of
  `sale-calculations`/`stock-ledger`/`opening-balance-resolver`, the in-memory
  vault crypto, and `logger`/`lock` file tests.
- All `beforeAll` hooks that open + migrate a database take the budget; the
  remaining hooks only `mkdtemp`.
- E2E: not applicable — no user-facing behaviour changed.

## Evidence the budget is load-bearing

Tests that cleared Bun's 5s default while merely being slow and passed:

| test | observed |
|---|---|
| `daily startup backup > rebuilds a header-valid file whose tail pages were truncated` | 13.1s / 9.3s / 6.1s |
| `first-time setup provisioning > refuses a non-empty database with no owner…` | 8.4s / 8.5s |
| `desktop shell vault broker > resets the passphrase from a recovery key…` | 16.1s |
| `ensureSessionSecret > regenerates empty, short and malformed stored values…` | 6.5s / 6.4s |
| `databaseIsEmpty > is false when the return number sequence has been used` | 6.0s / 8.7s |
| `databaseIsEmpty > is true after setup on a fresh database` | 4.8s / 7.2s |
| `parties (issue 120) > backfills one party per distinct typed name…` | **96s** (four `setup()` calls) |

## Gates

| command | exit |
|---|---|
| `bun run typecheck` (turbo, 4 tasks) | 0 |
| `bun run lint` (oxlint) | 0 |
| `bun run test` (api 911, web 1057, desktop 59, e2e-support 22, scripts 38; 0 fail) | 0 |
| 2× concurrent `bun test --max-concurrency=2` (contended, 911 pass each) | 0 / 0 |

Logs: `.scratch/91-logs/gate-postgap.log`, `v4-1.log`, `v4-2.log`,
`final-single2.log`, `full-test-final.log`, `final2-*.log`, `v3-*.log`.

## Residual risk

A heavy test not covered by the audit would still flake, and the 96s outlier
shows the budget can be approached under an extreme multi-lane load. The audit
covers every file that touches a real database or the vault; the strict default
is kept where the work is genuinely light, so a real hang still fails fast.
