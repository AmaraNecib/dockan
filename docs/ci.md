# CI

`.github/workflows/ci.yml` runs on every pull request targeting `develop` and
every push to `develop`. It is the server-side twin of the local Guard checks
in `engineering-workflow.md`.

| Job | Steps |
| --- | --- |
| `checks` | `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun run test`, `bun audit` |
| `e2e` | `bunx playwright install --with-deps chromium`, `bun run test:e2e` on CI-only ports (`DOKAN_PORT=5317`, `DOKAN_WEB_PORT=6173`) |

The two jobs are independent. A typecheck/lint/test failure and a Playwright
flake are visible without one hiding the other.

## Audit policy

`bun audit` first prints every advisory (informational), then fails the job
only on `high`/`critical` via `bun audit --audit-level=high`. Low and moderate
advisories are reported but do not block a merge; open an issue for them.

`bun audit` needs the npm advisory endpoint. A registry outage fails the job
on purpose — an unverifiable audit is not a green audit.

## Bun version

`oven-sh/setup-bun` reads `packageManager` from `package.json`
(`bun@1.3.14`), so CI tracks the repo pin automatically.

## Required checks — manual step

Branch protection is a GitHub repository setting, not something a workflow can
enforce. To make these checks required on `develop` an admin must:

1. GitHub → Settings → Branches → **Add branch protection rule** (or edit the
   existing `develop` rule).
2. Branch name pattern: `develop`.
3. Enable **Require status checks to pass before merging**.
4. Select the `typecheck, lint, test, audit` and `playwright e2e` checks.

Until that is done the workflow still runs and reports, but a red run does not
block a merge.

## Desktop installer (nightly + manual)

`.github/workflows/desktop-installer.yml` builds the one universal Tauri app
(ADR-0008) and uploads the NSIS installer as a workflow artifact. It runs only
on `workflow_dispatch` and a nightly `schedule` — never on pull requests — and
is intentionally **not** one of the required status checks, so a slow or broken
desktop build can never block an ordinary PR.

The build is the documented release command
(`bun run --filter @dokan/desktop installer`: sidecar compile + `tauri build
--bundles nsis`), run on `windows-latest` because the Tauri shell and the
portable/NSIS deliverables are Windows-only (`development-workflow.md` §5). No
repository secrets are used: ADR-0008 removed the per-customer build secrets.

Artifacts: the NSIS installer (`dokan-installer-<run_number>-<run_attempt>`),
retained 14 days. A run that produces no installer fails loudly
(`if-no-files-found: error` plus an explicit size check).

## Not in the PR gate

The desktop/Tauri build is not part of the PR gate: it is a Windows-only
Rust/Tauri build, and the api/web gates in CI are the same commands the local
Guard runs. It has its own nightly/manual workflow (above) and is not a
required status check. The rest of the desktop path is covered by local gates
(see `development-workflow.md` §5).
