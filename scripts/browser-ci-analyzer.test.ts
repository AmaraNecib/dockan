import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { classifyPair, loadBrowserEvidence, parseArgs, parseBrowserLog, type BrowserEvidence } from "./browser-ci-analyzer";

const SHA_PR = "f248634aebb67a119a3086f5d5c816b194910199";
const SHA_PUSH = "25a8f1f5a8078c5d05b7311e517138ea05e2cc76";
const TREE = "29d827fa4e3e5be76d56de3d4e0c08478341c685";
const PIPELINE_LOG = `
##[group]Runner Image
Image: ubuntu-26.04
Version: 20261101.186.1
##[endgroup]
Obtained version 1.4.3 from package.json
Using a cached version of Bun: 1.4.3+c6da4a4d3
##[group]Run bunx playwright install --with-deps chromium
##[endgroup]
##[group]Run Playwright e2e
bun run test:e2e $E2E_SPECS 2>&1 | tee e2e-logs/playwright.log
shell: /usr/bin/bash -e {0}
env:
  DOKAN_PORT: 5317
  E2E_SPECS: 
##[endgroup]
$ playwright test
[WebServer] RPC_ERROR (an app log, not the test result)
Running 148 tests using 1 worker
  148 passed (8.0m)
`;
function evidence(overrides: Partial<BrowserEvidence> = {}): BrowserEvidence {
  return {
    runId: 1, attempt: 1, event: "pull_request", jobName: "playwright e2e", jobConclusion: "success",
    checkoutSha: SHA_PR, checkoutTree: TREE, scope: "full", passed: 148, failed: 0, skipped: 0,
    runtime: ["image=ubuntu-26.04", "runnerImage=20261101.186.1", "bun=1.4.3+c6da4a4d3"],
    wallSeconds: 506, evidenceErrors: [], ...overrides,
  };
}

