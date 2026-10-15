# #206 — guard verification (head 7caa6b6)

Branch `test-206-vault-port-coverage`, base `origin/develop` `3c3abcf`
(confirmed via `git ls-remote` and the GitHub API: develop has not moved; no
rebase was possible or needed beyond the one already applied).

## Guard 1 — pre-commit (7caa6b6)

| Check | Command | Exit | Log |
|---|---|---|---|
| Typecheck | `bun run typecheck` | 0 | `7caa6b6-guard1-typecheck.log` |
| Lint | `bun run lint` | 0 | `7caa6b6-guard1-lint.log` |
| Unit (turbo) | `bun run test` | 0 | `7caa6b6-guard1-test.log` |
| Unit (fresh, changed pkg) | `cd packages/e2e-support && bun test --max-concurrency=2` | 0 | 22 pass / 0 fail |

## Guard 2 — pre-push (7caa6b6)

Full Playwright on four isolated ports, default `E2E_DATA_DIR`:

```
DOKAN_PORT=4871 DOKAN_WEB_PORT=5871 \
DOKAN_VAULT_PORT=4872 DOKAN_VAULT_WEB_PORT=5872 \
bun run test:e2e
```

`69 passed (11.2m)`, exit 0. Log: `7caa6b6-guard2-e2e-full.log`. Includes vault
3/3 and `backups.spec.ts` on the default `.e2e-data` path. No flakes, no retries
(`retries: 0`). Sibling lanes were active (shared ports 4451/4477), so the run
took 11.2 m versus the earlier 6.0 m green run; nothing timed out.

Targeted `E2E_DATA_DIR` branch run (the default run only exercises the `??`
fallback):

```
DOKAN_PORT=4873 DOKAN_WEB_PORT=5873 \
E2E_DATA_DIR=$PWD/.e2e-data/206-custom \
bun run test:e2e tests/e2e/backups.spec.ts
```

`1 passed (15.5s)`, exit 0, and `dokan-2026-10-15.db` landed under
`.e2e-data/206-custom/backups` while the default dir's file was not rewritten.
Log: `7caa6b6-guard2-backups-custom-datadir.log`.

## Evidence

- `7caa6b6-test-audit.md` — three-agent audit + dispositions.
- `7caa6b6-code-review.md` — standards + spec axes, plus the delta review.
- `7caa6b6-diff.txt`, `7caa6b6-spec.md` — review inputs.

## Tree

`.dokan-port` was restored after the e2e runs; the only working-tree changes are
the review evidence under `.scratch/`.

## Not run / deferred

- The two-concurrent-vault-runs property stays manual per the brief: a
  deterministic version needs two full vault suites and `tests/e2e/` has no Bun
  harness. See `docs/ci.md` § Vault-port isolation and
  `.agents/wisdom/2026-10-15-vault-concurrent-runs-are-kdf-bound.md`.
- No push, PR, or merge (lane authority boundary).
