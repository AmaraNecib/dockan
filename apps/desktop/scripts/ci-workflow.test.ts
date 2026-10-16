/**
 * Invariants for the PR CI workflow (issue 154, extended by issue 226). The
 * Rust capability guards added in #153 only gate a merge if a job in this
 * workflow actually runs `cargo test` in the desktop crate, so these tests
 * assert that job exists, that its steps execute the real commands (not
 * comments or `echo` no-ops), that cargo runs in the crate directory, and that
 * its path gate runs it for every crate-affecting diff. Issue 226 replaced the
 * always-run trade-off with a diff decision: the trigger keeps no `paths:`
 * filter, a `changes` job computes `rust`, and the rust job's only gate is
 * that output. The tests below pin the detector to the crate paths, so a
 * tightened regex cannot silently drop the guard.
 *
 * The workflow is parsed with the shared `workflow-utils` helpers, so comments
 * are stripped, block scalars are dedented and line endings are normalised the
 * same way as the desktop-installer workflow tests.
 *
 * #231 added the review-round guards: `--no-renames` (both sides of a rename),
 * the `labeled` trigger, the decision step reaching `full` for a labeled PR, and
 * the root-`test`-script wiring assertion moved out of the scripts suite.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * `bun run test:e2e 2>&1 | tee e2e-logs/playwright.log`, or the affected form
 * `bun run test:e2e $E2E_SPECS 2>&1 | tee e2e-logs/playwright.log`.
 *
 * Every leg is load-bearing for #197: `argv[0] === "bun"` keeps `echo ... | tee`
 * or a separate line from satisfying the guard, `2>&1` merges the stderr carrying
 * the Playwright-managed server logs, and the tee must write the exact path the
 * upload step collects. The shape is pinned end to end (`--list`, an extra token,
 * or a reordered redirect must not satisfy it): a suite invoked with a flag that
 * lists rather than runs would still leave a log file that proves nothing. #226
 * added the optional spec list, but it must be exactly the `$E2E_SPECS` token,
 * so `--list` or any other flag still fails the guard.
 * `set -o pipefail` and `shell: bash` keep a red suite red, but they say nothing
 * about where its output goes, so deleting this pipeline would leave them green
 * while the evidence disappears.
 */
function pipesSuiteToTee(argv: readonly string[], logPath: string): boolean {
  if (argv[0] !== "bun" || argv[1] !== "run" || argv[2] !== "test:e2e") return false;
  const rest = argv[3] === "$E2E_SPECS" ? argv.slice(4) : argv.slice(3);
  return (
    rest.length === 4 &&
    rest[0] === "2>&1" &&
    rest[1] === "|" &&
    rest[2] === "tee" &&
    rest[3] === logPath
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

/** The rust-path ERE the `changes` job greps changed.txt with, as a string. */
function rustPathPattern(): string {
  const decide = stepNamed(parseSteps(WORKFLOW_SOURCE, "changes"), "Decide the scope");
  const match = /grep -qE '([^']+)' changed\.txt/u.exec(decide.run);
  if (match === null) throw new Error("The changes job has no rust grep");
  return match[1];
}

/**
 * Run the `changes` decision script with the two GitHub expressions it
 * interpolates resolved (event name, and whether the PR carries `e2e:full`).
 * An expression left unresolved throws, so a new one cannot pass the test while
 * the step is only partially executed.
 */
