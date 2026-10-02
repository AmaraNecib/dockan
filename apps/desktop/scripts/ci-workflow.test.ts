/**
 * Invariants for the PR CI workflow (issue 154). The Rust capability guards
 * added in #153 only gate a merge if a job in this workflow actually runs
 * `cargo test`, so these tests assert that job exists, that its steps are real
 * commands (not comments or no-ops), and that it is not hidden behind a
 * `paths:` filter that would leave a required check pending forever.
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

/** The `rust` job's steps, or a loud failure when the job was removed. */
function rustSteps(): ReturnType<typeof parseSteps> {
  const steps = parseSteps(WORKFLOW_SOURCE, RUST_JOB);
  if (steps.length === 0) throw new Error("ci.yml has no `rust` job");
  return steps;
}

describe("PR CI workflow", () => {
  it("keeps the existing bun and playwright jobs and their commands", () => {
    const checks = parseSteps(WORKFLOW_SOURCE, "checks");
    expect(stepNamed(checks, "Typecheck").run).toBe("bun run typecheck");
    expect(stepNamed(checks, "Lint").run).toBe("bun run lint");
    expect(stepNamed(checks, "Tests").run).toBe("bun run test");

    const e2e = parseSteps(WORKFLOW_SOURCE, "e2e");
    expect(stepNamed(e2e, "Run Playwright e2e").run).toBe("bun run test:e2e");
  });

  it("runs cargo test in the desktop crate on every PR", () => {
    const tests = stepNamed(rustSteps(), "Rust tests");
    // the guard from #153 lives in this crate's unit tests; if this step is
    // gone the regression can ship again
    expect(tests.run).toContain("cargo test");
    // no `if:` keeps it unconditional on the PR trigger
    expect(tests.condition).toBe("");
  });

  it("runs clippy with warnings denied", () => {
    const clippy = stepNamed(rustSteps(), "Rust clippy");
    expect(clippy.run).toContain("cargo clippy");
    expect(clippy.run).toContain("-D warnings");
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
    expect(cache.with.get("workspaces")).toContain("apps/desktop/src-tauri");
    expect(cache.with.get("cache-on-failure")).toBe("true");
  });

  it("pins every action in the workflow to a full commit SHA", () => {
    const refs = actionRefs(WORKFLOW_SOURCE);
    expect(refs.length).toBeGreaterThan(0);
    for (const { name, revision } of refs) {
      expect(revision, `${name} must be pinned to a 40-char SHA`).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  it("rejects a deleted or no-op rust test step", () => {
    const noop = [
      "jobs:",
      "  rust:",
      "    steps:",
      "      - name: Rust tests",
      "        run: echo skipped",
    ].join("\n");
    // the step still exists, but it no longer runs the tests
    expect(stepNamed(parseSteps(noop, RUST_JOB), "Rust tests").run).not.toContain("cargo test");

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

  it("does not accept a cargo test that only appears in a comment", () => {
    const commentOnly = [
      "jobs:",
      "  rust:",
      "    steps:",
      "      # cargo test",
      "      - name: Rust tests",
      "        run: echo not-the-test-command",
    ].join("\n");
    expect(commentOnly).toContain("cargo test");
    // ...but the parsed run command does not, so the assertion cannot pass
    expect(stepNamed(parseSteps(commentOnly, RUST_JOB), "Rust tests").run).not.toContain(
      "cargo test",
    );
  });

  it("parses a CRLF checkout the same as LF", () => {
    const crlf = WORKFLOW_SOURCE.replace(/\n/gu, "\r\n");
    const tests = stepNamed(parseSteps(crlf, RUST_JOB), "Rust tests");
    expect(tests.run).toContain("cargo test");
  });
});
