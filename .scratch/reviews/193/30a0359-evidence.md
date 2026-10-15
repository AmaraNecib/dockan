# Evidence — #193 + #202 at `30a0359`

**Branch:** `test-193-load-sensitive-specs` · **Base:** `origin/develop` @ `f757211`
· **Tier:** Standard · **HEAD:** `30a035975ffd72daa5f11f7c82841d443eb3db34`

Commits (do not push — parent lands):

| SHA | What |
| --- | --- |
| `3324bcb` | vault ports configurable + 201-supplier fill batched |
| `c8ee009` | sibling 200-row fill batched too + wisdom |
| `9309830` | vault port env validation + helper hardening (review round 2) |
| `30a0359` | wisdom snippet synced to the shipped helper (review round 3) |

Changed files (`git diff f757211...HEAD --name-only`):

| File | Why |
| --- | --- |
| `tests/e2e/vault.spec.ts` | #202 — vault pair from `DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT` |
| `apps/web/src/pages/supplier-opening-balance.test.tsx` | #193 — batch the 200-row fills |
| `AGENTS.md` | #202 — state the relaxed lane rule |
| `.agents/wisdom/2026-10-15-react-discrete-event-render-cost.md` | #193 lesson |
| `.agents/wisdom/2026-10-14-e2e-port-collisions-vault-spec.md` | superseded note |
| `.agents/wisdom/2026-10-13-e2e-stale-server-and-checksum-flake.md` | superseded note |
| `.scratch/implementation/193-design.md` | design |

## #202 — two concurrent vault runs, no cross-talk

Each run starts its own shared pair (`DOKAN_PORT`/`DOKAN_WEB_PORT`) plus its own
vault pair (`DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT`); the vault spec reads the
resolved pair at its spawn env, both health polls, the vault-status poll and
every navigation.

### Positive — disjoint pairs (the acceptance case), run simultaneously

```
A: DOKAN_PORT=5317 DOKAN_WEB_PORT=5373 DOKAN_VAULT_PORT=5320 DOKAN_VAULT_WEB_PORT=5374
B: DOKAN_PORT=5417 DOKAN_WEB_PORT=5473 DOKAN_VAULT_PORT=5420 DOKAN_VAULT_WEB_PORT=5474

A: 3 passed (36.2s)   A_EXIT=0
B: 3 passed (36.7s)   B_EXIT=0
```

No cross-talk: each run created, restarted and re-unlocked its own vault against
its own API/web pair and its own `mkdtemp` data dir.

### Negative control — shared vault pair (a race, as expected)

(a) Both runs forced onto one explicit vault pair (5701/5702), disjoint main
pairs:

```
C: 1 failed, 1 passed   C_EXIT=1
D: 3 passed             D_EXIT=0
```

(b) Earlier at `3324bcb`, both runs left on the default pair 4399/5174 (disjoint
main pairs) — both lost:

```
C: 1 failed, 1 passed (49.5s)      C_EXIT=1   (vault gate never reported state locked)
D: 1 failed, 1 did not run, 1 passed (20.7s)   D_EXIT=1   (recovery key never shown)
```

The controls are inherently racy (Windows can let a second socket bind the same
port), which is why the isolation must be explicit. The positive run is the
acceptance: with disjoint pairs neither run ever touched the other's servers.

### Full suite on isolated ports

```
DOKAN_PORT=5241 DOKAN_WEB_PORT=5297 DOKAN_VAULT_PORT=5242 DOKAN_VAULT_WEB_PORT=5298 bun run test:e2e
→ 57 passed (4.7m)   E2E_EXIT=0     (vault.spec.ts on 5242/5298: 3 passed)
```

Defaults unchanged: `vaultPort(name, fallback)` returns 4399/5174 for an
unset/blank variable. A non-port value throws a named error instead of polling
port `0`/`NaN`.

## #193 — the 200-row fills are batched, not timed out

Root cause: filling 200 controlled inputs with 200 real DOM `input` events
re-renders the 200+ row table once per fill — React flushes every *discrete*
event synchronously. Both cap tests did this (round-5 201-supplier, and the
200-row contract-limit test).

### Reproduction of the original failure (base test, pre-fix)

40 CPU burners on a 12-core host (~3.3× oversubscription), round-5 test:

```
(fail) ... counts a typed name toward the batch limit and blocks before the server
  ^ this test timed out after 60000ms.
EXIT=1
```

The test already carried a `60_000` bound, so this was **not** Bun's 5 s default.
A synchronous fill loop cannot be pre-empted at the bound — the reported
duration balloons (300+ s) before the timeout is detected. A fixed bound is a
bet on the host's CPU share; the only robust fix is to remove the 200 renders.

### Fix and measurement

`fillAmounts(inputs, valueFor)` invokes each input's React `onChange` inside one
`act`, so the 200 state updates batch into **one** render. The page's real
`setRow` handler still runs; a DOM-event fallback keeps it correct if React's
`__reactProps$` binding is ever renamed.

| Run | round-5 test | contract-limit test |
| --- | --- | --- |
| isolation, before | ~15 s | ~48 s (measured by a reviewer) |
| full turbo unit, after | 2.0 s | 2.1 s |
| two heavy suites concurrently, after | 927 ms | 642 ms |

### Contended run (several suites at once) at this SHA

`TURBO_FORCE=1 bun run test` (api+web+desktop parallel) **and** a second full
`apps/api` suite, started together:

```
@dokan/web:test: (pass) ... blocks a batch over the 200-row contract limit ... [642.02ms]
@dokan/web:test: (pass) ... counts a typed name toward the batch limit ... [927.40ms]
@dokan/api:test: Ran 886 tests across 43 files. [107.27s]   0 fail
@dokan/web:test: Ran 958 tests across 70 files. [143.63s]   0 fail
A_EXIT=0
B (second api suite): Ran 886 tests ... 0 fail   B_EXIT=0
```

The budget is unchanged at `60_000` (now the named
`BATCH_LIMIT_TEST_TIMEOUT_MS`, on both cap tests) — a safety net with >20×
headroom, not the mechanism. It was not raised.

## Gates (at this SHA)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | 3 successful, exit 0 |
| Lint | `bun run lint` | 0 errors, exit 0 |
| Unit (turbo) | `TURBO_FORCE=1 bun run test` | 886+958+57 pass, 0 fail, exit 0 |
| E2E | `bun run test:e2e` (isolated ports) | 57 passed, exit 0 |
| Vault spec | `playwright test tests/e2e/vault.spec.ts` (isolated) | 3 passed, exit 0 |

No app, contract, or schema change. No real app bug found behind either failure.
