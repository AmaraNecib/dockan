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

## Desktop release (manual + version tags)

`.github/workflows/desktop-installer.yml` builds the one universal Tauri app
(ADR-0008) as both release targets and uploads them:

| Target | Command | Artifact |
| --- | --- | --- |
| installer | `bun run --filter @dokan/desktop installer` | NSIS `Dokan_<version>_x64-setup.exe` |
| portable | `bun run --filter @dokan/desktop portable` | `Dokan-portable.zip` + the `Dokan-portable/` folder |

It runs on `windows-latest` because the Tauri shell and the portable/NSIS
deliverables are Windows-only (`development-workflow.md` §5). No repository
secrets are used: ADR-0008 removed the per-customer build secrets.

The version lives in **both** `apps/desktop/package.json` and
`apps/desktop/src-tauri/tauri.conf.json`. Before any build the workflow asserts
they match and, on a tag, that the tag equals `v<version>` (an optional
pre-release suffix is allowed, e.g. `v0.2.0-rc.1` for version `0.2.0`). A
mismatch fails loudly — a wrong-version installer is worse than no installer.
The resolved version is written to the run summary and used in the artifact
names (`Dokan-<version>-installer`, `Dokan-<version>-portable`). Both targets
are verified non-empty before either is uploaded, so a missing target fails the
job instead of leaving a partial success.

### Release procedure (tag → published release)

1. Bump the version to the same value in **both**
   `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json`.
2. Merge the bump to `main`.
3. Create and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

4. The workflow builds **both** targets, then a separate `release` job — the
   only job with `contents: write` — publishes a GitHub release for the tag with
   the installer `.exe` and the portable `.zip` attached. A tag with a
   pre-release suffix (`v0.2.0-rc.1`) is published as a GitHub **prerelease**;
   a plain `v0.2.0` is a normal release. The resolved kind is shown in the run
   summary, and a re-run re-applies it rather than flipping the release.

### One-off manual build (does NOT publish a release)

Run the workflow from the Actions tab (**workflow_dispatch**) and choose
`all`, `installer` or `portable`. It builds the selected target(s) and uploads
them as run artifacts; it never creates a release. A manual run on a tag ref
does not publish either — only a `push` of a `v*` tag does.

The workflow is intentionally **not** one of the required status checks and
never runs on a pull request, so it can never block an ordinary PR.

## Not in the PR gate

The desktop/Tauri build is not part of the PR gate: it is a Windows-only
Rust/Tauri build, and the api/web gates in CI are the same commands the local
Guard runs. It has its own manual/tag workflow (above) and is not a required
status check. The rest of the desktop path is covered by local gates
(see `development-workflow.md` §5).
