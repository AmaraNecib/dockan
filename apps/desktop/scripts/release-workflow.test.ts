/**
 * Invariants for the desktop release workflow (issue 128; owner round-4
 * requirements). The repo has no generic workflow linter, so this is the cheap
 * guard that keeps the release job honest: pinned actions, no repository
 * secrets, OS/arch-scoped caches, version integrity, both targets built,
 * verified and uploaded, and a release published only for a pushed version tag.
 *
 * The workflow is parsed into jobs and steps first, and each assertion targets
 * the job/step that owns the behavior. Matching the raw file would let a stray
 * comment or an unrelated step satisfy a positive assertion (PR #152 finding
 * 2), so comments are stripped before any matching and the build commands are
 * only accepted from the owning step's `run:`. Block scalars are dedented and
 * newline-trimmed so a formatting edit cannot fail the tests (PR #152 finding
 * 3), and line endings are normalised for a CRLF checkout.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  actionRefs,
  cacheKeys,
  dispatchOptions,
  dispatchScalar,
  jobLines,
  onLines,
  parseSteps,
  stepNamed,
  stripComments,
} from "./workflow-utils";

const WORKFLOW_PATH = path.resolve(
  import.meta.dir,
  "../../../.github/workflows/desktop-installer.yml",
);
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n?/gu, "\n");

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const VERSION_STEP_RUN = stepNamed(
  parseSteps(WORKFLOW_SOURCE, "build"),
  "Resolve and validate version",
).run;

/** The version declared in apps/desktop/package.json. */
function readDesktopVersion(): string {
  const match = /"version":\s*"([^"]+)"/u.exec(
    readFileSync(path.join(REPO_ROOT, "apps/desktop/package.json"), "utf8"),
  );
  if (match === null) throw new Error("apps/desktop/package.json has no version");
  return match[1];
}

/** pwsh is on ubuntu-latest and Windows; the behavioural test skips elsewhere. */
function hasPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

const PWSH_AVAILABLE = hasPwsh();

type VersionRun = {
  readonly status: number;
  readonly outputs: ReadonlyMap<string, string>;
};

/**
 * Run the workflow's actual version step under pwsh for a given ref/event.
 * Behavioural, not a copy: a regression in the shipped PowerShell fails here.
 */
