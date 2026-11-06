import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBrowserManifest, writeManifestSafely, type BrowserManifest, type BrowserManifestInput, type ManifestResult, type ManifestTest } from "./browser-ci-manifest";
import { BrowserManifestReporter } from "./browser-ci-manifest-collector";

const testCase = (id: string, projectName = "chromium"): ManifestTest => ({
  id,
  titlePath: ["root", "suite", `test-${id}`],
  location: { file: "tests/e2e/example.spec.ts" },
  project: () => ({ name: projectName }),
  repeatEachIndex: 0,
});

const result = (retry: number, status: ManifestResult["status"], expectedStatus: ManifestResult["expectedStatus"] = "passed"): ManifestResult => ({ retry, status, expectedStatus, duration: 12 });

function manifest(overrides: Partial<BrowserManifestInput> = {}): BrowserManifest {
  const value = createBrowserManifest({
    discovered: [testCase("one")],
    results: [{ test: testCase("one"), result: result(0, "passed") }],
    runStatus: "passed",
    initialized: true,
    finalized: true,
    provenance: { checkoutSha: "a".repeat(40), runId: "42" },
    ...overrides,
  });
  expect(value).toMatchObject({ schemaVersion: 1 });
  return value;
}

describe("browser CI manifest", () => {
  test("records discovered identities and their final executed outcome only after complete onEnd", () => {
    const value = manifest();
    expect(value.inventory).toEqual([{
      file: "tests/e2e/example.spec.ts",
      project: "chromium",
      titlePath: ["root", "suite", "test-one"],
      repeatEachIndex: 0,
      id: "one",
    }]);
    expect(value.outcomes).toEqual([{
      id: "one",
      repeatEachIndex: 0,
      attempts: [{ retry: 0, status: "passed", expectedStatus: "passed", durationMs: 12 }],
      finalStatus: "passed",
      expectedStatus: "passed",
      unexpected: false,
    }]);
    expect(value).toMatchObject({ phase: "finalized", complete: true, noSafeReuseCertified: true, savedMinutes: 0 });
  });

  test("keeps retries, expected failures and skips explicit", () => {
    const value = manifest({
      discovered: [testCase("retry"), testCase("xfail"), testCase("skip")],
      results: [
        { test: testCase("retry"), result: result(0, "failed") },
        { test: testCase("retry"), result: result(1, "passed") },
        { test: testCase("xfail"), result: result(0, "failed", "failed") },
        { test: testCase("skip"), result: result(0, "skipped", "skipped") },
      ],
    });
    expect(value.outcomes).toEqual([
      { id: "retry", repeatEachIndex: 0, attempts: [
        { retry: 0, status: "failed", expectedStatus: "passed", durationMs: 12 },
        { retry: 1, status: "passed", expectedStatus: "passed", durationMs: 12 },
      ], finalStatus: "passed", expectedStatus: "passed", unexpected: false },
      { id: "xfail", repeatEachIndex: 0, attempts: [{ retry: 0, status: "failed", expectedStatus: "failed", durationMs: 12 }], finalStatus: "failed", expectedStatus: "failed", unexpected: false },
      { id: "skip", repeatEachIndex: 0, attempts: [{ retry: 0, status: "skipped", expectedStatus: "skipped", durationMs: 12 }], finalStatus: "skipped", expectedStatus: "skipped", unexpected: false },
    ]);
  });

  test("marks missing outcomes, duplicate identities, interruption and absent finalization incomplete", () => {
    expect(manifest({ results: [] })).toMatchObject({ phase: "finalized", complete: false });
    expect(manifest({ discovered: [testCase("same"), testCase("same")] })).toMatchObject({ phase: "finalized", complete: false });
    expect(manifest({ runStatus: "interrupted" })).toMatchObject({ phase: "interrupted", complete: false });
    expect(manifest({ finalized: false })).toMatchObject({ phase: "running", complete: false });
    expect(manifest({ initialized: false })).toMatchObject({ phase: "initializing", complete: false });
    expect(manifest({ collectorError: true })).toMatchObject({ phase: "collector-error", complete: false });
  });

  test("keeps repeated executions distinct even when the Playwright test ID repeats", () => {
    const first = { ...testCase("same"), repeatEachIndex: 0 };
    const second = { ...testCase("same"), repeatEachIndex: 1 };
    const value = manifest({
      discovered: [first, second],
      results: [
        { test: first, result: result(0, "passed") },
        { test: second, result: result(0, "failed") },
      ],
    });
    expect(value).toMatchObject({ complete: true, inventory: [{ repeatEachIndex: 0 }, { repeatEachIndex: 1 }] });
    expect(value.outcomes.map(({ repeatEachIndex, finalStatus }) => [repeatEachIndex, finalStatus])).toEqual([[0, "passed"], [1, "failed"]]);
  });

  test("distinguishes the unnamed default project from a missing project", () => {
    const unnamed = testCase("unnamed", "");
    expect(manifest({ discovered: [unnamed], results: [{ test: unnamed, result: result(0, "passed") }] })).toMatchObject({
      complete: true, inventory: [{ project: "" }],
    });
    const missing = { ...unnamed, project: () => undefined };
    expect(manifest({ discovered: [missing], results: [] })).toMatchObject({ complete: false, inventory: [] });
  });

  test("preserves unknown provenance and excludes unapproved values", () => {
    const untrusted = { checkoutSha: null, runId: "malformed", secret: "do-not-copy" };
    const value = manifest({ provenance: untrusted });
    expect(value.provenance).toMatchObject({ checkoutSha: "unknown", runId: "unknown" });
    expect(JSON.stringify(value)).not.toContain("do-not-copy");
  });

  test("writes bounded JSON under a safe relative path and refuses traversal or symlinks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "browser-manifest-"));
    try {
      const value = manifest();
      const bytes = writeManifestSafely(root, "attempt-1/manifest.json", value);
      expect(bytes).toBe(readFileSync(path.join(root, "attempt-1", "manifest.json")).byteLength);
      expect(() => writeManifestSafely(root, "../manifest.json", value)).toThrow("unsafe manifest path");
      symlinkSync(tmpdir(), path.join(root, "linked"), "junction");
      expect(() => writeManifestSafely(root, "linked/manifest.json", value)).toThrow("symlink");
      const huge = createBrowserManifest({
        discovered: Array.from({ length: 1200 }, (_, i) => ({ ...testCase(`test-${i}`), titlePath: ["suite", "x".repeat(300)] })),
        results: [], initialized: true, finalized: true, runStatus: "passed",
      });
      expect(() => writeManifestSafely(root, "large/manifest.json", huge)).toThrow("256 KiB");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("collects actual reporter inventory and callbacks while labeling browser identity unknown", () => {
    const scratch = mkdtempSync(path.join(process.cwd(), ".scratch", "manifest-reporter-"));
    try {
      const outputDirectory = path.relative(process.cwd(), path.join(scratch, "attempt-7"));
      const reporter = new BrowserManifestReporter({ outputDirectory });
      expect(reporter.onBegin).toBeInstanceOf(Function);
      expect(reporter.onTestEnd).toBeInstanceOf(Function);
      expect(reporter.onEnd).toBeInstanceOf(Function);
      // SAFETY: This fixture contains every TestCase field the reporter reads.
      const fakeTest = {
        id: "runtime-id",
        titlePath: () => ["", "chromium", "runtime.spec.ts", "runtime title"],
        location: { file: path.join(process.cwd(), "tests", "e2e", "runtime.spec.ts") },
        repeatEachIndex: 0,
        expectedStatus: "passed",
        parent: { project: () => ({ name: "" }) },
      } as never;
      // SAFETY: This partial config fixture supplies every field read by onBegin.
      const config = { workers: 1, projects: [{ retries: 0, use: { locale: "ar-DZ" } }] } as never;
      // SAFETY: This partial suite fixture supplies the allTests method read by onBegin.
      const suite = { allTests: () => [fakeTest] } as never;
      reporter.onBegin(config, suite);
      // SAFETY: This result fixture supplies each result field consumed by onTestEnd.
      const testResult = { retry: 0, status: "passed", duration: 9 } as never;
      reporter.onTestEnd(fakeTest, testResult);
      // SAFETY: This fixture supplies the final status read by onEnd.
      const fullResult = { status: "passed" } as never;
      reporter.onEnd(fullResult);
      expect(existsSync(path.join(scratch, "attempt-7", "manifest.json"))).toBe(true);
      // SAFETY: The reporter writes the BrowserManifest contract verified below.
      const recorded = JSON.parse(readFileSync(path.join(scratch, "attempt-7", "manifest.json"), "utf8")) as BrowserManifest;
      expect(recorded.inventory).toEqual([{
        file: "tests/e2e/runtime.spec.ts", project: "", titlePath: ["", "chromium", "runtime.spec.ts", "runtime title"], repeatEachIndex: 0, id: "runtime-id",
      }]);
      expect(recorded.outcomes[0]).toMatchObject({ repeatEachIndex: 0, finalStatus: "passed", expectedStatus: "passed", attempts: [{ retry: 0 }] });
      expect(recorded).toMatchObject({ phase: "finalized", complete: true });
      expect(recorded.provenance.browserIdentity).toMatchObject({ ACTUAL_VERSION: "unknown", ACTUAL_REVISION: "unknown", EXECUTABLE_SHA256: "unknown" });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("keeps the CI e2e selection and pipefail contract while uploading both artifact classes", () => {
    const workflow = readFileSync(path.join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toContain("bun run test:e2e $E2E_SPECS 2>&1 | tee e2e-logs/playwright.log");
    expect(workflow).toContain("set -o pipefail");
    expect(workflow).toContain("if: failure() || cancelled()");
    expect(workflow).toContain("playwright-e2e-failure-${{ github.run_attempt }}");
    expect(workflow).toContain("playwright-e2e-manifest-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(workflow).toContain("retention-days: 5");
    expect(workflow).toContain("continue-on-error: true");
  });
});
