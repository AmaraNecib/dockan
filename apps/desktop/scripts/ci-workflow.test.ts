/**
 * Invariants for the PR CI workflow (issue 154). The Rust capability guards
 * added in #153 only gate a merge if a job in this workflow actually runs
 * `cargo test` in the desktop crate, so these tests assert that job exists,
 * that its steps execute the real commands (not comments or `echo` no-ops),
 * that cargo runs in the crate directory, and that neither a `paths:` filter
 * nor a job-level `if:` can silently stop the guards on a pull request.
 *
 * The workflow is parsed with the shared `workflow-utils` helpers, so comments
 * are stripped, block scalars are dedented and line endings are normalised the
 * same way as the desktop-installer workflow tests.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  actionRefs,
  jobLines,
  onLines,
  parseSteps,
  stepNamed,
} from "./workflow-utils";

const WORKFLOW_PATH = path.resolve(import.meta.dir, "../../../.github/workflows/ci.yml");
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n?/gu, "\n");

const RUST_JOB = "rust";
const CRATE_DIR = "apps/desktop/src-tauri";
/**
 * Minutes the e2e job must keep beyond the run step's own limit, covering SETUP
 * (checkout + two installs; ~30s warm, minutes cold — `playwright install
 * --with-deps` is the bulk) plus the failure-evidence upload. The job budget is
 * shared with all of them, so with no slack a cold setup pushes the job past its
 * ceiling FIRST: the job is cancelled, no later step runs, and the upload is
 * lost — the one case it exists for (#197).
 */
const E2E_SETUP_AND_UPLOAD_ALLOWANCE_MINUTES = 10;

/** The file the `Run Playwright e2e` step tees the suite output into (#197). */
const E2E_LOG_PATH = "e2e-logs/playwright.log";

/** The `rust` job's steps, or a loud failure when the job was removed. */
function rustSteps(): ReturnType<typeof parseSteps> {
  const steps = parseSteps(WORKFLOW_SOURCE, RUST_JOB);
  if (steps.length === 0) throw new Error("ci.yml has no `rust` job");
  return steps;
}

/**
 * The argv of every shell command in a step's `run:` (comments stripped, so a
 * `# cargo test` line is not a command). A step invokes a command only when a
 * command line starts with that exact executable: `echo cargo test` does not,
 * because its argv[0] is `echo`.
 */
function commandArgvs(run: string): string[][] {
  return run
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/u, "$1").trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/u));
}

/** True when some command line in the step runs `cargo test` (extra flags allowed). */
function invokesCargoTest(run: string): boolean {
  return commandArgvs(run).some((argv) => argv[0] === "cargo" && argv[1] === "test");
}

/**
 * True when one argv is exactly the e2e log pipeline:
 * `bun run test:e2e 2>&1 | tee e2e-logs/playwright.log`.
 *
 * Every leg is load-bearing for #197: `argv[0] === "bun"` keeps `echo ... | tee`
 * or a separate line from satisfying the guard, `2>&1` merges the stderr carrying
 * the Playwright-managed server logs, and the tee must write the exact path the
 * upload step collects. The shape is pinned end to end (`--list`, an extra token,
 * or a reordered redirect must not satisfy it): a suite invoked with a flag that
 * lists rather than runs would still leave a log file that proves nothing.
 * `set -o pipefail` and `shell: bash` keep a red suite red, but they say nothing
 * about where its output goes, so deleting this pipeline would leave them green
 * while the evidence disappears.
 */
function pipesSuiteToTee(argv: readonly string[], logPath: string): boolean {
  return (
    argv.length === 7 &&
    argv[0] === "bun" &&
    argv[1] === "run" &&
    argv[2] === "test:e2e" &&
    argv[3] === "2>&1" &&
    argv[4] === "|" &&
    argv[5] === "tee" &&
    argv[6] === logPath
  );
}

