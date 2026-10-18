# Wisdom — 2026-10-15 · CI failure evidence: what actually survives a red run (#197)

Follow-up to `../e2e/ack-vs-test-budget.md` (#191). That note is about
writing a *better* assertion; this one is about what is left on disk when the
assertion fails in CI.

## A job-level `timeout-minutes` cancels the job, and no later step runs
An upload step guarded by `if: failure()`, `if: cancelled()` or even
`if: always()` cannot run after the **job** is cancelled — there is no later step
to run it. A suite that hangs is exactly the failure the evidence exists for, and
it is the one case a job timeout discards. `cancelled()` in the `if:` does not
rescue it.

**Always**: put a shorter `timeout-minutes` on the long step than on the job, so a
hang stops the *step* while the job still has budget to upload. Then guard the
upload with `if: failure() || cancelled()` rather than `failure()` alone: GitHub
documents a step timeout as killing the process but not whether the stopped step
is reported failed or cancelled, so either arm may be the true one. Success stays
the only outcome that skips the upload.

## Playwright's `webServer.stdout` defaults to `"ignore"` (stderr defaults to `"pipe"`)
Server stdout is discarded unless the config sets `stdout: "pipe"`. A workflow
that tees Playwright's own stdout therefore captures the Playwright log and the
server *stderr* only — which looks like a captured server log until you need the
boot banner or a request line. (`playwright/types/test.d.ts`: stderr "Defaults to
`pipe`", stdout "Default to `ignore`".)

**Always**: set `stdout: "pipe"` on every `webServer` entry that must be
diagnosable from an artifact, and prove it — a tee'd run should show `[WebServer]`
lines, not just the runner output.

## `... | tee file` turns a red run green *and* suppresses the failure-only upload
GitHub's default shell for `run:` on Linux is `bash -e {0}`; `-o pipefail` is only
added by an explicit `shell: bash`. So `bun run test:e2e 2>&1 | tee log` exits with
`tee`'s status: the step passes, the job passes, and a step guarded by
`if: failure()` never fires. The evidence is silently absent exactly when it is
needed.

**Always**: `shell: bash` *and* an explicit `set -o pipefail` before a tee in a CI
step, and prefer the tee in the workflow over a redirect inside
`playwright.config.ts` — `webServer.command` runs through the platform shell, and
Windows `cmd.exe` has no `tee`.

## Never write captured logs inside Playwright's output directory
Playwright deletes `test-results/` (its default `outputDir`) at the start of every
run. A tee'd log written there — or a `mkdir`ed subdirectory of it — is unlinked
under the writer's feet, so the artifact ends up empty.

**Always**: give captured logs their own directory (`e2e-logs/` here), ignore it
in `.gitignore`, and upload both paths.

## `trace: "retain-on-failure"` is not free, and it is the only mode worth having at `retries: 0`
Measured on the 56-test sequential suite: 7m24s with traces vs 4m50s with
`--trace=off` (+50%), because the trace is recorded for *every* test and only
discarded for the passing ones. `on-first-retry` records nothing when retries are
off, so the honest choice is "pay ~2.5 minutes per run" or "keep the dead end".

**Always**: price a trace change against the suite before calling it cheap, and if
the cost matters later the lever is `trace: { mode: "retain-on-failure",
screenshots: false }` — DOM snapshots and the network log stay, the per-action
screencast goes.

## Name failure artifacts by `github.run_attempt`
Re-running a failed job is the normal recovery path, and the retry can fail
differently. A fixed artifact name plus `overwrite: true` deletes the first
attempt's trace in favour of the second — destroying the evidence the artifact
exists for. Build artifacts may be replaced by a newer build; failure evidence may
not.

**Always**: `name: <thing>-${{ github.run_attempt }}` for diagnostic artifacts
(and document that consumers glob `<thing>-*`).

## A test that proves "the trace answers the question" must reproduce the failure class
The first proof here forced a plain 2s assertion failure — which shows the files
appear, not that they explain anything. Re-running with a
`page.waitForResponse` timeout (the #191 signature) then unpacking
`0-trace.network` showed the RPC calls the page *did* make and zero occurrences of
the awaited procedure: that is the attribution the CI log could not give.

**Always**: when the claim is "this evidence would have explained case X",
reproduce case X, not a nearby failure, and read the produced artifact.