describe("offline browser CI evidence", () => {
  test("reads checkout from the browser job pipeline, not app RPC failures", () => {
    const result = parseBrowserLog({ runId: 11, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log: `[command]/usr/bin/git log -1 --format=%H\n${SHA_PR}\n${PIPELINE_LOG}`, wallSeconds: 506 });
    expect(result.checkoutSha).toBe(SHA_PR);
    expect(result.scope).toBe("full");
    expect([result.passed, result.failed, result.skipped]).toEqual([148, 0, 0]);
    expect(result.runtime).toEqual(["image=ubuntu-26.04", "runnerImage=20261101.186.1", "bun=1.4.3+c6da4a4d3"]);
    expect(result.wallSeconds).toBe(506);
    expect(result.evidenceErrors).toEqual([]);
  });

  test("marks a mapped E2E_SPECS value scoped, not full", () => {
    const log = PIPELINE_LOG.replace("E2E_SPECS: ", "E2E_SPECS: tests/e2e/backups.spec.ts");
    expect(parseBrowserLog({ runId: 1, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log }).scope).toBe("scoped");
  });

  test("UNKNOWN STEP log prefixes do not hide the job-anchored checkout", () => {
    const raw = `[command]git log -1 --format=%H\n${SHA_PR}\n${PIPELINE_LOG}`;
    const log = raw.split("\n").map((line) => `playwright e2e\tUNKNOWN STEP\t2026-11-05T20:13:28.183Z ${line}`).join("\n");
    const result = parseBrowserLog({ runId: 2, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log });
    expect(result.checkoutSha).toBe(SHA_PR);
    expect(result.scope).toBe("full");
    expect(result.passed).toBe(148);
  });

  test("named-step prefixes preserve checkout, scope and summary evidence", () => {
    const raw = `[command]git log -1 --format=%H\n${SHA_PR}\n${PIPELINE_LOG}`;
    const log = raw.split("\n").map((line) => `playwright e2e\tRun Playwright e2e\t2026-11-05T20:13:28.183Z ${line}`).join("\n");
    const result = parseBrowserLog({ runId: 2, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log });
    expect(result.checkoutSha).toBe(SHA_PR);
    expect(result.scope).toBe("full");
    expect(result.passed).toBe(148);
  });

  test("separate summary lines retain failed and skipped counts", () => {
    const log = PIPELINE_LOG.replace("148 passed (8.0m)", "2 failed\n  3 skipped\n  143 passed (8.0m)");
    const result = parseBrowserLog({ runId: 3, attempt: 1, jobName: "playwright e2e", jobConclusion: "failure", log });
    expect([result.passed, result.failed, result.skipped]).toEqual([143, 2, 3]);
  });

  test("a narrowed emitted Playwright command cannot establish full scope", () => {
    const log = PIPELINE_LOG.replace("$ playwright test\n", "$ playwright test tests/e2e/foo.spec.ts\n");
    const result = parseBrowserLog({ runId: 3, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log });
    expect(result.scope).toBe("unknown");
  });

  test("conflicting runtime versions cannot establish a candidate", () => {
    const log = PIPELINE_LOG.replace("Version: 20261101.186.1", "Version: 20261101.186.1\nVersion: 20261102.187.1");
    const result = parseBrowserLog({ runId: 3, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log });
    expect(result.evidenceErrors).toContain("runtime signals ambiguous");
  });

  test.each([
    ["2026-11-05T20:08:26Z", "2026-11-05T20:00:00Z", null],
    ["invalid", "2026-11-05T20:08:26Z", null],
    ["2026-11-05T20:00:00Z", "2026-11-05T20:00:00Z", 0],
  ] as const)("validates browser timestamps %s to %s", (startedAt, completedAt, expected) => {
    const result = loadBrowserEvidence("owner/repo", 77, (args) => {
      if (args.includes("--json")) return JSON.stringify({
        databaseId: 77, attempt: 1, event: "pull_request", headSha: SHA_PR, status: "completed", conclusion: "success",
        jobs: [{ databaseId: 88, name: "playwright e2e", conclusion: "success", startedAt, completedAt }],
      });
      if (args.includes("--log")) return `[command]git log -1 --format=%H\n${SHA_PR}\n${PIPELINE_LOG}`;
      return JSON.stringify({ sha: SHA_PR, commit: { tree: { sha: TREE } } });
    });
    expect(result.wallSeconds).toBe(expected);
    expect(classifyPair(result, evidence({ event: "push" })).classification).toBe(expected === null ? "unknown" : "candidate");
  });

  test("does not mistake RPC text containing failed for a failing Playwright summary", () => {
    const result = parseBrowserLog({ runId: 3, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log: PIPELINE_LOG.replace("148 passed (8.0m)", "RPC_ERROR failed in app log") });
    expect(result.passed).toBeNull();
    expect(result.evidenceErrors).toContain("Playwright summary missing");
  });

  test("ambiguous summaries, malformed SHA and missing runtime stay unknown", () => {
    const log = PIPELINE_LOG.replace("148 passed (8.0m)", "148 passed (8.0m)\n148 passed (8.0m)").replace("20261101.186.1", "bad-image");
    const result = parseBrowserLog({ runId: 4, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log: `[command]git log -1 --format=%H\nnot-a-sha\n${log}` });
    expect(result.checkoutSha).toBeNull();
    expect(result.passed).toBeNull();
    expect(result.runtime).toEqual(["image=ubuntu-26.04", "bun=1.4.3+c6da4a4d3"]);
    expect(result.evidenceErrors).toContain("runtime signals incomplete");
    expect(classifyPair(result, evidence()).classification).toBe("unknown");
  });

  test("matching counts are only a candidate, never certified reuse", () => {
    const result = classifyPair(evidence(), evidence({ runId: 2, event: "push", checkoutSha: SHA_PUSH }));
    expect(result.classification).toBe("candidate");
    expect(result.reasons).toContain("test counts match; inventory identity is not established");
    expect(result.noSafeReuseCertified).toBe(true);
    expect(result.wholeWorkflowDurationReported).toBe(false);
  });

  test("different actual browser checkout trees are a mismatch even when counts match", () => {
    const result = classifyPair(evidence(), evidence({ event: "push", checkoutSha: SHA_PUSH, checkoutTree: "96f88fa0b0279d3f9bd208452717033eed1dacb3" }));
    expect(result.classification).toBe("mismatch");
    expect(result.reasons).toContain("browser checkout trees differ");
  });

  test("failed or cancelled browser jobs and attempt mismatch cannot be candidates", () => {
    expect(classifyPair(evidence({ jobConclusion: "failure" }), evidence({ event: "push" })).classification).toBe("unknown");
    expect(classifyPair(evidence({ jobConclusion: "cancelled" }), evidence({ event: "push" })).classification).toBe("unknown");
    expect(classifyPair(evidence(), evidence({ event: "push", attempt: 2 })).classification).toBe("unknown");
    expect(classifyPair(evidence(), evidence({ event: "pull_request" })).classification).toBe("unknown");
  });

  test("GitHub metadata, job log, attempt and checkout tree are tied to requested IDs", () => {
    const calls: string[][] = [];
    const request = (args: string[]) => {
      calls.push(args);
      if (args[0] === "run" && args.includes("--json")) return JSON.stringify({
        databaseId: 77, attempt: 2, event: "pull_request", headSha: SHA_PR, status: "completed", conclusion: "success",
        jobs: [{ databaseId: 88, name: "playwright e2e", conclusion: "success", startedAt: "2026-11-05T20:00:00Z", completedAt: "2026-11-05T20:08:26Z" }],
      });
      if (args[0] === "run" && args.includes("--log")) return `[command]git log -1 --format=%H\n${SHA_PR}\n${PIPELINE_LOG}`;
      if (args[0] === "api") return JSON.stringify({ sha: SHA_PR, commit: { tree: { sha: TREE } } });
      throw new Error("unexpected request");
    };
    const result = loadBrowserEvidence("owner/repo", 77, request);
    expect(result.checkoutSha).toBe(SHA_PR);
    expect(result.checkoutTree).toBe(TREE);
    expect(result.attempt).toBe(2);
    expect(result.event).toBe("pull_request");
    expect(calls[1]).toContain("2");
    expect(calls[2]).toEqual(["api", `repos/owner/repo/commits/${SHA_PR}`]);
  });

  test("GitHub API errors and timeouts return unknown evidence", () => {
    const result = loadBrowserEvidence("owner/repo", 99, () => { throw new Error("timeout"); });
    expect(result.evidenceErrors).toEqual(["GitHub lookup failed or timed out"]);
    expect(classifyPair(result, evidence({ event: "push" })).classification).toBe("unknown");
  });

  test("missing logs or duration lookup errors remain unclassified", () => {
    const unavailable = evidence({ checkoutSha: null, checkoutTree: null, scope: "unknown", passed: null, wallSeconds: null, runtime: [], evidenceErrors: ["GitHub lookup failed or timed out"] });
    expect(classifyPair(unavailable, evidence({ event: "push" })).classification).toBe("unknown");
  });

  test("oversized log input is non-certifying", () => {
    const result = parseBrowserLog({ runId: 6, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log: `${PIPELINE_LOG}${"x".repeat(8 * 1024 * 1024)}` });
    expect(result.evidenceErrors).toContain("browser job log exceeded the 8 MiB parser limit");
    expect(classifyPair(result, evidence()).classification).toBe("unknown");
  });

  test("malformed CLI input is separate from unknown evidence", () => {
    expect(() => parseArgs(["--repo", "AmaraNecib/dockan", "--pair", "42101309032"])).toThrow("malformed CLI");
  });

  test("untrusted log commands remain inert text", () => {
    const marker = `/tmp/browser-analyzer-must-not-run-${Date.now()}`;
    const result = parseBrowserLog({ runId: 5, attempt: 1, jobName: "playwright e2e", jobConclusion: "success", log: `[command]git log -1 --format=%H\n${SHA_PR}\n${PIPELINE_LOG}\n$(touch ${marker})` });
    expect(result.passed).toBe(148);
    expect(result.evidenceErrors).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});