/** The value of a job-level field (e.g. `if:`, `runs-on:`) or "" when absent. */
function jobField(source: string, jobName: string, key: string): string {
  const pattern = new RegExp(`^    ${key}:\\s*(.*)$`, "u");
  for (const line of jobLines(source, jobName)) {
    const match = pattern.exec(line);
    if (match !== null) return match[1].trim();
  }
  return "";
}

describe("PR CI workflow", () => {
  it("keeps the existing bun and playwright jobs and their commands", () => {
    const checks = parseSteps(WORKFLOW_SOURCE, "checks");
    expect(stepNamed(checks, "Typecheck").run).toBe("bun run typecheck");
    expect(stepNamed(checks, "Lint").run).toBe("bun run lint");
    expect(stepNamed(checks, "Tests").run).toBe("bun run test");

    const e2e = parseSteps(WORKFLOW_SOURCE, "e2e");
    const runE2e = stepNamed(e2e, "Run Playwright e2e");
    const runArgvs = commandArgvs(runE2e.run);
    // The suite must still be invoked by a real command line. A substring check
    // would be satisfied by `echo bun run test:e2e` or a comment, which run
    // nothing; only a line whose argv starts `bun run test:e2e` executes it.
    expect(
      runArgvs.findIndex(
        (argv) => argv[0] === "bun" && argv[1] === "run" && argv[2] === "test:e2e",
      ),
      `Run Playwright e2e must invoke the suite, got: ${runE2e.run}`,
    ).toBeGreaterThanOrEqual(0);
    // #197 teed the run into a log so the server output survives. A pipeline
    // reports tee's status unless pipefail is set — so without this a RED suite
    // would report green and the evidence upload would never fire. The directive
    // is read as argv, not text: `echo set -o pipefail` runs nothing and must
    // not satisfy the guard.
    const pipefailIndex = runArgvs.findIndex(
      (argv) => argv[0] === "set" && argv[1] === "-o" && argv[2] === "pipefail",
    );
    expect(
      pipefailIndex,
      `Run Playwright e2e must set pipefail, got: ${runE2e.run}`,
    ).toBeGreaterThanOrEqual(0);
    // `tee` cannot create its target directory, so `mkdir -p e2e-logs` is
    // load-bearing: without it the pipeline fails and no log is ever written.
    const mkdirIndex = runArgvs.findIndex(
      (argv) => argv[0] === "mkdir" && argv[1] === "-p" && argv[2] === "e2e-logs",
    );
    expect(
      mkdirIndex,
      `Run Playwright e2e must create e2e-logs/, got: ${runE2e.run}`,
    ).toBeGreaterThanOrEqual(0);
    expect(runE2e.shell).toBe("bash");
    // The pipeline that actually writes the log is a separate requirement:
    // pipefail and `shell: bash` stay green when `2>&1 | tee ...` is deleted,
    // leaving the upload with no server output — the exact regression #197
    // fixed. The suite and the tee must share one command line, and the setup
    // lines must precede it: pipefail after the pipeline is inert, and mkdir
    // after it comes too late.
    const pipelineIndex = runArgvs.findIndex((argv) => pipesSuiteToTee(argv, E2E_LOG_PATH));
    expect(
      pipelineIndex,
      `Run Playwright e2e must pipe the suite's stderr into ${E2E_LOG_PATH}, got: ${runE2e.run}`,
    ).toBeGreaterThanOrEqual(0);
    expect(pipefailIndex).toBeLessThan(pipelineIndex);
    expect(mkdirIndex).toBeLessThan(pipelineIndex);
    // Evidence survives a hang only when the step gives up before the job does:
    // a job-level timeout cancels the job, and a cancelled job runs no later
    // step — including the upload.
    const jobTimeout = Number(jobField(WORKFLOW_SOURCE, "e2e", "timeout-minutes"));
    const runTimeout = Number(runE2e.timeoutMinutes);
    expect(runTimeout).toBeGreaterThan(0);
    expect(jobTimeout - runTimeout).toBeGreaterThanOrEqual(E2E_SETUP_AND_UPLOAD_ALLOWANCE_MINUTES);
  });

  it("uploads the evidence a red e2e run leaves behind (#197)", () => {
    const e2eSteps = parseSteps(WORKFLOW_SOURCE, "e2e");
    const upload = stepNamed(e2eSteps, "Upload e2e failure evidence");
    // success is the one outcome with nothing worth keeping, and a cancellation
    // (superseded run, step timeout) must still leave the trace behind. Presence
    // alone would accept `failure() && cancelled()` (never true); an unanchored
    // match would also accept `!failure() || cancelled()`, which never fires on a
    // failure. Pin the whole condition to the disjunction.
    const condition = upload.condition.replace(/\$\{\{|\}\}/gu, "").trim();
    expect(condition).toMatch(
      /^(failure\(\)\s*\|\|\s*cancelled\(\)|cancelled\(\)\s*\|\|\s*failure\(\))$/u,
    );
    // same pinned-SHA convention as every other `uses:` in this repo
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}/u);
    // test-results/ is Playwright's output dir (trace, screenshot, context) and
    // e2e-logs/ is the tee'd run + server logs. They must be separate path
    // entries: one string that merely contains both (`test-results/ e2e-logs/`)
    // would pass a substring check while uploading neither.
    const uploadPaths = (upload.with.get("path") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(uploadPaths).toContain("test-results/");
    expect(uploadPaths).toContain("e2e-logs/");
    expect(upload.with.get("retention-days")).toBe("5");
    // keyed on the attempt: a re-run must not overwrite the trace from the
    // attempt that actually failed. The interpolation is what changes per
    // attempt; the bare literal would not.
    expect(upload.with.get("name")).toMatch(/\$\{\{\s*github\.run_attempt\s*\}\}/u);
    // The run step must precede the upload: a step moved earlier would run
    // before any evidence exists and the assertions above would stay green.
    const stepNames = e2eSteps.map((step) => step.name);
    expect(stepNames.indexOf("Upload e2e failure evidence")).toBeGreaterThan(
      stepNames.indexOf("Run Playwright e2e"),
    );
  });

  it("rejects an e2e run whose log capture was deleted or mangled", () => {
    const pipeline = ["bun", "run", "test:e2e", "2>&1", "|", "tee", E2E_LOG_PATH];
    expect(pipesSuiteToTee(pipeline, E2E_LOG_PATH)).toBe(true);

    // the regression #197 fixed: no tee, so nothing reaches the upload
    expect(pipesSuiteToTee(["bun", "run", "test:e2e"], E2E_LOG_PATH)).toBe(false);
    // stderr not merged: the Playwright-managed server logs are lost
    expect(
      pipesSuiteToTee(["bun", "run", "test:e2e", "|", "tee", E2E_LOG_PATH], E2E_LOG_PATH),
    ).toBe(false);
    // tee writes a path the upload does not collect
    expect(
      pipesSuiteToTee(["bun", "run", "test:e2e", "2>&1", "|", "tee", "other.log"], E2E_LOG_PATH),
    ).toBe(false);
    // `2>&1` after tee only merges tee's stderr, not the suite's
    expect(
      pipesSuiteToTee(["bun", "run", "test:e2e", "|", "tee", E2E_LOG_PATH, "2>&1"], E2E_LOG_PATH),
    ).toBe(false);
    // a separate line echoing the pipeline must not satisfy the guard
    expect(pipesSuiteToTee(["echo", "2>&1", "|", "tee", E2E_LOG_PATH], E2E_LOG_PATH)).toBe(false);
    // a flag that lists tests instead of running them still writes a log that
    // proves nothing, so the pipeline shape is pinned end to end
    expect(
      pipesSuiteToTee(
        ["bun", "run", "test:e2e", "--list", "2>&1", "|", "tee", E2E_LOG_PATH],
        E2E_LOG_PATH,
      ),
    ).toBe(false);
    // a trailing token means tee is no longer the last command in the pipeline
    expect(
      pipesSuiteToTee(
        ["bun", "run", "test:e2e", "2>&1", "|", "tee", E2E_LOG_PATH, "extra"],
        E2E_LOG_PATH,
      ),
    ).toBe(false);
  });

  it("actually runs cargo test in the desktop crate on every PR", () => {
    const tests = stepNamed(rustSteps(), "Rust tests");
    // `echo cargo test` satisfies a substring check; only a command line whose
    // argv starts with `cargo test` executes the #153 guards.
    expect(
      invokesCargoTest(tests.run),
      `Rust tests must invoke cargo test, got: ${tests.run}`,
    ).toBe(true);
    // The crate dir matters: cargo from the repo root would not run these
    // tests, and dropping the field would leave this assertion green without it.
    expect(tests.workingDirectory).toBe(CRATE_DIR);
    // no step-level `if:` keeps it unconditional on the PR trigger
    expect(tests.condition).toBe("");
  });

  it("runs clippy with warnings denied in the crate dir", () => {
    const clippy = stepNamed(rustSteps(), "Rust clippy");
    expect(clippy.run).toBe("cargo clippy -- -D warnings");
    expect(clippy.workingDirectory).toBe(CRATE_DIR);
    expect(clippy.condition).toBe("");
  });

  it("does not put the Rust job behind a paths filter", () => {
    const triggers = onLines(WORKFLOW_SOURCE).join("\n");
    expect(triggers).toContain("pull_request:");
    expect(triggers).toContain("branches: [develop]");
    // A `paths:`/`paths-ignore:` filter makes the job report "skipped"; if the
    // owner marks it required, a skipped check never satisfies branch
    // protection and the PR is stuck pending forever. No filter, no trap.
    expect(triggers).not.toContain("paths");
  });

  it("does not let a job-level if: skip the Rust job on pull requests", () => {
    // A job-level `if:` is the other way to silently disable the guards: a
    // condition like `github.event_name == 'push'` leaves every step assertion
    // above green while the rust job never runs on a PR. No condition at all
    // is the strongest form of "always runs on pull_request".
    expect(jobField(WORKFLOW_SOURCE, RUST_JOB, "if")).toBe("");
  });

  it("builds the web frontend before cargo, because build.rs requires it", () => {
    const steps = rustSteps();
    expect(stepNamed(steps, "Build web frontend").run).toBe(
      "bun run --filter @dokan/web build",
    );
    const names = steps.map((step) => step.name);
    // tauri.conf.json bundles apps/web/dist and build.rs hard-fails without
    // it, so the frontend build must precede the first cargo command
    expect(names.indexOf("Build web frontend")).toBeLessThan(names.indexOf("Rust tests"));
    expect(names.indexOf("Build web frontend")).toBeLessThan(names.indexOf("Rust clippy"));
  });

  it("runs on windows-latest with a timeout", () => {
    const job = jobLines(WORKFLOW_SOURCE, RUST_JOB).join("\n");
    // Windows is the deliberate choice: the installer workflow already proves
    // this crate builds there, and Linux would need webkit2gtk/libsoup apt
    // packages before a single test compiles.
    expect(job).toContain("runs-on: windows-latest");
    const timeout = /timeout-minutes:\s*(\d+)/u.exec(job);
    if (timeout === null) throw new Error("rust job has no timeout-minutes");
    expect(Number(timeout[1])).toBeGreaterThan(0);
  });

  it("pins the Rust toolchain and caches the crate build", () => {
    const toolchain = actionRefs(WORKFLOW_SOURCE).find(
      (ref) => ref.name === "dtolnay/rust-toolchain",
    );
    if (toolchain === undefined) throw new Error("no dtolnay/rust-toolchain action");
    expect(toolchain.revision).toMatch(/^[0-9a-f]{40}$/u);

    const cache = stepNamed(rustSteps(), "Cache Rust build");
    expect(cache.uses.startsWith("Swatinem/rust-cache@")).toBe(true);
    expect(cache.with.get("workspaces")).toContain(CRATE_DIR);
    expect(cache.with.get("cache-on-failure")).toBe("true");
  });

  it("pins every action in the workflow to a full commit SHA", () => {
    const refs = actionRefs(WORKFLOW_SOURCE);
    expect(refs.length).toBeGreaterThan(0);
    for (const { name, revision } of refs) {
      expect(revision, `${name} must be pinned to a 40-char SHA`).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  it("rejects a deleted, no-op or echo cargo test step", () => {
    const echoCargoTest = [
      "jobs:",
      "  rust:",
      "    steps:",
      "      - name: Rust tests",
      "        working-directory: apps/desktop/src-tauri",
      "        run: echo cargo test",
    ].join("\n");
    // the raw text contains the command...
    expect(echoCargoTest).toContain("cargo test");
    // ...but the executable is `echo`, so the assertion must not pass
    expect(
      invokesCargoTest(stepNamed(parseSteps(echoCargoTest, RUST_JOB), "Rust tests").run),
    ).toBe(false);

    const noop = [
      "jobs:",
      "  rust:",
      "    steps:",
      "      - name: Rust tests",
      "        run: echo skipped",
    ].join("\n");
    expect(invokesCargoTest(stepNamed(parseSteps(noop, RUST_JOB), "Rust tests").run)).toBe(
      false,
    );

    const deleted = [
      "jobs:",
      "  rust:",
      "    steps:",
      "      - name: Rust clippy",
      "        run: cargo clippy -- -D warnings",
    ].join("\n");
    // a missing test step must fail loudly, not silently pass
    expect(() => stepNamed(parseSteps(deleted, RUST_JOB), "Rust tests")).toThrow();
  });

  it("rejects a rust test step whose working-directory is missing or wrong", () => {
    const missing = [
      "jobs:",
      "  rust:",
      "    steps:",
      "      - name: Rust tests",
      "        run: cargo test",
    ].join("\n");
    // removing the field leaves it empty, which is not the crate dir
    expect(stepNamed(parseSteps(missing, RUST_JOB), "Rust tests").workingDirectory).toBe("");

    const wrong = [
      "jobs:",
      "  rust:",
      "    steps:",
      "      - name: Rust tests",
      "        working-directory: .",
      "        run: cargo test",
    ].join("\n");
    expect(stepNamed(parseSteps(wrong, RUST_JOB), "Rust tests").workingDirectory).not.toBe(
      CRATE_DIR,
    );
  });

  it("rejects a rust job gated off pull requests by a job-level if:", () => {
    const pushOnly = [
      "jobs:",
      "  rust:",
      "    if: github.event_name == 'push'",
      "    steps:",
      "      - name: Rust tests",
      "        working-directory: apps/desktop/src-tauri",
      "        run: cargo test",
    ].join("\n");
    // the mutation is detected: a non-empty condition is not "" ...
    expect(jobField(pushOnly, RUST_JOB, "if")).toBe("github.event_name == 'push'");
    // ... and the real workflow must not have one
    expect(jobField(WORKFLOW_SOURCE, RUST_JOB, "if")).toBe("");
  });

  it("does not accept a cargo test that only appears in a comment", () => {
    const commentOnly = [
      "jobs:",
      "  rust:",
      "    steps:",
      "      # cargo test",
      "      - name: Rust tests",
      "        working-directory: apps/desktop/src-tauri",
      "        run: echo not-the-test-command",
    ].join("\n");
    expect(commentOnly).toContain("cargo test");
    // ...but the parsed run command does not, so the assertion cannot pass
    expect(
      invokesCargoTest(stepNamed(parseSteps(commentOnly, RUST_JOB), "Rust tests").run),
    ).toBe(false);
  });

  it("parses a CRLF checkout the same as LF", () => {
    const crlf = WORKFLOW_SOURCE.replace(/\n/gu, "\r\n");
    const tests = stepNamed(parseSteps(crlf, RUST_JOB), "Rust tests");
    expect(invokesCargoTest(tests.run)).toBe(true);
    expect(tests.workingDirectory).toBe(CRATE_DIR);
  });
});
