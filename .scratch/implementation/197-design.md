# Issue 197 — design: upload e2e failure evidence

- Tier: **Standard** (CI + Playwright config; owner reviews before merge)
- Base: `origin/develop` @ `bcc586a7b8a80b9f13135fd510e5fbbac76e0293` (= merge-base, branch is at tip)
- Branch: `chore-197-e2e-artifacts`
- Evidence: `.scratch/reviews/197/<sha>-{debate,test-audit,code-review}.md`

## The defect

`gh run 38464745468` failed with `page.waitForResponse: Test timeout of 30000ms
exceeded`. Nothing survived the run: Playwright's defaults (`trace: off`,
`screenshot: off`, `video: off`) capture nothing, and the `e2e` job ends after
`bun run test:e2e` with no upload step. #191 therefore re-measured 120 local runs
to disprove a hypothesis that one trace would have answered.

Two independent gaps. Fixing one leaves the failure mode intact.

## (a) `playwright.config.ts` — capture on failure

`use` gains:

```ts
trace: "retain-on-failure",
screenshot: "only-on-failure",
```

- `retain-on-failure`, not `on-first-retry`: the config pins `retries: 0`
  (deliberate — shared sqlite DB, documented at the top of the file), so
  `on-first-retry` would record nothing.
- The trace is the artifact that answers #191's actual question — its network
  panel records `/api/rpc` request/response bodies and its DOM snapshots show the
  pre-click state — and it already implies `error-context.md` under
  `test-results/<test-title>/`.
- **No `video`.** Trace already carries the DOM + network timeline; video adds
  encoding CPU per test on a 5-minute sequential suite and would not answer a
  question the trace leaves open. Reversed here if a future failure needs motion
  (e.g. a visual-only regression).
- `workers: 1` and `retries` are untouched.

Default output dir stays `test-results/` (Playwright default, already in
`.gitignore`). Note: Playwright wipes that directory at the start of every run, so
server logs must **not** live inside it.

## (b) `ci.yml` — upload on failure

```yaml
      - name: Run Playwright e2e
        shell: bash
        timeout-minutes: 15
        run: |
          set -o pipefail
          mkdir -p e2e-logs
          bun run test:e2e 2>&1 | tee e2e-logs/playwright.log

      - name: Upload e2e failure evidence
        if: failure() || cancelled()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: playwright-e2e-failure-${{ github.run_attempt }}
          path: |
            test-results/
            e2e-logs/
          if-no-files-found: warn
          retention-days: 5
```

Placement of the SHA: reuses the `upload-artifact` SHA already pinned in
`desktop-installer.yml` (v4.6.2), so the repo keeps one pin per action release.

`pipefail` is load-bearing: without it the step's exit status is `tee`'s (0), so a
red suite would report green *and* the upload would never fire. Verified against
GitHub's `workflow-syntax` reference (`github/docs`, line 967): "By default,
fail-fast behavior is enforced using `set -e` for both `sh` and `bash`. When
`shell: bash` is specified, `-o pipefail` is also applied" — i.e. the default
`bash -e {0}` does **not** carry pipefail. `shell: bash` therefore supplies it
from the shell specification, and the explicit `set -o pipefail` keeps the
invariant visible if a future edit changes `shell:`.

### Why the logs are tee'd in the workflow, not redirected in the config

`webServer` entries cannot be redirected with `... | tee` in
`playwright.config.ts`: Playwright runs those commands through the shell, and the
repo is developed on Windows, where `cmd.exe` has no `tee`. A Node tee-wrapper
script would work but is more moving parts than this change is worth.

