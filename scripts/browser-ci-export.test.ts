import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExportRecord, mergeArchive, writeArchiveSafely, type ExportRecord } from "./browser-ci-export";

const tmp: string[] = [];
afterEach(() => { for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dir(): string { const value = mkdtempSync(path.join(os.tmpdir(), "browser-ci-export-")); tmp.push(value); return value; }
const manifest = (overrides: { complete?: boolean; phase?: string; provenance?: object; inventory?: { id: string; file: string; project: string; titlePath: string[]; repeatEachIndex: number }[]; outcomes?: { id: string; repeatEachIndex: number; attempts: { retry: number; status: string }[] }[] } = {}) => ({
  schemaVersion: 1, phase: "finalized", complete: true, noSafeReuseCertified: true,
  provenance: { runId: 12, attempt: 2, event: "pull_request", repository: "owner/repo", checkoutSha: "a".repeat(40), checkoutTree: "b".repeat(40), workflowSha256: "c".repeat(64), playwrightConfigSha256: "d".repeat(64), lockSha256: "e".repeat(64), browserIdentity: { ACTUAL_VERSION: "unknown" } },
  inventory: [{ id: "test-id-secret", file: "tests/e2e/a.spec.ts", project: "chromium", titlePath: ["root", "case"], repeatEachIndex: 0 }],
  outcomes: [{ id: "test-id-secret", repeatEachIndex: 0, attempts: [{ retry: 0, status: "passed" }] }], ...overrides,
});
function record(value = manifest(), digest = "f".repeat(64), scope: "full" | "selected" | "unknown" = "full"): ExportRecord {
  return createExportRecord({ repository: "owner/repo", runId: 12, attempt: 2, jobId: 99, event: "pull_request", workflowHeadSha: "a".repeat(40), jobConclusion: "success", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:03Z", scope, selectedFiles: scope === "selected" ? ["tests/e2e/a.spec.ts"] : [], manifest: value, artifactDigest: digest, exportedAt: "2026-01-02T00:00:00Z" });
}

describe("browser CI durable export", () => {
  test("binds the manifest to repository, run and attempt; mismatch is unavailable", () => {
    expect(() => record(manifest({ provenance: { ...manifest().provenance, attempt: 1 } }))).toThrow(/attempt/i);
    expect(() => record(manifest({ provenance: { ...manifest().provenance, repository: "other/repo" } }))).toThrow(/repository/i);
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
