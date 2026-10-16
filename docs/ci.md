# CI

`.github/workflows/ci.yml` runs on every pull request targeting `develop`, every
push to `develop`, and on manual dispatch. It is the server-side twin of the
local Guard checks in `engineering-workflow.md`.

| Job | Steps |
| --- | --- |
| `changes` | fetch-depth-0 checkout, `git diff --no-renames` of the PR (or push), then `scripts/e2e-selection.ts` and one `grep -E` turn the file list into the `e2e_mode`, `e2e_specs` and `rust` outputs the other jobs read, and write the scope decision to the run summary |
| `checks` | `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun run test`, `bun run --filter @dokan/web build`, `bun audit` |
| `e2e` | `bunx playwright install --with-deps chromium`, then `bun run test:e2e` (with the mapped spec list when the diff is affected) on CI-only ports (`DOKAN_PORT=5317`, `DOKAN_WEB_PORT=6173`), teed to `e2e-logs/playwright.log`; uploads `test-results/` + `e2e-logs/` as the `playwright-e2e-failure-<attempt>` artifact on any non-success outcome |
| `rust` | gated on the `changes` job's `rust` output; `bun install --frozen-lockfile`, `bun run --filter @dokan/web build`, then `cargo test` and `cargo clippy -- -D warnings` in `apps/desktop/src-tauri` |

`checks` always runs. `e2e` and `rust` read the `changes` outputs, so an e2e
`skip` or a diff that cannot reach the crate skips those jobs; the scope
decision is written to the **`changes` job summary**, not the skipped job's, so
a `skip` decision is explained on the run itself. If the `changes` job itself
fails, its
outputs are empty and both consumers read that as "run": the gates use
`!cancelled()` with an empty-tolerant comparison, so an infra failure widens
the run instead of silently narrowing it. A typecheck/lint/test failure and a
Playwright flake are visible without one hiding the other.

## PR scope decision (issue 226)

The PR jobs are narrowed by changed path so a docs-only or web-only PR does not
pay for the Windows crate build, and a feature PR runs only the specs its paths
reach. `push: develop` is never narrowed: it is the only run that sees the exact
merged tree, and it is the backstop that makes narrowing a PR safe.

