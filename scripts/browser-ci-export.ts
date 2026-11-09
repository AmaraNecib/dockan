import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 256 * 1024;
const TestStatus = z.enum(["passed", "failed", "timedOut", "skipped", "interrupted"]);
const ManifestSchema = z.object({
  schemaVersion: z.literal(1), phase: z.string().max(40), complete: z.boolean(), noSafeReuseCertified: z.literal(true),
  provenance: z.object({ runId: z.union([z.number(), z.string()]), attempt: z.union([z.number(), z.string()]), event: z.string().max(40), repository: z.string().max(200), checkoutSha: z.string().max(80), checkoutTree: z.string().max(80), workflowSha256: z.string().max(80), playwrightConfigSha256: z.string().max(80), lockSha256: z.string().max(80), browserIdentity: z.record(z.string(), z.unknown()).optional() }).passthrough(),
  inventory: z.array(z.object({ id: z.string().max(256), file: z.string().max(300), project: z.string().max(200), titlePath: z.array(z.string().max(300)).max(40), repeatEachIndex: z.number().int().nonnegative() }).passthrough()).max(20000),
  diagnostics: z.array(z.string().max(1000)).max(20000),
  outcomes: z.array(z.object({ id: z.string().max(256), repeatEachIndex: z.number().int().nonnegative(), finalStatus: z.union([TestStatus, z.literal("unknown")]), expectedStatus: z.union([TestStatus, z.literal("unknown")]), unexpected: z.union([z.boolean(), z.literal("unknown")]), attempts: z.array(z.object({ retry: z.number().int().nonnegative(), status: TestStatus, expectedStatus: TestStatus }).passthrough()).max(100) }).passthrough()).max(20000),
}).passthrough();
export type ExportRecord = {
  schemaVersion: 1; repository: string; runId: number; attempt: number; browserJobId: number; event: string;
  workflowHeadSha: string | null; checkoutSha: string | null; checkoutTree: string | null; jobConclusion: string | null;
  jobStartedAt: string | null; jobCompletedAt: string | null; jobDurationSeconds: number | null;
  scope: "full" | "selected" | "unknown"; selectedFiles: string[]; evidence: "complete" | "unavailable";
  complete: boolean; phase: string; inventoryCount: number | null; outcomeCount: number | null;
  passed: number | null; failed: number | null; skipped: number | null; unexpected: number | null;
  retryCount: number | null; tests: { identity: string; status: string[] }[];
  workflowSha256: string | null; configSha256: string | null; lockSha256: string | null; browserIdentity: "unknown";
  artifactDigest: string; exportedAt: string;
};
type CreateInput = { repository: string; runId: number; attempt: number; jobId: number; event: string; workflowHeadSha: string; jobConclusion: string | null; startedAt: string; completedAt: string; scope: "full" | "selected" | "unknown"; selectedFiles: string[]; manifest: unknown; artifactDigest: string; exportedAt: string };
function safeRepo(value: string): boolean { return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(value); }
function safeFile(value: string): boolean { return value.length > 0 && value.length <= 300 && !value.includes("\\") && !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "."); }
// eslint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- GitHub metadata is untrusted JSON and must be narrowed before storing.
function sha(value: unknown): string | null { return typeof value === "string" && SHA.test(value) ? value.toLowerCase() : null; }
// eslint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- GitHub metadata is untrusted JSON and must be narrowed before storing.
function digest(value: unknown): string | null { return typeof value === "string" && DIGEST.test(value) ? value.toLowerCase() : null; }
function stableIdentity(item: { file: string; project: string; titlePath: string[]; repeatEachIndex: number }): string {
  return createHash("sha256").update(JSON.stringify([item.file, item.project, item.titlePath, item.repeatEachIndex])).digest("hex");
}
export function createExportRecord(input: CreateInput): ExportRecord {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- Accept serialized fixture input as well as the parsed CLI payload.
  const rawBytes = typeof input.manifest === "string" ? Buffer.byteLength(input.manifest) : Buffer.byteLength(JSON.stringify(input.manifest));
  if (rawBytes > MAX_BYTES) throw new Error("manifest exceeds 256 KiB size limit");
  if (!safeRepo(input.repository) || !Number.isSafeInteger(input.runId) || input.runId < 1 || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || !Number.isSafeInteger(input.jobId) || input.jobId < 1) throw new Error("invalid repository, run, attempt or browser job identity");
  if (!digest(input.artifactDigest)) throw new Error("invalid artifact digest");
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- Parse serialized input at this public validation seam.
  const parsed = ManifestSchema.safeParse(typeof input.manifest === "string" ? JSON.parse(input.manifest) : input.manifest);
  if (!parsed.success) throw new Error("manifest schema is malformed");
  const manifest = parsed.data;
  if (String(manifest.provenance.runId) !== String(input.runId)) throw new Error("manifest run ID mismatch");
  if (String(manifest.provenance.attempt) !== String(input.attempt)) throw new Error("manifest attempt mismatch");
  if (manifest.provenance.repository.toLowerCase() !== input.repository.toLowerCase()) throw new Error("manifest repository mismatch");
  const inventory = manifest.inventory;
  if (inventory.some((item) => !safeFile(item.file))) throw new Error("manifest contains unsafe or invalid file path");
  if (input.scope === "selected" && (input.selectedFiles.length === 0 || input.selectedFiles.some((file) => !safeFile(file)))) throw new Error("selected scope requires a safe file set");
  const identities = inventory.map((item) => JSON.stringify([item.id, item.repeatEachIndex]));
  const complete = manifest.complete && manifest.phase === "finalized" && manifest.diagnostics.length === 0 && new Set(identities).size === inventory.length && inventory.length === manifest.outcomes.length && manifest.outcomes.every((item) => {
    const last = item.attempts.at(-1);
    return last !== undefined && item.attempts.every((attempt, index) => attempt.retry === index && attempt.status !== "interrupted") && item.finalStatus === last.status && item.expectedStatus === last.expectedStatus && item.unexpected === (last.status !== last.expectedStatus);
  });
  const counts = complete ? { passed: 0, failed: 0, skipped: 0, unexpected: 0, retries: 0 } : null;
  const outcomeTests = manifest.outcomes.map((item, index) => {
    const inv = inventory[index];
    if (!inv || item.id !== inv.id || item.repeatEachIndex !== inv.repeatEachIndex) throw new Error("manifest outcome does not match inventory identity");
    const file = inv.file; const project = inv.project; const titlePath = inv.titlePath;
    if (!file || project === undefined || !titlePath || !safeFile(file)) throw new Error("manifest outcome identity is incomplete or unsafe");
    const identity = stableIdentity({ file, project, titlePath, repeatEachIndex: item.repeatEachIndex });
    const statuses = item.attempts.map((attempt) => attempt.status);
    if (counts) {
      const last = statuses.at(-1);
      if (last === "passed") counts.passed++;
      else if (last === "failed" || last === "timedOut") counts.failed++;
      else if (last === "skipped") counts.skipped++;
      if (item.unexpected === true) counts.unexpected++;
      counts.retries += Math.max(0, statuses.length - 1);
    }
    return { identity, status: statuses };
  });
  const startMs = Date.parse(input.startedAt); const endMs = Date.parse(input.completedAt);
  const duration = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? (endMs - startMs) / 1000 : null;
  const p = manifest.provenance;
  return {
    schemaVersion: 1, repository: input.repository.toLowerCase(), runId: input.runId, attempt: input.attempt, browserJobId: input.jobId, event: input.event,
    workflowHeadSha: sha(input.workflowHeadSha), checkoutSha: sha(p.checkoutSha), checkoutTree: sha(p.checkoutTree), jobConclusion: input.jobConclusion,
    jobStartedAt: Number.isFinite(startMs) ? input.startedAt : null, jobCompletedAt: Number.isFinite(endMs) ? input.completedAt : null, jobDurationSeconds: duration,
    scope: input.scope, selectedFiles: input.scope === "selected" ? [...new Set(input.selectedFiles)].sort() : [], evidence: complete ? "complete" : "unavailable",
    complete, phase: manifest.phase, inventoryCount: complete ? inventory.length : null, outcomeCount: complete ? manifest.outcomes.length : null,
    passed: counts?.passed ?? null, failed: counts?.failed ?? null, skipped: counts?.skipped ?? null, unexpected: counts?.unexpected ?? null,
    retryCount: counts?.retries ?? null, tests: complete ? outcomeTests : [],
    workflowSha256: digest(p.workflowSha256), configSha256: digest(p.playwrightConfigSha256), lockSha256: digest(p.lockSha256), browserIdentity: "unknown",
    artifactDigest: input.artifactDigest.toLowerCase(), exportedAt: input.exportedAt,
  };
}
function key(row: ExportRecord): string { return JSON.stringify([row.repository.toLowerCase(), row.runId, row.attempt, row.browserJobId]); }
export function mergeArchive(existing: ExportRecord[], incoming: ExportRecord[]): ExportRecord[] {
  const rows = new Map(existing.map((row) => [key(row), row]));
  for (const row of incoming) {
    const old = rows.get(key(row));
    if (old && old.artifactDigest !== row.artifactDigest) throw new Error(`artifact digest conflict for ${key(row)}`);
    if (!old) rows.set(key(row), row);
  }
  return [...rows.values()].map((row) => ({ ...row, repository: row.repository.toLowerCase() })).sort((a, b) => key(a).localeCompare(key(b)));
}
function assertSafePath(file: string): void {
  const absolute = path.resolve(file); const parsed = path.parse(absolute); const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("archive destination contains a symlink");
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error("archive parent is not a directory");
  }
}
export function writeArchiveSafely(file: string, rows: ExportRecord[], hooks: { beforeRename?: () => void } = {}): void {
  const destination = path.resolve(file); assertSafePath(destination); mkdirSync(path.dirname(destination), { recursive: true }); assertSafePath(destination);
  const lock = `${destination}.lock`; const tmp = `${destination}.${process.pid}.tmp`;
  let lockFd: number | undefined; let tmpFd: number | undefined;
  try {
    lockFd = openSync(lock, "wx", 0o600);
    assertSafePath(destination);
    if (existsSync(tmp)) throw new Error("archive temporary file already exists");
    const old = existsSync(destination) ? readFileSync(destination, "utf8") : "";
    // SAFETY: every persisted line is produced by this module's ExportRecord serializer.
    const existing = old.trim() ? old.trimEnd().split(/\r?\n/u).map((line) => JSON.parse(line) as ExportRecord) : [];
    const merged = mergeArchive(existing, rows);
    const bytes = Buffer.from(merged.map((row) => JSON.stringify(row)).join("\n") + (merged.length ? "\n" : ""), "utf8");
    if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("archive exceeds 32 MiB size limit");
    tmpFd = openSync(tmp, "wx", 0o600); writeFileSync(tmpFd, bytes); closeSync(tmpFd); tmpFd = undefined;
    hooks.beforeRename?.(); assertSafePath(destination); renameSync(tmp, destination);
  } finally {
    if (tmpFd !== undefined) closeSync(tmpFd);
    if (existsSync(tmp)) unlinkSync(tmp);
    if (lockFd !== undefined) { closeSync(lockFd); unlinkSync(lock); }
  }
}

