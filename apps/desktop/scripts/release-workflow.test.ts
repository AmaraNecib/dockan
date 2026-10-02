/**
 * Invariants for the desktop installer workflow (issue 128). The repo has no
 * generic workflow linter, so this is the cheap guard that keeps the release
 * job honest: pinned actions, no repository secrets, OS/arch-scoped caches,
 * the documented release command, and a fail-loud artifact upload.
 *
 * The assertions are deliberately textual — a full YAML parser in the test
 * would have to re-assert the same invariants, and the workflow is a config
 * file we own end to end.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const WORKFLOW_PATH = path.resolve(
  import.meta.dir,
  "../../../.github/workflows/desktop-installer.yml",
);
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8");

/** Every `uses:` action reference, split into name and pinned revision. */
function actionRefs(): { name: string; revision: string }[] {
  const refs: { name: string; revision: string }[] = [];
  for (const line of WORKFLOW_SOURCE.split("\n")) {
    const match = /^\s*uses:\s*(\S+)\s*(?:#.*)?$/u.exec(line);
    if (match === null) continue;
    const at = match[1].lastIndexOf("@");
    refs.push({ name: match[1].slice(0, at), revision: match[1].slice(at + 1) });
  }
  return refs;
}

/** The values of every `key:` line (the bun cache key), for scope checks. */
function cacheKeys(): string[] {
  const keys: string[] = [];
  for (const line of WORKFLOW_SOURCE.split("\n")) {
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

  it("builds on Windows with the documented release command", () => {
    expect(WORKFLOW_SOURCE).toContain("runs-on: windows-latest");
    expect(WORKFLOW_SOURCE).toContain("bun run --filter @dokan/desktop installer");
  });

  it("uploads the NSIS installer and fails loudly when it is missing", () => {
    expect(WORKFLOW_SOURCE).toContain("actions/upload-artifact@");
    expect(WORKFLOW_SOURCE).toContain("if-no-files-found: error");
    expect(WORKFLOW_SOURCE).toContain("bundle/nsis/*.exe");
  });

  it("is a hard gate: no step is allowed to fail", () => {
    expect(WORKFLOW_SOURCE).not.toContain("continue-on-error");
  });
});
