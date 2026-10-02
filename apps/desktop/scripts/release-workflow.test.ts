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
import { readFileSync } from "node:fs";
import path from "node:path";

const WORKFLOW_PATH = path.resolve(
  import.meta.dir,
  "../../../.github/workflows/desktop-installer.yml",
);
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n?/gu, "\n");

type WorkflowStep = {
  readonly name: string;
  readonly run: string;
  readonly uses: string;
  readonly condition: string;
  readonly with: ReadonlyMap<string, string>;
};

type MutableStep = {
  name: string;
  run: string;
  uses: string;
  condition: string;
  with: Map<string, string>;
};

type BlockScalar = {
  readonly target: "run" | "with";
  readonly key: string;
  readonly indent: number;
};

/**
 * Drop YAML comments before any assertion. A `#` only starts a comment at the
 * start of a line or after whitespace, so a `#` inside a scalar survives.
 * Line endings are normalised first: a CRLF checkout (core.autocrlf on
 * Windows) must not change how the file is parsed.
 */
function stripComments(source: string): string {
  return source
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/u, "$1"))
    .join("\n");
}

/**
 * Normalise a parsed scalar so YAML formatting choices compare equal: an
 * inline `run: cmd`, a `run: |` block with one line, and a `run: |` block with
 * several indented lines all reduce to the same de-indented, newline-trimmed
 * text. Without this a harmless formatting edit (a human, or Prettier) would
 * fail the tests even though the command did not change.
 */
function normaliseScalar(value: string): string {
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(commonIndent)).join("\n").trimEnd();
}

/**
 * Parse the `jobs.<jobName>.steps` list into named steps with their `run`,
 * `uses`, `if` and `with` values. Only the fields a step actually declares are
 * captured, so a comment can never look like a declared step field, and every
 * captured value is normalised so block-scalar formatting does not matter.
 */
function parseSteps(source: string, jobName: string): readonly WorkflowStep[] {
  const lines = stripComments(source).split("\n");
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsIndex === -1) return [];
  const jobPattern = new RegExp(`^  ${jobName}:\\s*$`, "u");
  const jobIndex = lines.findIndex((line, index) => index > jobsIndex && jobPattern.test(line));
  if (jobIndex === -1) return [];
  const stepsIndex = lines.findIndex(
    (line, index) => index > jobIndex && /^    steps:\s*$/u.test(line),
  );
  if (stepsIndex === -1) return [];
  // the steps list must belong to this job, not a later one
  for (let index = jobIndex + 1; index < stepsIndex; index += 1) {
    if (/^  \S+:\s*$/u.test(lines[index])) return [];
  }

  const steps: WorkflowStep[] = [];
  let current: MutableStep | null = null;
  let block: BlockScalar | null = null;
  let inWith = false;

  const flush = () => {
    if (current === null) return;
    const step = current;
    const normalisedWith = new Map<string, string>();
    for (const [key, value] of step.with) normalisedWith.set(key, normaliseScalar(value));
    steps.push({
      name: step.name,
      run: normaliseScalar(step.run),
      uses: step.uses,
      condition: step.condition,
      with: normalisedWith,
    });
  };

  for (let index = stepsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;

    // past the end of the job body
    if (indent <= 4) break;

    const stepStart = /^      - (.*)$/u.exec(line);
    if (stepStart !== null) {
      flush();
      current = { name: "", run: "", uses: "", condition: "", with: new Map() };
      block = null;
      inWith = false;
      const field = /^([\w-]+):\s*(.*)$/u.exec(stepStart[1]);
      if (field !== null && field[1] === "name") current.name = field[2].trim();
      if (field !== null && field[1] === "uses") current.uses = field[2].trim();
      continue;
    }

    if (current === null) continue;

    // continuation of a block scalar (`run: |` or a `with:` value)
    if (block !== null && indent > block.indent) {
      const text = `${line.slice(block.indent)}\n`;
      if (block.target === "run") current.run += text;
      else current.with.set(block.key, (current.with.get(block.key) ?? "") + text);
      continue;
    }
    block = null;

    if (indent === 8) {
      const field = /^        ([\w-]+):\s*(.*)$/u.exec(line);
      if (field === null) continue;
      const key = field[1];
      const value = field[2].trim();
      if (key === "name") current.name = value;
      else if (key === "uses") current.uses = value;
      else if (key === "if") current.condition = value;
      else if (key === "run") {
        if (value.startsWith("|") || value.startsWith(">")) {
          block = { target: "run", key: "run", indent };
          current.run = "";
        } else current.run = value;
      } else if (key === "with") inWith = true;
      else inWith = false;
      continue;
    }

    if (inWith && indent === 10) {
      const field = /^          ([\w-]+):\s*(.*)$/u.exec(line);
      if (field === null) continue;
      const key = field[1];
      const value = field[2].trim();
      if (value.startsWith("|") || value.startsWith(">")) {
        block = { target: "with", key, indent };
        current.with.set(key, "");
      } else {
        current.with.set(key, value);
      }
    }
  }

  flush();
  return steps;
}

