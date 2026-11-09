import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExportRecord, exportRun, mergeArchive, readRunAttempt, runGithubCommand, writeArchiveSafely, type ExportRecord } from "./browser-ci-export";

const tmp: string[] = [];
afterEach(() => { for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dir(): string { const value = mkdtempSync(path.join(os.tmpdir(), "browser-ci-export-")); tmp.push(value); return value; }
const manifest = (overrides: { complete?: boolean; phase?: string; provenance?: object; inventory?: { id: string; file: string; project: string; titlePath: string[]; repeatEachIndex: number }[]; outcomes?: unknown[]; diagnostics?: string[] } = {}) => ({
  schemaVersion: 1, phase: "finalized", complete: true, noSafeReuseCertified: true, diagnostics: [],
  provenance: { runId: 12, attempt: 2, event: "pull_request", repository: "owner/repo", checkoutSha: "a".repeat(40), checkoutTree: "b".repeat(40), workflowSha256: "c".repeat(64), playwrightConfigSha256: "d".repeat(64), lockSha256: "e".repeat(64), browserIdentity: { ACTUAL_VERSION: "unknown" } },
  inventory: [{ id: "test-id-secret", file: "tests/e2e/a.spec.ts", project: "chromium", titlePath: ["root", "case"], repeatEachIndex: 0 }],
  outcomes: [{ id: "test-id-secret", repeatEachIndex: 0, finalStatus: "passed", expectedStatus: "passed", unexpected: false, attempts: [{ retry: 0, status: "passed", expectedStatus: "passed" }] }], ...overrides,
});
function record(value = manifest(), digest = "f".repeat(64), scope: "full" | "selected" | "unknown" = "full"): ExportRecord {
  return createExportRecord({ repository: "owner/repo", runId: 12, attempt: 2, jobId: 99, event: "pull_request", workflowHeadSha: "a".repeat(40), jobConclusion: "success", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:03Z", scope, selectedFiles: scope === "selected" ? ["tests/e2e/a.spec.ts"] : [], manifest: value, artifactDigest: digest, exportedAt: "2026-01-02T00:00:00Z" });
}

describe("browser CI subprocess diagnostics", () => {
  test("emits an allowlisted diagnostic for subprocess failures and keeps the generic error", () => {
    const stderr: string[] = [];
    expect(() => runGithubCommand("artifact_download", ["download", "SECRET_ARG"], {
      spawn: () => ({ error: Object.assign(new Error("TOKEN_SENTINEL"), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM", stdout: "STDOUT_SENTINEL", stderr: "STDERR_SENTINEL" }),
      now: (() => { let value = 10; return () => (value += 20); })(),
      writeDiagnostic: (line) => stderr.push(line),
    })).toThrow("GitHub read failed or timed out; no archive was changed");
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toBe('BROWSER_CI_DIAGNOSTIC {"schemaVersion":1,"stage":"artifact_download","elapsedMs":20,"exitCode":null,"processErrorCode":"ETIMEDOUT","signal":"SIGTERM","category":"timeout"}');
    expect(stderr.join(" ")).not.toMatch(/SENTINEL|SECRET_ARG|TOKEN/u);
  });
  test("classifies only explicit supported failure signatures", () => {
    const cases = [
      [{ error: Object.assign(new Error(), { code: "ENOENT" }), status: null, signal: null, stdout: "", stderr: "" }, "missing_tool", "ENOENT"],
      [{ error: Object.assign(new Error(), { code: "ETIMEDOUT" }), status: null, signal: null, stdout: "", stderr: "HTTP 403" }, "unknown", "ETIMEDOUT"],
      [{ error: undefined, status: 1, signal: null, stdout: "", stderr: "gh: Requires authentication (HTTP 401)" }, "access_denied", null],
      [{ error: undefined, status: 1, signal: null, stdout: "", stderr: "gh: Forbidden (HTTP 403)" }, "access_denied", null],
      [{ error: undefined, status: 1, signal: null, stdout: "", stderr: "HTTP 403 followed by HTTP 503" }, "unknown", null],
      [{ error: undefined, status: 1, signal: null, stdout: "", stderr: "HTTP 403 ECONNRESET" }, "unknown", null],
      [{ error: undefined, status: 1, signal: null, stdout: "", stderr: "gh: Not Found (HTTP 404)" }, "not_found", null],
      [{ error: undefined, status: 1, signal: null, stdout: "", stderr: "gh: Too Many Requests (HTTP 429)" }, "rate_limited", null],
      [{ error: undefined, status: 1, signal: null, stdout: "", stderr: "gh: Service Unavailable (HTTP 503)" }, "server_error", null],
      [{ error: undefined, status: 1, signal: null, stdout: "", stderr: "connect ECONNRESET" }, "network", null],
      [{ error: undefined, status: 7, signal: null, stdout: "", stderr: "permission denied" }, "unknown", null],
      [{ error: undefined, status: null, signal: "SIGINT", stdout: "", stderr: "" }, "unknown", null],
    ] as const;
    for (const [processResult, category, processErrorCode] of cases) {
      const lines: string[] = [];
      expect(() => runGithubCommand("run_metadata", [], { spawn: () => processResult, now: () => 0, writeDiagnostic: (line) => lines.push(line) })).toThrow("GitHub read failed or timed out; no archive was changed");
      const parsed = JSON.parse((lines[0] ?? "").replace("BROWSER_CI_DIAGNOSTIC ", ""));
      expect(parsed).toMatchObject({ stage: "run_metadata", category, processErrorCode });
      expect(parsed.signal).toBe(processResult.signal);
      expect(parsed.exitCode).toBe(processResult.status);
    }
  });
  test("ignores incidental HTTP and transport mentions outside supported error forms", () => {
    for (const stderr of [
      "see HTTP 403 in the request log", "HTTP 403", "quoted HTTP 401", "quoted HTTP 404",
      "quoted HTTP 429", "quoted HTTP 503", "see ECONNRESET in the request log",
      "context\ngh: Forbidden (HTTP 403)", "gh: previous HTTP 503 (HTTP 403)",
    ]) {
      const lines: string[] = [];
      expect(() => runGithubCommand("run_metadata", [], {
        spawn: () => ({ error: undefined, status: 1, signal: null, stdout: "", stderr }),
        now: () => 0,
        writeDiagnostic: (line) => lines.push(line),
      })).toThrow("GitHub read failed or timed out; no archive was changed");
      expect(JSON.parse((lines[0] ?? "").replace("BROWSER_CI_DIAGNOSTIC ", ""))).toMatchObject({ category: "unknown" });
    }
  });
  test("the default metadata reader labels run_metadata without invoking gh", () => {
    const lines: string[] = [];
    expect(() => readRunAttempt("owner/repo", 12, undefined, undefined, {
      spawn: () => ({ error: undefined, status: 1, signal: null, stdout: "", stderr: "ambiguous" }),
      now: () => 5,
      writeDiagnostic: (line) => lines.push(line),
    })).toThrow("GitHub read failed or timed out; no archive was changed");
    expect(JSON.parse((lines[0] ?? "").replace("BROWSER_CI_DIAGNOSTIC ", ""))).toMatchObject({ stage: "run_metadata", category: "unknown" });
  });
  test("artifact failure keeps the archive untouched and removes its owned temp directory", () => {
    const archive = path.join(dir(), "archive.jsonl");
    const lines: string[] = [];
    let downloadDirectory = "";
    const metadata = JSON.stringify({ databaseId: 12, attempt: 2, event: "pull_request", headSha: "a".repeat(40), status: "completed", conclusion: "success", jobs: [{ databaseId: 99, name: "playwright e2e", conclusion: "success", startedAt: "2035-06-01T00:00:00Z", completedAt: "2035-06-01T00:00:03Z" }] });
    expect(() => exportRun("owner/repo", 12, archive, "full", [], undefined, {
      spawn: (_command, args) => {
        if (args[1] === "view") return { error: undefined, status: 0, signal: null, stdout: metadata, stderr: "" };
        downloadDirectory = args[args.indexOf("--dir") + 1] ?? "";
        return { error: undefined, status: 7, signal: null, stdout: "", stderr: "generic failure" };
      },
      now: () => 100,
      writeDiagnostic: (line) => lines.push(line),
    })).toThrow("GitHub read failed or timed out; no archive was changed");
    expect(JSON.parse((lines[0] ?? "").replace("BROWSER_CI_DIAGNOSTIC ", ""))).toMatchObject({ stage: "artifact_download", category: "unknown" });
    expect(existsSync(archive)).toBe(false);
    expect(downloadDirectory).not.toBe("");
    expect(existsSync(downloadDirectory)).toBe(false);
  });
  test("sanitizes unexpected process metadata and bounds elapsed time", () => {
    const lines: string[] = [];
    expect(() => runGithubCommand("run_metadata", [], {
      spawn: () => ({ error: Object.assign(new Error("PRIVATE_ERROR"), { code: "PRIVATE_CODE" }), status: 1, signal: "SIGUSR1" as const, stdout: "PRIVATE_STDOUT", stderr: "PRIVATE_STDERR" }),
      now: (() => { let tick = 0; return () => (tick++ === 0 ? 10 : 50_010); })(),
      writeDiagnostic: (line) => lines.push(line),
    })).toThrow("GitHub read failed or timed out; no archive was changed");
    const serialized = lines.join(" ");
    expect(serialized).not.toMatch(/PRIVATE/u);
    expect(JSON.parse((lines[0] ?? "").replace("BROWSER_CI_DIAGNOSTIC ", ""))).toMatchObject({ elapsedMs: 50_000, processErrorCode: null, signal: null, category: "unknown" });
  });
  test("keeps subprocess limits and generic failure exit behavior", () => {
    let options: { timeout: number; maxBuffer: number } | undefined;
    const lines: string[] = [];
    expect(() => runGithubCommand("run_metadata", [], {
      spawn: (_command, _args, receivedOptions) => { options = receivedOptions; return { error: undefined, status: 1, signal: null, stdout: "", stderr: "generic failure" }; },
      now: () => 0,
      writeDiagnostic: (line) => lines.push(line),
    })).toThrow("GitHub read failed or timed out; no archive was changed");
    expect(options).toMatchObject({ timeout: 20_000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse((lines[0] ?? "").replace("BROWSER_CI_DIAGNOSTIC ", ""))).toMatchObject({ category: "unknown", exitCode: 1 });
  });
  test("success is silent and preserves stdout", () => {
    const lines: string[] = [];
    expect(runGithubCommand("run_metadata", [], { spawn: () => ({ error: undefined, status: 0, signal: null, stdout: "ok", stderr: "" }), now: () => 0, writeDiagnostic: (line) => lines.push(line) })).toBe("ok");
    expect(lines).toEqual([]);
    expect(() => runGithubCommand("run_metadata", [], { spawn: () => ({ error: undefined, status: 1, signal: null, stdout: "", stderr: "generic failure" }), now: () => 0, writeDiagnostic: (line) => lines.push(line) })).toThrow("GitHub read failed or timed out; no archive was changed");
    expect(JSON.parse((lines[0] ?? "").replace("BROWSER_CI_DIAGNOSTIC ", ""))).toMatchObject({ category: "unknown", exitCode: 1 });
  });
});

describe("browser CI durable export", () => {
  test("binds the manifest to repository, run and attempt; mismatch is unavailable", () => {
    expect(() => record(manifest({ provenance: { ...manifest().provenance, attempt: 1 } }))).toThrow(/attempt/i);
    expect(() => record(manifest({ provenance: { ...manifest().provenance, repository: "other/repo" } }))).toThrow(/repository/i);
  });
  test("normalizes repository capitalization for binding and archive identity", () => {
    const canonical = record(manifest({ provenance: { ...manifest().provenance, repository: "OWNER/Repo" } }));
    expect(canonical).toMatchObject({ repository: "owner/repo", complete: true });
    expect(mergeArchive([{ ...canonical, repository: "Owner/REPO" }], [canonical])).toEqual([canonical]);
  });
  test("selects an earlier attempt for metadata and artifact identity", () => {
    const calls: string[][] = [];
    const metadata = { databaseId: 12, attempt: 1, event: "pull_request", headSha: "a".repeat(40), status: "completed", conclusion: "success", jobs: [] };
    const earlier = readRunAttempt("owner/repo", 12, 1, (args) => { calls.push(args); return JSON.stringify(metadata); });
    expect(earlier).toMatchObject({ attempt: 1, databaseId: 12 });
    expect(calls).toEqual([["run", "view", "12", "--repo", "owner/repo", "--attempt", "1", "--json", "databaseId,attempt,event,headSha,status,conclusion,jobs"]]);
    expect(() => readRunAttempt("owner/repo", 12, 2, () => JSON.stringify(metadata))).toThrow(/attempt/u);
    expect(() => readRunAttempt("owner/repo", 12, 0, () => JSON.stringify(metadata))).toThrow(/attempt/u);
  });
  test("keeps incomplete evidence explicit with null measurements", () => {
    const value = record(manifest({ complete: false, phase: "interrupted" }));
    expect(value).toMatchObject({ evidence: "unavailable", complete: false, inventoryCount: null, outcomeCount: null });
  });
  test("hashes stable test identities and excludes titles, actors and environments", () => {
    const value = record();
    expect(value).toMatchObject({ tests: [{ identity: expect.stringMatching(/^[a-f0-9]{64}$/u), status: ["passed"] }] });
    expect(JSON.stringify(value)).not.toMatch(/case|actor|DOKAN_PORT|ACTUAL_VERSION/u);
  });
  test("does not count an expected failure as unexpected", () => {
    const outcomes = [{ id: "test-id-secret", repeatEachIndex: 0, finalStatus: "failed", expectedStatus: "failed", unexpected: false, attempts: [{ retry: 0, status: "failed", expectedStatus: "failed" }] }];
    expect(record(manifest({ outcomes }))).toMatchObject({ complete: true, failed: 1, unexpected: 0 });
  });
  test("rejects malformed statuses and downgrades inconsistent complete evidence", () => {
    const good = { id: "test-id-secret", repeatEachIndex: 0, finalStatus: "passed", expectedStatus: "passed", unexpected: false, attempts: [{ retry: 0, status: "passed", expectedStatus: "passed" }] };
    expect(() => record(manifest({ outcomes: [{ ...good, attempts: [{ retry: 7, status: "bogus", expectedStatus: "passed" }] }] }))).toThrow(/malformed/u);
    for (const value of [
      manifest({ diagnostics: ["result mismatch"] }),
      manifest({ outcomes: [{ ...good, unexpected: true }] }),
      manifest({ outcomes: [{ ...good, finalStatus: "failed" }] }),
      manifest({ outcomes: [{ ...good, attempts: [{ retry: 7, status: "passed", expectedStatus: "passed" }] }] }),
      manifest({ outcomes: [{ ...good, attempts: [{ retry: 0, status: "interrupted", expectedStatus: "passed" }] }] }),
      manifest({ inventory: [...manifest().inventory, ...manifest().inventory], outcomes: [good, good] }),
    ]) expect(record(value)).toMatchObject({ complete: false, evidence: "unavailable", inventoryCount: null, passed: null, unexpected: null, tests: [] });
  });
  test("selected scope remains distinct from full scope", () => {
    expect(record(undefined, undefined, "selected")).toMatchObject({ scope: "selected", selectedFiles: ["tests/e2e/a.spec.ts"] });
    expect(record()).toMatchObject({ scope: "full", selectedFiles: [] });
  });
  test("same key and digest is idempotent; changed digest conflicts and preserves attempts", () => {
    const first = record();
    expect(mergeArchive([first], [record()])).toEqual([first]);
    expect(() => mergeArchive([first], [record(manifest(), "0".repeat(64))])).toThrow(/digest conflict/u);
    const retry = createExportRecord({ repository: "owner/repo", runId: 12, attempt: 3, jobId: 99, event: "pull_request", workflowHeadSha: "a".repeat(40), jobConclusion: "success", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:03Z", scope: "full", selectedFiles: [], manifest: manifest({ provenance: { ...manifest().provenance, attempt: 3 } }), artifactDigest: "0".repeat(64), exportedAt: "2026-01-02T00:00:00Z" });
    expect(mergeArchive([first], [retry])).toHaveLength(2);
  });
  test("rejects hostile manifest files and oversized evidence", () => {
    expect(() => record(manifest({ inventory: [{ id: "test-id-secret", file: "../secret", project: "chromium", titlePath: ["secret"], repeatEachIndex: 0 }] }))).toThrow(/unsafe|invalid/i);
    expect(() => createExportRecord({ repository: "owner/repo", runId: 12, attempt: 2, jobId: 99, event: "pull_request", workflowHeadSha: "a".repeat(40), jobConclusion: "success", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:03Z", scope: "full", selectedFiles: [], manifest: "x".repeat(256 * 1024 + 1), artifactDigest: "f".repeat(64), exportedAt: "2026-01-02T00:00:00Z" })).toThrow(/size/i);
  });
  test("atomic archive failure leaves the existing bytes unchanged; refuses symlink destinations", () => {
    const root = dir(); const file = path.join(root, "archive.jsonl"); writeFileSync(file, `${JSON.stringify(record())}\n`);
    const original = readFileSync(file, "utf8");
    expect(() => writeArchiveSafely(file, [record()], { beforeRename: () => { throw new Error("injected failure"); } })).toThrow("injected failure");
    expect(readFileSync(file, "utf8")).toBe(original);
    const link = path.join(root, "link.jsonl");
    try { require("node:fs").symlinkSync(file, link); } catch { return; }
    expect(() => writeArchiveSafely(link, [record()])).toThrow(/symlink/u);
  });
});