function runVersionStep(ref: string, event: string, target: string): VersionRun {
  const dir = mkdtempSync(path.join(tmpdir(), "dokan-version-"));
  const scriptPath = path.join(dir, "step.ps1");
  const outputPath = path.join(dir, "output.txt");
  const summaryPath = path.join(dir, "summary.txt");
  writeFileSync(scriptPath, VERSION_STEP_RUN, "utf8");
  try {
    const result = spawnSync("pwsh", ["-NoProfile", "-File", scriptPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_REF: ref,
        GITHUB_EVENT_NAME: event,
        DISPATCH_TARGET: target,
      },
    });
    const outputs = new Map<string, string>();
    if (existsSync(outputPath)) {
      for (const line of readFileSync(outputPath, "utf8").split("\n")) {
        const separator = line.indexOf("=");
        if (separator > 0) {
          outputs.set(line.slice(0, separator), line.slice(separator + 1).trim());
        }
      }
    }
    return { status: result.status ?? 1, outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("desktop release workflow", () => {
  it("runs only on workflow_dispatch and v* tags, never on a schedule or PRs", () => {
    const triggers = onLines(WORKFLOW_SOURCE).join("\n");
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).toContain("push:");
    expect(triggers).toContain("tags:");
    expect(triggers).toContain('"v*"');
    // the owner removed the nightly build: no unattended runs
    expect(stripComments(WORKFLOW_SOURCE)).not.toContain("schedule");
    expect(WORKFLOW_SOURCE).not.toContain("pull_request");
  });

  it("exposes a dispatch input to choose all, installer or portable", () => {
    expect(dispatchOptions(WORKFLOW_SOURCE)).toEqual(["all", "installer", "portable"]);
    expect(dispatchScalar(WORKFLOW_SOURCE, "default")).toBe("all");
    expect(dispatchScalar(WORKFLOW_SOURCE, "type")).toBe("choice");
  });

  it("keeps manual and tag runs in separate concurrency groups", () => {
    const match = /^concurrency:\n  group: (.+)$/mu.exec(WORKFLOW_SOURCE);
    if (match === null) throw new Error("workflow has no concurrency.group");
    expect(match[1]).toContain("github.event_name");
    // still cancel duplicate runs of the same trigger
    expect(WORKFLOW_SOURCE).toContain("cancel-in-progress: true");
  });

  it("pins every action to a full commit SHA", () => {
    const refs = actionRefs(WORKFLOW_SOURCE);
    expect(refs.length).toBeGreaterThan(0);
    for (const { name, revision } of refs) {
      expect(revision, `${name} must be pinned to a 40-char SHA`).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  it("reads no repository secrets (ADR-0008: one universal build)", () => {
    expect(WORKFLOW_SOURCE).not.toMatch(/secrets[.[]/u);
    expect(WORKFLOW_SOURCE).not.toContain("DOKAN_BUILD_SECRET");
    expect(WORKFLOW_SOURCE).not.toContain("DOKAN_AUTH_SECRET");
  });

  it("scopes cache keys to the runner OS and arch so platforms cannot collide", () => {
    const keys = cacheKeys(WORKFLOW_SOURCE);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toContain("runner.os");
      expect(key).toContain("runner.arch");
    }
  });

  it("validates the version in both files and against a version tag", () => {
    const steps = parseSteps(WORKFLOW_SOURCE, "build");
    const version = stepNamed(steps, "Resolve and validate version");
    // must run before any build: no `if:` on the step
    expect(version.condition).toBe("");
    // both files are actually read (not just named in an error message)
    expect(version.run).toContain("Get-Content apps/desktop/package.json");
    expect(version.run).toContain("Get-Content apps/desktop/src-tauri/tauri.conf.json");
    expect(version.run).toContain("version mismatch");
    // on a tag, the tag must be v<version> (optional pre-release suffix)
    expect(version.run).toContain('refs/tags/v*');
    expect(version.run).toContain("does not match the version");
    // the resolved version feeds the artifact names, so the step must have run
    expect(stepNamed(steps, "Upload portable").with.get("name")).toContain(
      "steps.version.outputs.version",
    );
    expect(stepNamed(steps, "Upload installer").with.get("name")).toContain(
      "steps.version.outputs.version",
    );
  });

  it("derives the prerelease flag from the tag and reports it", () => {
    const version = stepNamed(parseSteps(WORKFLOW_SOURCE, "build"), "Resolve and validate version");
    expect(version.run).toContain('prerelease=$($prerelease.ToString().ToLowerInvariant())');
    // the flag is wired out of the build job for the release job
    expect(jobLines(WORKFLOW_SOURCE, "build").join("\n")).toContain(
      "prerelease: ${{ steps.version.outputs.prerelease }}",
    );
  });

  it.skipIf(!PWSH_AVAILABLE)(
    "runs the version step: pre-release kind and target gating come from the ref",
    () => {
      const version = readDesktopVersion();

      // a tag builds both targets and is a normal release
      const plain = runVersionStep(`refs/tags/v${version}`, "push", "");
      expect(plain.status, "a plain tag must pass the version check").toBe(0);
      expect(plain.outputs.get("version")).toBe(version);
      expect(plain.outputs.get("prerelease")).toBe("false");
      expect(plain.outputs.get("build_portable")).toBe("true");
      expect(plain.outputs.get("build_installer")).toBe("true");

      // a -rc tag is a prerelease and still builds both
      const rc = runVersionStep(`refs/tags/v${version}-rc.1`, "push", "");
      expect(rc.status, "a pre-release tag must pass the version check").toBe(0);
      expect(rc.outputs.get("prerelease")).toBe("true");
      expect(rc.outputs.get("build_portable")).toBe("true");
      expect(rc.outputs.get("build_installer")).toBe("true");

      // a manual installer run selects ONLY the installer
      const installer = runVersionStep("refs/heads/develop", "workflow_dispatch", "installer");
      expect(installer.status).toBe(0);
      expect(installer.outputs.get("prerelease")).toBe("false");
      expect(installer.outputs.get("build_portable")).toBe("false");
      expect(installer.outputs.get("build_installer")).toBe("true");

      // a manual portable run selects ONLY the portable
      const portable = runVersionStep("refs/heads/develop", "workflow_dispatch", "portable");
      expect(portable.status).toBe(0);
      expect(portable.outputs.get("build_portable")).toBe("true");
      expect(portable.outputs.get("build_installer")).toBe("false");

      // a tag that does not match the version fails loudly
      const wrong = runVersionStep("refs/tags/v999.0.0", "push", "");
      expect(wrong.status, "a tag that does not match the version must fail").not.toBe(0);
    },
    // pwsh cold-start on the runner is slower than the 5s default; each
    // scenario spawns one pwsh, so give the whole test a generous budget.
    { timeout: 60_000 },
  );

  it("passes --prerelease only for a pre-release tag and keeps the kind on a re-run", () => {
    const publish = stepNamed(parseSteps(WORKFLOW_SOURCE, "release"), "Publish release");
    // the flag comes from the build job's resolved kind
    expect(publish.env.get("PRERELEASE")).toBe("${{ needs.build.outputs.prerelease }}");
    // create carries the flag when the tag is a pre-release
    expect(publish.run).toContain('PRERELEASE_ARG="--prerelease"');
    expect(publish.run).toContain("gh release create");
    expect(publish.run).toContain("${PRERELEASE_ARG}");
    // a re-run re-applies the derived kind instead of dropping or flipping it
    expect(publish.run).toContain("gh release edit");
    expect(publish.run).toContain('--prerelease="${PRERELEASE}"');
    expect(publish.run).toContain("gh release upload");
  });

  it("builds both the portable and the installer targets", () => {
    const steps = parseSteps(WORKFLOW_SOURCE, "build");
    expect(stepNamed(steps, "Build portable").run).toBe(
      "bun run --filter @dokan/desktop portable",
    );
    expect(stepNamed(steps, "Build installer").run).toBe(
      "bun run --filter @dokan/desktop installer",
    );
  });

  it("gates every target step on its dispatch flag", () => {
    const steps = parseSteps(WORKFLOW_SOURCE, "build");
    // a manual `installer` run must build, verify and upload ONLY the installer:
    // every portable step is gated on build_portable and every installer step
    // on build_installer (the version step resolves those from the input).
    for (const name of ["Build portable", "Verify portable", "Upload portable"]) {
      expect(stepNamed(steps, name).condition, `${name} must be gated on build_portable`).toBe(
        "steps.version.outputs.build_portable == 'true'",
      );
    }
    for (const name of ["Build installer", "Verify installer", "Upload installer"]) {
      expect(stepNamed(steps, name).condition, `${name} must be gated on build_installer`).toBe(
        "steps.version.outputs.build_installer == 'true'",
      );
    }
  });

  it("does not accept a build command that only appears in a comment", () => {
    const commentOnly = [
      "jobs:",
      "  build:",
      "    steps:",
      "      # bun run --filter @dokan/desktop installer",
      "      - name: Build installer",
      "        run: echo not-the-release-command",
    ].join("\n");
    // the raw text does contain the command...
    expect(commentOnly).toContain("bun run --filter @dokan/desktop installer");
    // ...but the parsed build step does not, so the assertion must not pass
    const build = stepNamed(parseSteps(commentOnly, "build"), "Build installer");
    expect(build.run).not.toContain("bun run --filter @dokan/desktop installer");
  });

  it("accepts the installer command written as an indented run: | block", () => {
    // a formatter may rewrite `run: cmd` as a block scalar; the command is
    // unchanged, so the assertion must still pass
    const blockForm = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Build installer",
      "        run: |",
      "          bun run --filter @dokan/desktop installer",
    ].join("\n");
    const build = stepNamed(parseSteps(blockForm, "build"), "Build installer");
    expect(build.run).toBe("bun run --filter @dokan/desktop installer");
  });

  it("rejects a run: | block whose installer command is commented out or a no-op", () => {
    const commented = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Build installer",
      "        run: |",
      "          # bun run --filter @dokan/desktop installer",
      "          echo not-the-release-command",
    ].join("\n");
    const noop = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Build installer",
      "        run: |",
      "          echo not-the-release-command",
    ].join("\n");
    // normalisation must not weaken the check: neither form is the release command
    for (const source of [commented, noop]) {
      const build = stepNamed(parseSteps(source, "build"), "Build installer");
      expect(build.run).not.toBe("bun run --filter @dokan/desktop installer");
    }
  });

  it("parses a CRLF checkout the same as LF", () => {
    // core.autocrlf on Windows hands the test a CRLF working copy; the parser
    // must still find the step and its run command.
    const crlf = WORKFLOW_SOURCE.replace(/\n/gu, "\r\n");
    const build = stepNamed(parseSteps(crlf, "build"), "Build installer");
    expect(build.run).toBe("bun run --filter @dokan/desktop installer");
  });

  it("verifies both targets and fails loudly when either is missing", () => {
    const steps = parseSteps(WORKFLOW_SOURCE, "build");

    const portable = stepNamed(steps, "Verify portable");
    expect(portable.run).toContain("Dokan-portable.zip");
    expect(portable.run).toContain("Dokan-portable.exe");
    // both the zip and the exe must be non-empty, each with its own check
    expect(portable.run).toContain("portable zip is empty");
    expect(portable.run).toContain("portable exe is empty");

    const installer = stepNamed(steps, "Verify installer");
    expect(installer.run).toContain("$installers.Count -eq 0");
    expect(installer.run).toContain("no NSIS installer produced");
    expect(installer.run).toContain("installer is empty");
  });

  it("uploads both targets under clear names and fails when either is absent", () => {
    const steps = parseSteps(WORKFLOW_SOURCE, "build");

    const portable = stepNamed(steps, "Upload portable");
    expect(portable.uses.startsWith("actions/upload-artifact@")).toBe(true);
    expect(portable.with.get("name")).toContain("-portable");
    expect(portable.with.get("path")).toContain("Dokan-portable.zip");
    expect(portable.with.get("if-no-files-found")).toBe("error");

    const installer = stepNamed(steps, "Upload installer");
    expect(installer.uses.startsWith("actions/upload-artifact@")).toBe(true);
    expect(installer.with.get("name")).toContain("-installer");
    expect(installer.with.get("path")).toContain("bundle/nsis");
    expect(installer.with.get("if-no-files-found")).toBe("error");
  });

  it("publishes a GitHub release only for a pushed version tag, with contents: write there only", () => {
    const release = jobLines(WORKFLOW_SOURCE, "release").join("\n");
    expect(release).toContain("needs: build");
    expect(release).toContain("github.event_name == 'push'");
    expect(release).toContain("refs/tags/");
    expect(release).toContain("contents: write");
    expect(release).toContain("gh release create");

    // both files are attached to the release, and neither download is skipped
    const steps = parseSteps(WORKFLOW_SOURCE, "release");
    const downloads = steps.filter((step) => step.uses.startsWith("actions/download-artifact@"));
    expect(downloads).toHaveLength(2);
    for (const download of downloads) {
      expect(download.condition, `${download.name} must not be skipped`).toBe("");
    }
    const names = downloads.map((step) => step.with.get("name")).join("\n");
    expect(names).toContain("-portable");
    expect(names).toContain("-installer");
    expect(stepNamed(steps, "Publish release").condition).toBe("");

    // the build job stays read-only
    const build = jobLines(WORKFLOW_SOURCE, "build").join("\n");
    expect(build).not.toContain("contents: write");
  });

  it("is a hard gate: no step is allowed to fail", () => {
    expect(WORKFLOW_SOURCE).not.toContain("continue-on-error");
  });
});