- `e2e` runs `full` on a push, `full` on a PR carrying the `e2e:full` label, the
  selected specs otherwise, and is skipped only when nothing in the diff can
  reach a browser. The `pull_request` trigger subscribes to `labeled` (alongside
  the default `opened`, `synchronize` and `reopened`) so adding `e2e:full` to an
  already-open PR starts a run — GitHub dispatches no event for a label change
  otherwise, which left the escape hatch silently inert (#231).
- The changed-file list is collected with `git diff --no-renames`, so a rename
  is listed as a delete plus an add. Rename detection reports only the
  destination, which would hide a file moved out of `apps/desktop/src-tauri/**`
  from the `rust` gate; listing both sides runs the gates whichever way a file
  moved, and can only over-run them (#231).
- `rust` runs when a path that can end up inside the crate, or drive its
  `build.rs`, changed. The crate itself and its scripts are
  `apps/desktop/src-tauri/**`, `apps/desktop/scripts/**` and
  `apps/desktop/package.json`. `build.rs` also fingerprints the api sources and
  their configs (`apps/api/src/**`, `apps/api/package.json`,
  `apps/api/tsconfig.json`), the `packages/contracts/**` package, `bun.lock`,
  `tsconfig.base.json` and the root `package.json`, because it compiles the api
  sidecar and re-runs when those change. A `rust-toolchain.toml` or `.cargo/**`
  counts too. It stays on `windows-latest`: the ACL/`capabilities` guard is a
  Windows-app guard, and `desktop-installer.yml` runs only on a tag, so it
  cannot replace a PR gate.
- `checks` runs the production `vite build` as an **additional always-running**
  step; it was not moved out of `rust`. The `rust` job still runs the same build
  at its own step, because `build.rs` hard-fails without `apps/web/dist` and
  Cargo needs it before it starts. Deleting the `rust` build because "the build
  is in `checks` now" would break the crate. The added `checks` build keeps a
  PR-time production build on web-only diffs that skip `rust` (the `e2e` job
  runs `vite dev`, and `turbo test` builds workspace dependencies, not the web
  app).
- `workflow_dispatch` takes no input and runs every suite, including `rust`.
  It is the escape hatch when the selector is distrusted; it deliberately has
  no scope input, so there is no hand-typed override to record.

### Fail-closed path -> spec map

`scripts/e2e-selection.ts` is a pure `selectSpecs(changed, map)` plus a CLI, and
`tests/e2e-selection.map.json` is the checked-in artifact. Precedence per file is
**critical (`always_full`) -> feature rule -> `skip_e2e` -> full**. An empty
diff, a critical path (the router and entry points, `store/**`, `rpc/**`,
`db/**`, the API bootstrap, `packages/contracts/**`, `apps/web/src/lib/**`,
`bun.lock`, the harness itself), or a path the map does not know forces the
whole suite. The selector never reads free text; the only overrule is the
`e2e:full` PR label, and it is recorded on the PR.

`scripts/e2e-selection.test.ts` runs inside `bun run test` (`turbo test` then
`bun test ./scripts/`) and fails when a spec on disk is unreachable from every
feature rule, when a rule names a spec that does not exist, or when a pattern
matches nothing. A stale map therefore costs minutes, never coverage.

Most rows are obvious page -> specs pairs. The non-obvious ones are deliberate:

- `apps/web/src/lib/**`, `components/app/**`, `components/ui/**` and `hooks/**`
  are **critical**, not feature rules. Every screen renders through the shell,
  the primitives and the shared helpers, so a changed line there can move any
  screen; claiming a per-screen rule would be a guess.
- `apps/web/src/components/print-sheet.tsx` is critical for the same reason: the
  invoice, receipt and return documents share its print layout.
- `apps/web/src/components/catalog/**` and `apps/web/src/components/parties/**`
  are critical too. The item picker is imported by the items, sale and purchase
  pages, and the party panels by the parties, party-detail, sale and purchase
  pages, so a single feature rule would under-select.
- `apps/web/src/components/vault/vault-gate.tsx` is **critical**, not a
  vault-only feature rule. `RequireSession` renders the gate before any route,
  and its `useVaultStatus` also drives the legacy plaintext startup, so a change
  there can change how every spec boots (#231). Its sibling `vault-settings.tsx`
  keeps the narrow `vault.spec.ts` rule.
- The invoice rule carries `returns.spec.ts`, because the invoice page renders
  the new-return `ReturnsPanel` that spec drives; the purchase rule carries
  `learnability.spec.ts` for the unit-test sibling, while `purchase.tsx` itself
  is critical (see the promotion bullet below) (#231).
- `stock.tsx`, `items.tsx`, `sale.tsx`, `purchase.tsx`, `parties.tsx` and
  `party-detail.tsx` are **critical**, not feature rules. Five of them render a
  component tree already marked critical (`components/catalog/**` or
  `components/parties/**`), which more than one page shares and whose specs span
  several feature rules; `stock.tsx` is imported by `items.tsx` as `StockForm`,
  so it is a component for another page. The page is another entry to the same
  surface, so its own rule kept under-selecting: hand-enumeration was wrong for
  three rounds running, so an unknown reach now costs a full run instead of
  coverage. The cost is real — those six pages always run the full suite — and is
  accepted. Pages examined and left as feature rules: `invoice.tsx` (its rule
  already carries `returns.spec.ts` and `purchase-intake.spec.ts` for the shared
  `ReturnsPanel` and `InvoiceHeader`), and `categories.tsx`, `invoices.tsx`,
  `receipt-print.tsx`, `return-print.tsx` and `settings.tsx`, whose components
  are rendered by that page alone (#231).
- The `debts.tsx` rule carries `supplier-adjustment.spec.ts` (the supplier-credit
  label and total on /debts) and the `activity.tsx` rule carries
  `backups.spec.ts` (the activity table's backup-filename render). The `sale.tsx`
  rule carries `items-flow.spec.ts` and `customer-name-variants.spec.ts` for the
  zero-price quick-add and the party-picker warning; `sale.tsx` is itself
  critical (see above), so the rule documents its unit-test reach and keeps the
  list if the page is ever un-promoted (#231).
- `phone-identity.spec.ts` and `rpc-helpers.spec.ts` (#209) ride the parties
  rule: both drive the customers page (`customersList`, and `actAndAck` over
  `customersCreate`).
- The whole of `apps/api/**` except `auth/**` is critical. The API is a single
  router over a single store; the map does not claim to trace which API module
  reaches which screen. `apps/api/src/auth/**` is the one API area with a
  dedicated spec (`login.spec.ts`, `00-onboarding.spec.ts`).
- `packages/e2e-support/**` is critical: it resolves the vault ports every vault
  run depends on.
- `apps/desktop/**` is **skipped**: the Playwright suite drives the web dev
  server, not the Tauri binary. The crate is covered by the `rust` job instead.
- `**/*.test.ts`, `**/*.test.tsx` and `apps/web/src/tests/**` are skipped: unit
  tests and their harness never reach the browser. A test file a feature rule
  names explicitly still wins, because feature rules are checked before
  `skip_e2e`.
- `.github/**` is skipped: CI configuration cannot change what the browser
  renders, and the workflow itself is covered by the `checks` job's workflow
  tests (`apps/desktop/scripts/ci-workflow.test.ts`).

Selecting fewer specs changes which tests run, not how the servers start: a
subset run still boots the config's shared API+web pair and is wiped/reseeded
from `E2E_DATA_DIR` (see the vault section below).

## e2e failure evidence

`playwright.config.ts` sets `trace: "retain-on-failure"` and
`screenshot: "only-on-failure"`, so a failed test leaves `trace.zip`, the
failure screenshot and `error-context.md` in `test-results/`, while a passing
test leaves nothing. The `e2e` job tees its own stdout — which includes the two
Playwright-managed servers, `stdout: "pipe"` in the config because Playwright's
`stdout` default is `ignore` — into `e2e-logs/playwright.log`, then uploads both
directories for any non-success outcome (`if: failure() || cancelled()`),
`retention-days: 5`, named with `github.run_attempt` so re-running a failed job
cannot overwrite the evidence from the attempt that failed.

The run step also carries `timeout-minutes: 15`, below the job's 25: a job-level
timeout *cancels* the job, and a cancelled job runs no further steps, so a hang
would upload nothing — the exact case this evidence exists for. Stopping the suite
step first, at 15 minutes, lets the upload still run. The `cancelled()` arm is
there because GitHub documents a step timeout as killing the process but not
whether the stopped step is then reported failed or cancelled; either way the
upload fires. Added by #197, after `gh run 38464745468` failed with no trace and
no screenshot to read.

## Vault-port isolation

`tests/e2e/vault.spec.ts` runs its own API+web pair, separate from the pair
`playwright.config.ts` boots for the shared suite. Since #202 that pair is
`DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT` (defaults `4399`/`5174`), so a lane
that claims its own pair can run vault suites side by side.

The resolver lives in `packages/e2e-support` and is unit-tested in
`bun run test` (defaults, blank-means-unset, overrides, out-of-range rejection),
which is the cheap half of the property and runs on every PR.

The two-concurrent-runs property is **not** in CI. A deterministic test needs
two full vault suites running at once; `tests/e2e/` has no Bun harness and a
timing-based version would race, so it stays a manual procedure:

```bash
# terminal A
DOKAN_PORT=4617 DOKAN_WEB_PORT=5473 \
DOKAN_VAULT_PORT=4399 DOKAN_VAULT_WEB_PORT=5174 \
E2E_DATA_DIR="$PWD/.e2e-data/lane-a" \
bun run test:e2e --output=.e2e-data/lane-a/test-results tests/e2e/vault.spec.ts

# terminal B
DOKAN_PORT=4618 DOKAN_WEB_PORT=5474 \
DOKAN_VAULT_PORT=4400 DOKAN_VAULT_WEB_PORT=5175 \
E2E_DATA_DIR="$PWD/.e2e-data/lane-b" \
bun run test:e2e --output=.e2e-data/lane-b/test-results tests/e2e/vault.spec.ts
```

Both must exit 0. All four ports must be disjoint, and each run needs its own
`E2E_DATA_DIR`: selecting only the vault spec still boots the config's shared
pair, which is wiped and reseeded from that variable (a path under the ignored
`.e2e-data/` keeps the runs clean). The vault pair itself makes its own temp data
dir (`mkdtemp`), so it does not need `E2E_DATA_DIR`.

Each run also needs its own `--output` dir. Playwright clears its output
directory at startup and writes failed-test traces, screenshots, and
`error-context.md` into it by path, so two runs left on the default
`test-results/` would delete or overwrite each other's failure evidence. That is
worst exactly when these runs are being used to explain a failure, which is the
point of the pair.

Negative control: run both with the *same* `DOKAN_VAULT_PORT` pair. It is
timing-dependent and only *may* catch a shared server, so it does not prove
isolation. Test 1 never creates a vault and `waitForOk` only checks that the
status route answers, not who owns it; while the shared API is still fresh both
runs can pass the create-vault heading (`إنشاء الخزنة`) before either reaches
test 2, and the wrong gate (`فتح الخزنة`) appears only after one run has
initialized the vault. A green negative control therefore proves nothing, and a
red one does not by itself pin the cause. What would prove isolation is each run
completing its *own* vault flow on disjoint pairs, so that its own recovery key
unlocks its own restarted server, or an explicit ownership check on the server.
A heading is neither.

Run this on an otherwise-idle host. Two runs boot the config's shared pair *and*
the vault spec's own pair (eight servers) and perform two Argon2id derivations
(32 MiB × 3 iterations, pure TS); the post-KDF UI assertions use Playwright's 5 s
default, so a CPU-saturated host can time a run out at `vault-recovery-key` or
`vault-settings-saved`. Once each run has completed its own vault flow (the
isolation proof above), that late timeout is KDF contention, not cross-talk; on
an unproven shared pair it can be either, so attribute it only after isolation
is established. Measured in #206 at `unlock` 3.2 s, `unlock-recovery` 2.1 s and
`reset-passphrase` >5 s with two runs plus other lanes on a 12-core host.

## Audit policy

`bun audit` first prints every advisory (informational), then fails the job
only on `high`/`critical` via `bun audit --audit-level=high`. Low and moderate
advisories are reported but do not block a merge; open an issue for them.

`bun audit` needs the npm advisory endpoint. A registry outage fails the job
on purpose — an unverifiable audit is not a green audit.

## Bun version

`oven-sh/setup-bun` reads `packageManager` from `package.json`
(`bun@1.3.14`), so CI tracks the repo pin automatically.

## Rust capability guards (`rust` job)

The desktop crate's Rust tests include the guard added in #153: it drives the
real `tauri-utils` URLPattern matcher over `setup_navigation_url()` and the
resolved ACL over `capabilities/default.json`. That guard exists because a
missing `remote.urls` entry or a missing `allow-vault-broker` permission
silently broke the packaged app — a release-blocking bug found only by running
the real installer. Before this job, nothing in PR CI ran `cargo test`, so the
regression could be re-introduced unnoticed. The job runs the crate's tests
and `cargo clippy -- -D warnings` so those guards gate PRs.

The job runs on `windows-latest` deliberately: `desktop-installer.yml` already
proves the crate compiles and links there, and the Windows image ships stable
Rust, rustup and the WebView2 runtime. A Linux runner would need the
`webkit2gtk`/`libsoup` Tauri system packages installed via apt before a single
test compiles — a slower and more fragile gate. The toolchain is pinned with
`dtolnay/rust-toolchain` (stable + clippy) and `Swatinem/rust-cache` caches
`apps/desktop/src-tauri -> target`, folding the runner OS/arch and the
`Cargo.lock` hash into its key. Every action is pinned to a full commit SHA.

Two preconditions are part of the job because `build.rs` needs them before
`cargo` compiles a single test:

- Bun dependencies (`bun install --frozen-lockfile`): `build.rs` compiles the
  api sidecar with `bun build --compile`.
- The web frontend (`bun run --filter @dokan/web build`): `tauri.conf.json`
  bundles `apps/web/dist` as the `ui` resource and `build.rs` hard-fails when
  that path is absent. The release workflow gets this from tauri's
  `beforeBuildCommand`, which does not run for a bare `cargo test`.

The job has no trigger-level `paths:` filter. A filtered trigger makes the
*whole* workflow report "skipped": GitHub creates no check run at all, so a
required check would stay pending forever on a docs-only PR. Issue 226 gates
the job on the `changes` job's `rust` output instead, so the trigger stays
unfiltered and the job still reports on every event (it is the job that is
skipped, not the workflow). A job skipped by a job-level `if:` reports a
`skipped` check, which GitHub counts as a successful required status (only
`success`, `skipped` and `neutral` satisfy branch protection), so `rust` and
`e2e` can be made required without a reporting shim. The rust-cache keeps the
warm path cheap when the gate does open.

## Required checks — manual step

Branch protection is a GitHub repository setting, not something a workflow can
enforce. To make these checks required on `develop` an admin must:

1. GitHub → Settings → Branches → **Add branch protection rule** (or edit the
   existing `develop` rule).
2. Branch name pattern: `develop`.
3. Enable **Require status checks to pass before merging**.
4. Select the `typecheck, lint, test, audit`, `playwright e2e` and
   `rust test, clippy` checks.

Until that is done the workflow still runs and reports, but a red run does not
block a merge. Making the `rust` job (or any check) required is a repository
setting the workflow itself cannot apply — it must be done by a repo admin in
branch protection. Until the owner selects it, `rust` still runs and reports on
every PR, but a red run does not block a merge.

Since #226, `rust` and `e2e` are skipped for diffs that cannot reach them. A
job-level skip reports a `skipped` check, which GitHub treats as a successful
required status, so both can be selected above without a reporting shim. What
would break is a trigger-level `paths:` filter (it deletes the workflow's check
runs entirely), which is why the trigger itself is kept unfiltered.

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

The full desktop/Tauri **build** (installer and portable) is not part of the PR
gate: it is a Windows-only Rust/Tauri release build with its own manual/tag
workflow (above) and is not a required status check. The Rust **tests and
clippy** for the desktop crate *are* in the PR gate now (the `rust` job),
because the capability/permission guards in that crate are the regression net
for the packaged app. The rest of the desktop path is covered by local gates
(see `development-workflow.md` §5).
