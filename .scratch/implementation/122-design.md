# #122 — CI gate: typecheck, lint, tests, dependency audit, Playwright e2e

Tier: **Standard**. Base: `origin/develop` @ a0b9671 (merge-base = HEAD).

## Scope of this lane

`.github/**` plus a `docs/ci.md` note. Not in scope: `package.json` /
`bun.lock` (every needed command already exists as a root script), app source,
and the desktop/Tauri build.

## Workflow

`.github/workflows/ci.yml`, triggered by `pull_request` → `develop` and
`push` → `develop`. Two jobs, intentionally independent (no `needs`): a
typecheck/lint failure and an e2e flake must be tellable apart at a glance,
and parallelism halves the wall clock. Both share the same setup:

`actions/checkout` (v7.0.1), `oven-sh/setup-bun` (v2.2.0), and
`actions/cache` (v6.1.0), each pinned to its release commit SHA — a mutable
tag can be moved to untrusted code. `setup-bun` reads
`packageManager: bun@1.3.14` from `package.json`, so CI follows the repo pin
without a second source of truth. The cache key is `bun.lock`.

| Job | Steps |
| --- | --- |
| `checks` | `bun run typecheck`, `bun run lint`, `bun run test`, `bun audit` |
| `e2e` | `bunx playwright install --with-deps chromium`, `bun run test:e2e` |

### Audit policy

bun 1.3.14 counts only advisories at or above `--audit-level`, then exits `1`
when any counted advisory remains (verified against
`src/cli/audit_command.zig` at tag `bun-v1.3.14`: `shouldIncludeSeverity`
filters the list before `vuln_counts`, and `total > 0` returns `1`). So the
step first prints the full report (`bun audit || true`, in a log group) and
then gates with `bun audit --audit-level=high`: low/moderate advisories are
reported but do not fail the build; high/critical do.

### Fixed CI ports

Playwright's defaults (4317/5173) collide with other worktrees on the
developer machine, so the `e2e` job pins `DOKAN_PORT=5317` /
`DOKAN_WEB_PORT=6173` at job level and passes them through the existing
`playwright.config.ts` seam. An explicit `DOKAN_WEB_PORT` also sets Vite
`strictPort`, so a clash fails loudly instead of silently moving.

## Required checks (manual, outside the repo)

Branch protection is a GitHub repository setting; the workflow can only
publish checks. An admin must require `checks` and `e2e` on `develop` —
documented in `docs/ci.md` and repeated in the PR body.

## Explicitly not in CI (follow-up)

- Desktop/Tauri build: needs per-customer `DOKAN_BUILD_SECRET` /
  `DOKAN_AUTH_SECRET`, which must never live in CI (see
  `docs/development-workflow.md` §5).
- Playwright browser caching and HTML-report artifacts: not worth the config
  until e2e runtime bites.

## Review follow-ups

- Greptile P2 (supply chain): all action refs are pinned to full commit
  SHAs (`actions/checkout@3d3c42e5…` v7.0.1,
  `oven-sh/setup-bun@0c5077e5…` v2.2.0,
  `actions/cache@55cc8345…` v6.1.0).
- CI failed on Linux: four tests asserted hardcoded Windows paths
  (`path.resolve("C:\\...")` is relative on Linux). The assertions in
  `apps/api/src/config.test.ts` and `apps/desktop/scripts/portable.test.ts`
  are now `it.skipIf(process.platform !== "win32")`; the deferred
  Windows/desktop CI (#128) runs them on a Windows host. `config.ts` behavior
  is unchanged.

## Risks

- `bun audit` needs the npm advisory endpoint; a registry outage turns the
  job red. Intended: an unverifiable audit must not be silently green.
- The e2e job pays for a second `bun install`; the install cache covers most
  of it.