/** The body lines of one `jobs.<jobName>` block, comment-stripped. */
function jobLines(source: string, jobName: string): readonly string[] {
  const lines = stripComments(source).split("\n");
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsIndex === -1) return [];
  const jobPattern = new RegExp(`^  ${jobName}:\\s*$`, "u");
  const jobIndex = lines.findIndex((line, index) => index > jobsIndex && jobPattern.test(line));
  if (jobIndex === -1) return [];
  const collected: string[] = [];
  for (let index = jobIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      collected.push(line);
      continue;
    }
    if (line.length - line.trimStart().length <= 2) break;
    collected.push(line);
  }
  return collected;
}

/** The `on:` block lines, comment-stripped. */
function onLines(source: string): readonly string[] {
  const lines = stripComments(source).split("\n");
  const onIndex = lines.findIndex((line) => /^on:\s*$/u.test(line));
  if (onIndex === -1) return [];
  const collected: string[] = [];
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      collected.push(line);
      continue;
    }
    if (line.length - line.trimStart().length === 0) break;
    collected.push(line);
  }
  return collected;
}

/** The `options:` list of the workflow_dispatch input. */
function dispatchOptions(source: string): readonly string[] {
  const lines = onLines(source);
  const optionsIndex = lines.findIndex((line) => /^        options:\s*$/u.test(line));
  if (optionsIndex === -1) return [];
  const options: string[] = [];
  for (let index = optionsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    if (line.length - line.trimStart().length <= 8) break;
    const item = /^\s*- (.*)$/u.exec(line);
    if (item !== null) options.push(item[1].trim());
  }
  return options;
}

/** A scalar under the workflow_dispatch input (e.g. `default`, `type`). */
function dispatchScalar(source: string, key: string): string {
  const pattern = new RegExp(`^        ${key}:\\s*(\\S+)\\s*$`, "u");
  for (const line of onLines(source)) {
    const match = pattern.exec(line);
    if (match !== null) return match[1];
  }
  return "";
}

/** A named step, or a loud failure when the job no longer declares it. */
function stepNamed(steps: readonly WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`workflow has no step named "${name}"`);
  }
  return step;
}

/** Every `uses:` action reference, split into name and pinned revision. */
function actionRefs(): { name: string; revision: string }[] {
  const refs: { name: string; revision: string }[] = [];
  for (const line of stripComments(WORKFLOW_SOURCE).split("\n")) {
    const match = /^\s*uses:\s*(\S+)\s*$/u.exec(line);
    if (match === null) continue;
    const at = match[1].lastIndexOf("@");
    refs.push({ name: match[1].slice(0, at), revision: match[1].slice(at + 1) });
  }
  return refs;
}

/** The values of every `key:` line (the bun cache key), for scope checks. */
function cacheKeys(): string[] {
  const keys: string[] = [];
  for (const line of stripComments(WORKFLOW_SOURCE).split("\n")) {
    const match = /^\s*key:\s*(\S.*)$/u.exec(line);
    if (match !== null) keys.push(match[1].trim());
  }
  return keys;
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
    const refs = actionRefs();
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
    const keys = cacheKeys();
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

  it("builds both the portable and the installer targets", () => {
    const steps = parseSteps(WORKFLOW_SOURCE, "build");
    expect(stepNamed(steps, "Build portable").run).toBe(
      "bun run --filter @dokan/desktop portable",
    );
    expect(stepNamed(steps, "Build installer").run).toBe(
      "bun run --filter @dokan/desktop installer",
    );
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
