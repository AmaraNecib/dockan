/**
 * Invariants for the desktop installer workflow (issue 128). The repo has no
 * generic workflow linter, so this is the cheap guard that keeps the release
 * job honest: pinned actions, no repository secrets, OS/arch-scoped caches,
 * the documented release command, and a fail-loud artifact upload.
 *
 * The workflow is parsed into its steps first, and each assertion targets the
 * step that owns the behavior. Matching the raw file would let a stray comment
 * or an unrelated step satisfy a positive assertion (PR #152 finding 2), so
 * comments are stripped before any matching and the build command is only
 * accepted from the build step's `run:`.
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
  readonly with: ReadonlyMap<string, string>;
};

type MutableStep = {
  name: string;
  run: string;
  uses: string;
  with: Map<string, string>;
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
 * Parse the `jobs.installer.steps` list into named steps with their `run`,
 * `uses` and `with` values. Only the fields a step actually declares are
 * captured, so a comment can never look like a declared step field.
 */
function parseSteps(source: string): readonly WorkflowStep[] {
  const lines = stripComments(source).split("\n");
  const stepsIndex = lines.findIndex((line) => /^    steps:\s*$/u.test(line));
  if (stepsIndex === -1) return [];

  const steps: WorkflowStep[] = [];
  let current: MutableStep | null = null;
  let runBlockIndent = -1;
  let inWith = false;

  const flush = () => {
    if (current !== null) steps.push(current);
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
      current = { name: "", run: "", uses: "", with: new Map() };
      inWith = false;
      runBlockIndent = -1;
      const field = /^([\w-]+):\s*(.*)$/u.exec(stepStart[1]);
      if (field !== null && field[1] === "name") current.name = field[2].trim();
      if (field !== null && field[1] === "uses") current.uses = field[2].trim();
      continue;
    }

    if (current === null) continue;

    // continuation of a `run: |` block scalar
    if (runBlockIndent !== -1 && indent > runBlockIndent) {
      current.run += `${line.slice(runBlockIndent)}\n`;
      continue;
    }
    runBlockIndent = -1;

    if (indent === 8) {
      const field = /^        ([\w-]+):\s*(.*)$/u.exec(line);
      if (field === null) continue;
      const key = field[1];
      const value = field[2].trim();
      if (key === "name") current.name = value;
      else if (key === "uses") current.uses = value;
      else if (key === "run") {
        if (value.startsWith("|") || value.startsWith(">")) runBlockIndent = indent;
        else current.run = value;
      } else if (key === "with") inWith = true;
      else inWith = false;
      continue;
    }

    if (inWith && indent === 10) {
      const field = /^          ([\w-]+):\s*(.*)$/u.exec(line);
      if (field !== null) current.with.set(field[1], field[2].trim());
    }
  }

  flush();
  return steps;
}

/** A named step, or a loud failure when the workflow no longer declares it. */
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

describe("desktop installer workflow", () => {
  it("runs only on workflow_dispatch and a nightly schedule, never on PRs", () => {
    expect(WORKFLOW_SOURCE).toContain("\n  workflow_dispatch:\n");
    expect(WORKFLOW_SOURCE).toContain("\n  schedule:\n");
    expect(WORKFLOW_SOURCE).not.toContain("pull_request");
    expect(WORKFLOW_SOURCE).not.toContain("\n  push:\n");
  });

  it("keeps manual and nightly runs in separate concurrency groups", () => {
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

  it("builds on Windows with the documented release command in the build step", () => {
    expect(WORKFLOW_SOURCE).toContain("runs-on: windows-latest");
    const build = stepNamed(parseSteps(WORKFLOW_SOURCE), "Build installer");
    expect(build.run).toBe("bun run --filter @dokan/desktop installer");
  });

  it("does not accept a build command that only appears in a comment", () => {
    const commentOnly = [
      "jobs:",
      "  installer:",
      "    steps:",
      "      # bun run --filter @dokan/desktop installer",
      "      - name: Build installer",
      "        run: echo not-the-release-command",
    ].join("\n");
    // the raw text does contain the command...
    expect(commentOnly).toContain("bun run --filter @dokan/desktop installer");
    // ...but the parsed build step does not, so the assertion must not pass
    const build = stepNamed(parseSteps(commentOnly), "Build installer");
    expect(build.run).not.toContain("bun run --filter @dokan/desktop installer");
  });

  it("parses a CRLF checkout the same as LF", () => {
    // core.autocrlf on Windows hands the test a CRLF working copy; the parser
    // must still find the step and its run command.
    const crlf = WORKFLOW_SOURCE.replace(/\n/gu, "\r\n");
    const build = stepNamed(parseSteps(crlf), "Build installer");
    expect(build.run).toBe("bun run --filter @dokan/desktop installer");
  });

  it("uploads the NSIS installer from the upload step and fails loudly when it is missing", () => {
    const steps = parseSteps(WORKFLOW_SOURCE);

    const upload = stepNamed(steps, "Upload installer");
    expect(upload.uses.startsWith("actions/upload-artifact@")).toBe(true);
    expect(upload.with.get("path")).toBe(
      "apps/desktop/src-tauri/target/release/bundle/nsis/*.exe",
    );
    expect(upload.with.get("if-no-files-found")).toBe("error");

    const verify = stepNamed(steps, "Verify installer exists and is non-empty");
    expect(verify.run).toContain("$installers.Count -eq 0");
    expect(verify.run).toContain(".Length -le 0");
  });

  it("is a hard gate: no step is allowed to fail", () => {
    expect(WORKFLOW_SOURCE).not.toContain("continue-on-error");
  });
});
