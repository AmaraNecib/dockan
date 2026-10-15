# Design — #206 (cover the vault-port property; make `backups.spec.ts` data-dir aware)

**Tier:** Standard (test + docs only; no app/contract/schema change).
**Base:** `origin/develop` @ `21dbc13` (== current `HEAD`).
**Issue:** #206, follow-up to #202 / PR #205.

## Problem

#202 replaced the vault spec's hardcoded `4399`/`5174` with
`DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT` resolved by a module-private
`vaultPort()` in `tests/e2e/vault.spec.ts`. The default path runs on every
invocation; the override path and the validation branches are only ever
exercised by hand, so an env-parsing regression ships silently. Separately,
`tests/e2e/backups.spec.ts` hardcodes `.e2e-data`, ignoring the `E2E_DATA_DIR`
isolation convention the rest of the suite (and `playwright.config.ts`) uses.

## Scope and decisions

### 1. Extract the resolver into a unit-testable module (requested)

`tests/e2e/` is not a Bun workspace, so a test file next to the spec would never
run under `bun run test` (turbo only visits workspace packages). The resolver
therefore moves to a new, deliberately tiny workspace package:

```
packages/e2e-support/
  package.json        # @dokan/e2e-support, typecheck + test scripts
  tsconfig.json       # node + bun types (bun:test)
  src/vault-ports.ts
  src/vault-ports.test.ts
```

Interface (the test surface — callers and tests cross the same seam):

```ts
export const VAULT_API_PORT_DEFAULT = 4399;
export const VAULT_WEB_PORT_DEFAULT = 5174;

export type VaultPorts = { api: number; web: number };

export function resolveVaultPorts(env?: NodeJS.ProcessEnv): VaultPorts;
```

- `resolveVaultPorts` returns both ports in one call; the env names, defaults and
  validation live inside the module, not at call sites.
- `env` is an injected dependency (defaults to `process.env`), so nearly every
  test exercises an explicit environment; the single default-argument test
  saves and restores both variables.
- Per-name parsing stays exactly as shipped in #202: blank/undefined → default;
  otherwise `Number.isInteger` and `1 <= port <= 65535`, else a named throw.
  Defaults and error text are byte-for-byte unchanged; every existing run and
  workflow is unaffected.
- `tests/e2e/vault.spec.ts` imports the module by relative path
  (`../../packages/e2e-support/src/vault-ports`). Playwright transpiles TS
  outside `node_modules`; a bare package specifier would need the root
  `package.json` to depend on the package and would push raw TS through
  `node_modules` resolution, which Playwright does not transform.

Why a package and not `apps/*/src`: the resolver is test infrastructure. Putting
`DOKAN_VAULT_PORT` parsing in the API source would suggest the app reads it (it
does not) and would ship it in the API bundle.

### 2. `backups.spec.ts` honours `E2E_DATA_DIR` (requested)

```ts
const dataDir = process.env.E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data");
const backupsDir = path.join(dataDir, "backups");
```

Matches `playwright.config.ts` and `00-onboarding.spec.ts`. With the variable
unset the path is the current default, so the spec passes unchanged.

### 3. Two concurrent vault runs — documentation, not a racy test (brief override)

The brief overrides the issue's requested "opt-in CI job": a deterministic
version needs two full vault suites (each spins its own API+web pair in
`beforeAll`), which the repo has no harness for, and a timing-dependent version
would race. No test is added. Instead the manual procedure is recorded in
`docs/ci.md` (run two `playwright test tests/e2e/vault.spec.ts` invocations
concurrently on disjoint `DOKAN_PORT`/`DOKAN_WEB_PORT` **and**
`DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT`, plus disjoint `E2E_DATA_DIR`; both
must exit 0), together with the negative control (sharing the vault pair fails)
and the reason it is not in CI.

## Planned tests / evidence

- Unit: `packages/e2e-support/src/vault-ports.test.ts` — defaults (4399/5174),
  blank/whitespace-means-unset, explicit overrides, the
  1..65535 boundary, out-of-range/non-integer/non-numeric rejection with the
  name in the message, per-port independence, and the `process.env` default
  argument.
- E2E: full `bun run test:e2e` on isolated ports and data dir, proving the spec
  still passes with the resolver extracted and the default data dir.
- Guard 1 + Guard 2: `bun run typecheck`, `bun run lint`, `bun run test`, full
  Playwright.

## Outcome (2026-10-15)

- Unit tests: 21 pass (`@dokan/e2e-support`), added to `bun run test`.
- Full `bun run test:e2e` at the final HEAD: 57 passed, including vault 3/3 and
  `backups.spec.ts` with the default `.e2e-data` path (also verified separately
  with `E2E_DATA_DIR` set). Earlier attempts on the same code flaked only on
  host-saturation timeouts in a different spec each run (91% CPU, sibling lanes);
  the green run had the sibling e2e finished.
- Two concurrent vault runs were executed on disjoint pairs. Both reached and
  passed the gate and first-run tests on their own servers (no cross-talk), then
  both timed out at test 3's 5 s post-KDF assertion. The trace shows
  `reset-passphrase` never completed while `unlock` took 3.2 s and
  `unlock-recovery` 2.1 s — pure-TS Argon2id (32 MiB × 3) under doubled load,
  not a port collision. `docs/ci.md` now states that signature; the lesson is in
  `.agents/wisdom/2026-10-15-vault-concurrent-runs-are-kdf-bound.md`.

## Risks

- **New workspace package changes `bun.lock`.** Committed; CI's
  `bun install --frozen-lockfile` must still pass. Re-run `bun install` after
  adding the package.
- **Relative import into `packages/`.** Shadows the package boundary, but the
  package has no build step and the alternative (root workspace dependency) has
  the `node_modules` TS-transform problem above. Documented in the spec import.
- **Default drift.** Defaults are the shipped literals; a run that sets nothing
  is byte-for-byte unchanged.

## Non-goals

- No app, contract, or schema change.
- No opt-in CI job for concurrent vault runs (brief: document, do not fake it).
- No timeout increases.