Instead `playwright.config.ts` sets `stdout: "pipe"` on both `webServer` entries
(**`stdout` defaults to `ignore`**, so server stdout is discarded today; `stderr`
already defaults to `pipe`). Playwright then forwards both streams to its own
stdout, the workflow's `tee` writes them next to the runner output, and the one
artifact carries the Playwright log *and* the logs of the two Playwright-managed
servers. (`tests/e2e/vault.spec.ts` spawns its own servers on hardcoded ports
4399/5174; their output is not covered by this and is not what #191 failed in.)

Residual risk (accepted, documented): if the job is killed with SIGKILL and the
server had unflushed buffered stdout, the last lines can be lost. The trace is the
primary evidence; logs are corroboration.

### Why `failure() || cancelled()`, plus `timeout-minutes: 15`

- Success is the only outcome that uploads nothing: a green run has no trace or
  screenshot worth 5 days of storage, on a suite that runs on every PR.
- The dangerous gap is a **hang**. A job-level `timeout-minutes: 20` *cancels* the
  job, a cancelled job runs no further steps, and no `if:` on a later step can
  help — there is no later step. The run step therefore carries
  `timeout-minutes: 15`, below the job's 20, so the suite is stopped while the job
  still has budget to upload. 15 sits ~3 minutes under the job cap (the run step
  starts after ~2 minutes of checkout/install) and well above the measured suite:
  7m24s locally with traces on, ~9–11m projected for CI (5.3m pre-change + ~2.5m
  trace overhead + install).
- The `cancelled()` arm exists because the step-timeout question is **unresolved
  by the docs**: GitHub documents `timeout-minutes` as killing the process but not
  whether the stopped step is then reported as failed or cancelled. With both
  arms the upload fires either way, instead of the mitigation resting on an
  unverified premise. It also covers a run superseded by `concurrency`.
- **Inference, not measured in CI**: this worktree cannot run GitHub Actions, so
  the CI projection is local wall time plus the #191 CI/local delta (5.3m vs
  5.2m), and the step-timeout behaviour is reasoned from the docs, not observed.
  The first real red e2e run is the confirmation.
- `if-no-files-found: warn`, not `error`: a failure before the suite starts
  (e.g. browser install) leaves nothing in these paths, and that step's own error
  must stay the headline rather than gaining a second one.
- `name: …-${{ github.run_attempt }}` instead of `overwrite: true`. Re-running a
  failed job is the normal recovery path, and the two attempts can fail
  differently; `overwrite` would delete the first attempt's trace in favour of the
  second. Keying the name on the attempt keeps both. (The installer workflow can
  overwrite because a build artifact may be replaced by a newer build; failure
  evidence may not.)

### `e2e-logs/` and `.gitignore`

`e2e-logs/` is added to `.gitignore`: a developer reproducing the CI recipe
locally would otherwise leave an untracked directory behind (same reason
`test-results/` is ignored). The recipe itself is *not* added to the "Local
equivalent" header of `ci.yml`: `tee` is bash-only and this repo is developed on
Windows, so it would be advice the primary platform cannot run.

## Verification (measured, not asserted)

All runs used isolated ports `DOKAN_PORT=6317 DOKAN_WEB_PORT=7173` (not the
hardcoded vault ports 4399/5174, not the 4317/5173 dev defaults).

### 1. Forced failure produces the three artifacts

Two temporary specs (never committed), each run on its own:

**(a) a plain assertion failure** at 2s: `test-results/<title>/` contained

```
error-context.md   # accessibility snapshot of the page
test-failed-1.png  # failure screenshot
trace.zip          # 0-trace.network (324 KB) + 0-trace.trace (98 KB)
                   # + DOM snapshots and action screenshots
```

The same run had a passing test alongside the failing one: `test-results/`
retained **only** the failing test's directory (plus `.last-run.json`), which is
what `retain-on-failure` promises and what keeps a green suite from filling the
artifact.

**(b) a `page.waitForResponse` timeout — #191's exact signature.** The failure
was `TimeoutError: page.waitForResponse: Timeout 3000ms exceeded while waiting
for event "response"`, the same shape as the CI failure, and `test-results/`
again held the trace, screenshot and error-context. Unpacking the trace:

- `0-trace.network` has 153 records and names the RPC traffic the page *did*
  make — `…/api/rpc/needsSetup`, `…/api/auth/get-session` — and contains
  `invoicesCreate` **0 times**.