function runDecide(
  run: string,
  event: { eventName: string; hasFullLabel: boolean },
) {
  const script = run
    .replace(
      /\$\{\{\s*contains\(github\.event\.pull_request\.labels\.\*\.name, 'e2e:full'\)\s*\}\}/gu,
      event.hasFullLabel ? "true" : "false",
    )
    .replace(/\$\{\{\s*github\.event_name\s*\}\}/gu, event.eventName);
  const unresolved = /\$\{\{[^}]*\}\}/u.exec(script);
  if (unresolved !== null) throw new Error(`unhandled expression in the decide step: ${unresolved[0]}`);

  const dir = mkdtempSync(path.join(tmpdir(), "ci-decide-"));
  try {
    const outputFile = path.join(dir, "github-output");
    // the decision step's rust grep reads changed.txt; an empty file keeps it
    // quiet and yields rust=false in the branches that do not run the selector
    writeFileSync(path.join(dir, "changed.txt"), "");
    const scope = execFileSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: shellEnv({ GITHUB_OUTPUT: outputFile }),
    });
    return { scope, outputs: readFileSync(outputFile, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** process.env as string values, plus `extra` — execFileSync rejects undefined. */
function shellEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** A throwaway git repo for the diff commands; `fn` runs inside it. */
function withTempRepo(fn: (git: (...args: string[]) => string, dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-rename-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "ci-workflow-test@example.com");
    git("config", "user.name", "ci-workflow-test");
    git("config", "commit.gpgsign", "false");
    fn(git, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The only Rust gate #226 allows: the `changes` job's diff decision. */
const RUST_GATE = "!cancelled() && needs.changes.outputs.rust != 'false'";

/**
 * True when a rust-job condition runs it for every crate-affecting diff.
 * Anything keyed off the event type (`push`) can drop the PR gate, and an empty
 * condition is the pre-#226 always-run behaviour; both must fail so the gate
 * cannot be deleted (or hollowed out) without a conscious test edit. A
 * `changes` failure leaves the output empty, and `!= 'false'` runs the crate in
 * that case, which is the fail-closed direction.
 */
function isRustGate(condition: string): boolean {
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/gu, "").trim();
  return expression === RUST_GATE;
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

  it("keeps the production web build in checks", () => {
    // #226 gates the rust job on crate-affecting paths. `checks` runs an
    // additional PR-time `vite build`; `rust` still runs its own for
    // crate-affecting diffs (build.rs needs apps/web/dist). This pins the
    // checks build so a later cleanup cannot drop the production build from
    // web-only diffs.
    const checks = parseSteps(WORKFLOW_SOURCE, "checks");
    expect(stepNamed(checks, "Build web frontend").run).toBe(
      "bun run --filter @dokan/web build",
    );
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
    // #226: the affected form adds exactly the spec-list token and nothing else
    expect(
      pipesSuiteToTee(
        ["bun", "run", "test:e2e", "$E2E_SPECS", "2>&1", "|", "tee", E2E_LOG_PATH],
        E2E_LOG_PATH,
      ),
    ).toBe(true);
    // a token after the spec list is no longer just the spec list
    expect(
      pipesSuiteToTee(
        ["bun", "run", "test:e2e", "$E2E_SPECS", "--list", "2>&1", "|", "tee", E2E_LOG_PATH],
        E2E_LOG_PATH,
      ),
    ).toBe(false);

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

  it("does not put the whole workflow behind a trigger-level paths filter", () => {
    const triggers = onLines(WORKFLOW_SOURCE).join("\n");
    expect(triggers).toContain("pull_request:");
    expect(triggers).toContain("branches: [develop]");
    // A `paths:`/`paths-ignore:` filter on the trigger makes the whole workflow
    // (including `checks`) report "skipped" on a docs-only PR; if the owner
    // marks a job required, a skipped check never satisfies branch protection
    // and the PR is stuck pending forever (#154). Scope is a job decision
    // instead, so every suite still reports on every event.
    expect(triggers).not.toContain("paths");
  });

  it("gates the Rust job on crate-affecting paths, not on the event type", () => {
    // Issue 226 made the job-level `if:` the only gate. A condition on the
    // event type (`push`) would leave every step assertion above green while
    // the rust job never runs on a PR; an empty condition is the old
    // always-run behaviour. Both must fail.
    expect(isRustGate(jobField(WORKFLOW_SOURCE, RUST_JOB, "if"))).toBe(true);
    expect(isRustGate("github.event_name == 'push'")).toBe(false);
    expect(isRustGate("")).toBe(false);
    // `${{ }}` is optional YAML dressing; the expression is what must match.
    expect(isRustGate("${{ " + RUST_GATE + " }}")).toBe(true);
  });

  it("detects every crate-affecting path for the Rust gate", () => {
    const rustPath = new RegExp(rustPathPattern(), "u");
    const cratePaths = [
      // the crate, its ACL and its build script
      "apps/desktop/src-tauri/src/lib.rs",
      "apps/desktop/src-tauri/capabilities/default.json",
      "apps/desktop/src-tauri/permissions/vault.toml",
      "apps/desktop/src-tauri/build.rs",
      "apps/desktop/src-tauri/Cargo.toml",
      "apps/desktop/src-tauri/tauri.conf.json",
      "apps/desktop/scripts/sidecar.ts",
      "apps/desktop/package.json",
      // the sidecar inputs build.rs fingerprints
      "apps/api/src/main.ts",
      "apps/api/package.json",
      "apps/api/tsconfig.json",
      "packages/contracts/src/core.ts",
      "packages/contracts/package.json",
      "bun.lock",
      "tsconfig.base.json",
      "package.json",
      // future root-level toolchain inputs
      "rust-toolchain.toml",
      ".cargo/config.toml",
      // the unknown-diff sentinel must gate rust ON (fail closed)
      "*",
    ];
    for (const cratePath of cratePaths) {
      expect(rustPath.test(cratePath), `${cratePath} must mark the diff as rust`).toBe(true);
    }
    for (const other of [
      "apps/web/src/pages/items.tsx",
      "apps/desktop/docs/design.md",
      "docs/ci.md",
      "README.md",
    ]) {
      expect(rustPath.test(other), `${other} must not mark the diff as rust`).toBe(false);
    }
  });

  it("collects both sides of a rename, so a move across the rust gate still runs it", () => {
    // #231: `git diff --name-only` reports only the destination of a detected
    // rename, so a file moved out of `apps/desktop/src-tauri/**` listed an
    // ungated path and the crate that just lost a file was skipped. The diff
    // must ask for `--no-renames`, which lists the move as delete + add.
    const diff = stepNamed(parseSteps(WORKFLOW_SOURCE, "changes"), "Compute the changed-file list");
    expect(diff.run).toContain("--no-renames");

    const rustPath = new RegExp(rustPathPattern(), "u");
    const crateFile = "apps/desktop/src-tauri/src/lib.rs";
    const outsideFile = "apps/desktop/lib.rs";
    const lines = (output: string): string[] => output.split("\n").filter(Boolean);

    withTempRepo((git, dir) => {
      mkdirSync(path.join(dir, "apps/desktop/src-tauri/src"), { recursive: true });
      writeFileSync(path.join(dir, crateFile), "pub fn guard() {}\n");
      git("add", "-A");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();

      // OUT of the gate: the crate loses a file, so the deleted side is what
      // must keep the gate open.
      git("mv", crateFile, outsideFile);
      git("commit", "-qm", "move out");
      const movedOut = git("diff", "--no-renames", "--name-only", base, "HEAD");
      expect(lines(movedOut)).toContain(crateFile);
      expect(lines(movedOut).some((file) => rustPath.test(file))).toBe(true);
      // The pre-#231 command hid the gate side entirely. Rename detection is
      // forced on so the contrast holds whatever the host's git config says.
      const withoutFix = git("-c", "diff.renames=true", "diff", "--name-only", base, "HEAD");
      expect(lines(withoutFix)).not.toContain(crateFile);

      // INTO the gate: a plain file becomes a crate input, so the added side
      // must open the gate.
      git("mv", outsideFile, "apps/desktop/src-tauri/src/recovered.rs");
      git("commit", "-qm", "move in");
      const movedIn = git("diff", "--no-renames", "--name-only", base, "HEAD");
      expect(lines(movedIn)).toContain("apps/desktop/src-tauri/src/recovered.rs");
      expect(lines(movedIn).some((file) => rustPath.test(file))).toBe(true);
    });
  });

  it("subscribes to `labeled` so the e2e:full escape hatch starts a run (#231)", () => {
    const triggers = onLines(WORKFLOW_SOURCE).join("\n");
    // A `types:` list replaces the default events, so `labeled` is not enough on
    // its own: the three defaults must stay or a push/PR stops triggering.
    expect(triggers).toMatch(/^\s{4}types:\s*\[opened, synchronize, reopened, labeled\]$/mu);
  });

  it("reaches `full` for a labeled pull_request event (#231)", () => {
    // The trigger (pinned by the `types:` test above) is what makes GitHub
    // dispatch; this proves the decision then classifies the event as full. The
    // two tests are the proof together: the `types:` assertion fails if the
    // trigger is reverted, this one fails if the label branch is.
    const decide = stepNamed(parseSteps(WORKFLOW_SOURCE, "changes"), "Decide the scope");
    const labeled = runDecide(decide.run, { eventName: "pull_request", hasFullLabel: true });
    expect(labeled.scope).toContain("mode=full");
    expect(labeled.scope).toContain("reason=e2e:full label");
    expect(labeled.outputs).toContain("e2e_mode=full");
    // a push to develop is full for a different reason; the branch still runs
    const pushed = runDecide(decide.run, { eventName: "push", hasFullLabel: false });
    expect(pushed.scope).toContain("reason=merge to develop");
  });

  it("publishes the skip explanation from the always-running changes job (#231)", () => {
    // Finding 4: the summary used to live in the `e2e` job, which a `skip`
    // decision does not run, so nothing explained the skip. Pin the home (it
    // must be a `changes` step, so a revert to `e2e` fails `stepNamed`) and the
    // behaviour (it writes the mode, reason and rust decision).
    const summary = stepNamed(
      parseSteps(WORKFLOW_SOURCE, "changes"),
      "Report the scope decision",
    );
    expect(summary.condition).toBe("always()");
    expect(
      parseSteps(WORKFLOW_SOURCE, "e2e").some((step) => step.name === "Report the scope decision"),
    ).toBe(false);

    const dir = mkdtempSync(path.join(tmpdir(), "ci-summary-"));
    try {
      const summaryFile = path.join(dir, "step-summary");
      execFileSync("bash", ["-euo", "pipefail", "-c", summary.run], {
        cwd: dir,
        encoding: "utf8",
        env: shellEnv({
          GITHUB_STEP_SUMMARY: summaryFile,
          E2E_MODE: "skip",
          E2E_REASON: "no browser-reachable path changed",
          E2E_SPECS_OUT: "",
          RUST_RUNS: "false",
        }),
      });
      const written = readFileSync(summaryFile, "utf8");
      expect(written).toContain("e2e: `skip`");
      expect(written).toContain("no browser-reachable path changed");
      expect(written).toContain("rust: `false`");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the root `test` script running the scripts suite (#231)", () => {
    // This assertion used to live in scripts/e2e-selection.test.ts, where
    // removing `bun test ./scripts/` from the root script also stopped the
    // assertion from running. This suite is reached through `turbo test`, so it
    // still runs — and fails — after the scripts suite is disconnected.
    // SAFETY: package.json is this repo's own file; `scripts` is the field read.
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dir, "../../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toContain("bun test ./scripts/");
  });

  it("keeps the fail-closed shell wiring for the diff decision", () => {
    const changes = parseSteps(WORKFLOW_SOURCE, "changes");
    const diff = stepNamed(changes, "Compute the changed-file list");
    // a new branch / unknown base must assume everything changed
    expect(diff.run).toContain("0000000000000000000000000000000000000000");
    expect(diff.run).toContain("merge-base");
    const decide = stepNamed(changes, "Decide the scope");
    // the only overrule is the recorded PR label
    expect(decide.run).toContain("e2e:full");
    expect(decide.run).toContain("github.event.pull_request.labels");
    // a push to develop is never narrowed; a dispatch runs full
    expect(decide.run).toContain("merge to develop");
    expect(decide.run).toContain("manual dispatch");
    // a hand-typed scope would be an unrecorded override (invariant 5)
    expect(onLines(WORKFLOW_SOURCE).join("\n")).not.toContain("inputs:");
    // the e2e job fails closed when `changes` fails
    const e2eIf = jobField(WORKFLOW_SOURCE, "e2e", "if");
    expect(e2eIf).toContain("!cancelled()");
    expect(e2eIf).toContain("e2e_mode != 'skip'");
  });

  it("parses as YAML, not only as the workflow-utils line parser", () => {
    // workflow-utils splits lines; it would accept a stray-indent or stray
    // colon that GitHub refuses. Bun ships a YAML parser, so parse for real.
    // SAFETY: Bun.YAML.parse returns `unknown`; only `jobs` is read, and the
    // assertions below pin its keys.
    const doc = Bun.YAML.parse(WORKFLOW_SOURCE) as { jobs?: object };
    expect(doc.jobs).toBeDefined();
    expect(Object.keys(doc.jobs ?? {}).sort()).toEqual(["changes", "checks", "e2e", "rust"]);
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
    // the mutation is detected: a push-only condition is not the crate gate ...
    expect(isRustGate(jobField(pushOnly, RUST_JOB, "if"))).toBe(false);
    // ... and the real workflow must use the diff decision
    expect(isRustGate(jobField(WORKFLOW_SOURCE, RUST_JOB, "if"))).toBe(true);
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
