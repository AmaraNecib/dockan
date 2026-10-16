# Test audit — #232 Greptile round

- **Reviewed SHA:** `75ca3645fabd9cea3ca0e5337a4db52a9ce442c9` (`75ca364`)
- **Base:** `origin/develop` @ `1ea76b5` (merge-base)
- **PR:** #232 (`fix-91-db-test-contention`), closes #91
- **Tier:** Standard (test-only)
- **Delta:** `7934fea...75ca364` — `apps/api/src/store/encrypted-store.test.ts` only (3 insertions / 3 deletions)

Greptile finding closed: the last two tests in `encrypted-store.test.ts` still used plain `it`
although they call `freshVault()` (opens an encrypted store, runs `store.setup()`, writes the first
snapshot). Both are now `itHeavy`; the now-unused `it` import was dropped, so all **7** tests in the
file use one mechanism.

## Lenses (independent sub-agents)

- **Edge-case hunter** — no confirmed false negatives in the files deep-read; confirmed the
  fast-KDF helpers (`vault/core.test.ts:freshVault`, `vault/backup.test.ts:headerText`) are correctly
  light, and that the sole production-KDF test in `core.test.ts` is `itHeavy`. Flagged that v1 of the
  sweep could not resolve arrow-const/imported helpers or `it.each`.
- **Coverage analyst** — enumeration complete (25/25 touched test files); found the sweep did not
  model the third carrier `it(name, fn, HEAVY_TEST_TIMEOUT_MS)` (used in `vault/broker.test.ts` ×9 and
  `rpc/supplier-account-zero.test.ts` ×1 test), and that v1 undercounted `itHeavy` (97 vs the true
  **119** sites, all in `vault/gate.test.ts`). Nil of these is an unbudgeted test.
- **Quality reviewer** — delta grade **A−**. Names still meaningful, import hygiene clean, no private
  timeout constant, no weakened assertions, isolation (`beforeEach` mkdtemp / `afterEach` rm-loop)
  untouched. Completing `itHeavy` is defensible: the file already used it for 5/7 tests, and unlike a
  file-level default it keeps the trivial `mkdtemp` `beforeEach` on the strict default.

The two review agents that audited the sweep agreed there is **no unbudgeted heavy test**; their
findings were about the sweep tool's recall, not the code.

## Sweep — every test file touched by the PR

Heavy = opens a store, runs `store.setup()`/DDL/migration, spawns a process, or a production-KDF
pass. Budget carrier = `itHeavy`, explicit third arg `HEAVY_TEST_TIMEOUT_MS`, or a module-top-level
`setHeavyDefaultTimeout()`.

| File | Mechanism | `itHeavy` | it + `HEAVY_TEST_TIMEOUT_MS` | Heavy tests | Unbudgeted |
|---|---|---:|---:|---:|---:|
| auth.test.ts | file default | 0 | 1 (hook) | 1 hook (owner login) | 0 |
| encrypted-connection.test.ts | file default | 0 | 0 | 12 | 0 |
| backups.test.ts | per-test | 7 | 1 (beforeAll) | 7 | 0 |
| schema-refusal.test.ts | per-test | 1 | 0 | 1 | 0 |
| schema-version.test.ts | per-test | 9 | 0 | 2 | 0 |
| session-secret.test.ts | per-test | 7 | 0 | 6 | 0 |
| vault/backup.test.ts | per-test | 1 | 0 | 1 | 0 |
| vault/broker.test.ts | per-test | 0 | 9 tests | 9 (spawns broker) | 0 |
| vault/core.test.ts | per-test | 1 | 0 | 1 (prod KDF) | 0 |
| vault/gate.test.ts | per-test | 28 | 0 | 6 | 0 |
| vault/lock.integration.test.ts | per-test | 2 | 0 | 2 (spawns) | 0 |
| vault/manager.test.ts | per-test | 21 | 0 | 21 | 0 |
| rpc/opening-balance-resolver.test.ts | per-test | 1 | 0 | 1 (repo scan) | 0 |
| rpc/router.test.ts | file default | 0 | 1 (hook) | 1 hook | 0 |
| rpc/supplier-account-zero.test.ts | per-test | 0 | 1 test + 1 hook | 1 | 0 |
| store/dashboard-summary.test.ts | per-test | 7 | 0 | 7 | 0 |
| store/database-empty.test.ts | per-test | 5 | 0 | 5 | 0 |
| store/drizzle-store.test.ts | file default | 0 | 1 (hook) | 12 | 0 |
| store/encrypted-store.test.ts | per-test | 7 | 0 | 7 | 0 |
| store/onboarding-progress.test.ts | per-test | 12 | 0 | 12 | 0 |
| store/pagination-store.test.ts | file default | 0 | 1 (hook) | 0 (hook budgeted) | 0 |
| store/preferences.test.ts | per-test | 4 | 0 | 4 | 0 |
| store/stock-ledger-store.test.ts | per-test | 3 | 1 (beforeAll) | 3 | 0 |
| store/supplier-account-store.test.ts | file default | 0 | 1 (hook) | 0 (hook budgeted) | 0 |
| store/supplier-adjustment-migration.test.ts | per-test | 3 | 0 | 3 | 0 |

**Totals:** 25 test files; 119 `itHeavy` sites; 6 files on the shared file-level default
(`auth`, `encrypted-connection`, `router`, `drizzle-store`, `pagination-store`,
`supplier-account-store`); **0 unbudgeted heavy tests**.

The 445 non-`itHeavy` test sites resolve either to a whole-file default (388 tests in the six files
above) or to the explicit third-arg carrier, or are genuinely light. Every plain `it` in the 19
per-test files was read: the fast-KDF helpers (`vault/core`, `vault/backup`), pure string/date checks
(`backups`), pure resolver/backoff logic (`opening-balance-resolver`, `vault/manager`), and HTTP
error-mapping (`schema-refusal`) are light and correctly keep the strict 5s default.

## Deliberately left

- **Duplicated serialize monkey-patch preamble** in `encrypted-store.test.ts` (the two converted tests
  each build a slow `conn.raw.serialize`). Pre-existing; extracting a helper would widen this round's
  diff beyond the Greptile finding. Left with reason, not silently.
- **Whole-file default on `rpc/router.test.ts` (238 tests)** keeps light tests at 120s. That is the
  PR's existing, design-doc-recorded decision for the wire files; not changed here.
- **Pre-existing test-harness quirk** (quality reviewer): the legacy-install fixture in
  `encrypted-store.test.ts` spawns `bun -e` with a relative `./src/config`, so it only resolves when
  the runner cwd is `apps/api`. Unrelated to this delta; worth a follow-up if the suite is ever run
  from the repo root.

## Commands

| Command | Result |
|---|---|
| `bun install` | 189 packages, exit 0 |
| `bun run typecheck` | 4/4 tasks, exit 0 |
| `bun run lint` | exit 0 |
| `bun run test` | exit 0 (api 911, web 1057, desktop 59, e2e-support 22, scripts 38) |
| `cd apps/api && bun test src/store/encrypted-store.test.ts` | 7 pass / 0 fail, exit 0 |
| 2× concurrent `cd apps/api && bun test --max-concurrency=2` | 911 pass / 0 fail each, exit 0 |
