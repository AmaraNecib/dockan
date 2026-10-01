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

`actions/checkout@v7` → `oven-sh/setup-bun@v2` (reads
`packageManager: bun@1.3.14` from `package.json`, so CI follows the repo pin
without a second source of truth) → `actions/cache@v6` on
`~/.bun/install/cache` keyed by `bun.lock` → `bun install --frozen-lockfile`.

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

## Risks

- `bun audit` needs the npm advisory endpoint; a registry outage turns the
  job red. Intended: an unverifiable audit must not be silently green.
- The e2e job pays for a second `bun install`; the install cache covers most
  of it.