type GithubStage = "run_metadata" | "artifact_download";
type GithubProcessResult = Pick<SpawnSyncReturns<string>, "error" | "status" | "signal" | "stdout" | "stderr">;
type GithubCommandDependencies = {
  spawn?: (command: string, args: string[], options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean }) => GithubProcessResult;
  now?: () => number;
  writeDiagnostic?: (line: string) => void;
};
const PROCESS_ERROR_CODES = new Set(["ETIMEDOUT", "ENOENT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);
const SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGKILL", "SIGABRT"]);
function getProcessErrorCode(result: GithubProcessResult): string | undefined {
  // SAFETY: spawnSync exposes OS process failures as ErrnoException; callers only serialize allowlisted codes.
  return (result.error as NodeJS.ErrnoException | null)?.code;
}
function githubFailureCategory(result: GithubProcessResult): string {
  const processErrorCode = getProcessErrorCode(result);
  const statuses = [...(result.stderr ?? "").matchAll(/(?:^|\b)HTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/gu)].map((match) => match[1]);
  const transports = [...(result.stderr ?? "").matchAll(/\b(ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b/gu)].map((match) => match[1]);
  // Accept one complete gh status-error line, not HTTP codes quoted in unrelated output.
  const statusError = /^gh: [^\r\n]+ \(HTTP (401|403|404|429|5\d\d)\)$/u.exec((result.stderr ?? "").trim())?.[1];
  const transportError = /^(?:connect|read|write) (ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)$/u.test((result.stderr ?? "").trim());
  if (processErrorCode === "ETIMEDOUT" && statuses.length === 0 && transports.length === 0) return "timeout";
  if (processErrorCode === "ENOENT" && statuses.length === 0 && transports.length === 0) return "missing_tool";
  if (["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(processErrorCode ?? "") && statuses.length === 0) return "network";
  if (processErrorCode === undefined && statuses.length === 1 && transports.length === 0 && statusError) {
    const status = statusError;
    if (status === "401" || status === "403") return "access_denied";
    if (status === "404") return "not_found";
    if (status === "429") return "rate_limited";
    return "server_error";
  }
  if (processErrorCode === undefined && statuses.length === 0 && transports.length === 1 && transportError) return "network";
  return "unknown";
}
export function runGithubCommand(stage: GithubStage, args: string[], dependencies: GithubCommandDependencies = {}): string {
  const run = dependencies.spawn ?? ((command, commandArgs, options) => spawnSync(command, commandArgs, options));
  const now = dependencies.now ?? (() => performance.now());
  const writeDiagnostic = dependencies.writeDiagnostic ?? ((line) => console.error(line));
  const start = now();
  const result = run("gh", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const elapsed = now() - start;
  if (result.error || result.status !== 0) {
    const errorCode = getProcessErrorCode(result);
    const diagnostic = {
      schemaVersion: 1,
      stage,
      elapsedMs: Number.isFinite(elapsed) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(elapsed))) : 0,
      exitCode: Number.isSafeInteger(result.status) ? result.status : null,
      processErrorCode: errorCode && PROCESS_ERROR_CODES.has(errorCode) ? errorCode : null,
      signal: result.signal && SIGNALS.has(result.signal) ? result.signal : null,
      category: githubFailureCategory(result),
    };
    writeDiagnostic(`BROWSER_CI_DIAGNOSTIC ${JSON.stringify(diagnostic)}`);
    throw new Error("GitHub read failed or timed out; no archive was changed");
  }
  return result.stdout ?? "";
}
export function readRunAttempt(repo: string, runId: number, attempt?: number, read?: (args: string[]) => string, dependencies: GithubCommandDependencies = {}) {
  if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) throw new Error("attempt must be a positive integer");
  const args = ["run", "view", String(runId), "--repo", repo, ...(attempt === undefined ? [] : ["--attempt", String(attempt)]), "--json", "databaseId,attempt,event,headSha,status,conclusion,jobs"];
  const readOutput = read ?? ((commandArgs: string[]) => runGithubCommand("run_metadata", commandArgs, dependencies));
  const info = z.object({ databaseId: z.number().int(), attempt: z.number().int().positive(), event: z.string(), headSha: z.string(), status: z.string(), conclusion: z.string().nullable(), jobs: z.array(z.object({ databaseId: z.number().int(), name: z.string(), conclusion: z.string().nullable(), startedAt: z.string(), completedAt: z.string() })) }).parse(JSON.parse(readOutput(args)));
  if (info.databaseId !== runId) throw new Error("run metadata did not match requested run");
  if (attempt !== undefined && info.attempt !== attempt) throw new Error("run metadata did not match requested attempt");
  return info;
}
export function exportRun(repo: string, runId: number, archive: string, scope: "full" | "selected" | "unknown", selectedFiles: string[], attempt?: number, dependencies: GithubCommandDependencies = {}): void {
  const info = readRunAttempt(repo, runId, attempt, undefined, dependencies);
  const jobs = info.jobs.filter((job) => /^playwright e2e$/iu.test(job.name));
  if (jobs.length !== 1) throw new Error("browser job missing or ambiguous; no archive was changed");
  const job = jobs[0]; if (!job) throw new Error("browser job missing; no archive was changed"); const artifact = `playwright-e2e-manifest-${runId}-${info.attempt}`;
  const directory = path.join(os.tmpdir(), `browser-ci-export-${process.pid}-${Date.now()}`); mkdirSync(directory, { mode: 0o700 });
  try {
    runGithubCommand("artifact_download", ["run", "download", String(runId), "--repo", repo, "--name", artifact, "--dir", directory], dependencies);
    const entries = readdirSync(directory);
    const manifestPath = path.join(directory, "manifest.json");
    if (entries.length !== 1 || entries[0] !== "manifest.json" || !existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink() || !statSync(manifestPath).isFile()) throw new Error("unique manifest artifact missing or unsafe; no archive was changed");
    if (statSync(manifestPath).size > MAX_BYTES) throw new Error("manifest exceeds 256 KiB; no archive was changed");
    const bytes = readFileSync(manifestPath); if (bytes.byteLength > MAX_BYTES) throw new Error("manifest exceeds 256 KiB; no archive was changed");
    const row = createExportRecord({ repository: repo, runId, attempt: info.attempt, jobId: job.databaseId, event: info.event, workflowHeadSha: info.headSha, jobConclusion: job.conclusion, startedAt: job.startedAt, completedAt: job.completedAt, scope, selectedFiles, manifest: bytes.toString("utf8"), artifactDigest: createHash("sha256").update(bytes).digest("hex"), exportedAt: new Date().toISOString() });
    // eslint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Existing JSONL rows were written by this module; zod validation is applied to the incoming manifest.
    const old = existsSync(archive) ? readFileSync(archive, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as ExportRecord) : [];
    writeArchiveSafely(archive, [...old, row]);
    console.log(`Exported ${repo} run ${runId} attempt ${info.attempt}; evidence=${row.evidence}; scope=${row.scope}; job duration=${row.jobDurationSeconds ?? "unknown"} seconds.`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) { console.log("Usage: bun scripts/browser-ci-export.ts --repo owner/name --archive /explicit/path.jsonl --scope full|selected|unknown [--selected-file PATH ...] --run ID [--run ID ...] [--attempt NUMBER]\nManual export only. Missed exports are unrecoverable after five-day artifact expiry. No automatic coverage claim."); return; }
  let repo = ""; let archive = ""; let scope: "full" | "selected" | "unknown" = "unknown"; let attempt: number | undefined; const selectedFiles: string[] = []; const runs: number[] = [];
  for (let i = 0; i < argv.length; i++) { const option = argv[i]; const value = argv[++i]; if (!value) throw new Error("missing option value"); if (option === "--repo") repo = value; else if (option === "--archive") archive = value; else if (option === "--run") runs.push(Number(value)); else if (option === "--attempt") { if (attempt !== undefined) throw new Error("provide --attempt only once"); attempt = Number(value); if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer"); } else if (option === "--scope") { const parsedScope = z.enum(["full", "selected", "unknown"]).safeParse(value); if (!parsedScope.success) throw new Error("scope must be full, selected or unknown"); scope = parsedScope.data; } else if (option === "--selected-file") selectedFiles.push(value); else throw new Error(`unknown option or invalid value ${option}`); }
  if (!safeRepo(repo) || !path.isAbsolute(archive) || !runs.length || runs.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("provide --repo owner/name, an explicit absolute --archive path and positive --run IDs");
  const requestedScope = z.enum(["full", "selected", "unknown"]).parse(scope);
  if ((requestedScope === "selected") !== (selectedFiles.length > 0) || (requestedScope !== "selected" && selectedFiles.length)) throw new Error("selected scope requires one or more --selected-file values; other scopes forbid them");
  for (const run of runs) exportRun(repo, run, archive, requestedScope, selectedFiles, attempt);
}
if (import.meta.main) { try { main(); } catch (error) { console.error(String(error)); process.exitCode = 1; } }