That is the attribution #191 could not get from `Error: page.waitForResponse:
Test timeout of 30000ms exceeded`: the network log distinguishes "the write was
never sent" from "the write was sent and stalled", which is the three-way
ambiguity the wisdom note records.

`e2e-logs/playwright.log` (the workflow recipe verbatim) contained 25
`[WebServer]` lines — the API boot banner and the Vite "ready" line — which
proves the `stdout: "pipe"` change is what makes server logs capturable. With
`stdout` left at its `ignore` default those lines never reach the runner.

Paths not yet covered by evidence, accepted and listed for honesty: a *webServer
boot* failure (the boot error goes through the same pipe, but was not
reproduced), and the CI-side upload itself (no branch was pushed — forbidden by
the brief — so the Actions runtime was never executed; the `upload-artifact`
inputs used here are the same ones `desktop-installer.yml` already runs in CI,
except `if-no-files-found`/`overwrite`, which that file also exercises).

### 2. Full suite green, and what the trace costs

| run | result | wall time |
|---|---|---|
| full suite, `trace: retain-on-failure` (this change) | 56 passed | 7m24s |
| full suite, `--trace=off` (A/B control, same machine) | 56 passed | 4m50s |
| #191 recorded, pre-change | 56 passed | 5.2m local / 5.3m CI |

Trace recording costs ~2.5 minutes on this 56-test sequential suite (+50%). That
is the honest price of the artifact, it is the mode the issue asked for
(`retain-on-failure`), and it is the "Medium" overhead the
`playwright-best-practices` reference documents. Projected CI total for the `e2e`
job: ~9–11m against the job's `timeout-minutes: 20` (and the run step's new 15),
so the margin is ~40%, not the 4× a pre-change reading would suggest. No test
outcome changed between the two runs.

If that cost ever matters, the lever is `trace: { mode: "retain-on-failure",
screenshots: false }` (keeps DOM snapshots and the network log, drops the
per-action screencast). Deferred, not done: the issue asked for the standard mode
and this is a CI change the owner reviews.

### 3. YAML parses, artifact paths enumerated

`jobs.e2e.steps` = `[Checkout, Set up Bun, Cache bun installs, Install
dependencies, Install Playwright browser, Run Playwright e2e, Upload e2e failure
evidence]`. For #191's failure the upload step would have collected
`test-results/receipts-…-sale-…/trace.zip` (its `0-trace.network` alone answers
"was the `invoicesCreate` POST sent?"), `test-failed-1.png`,
`error-context.md`, and `e2e-logs/playwright.log`.

No HTML report is uploaded: the repo configures no `html` reporter (hence no
`playwright-report/`), and the failure-only artifact is what the issue asked
for. Adding one is a separate, reviewable decision.

## Interfaces

- No public API, no runtime behaviour change. Two runner-side observability
  changes: local `bun run test:e2e` now streams the two Playwright-managed
  servers' stdout (previously discarded) and writes `test-results/` trace +
  screenshot on failure.
- CI consumes: `test-results/**`, `e2e-logs/playwright.log`, uploads them as
  `playwright-e2e-failure-<run_attempt>` on failure, keeps them 5 days.

## Planned tests

No unit tests apply (config + workflow). Verification is the evidence:

1. Forced local failure (temporary spec, never committed) → assert
   `test-results/<title>/` contains `trace.zip`, a `*.png` screenshot and
   `error-context.md`; assert `e2e-logs/playwright.log` contains the server lines.
2. The same proof once more with a `page.waitForResponse` timeout, so the
   evidence is produced by the failure class #191 hit, not a nearby one.
3. Full suite green afterwards, wall time compared against `--trace=off`, to show
   trace recording did not change outcomes and to price it.
4. Workflow YAML parses, and the uploaded paths are enumerated against what
   #191's failure would have produced.

## Implementation risks

| Risk | Mitigation |
|---|---|
| `tee` masks a red suite (`pipefail`) | `shell: bash` supplies `-o pipefail`; explicit `set -o pipefail` documents it at the point of use |
| Server logs missing because `stdout` defaults to `ignore` | `stdout: "pipe"` on both webServer entries, proven in the forced-failure run (25 `[WebServer]` lines) |
| Logs inside `test-results/` deleted by Playwright's output-dir wipe | separate `e2e-logs/` |
| A hang cancels the job and uploads nothing | run step `timeout-minutes: 15` < job 20, plus `if: failure() || cancelled()` so the upload does not depend on how GitHub labels a stopped step; inferred, not CI-verified |
| Trace recording slows the suite / changes outcomes | full green suite re-run; A/B wall time (+2.5m, no outcome change) |
| Re-run overwrites the awaited evidence | artifact name keyed on `github.run_attempt` |
| Trace/SIGKILL: a killed test never finalises `trace.zip` | accepted; the screenshot/error-context and the tee'd log are the fallback, and the step timeout is what keeps the kill from being a job cancel |
| `overwrite`/`if-no-files-found` semantics assumed | both inputs are already exercised by `desktop-installer.yml` on the same pinned SHA |
| Local Windows devs cannot run the CI recipe verbatim | no `tee` in the config; only the workflow pipes (bash), and the recipe is not advertised in the `ci.yml` header |
| Action pin drift | reuses the existing pinned `upload-artifact` SHA + release comment |
| `docs/ci.md` drifts from `ci.yml` | updated in the same change, matching what `1d02f93` and `46283c7` did |

## Review deltas (what the five review lanes changed)

`debate` (critic + defender), `test-audit`, and `code-review` (Standards + Spec)
ran against the first version of this diff
(`.scratch/reviews/197/197-review-input.diff`, sha256 `fffd351d…`). Fixes it
earned:

| Finding | Lane (severity) | Resolution |
|---|---|---|
| A hang is a job-level *cancel*, so `if: failure()` never runs and the design's `cancelled()` mitigation is impossible | critic 5, test-audit blocker | run step gained `timeout-minutes: 15` (below the job's 20) |
| Step-timeout semantics unverified: is a stopped step `failure()` or `cancelled()`? | delta re-review note 2 | `if:` widened to `failure() || cancelled()` so the upload fires either way |
| `overwrite: true` destroys the first attempt's trace on a re-run; also an input the brief did not ask for | critic 5, spec note | replaced by `name: …-${{ github.run_attempt }}`, `overwrite` dropped |
| `pipefail` protected only by a deletable line | critic 4 | `shell: bash` added (GitHub's shell spec carries `-o pipefail`), `set` kept explicit |
| "interleaved API/web server logs" overstates coverage | critic 3 | comment and this doc now say "the two Playwright-managed servers" |
| CI budget arithmetic was sloppy | critic 3 | corrected to ~9–11m projected, ~40% margin |
| GitHub's default shell claim in the comment was disputed | test-audit | verified against `github/docs` `workflow-syntax` line 967: default is `set -e` only |
| `docs/ci.md` stale — the e2e row is the documented step list | standards, hard | updated in the same change |
| `if-no-files-found: warn` justified by a false premise | critic 1 | comment reworded (nothing in these paths; the step's own error is the headline) |
| `ci.yml` referenced an untracked `.scratch/…-design.md` | standards, spec note | design doc is committed with the change (repo precedent: `122-design.md` in `1d02f93`) |
| `e2e-logs/` empty-file sub-case | test-audit, acceptable | accepted: `warn` uploads an empty log rather than nothing |

Dismissed: adding the tee recipe to the `ci.yml` "Local equivalent" header
(windows-hostile).

## Does this actually explain #191? (the critic's question)

Measured, not argued: the `waitForResponse`-timeout reproduction above produced a
`0-trace.network` that names the RPC calls the page made and contains
`invoicesCreate` zero times. So the artifact answers the one question #191 could
not: **was the `/api/rpc` request ever sent, and what came back?** That separates
"the client refused or the click was dropped" from "the server stalled" from
"the budget was already spent" without 120 local runs.

What it does **not** do: name a root cause by itself (a human still reads the
trace), and cover a run that is SIGKILLed before the trace is finalised. #191's
own code remedy — assert the app's surfaced state around every ack, per
`2026-10-14-e2e-ack-vs-test-budget.md` — is still open work; this issue only makes
the next such failure readable, which is what it was filed for.
