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
    // The suite must still be invoked by a real command line. A substring check
    // would be satisfied by `echo bun run test:e2e` or a comment, which run
    // nothing; only a line whose argv starts `bun run test:e2e` executes it.
    expect(
      commandArgvs(runE2e.run).some(
        (argv) => argv[0] === "bun" && argv[1] === "run" && argv[2] === "test:e2e",
      ),
      `Run Playwright e2e must invoke the suite, got: ${runE2e.run}`,
    ).toBe(true);
    // #197 teed the run into a log so the server output survives. A pipeline
    // reports tee's status unless pipefail is set — so without these two lines a
    // RED suite would report green and the evidence upload would never fire.
    expect(runE2e.run).toContain("set -o pipefail");
    expect(runE2e.shell).toBe("bash");
    // Evidence survives a hang only when the step gives up before the job does:
    // a job-level timeout cancels the job, and a cancelled job runs no later
    // step — including the upload.
    const jobTimeout = Number(jobField(WORKFLOW_SOURCE, "e2e", "timeout-minutes"));
    const runTimeout = Number(runE2e.timeoutMinutes);
    expect(runTimeout).toBeGreaterThan(0);
    expect(jobTimeout - runTimeout).toBeGreaterThanOrEqual(E2E_SETUP_AND_UPLOAD_ALLOWANCE_MINUTES);
  });

  it("uploads the evidence a red e2e run leaves behind (#197)", () => {
    const upload = stepNamed(parseSteps(WORKFLOW_SOURCE, "e2e"), "Upload e2e failure evidence");
    // success is the one outcome with nothing worth keeping, and a cancellation
    // (superseded run, step timeout) must still leave the trace behind
    expect(upload.condition).toContain("failure()");
    expect(upload.condition).toContain("cancelled()");
    // same pinned-SHA convention as every other `uses:` in this repo
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}/u);
    // test-results/ is Playwright's output dir (trace, screenshot, context) and
    // e2e-logs/ is the tee'd run + server logs
    expect(upload.with.get("path")).toContain("test-results/");
    expect(upload.with.get("path")).toContain("e2e-logs/");
    expect(upload.with.get("retention-days")).toBe("5");
    // keyed on the attempt: a re-run must not overwrite the trace from the
    // attempt that actually failed
    expect(upload.with.get("name")).toContain("github.run_attempt");
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
