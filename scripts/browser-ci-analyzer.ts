import { spawnSync } from "node:child_process";
import { z } from "zod";
export type Classification = "candidate" | "mismatch" | "unknown";
export type BrowserEvidence = {
  runId: number;
  attempt: number | null;
  event: string | null;
  jobName: string;
  jobConclusion: string | null;
  checkoutSha: string | null;
  checkoutTree: string | null;
  scope: "full" | "scoped" | "unknown";
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  runtime: string[];
  wallSeconds: number | null;
  evidenceErrors: string[];
};
export type PairResult = {
  classification: Classification;
  reasons: string[];
  noSafeReuseCertified: true;
  pr: BrowserEvidence;
  push: BrowserEvidence;
  browserWallSeconds: { pr: number | null; push: number | null };
  wholeWorkflowDurationReported: false;
};

function normalizeLogLine(line: string): string {
  const withoutJobPrefix = line.replace(/^playwright e2e\tUNKNOWN STEP\t/u, "");
  const withoutTimestamp = withoutJobPrefix.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[^\s]+Z\s*/u, "");
  // eslint-disable-next-line no-control-regex -- GitHub runner logs include terminal color escapes.
  return withoutTimestamp.replace(/\u001b\[[0-9;]*m/gu, "");
}

const SHA = /^[0-9a-f]{40}$/iu;
const MAX_LOG = 8 * 1024 * 1024;
const MAX_RUNS = 20;
const TIMEOUT_MS = 20_000;
const JOB_MATCH = /playwright\s+e2e/iu;

export function parseBrowserLog(input: {
  runId: number;
  attempt: number | null;
  event?: string | null;
  jobName: string;
  jobConclusion: string | null;
  log: string;
  wallSeconds?: number | null;
}): BrowserEvidence {
  const errors: string[] = [];
  if (input.log.length > MAX_LOG) errors.push("browser job log exceeded the 8 MiB parser limit");
  const lines = input.log.slice(0, MAX_LOG).replace(/^\uFEFF/u, "").split(/\r?\n/u).map(normalizeLogLine);
  const gitLogIndexes = lines.flatMap((line, i) => /git log -1 --format=%H/u.test(line) ? [i] : []);
  const shaValues = gitLogIndexes.flatMap((i) => {
    const value = lines.slice(i + 1, i + 3).map((line) => line.trim()).find((line) => SHA.test(line));
    return value ? [value.toLowerCase()] : [];
  });
  const checkoutSha = shaValues.length === 1 ? shaValues[0] ?? null : null;
  if (shaValues.length !== 1) errors.push(shaValues.length ? "ambiguous browser checkout SHA" : "browser checkout SHA missing");

  const summaries = lines.flatMap((line) => {
    const match = line.match(/^\s*(\d+) passed(?:\s*\(([^)]*)\))?(?:,\s*(\d+) failed)?(?:,\s*(\d+) skipped)?/u);
    return match ? [{ passed: Number(match[1]), duration: match[2] ?? null, failed: Number(match[3] ?? 0), skipped: Number(match[4] ?? 0) }] : [];
  });
  const summary = summaries.length === 1 ? summaries[0] : null;
  if (!summary) errors.push(summaries.length ? "ambiguous Playwright summary" : "Playwright summary missing");

  const launch = lines.filter((line) => /^bun run test:e2e\s+\$E2E_SPECS/u.test(line.trim()));
  const envLines = lines.filter((line) => /^\s*E2E_SPECS:\s*/u.test(line));
  const executed = lines.filter((line) => /^\$ playwright test(?:\s|$)/u.test(line.trim()));
  let scope: BrowserEvidence["scope"] = "unknown";
  const envLine = envLines.length === 1 ? envLines[0] ?? "" : null;
  if (launch.length === 1 && executed.length === 1 && envLine !== null) {
    if (/^\s*E2E_SPECS:\s*$/u.test(envLine)) scope = "full";
    else if (/^\s*E2E_SPECS:\s*\S+/u.test(envLine)) scope = "scoped";
  }
  if (scope === "unknown") errors.push("full-suite scope not proven");

  const runtimeValues = lines.flatMap((line) => {
    const image = line.match(/Image:\s*(ubuntu-[^\s]+)/u)?.[1];
    const imageVersion = line.match(/Version:\s*(\d{8}\.\d+\.\d+)/u)?.[1];
    const bun = line.match(/(?:Using a cached version of Bun:|Obtained version)\s*(\d+\.\d+\.\d+(?:\+[^\s]+)?)/u)?.[1];
    const playwright = line.match(/playwright(?:-core)?@([\d.]+)/iu)?.[1];
    return [image && `image=${image}`, imageVersion && `runnerImage=${imageVersion}`, bun && `bun=${bun}`, playwright && `playwright=${playwright}`].filter((value): value is string => Boolean(value));
  });
  const runtime = [...new Set(runtimeValues.filter((value) => !value.startsWith("bun=") || value.slice(4).includes("+") || !runtimeValues.some((candidate) => candidate.startsWith(`bun=${value.slice(4)}+`))))];
  if (!["image=", "runnerImage=", "bun="].every((prefix) => runtime.some((signal) => signal.startsWith(prefix)))) errors.push("runtime signals incomplete");
  const wallSeconds = Number.isFinite(input.wallSeconds) ? input.wallSeconds ?? null : null;
  return {
    runId: input.runId,
    attempt: input.attempt,
    event: input.event ?? null,
    jobName: input.jobName,
    jobConclusion: input.jobConclusion,
    checkoutSha,
    checkoutTree: null,
    scope,
    passed: summary?.passed ?? null,
    failed: summary?.failed ?? null,
    skipped: summary?.skipped ?? null,
    runtime,
    wallSeconds,
    evidenceErrors: errors,
  };
}

export function classifyPair(pr: BrowserEvidence, push: BrowserEvidence): PairResult {
  const reasons: string[] = [];
  const mismatch = (reason: string) => reasons.push(reason);
  const incomplete = (reason: string) => reasons.push(reason);
  for (const [label, item] of [["PR", pr], ["push", push]] as const) {
    if (item.jobConclusion !== "success") incomplete(`${label} browser job did not succeed`);
    if (item.attempt === null) incomplete(`${label} run attempt is unknown`);
    if (item.event !== (label === "PR" ? "pull_request" : "push")) incomplete(`${label} run event does not match the requested pair`);
    if (!item.checkoutSha || !SHA.test(item.checkoutSha)) incomplete(`${label} browser checkout SHA is missing or malformed`);
    if (!item.checkoutTree || !SHA.test(item.checkoutTree)) incomplete(`${label} browser checkout tree is unknown`);
    if (item.scope !== "full") incomplete(`${label} browser scope is not proven full`);
    if (item.passed === null || item.failed === null || item.skipped === null) incomplete(`${label} Playwright counts are incomplete`);
    if (item.wallSeconds === null) incomplete(`${label} browser job duration is unknown`);
    if (!item.runtime.length) incomplete(`${label} runtime signals are missing`);
    for (const error of item.evidenceErrors) incomplete(`${label}: ${error}`);
  }
  if (pr.checkoutTree && push.checkoutTree && pr.checkoutTree !== push.checkoutTree) mismatch("browser checkout trees differ");
  if (pr.scope !== "unknown" && push.scope !== "unknown" && pr.scope !== push.scope) mismatch("browser scope differs");
  if (pr.jobConclusion && push.jobConclusion && pr.jobConclusion !== push.jobConclusion) mismatch("browser job conclusions differ");
  if (pr.passed !== null && push.passed !== null && pr.passed !== push.passed) mismatch("passed test counts differ");
  if (pr.failed !== null && push.failed !== null && pr.failed !== push.failed) mismatch("failed test counts differ");
  if (pr.skipped !== null && push.skipped !== null && pr.skipped !== push.skipped) mismatch("skipped test counts differ");
  if (pr.runtime.length && push.runtime.length && pr.runtime.join("|") !== push.runtime.join("|")) mismatch("observed runtime signals differ");
  if (pr.attempt !== null && push.attempt !== null && pr.attempt !== push.attempt) reasons.push("run attempts are distinct identities");
  if (pr.passed !== null && pr.passed === push.passed) reasons.push("test counts match; inventory identity is not established");
  if (pr.checkoutSha && push.checkoutSha && pr.checkoutSha !== push.checkoutSha) reasons.push("browser checkout SHAs are distinct; tree comparison is the source comparison");
  const mismatchReasons = reasons.filter((reason) => ["browser checkout trees differ", "browser scope differs", "browser job conclusions differ", "passed test counts differ", "failed test counts differ", "skipped test counts differ", "observed runtime signals differ"].includes(reason));
  const unknownReasons = reasons.filter((reason) => /unknown|missing|not proven|did not succeed|incomplete|distinct identities|does not match/iu.test(reason) || reason.startsWith("PR: ") || reason.startsWith("push: "));
  const classification: Classification = unknownReasons.length ? "unknown" : mismatchReasons.length ? "mismatch" : "candidate";
  if (!reasons.length) reasons.push("observed evidence aligns; mutable environment and event/SHA dependence remain unverified");
  return { classification, reasons, noSafeReuseCertified: true, pr, push, browserWallSeconds: { pr: pr.wallSeconds, push: push.wallSeconds }, wholeWorkflowDurationReported: false };
}

type GhRun = { databaseId: number; attempt: number; event: string; headSha: string; status: string; conclusion: string | null; jobs: { databaseId: number; name: string; conclusion: string | null; startedAt: string; completedAt: string }[] };
const RunSchema = z.object({ databaseId: z.number().int(), attempt: z.number().int().positive(), event: z.string(), headSha: z.string(), status: z.string(), conclusion: z.string().nullable(), jobs: z.array(z.object({ databaseId: z.number().int(), name: z.string(), conclusion: z.string().nullable(), startedAt: z.string(), completedAt: z.string() })) });
const CommitSchema = z.object({ sha: z.string(), commit: z.object({ tree: z.object({ sha: z.string() }) }) });
type PairArguments = { repo: string; pairs: [number, number][] };
function gh(args: string[]): string {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_LOG, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("GitHub read failed or timed out");
  return result.stdout;
}
function runInfo(repo: string, id: number, request: (args: string[]) => string): GhRun {
  const raw = RunSchema.parse(JSON.parse(request(["run", "view", String(id), "--repo", repo, "--json", "databaseId,attempt,event,headSha,status,conclusion,jobs"])));
  if (raw.databaseId !== id) throw new Error("run metadata does not match requested run");
  return raw;
}
export function loadBrowserEvidence(repo: string, id: number, request: (args: string[]) => string = gh): BrowserEvidence {
  try {
    const info = runInfo(repo, id, request);
    const jobs = info.jobs.filter((job) => JOB_MATCH.test(job.name));
    const job = jobs.length === 1 ? jobs[0] : undefined;
    if (!job) return emptyEvidence(id, info.attempt, jobs.length ? "ambiguous browser job" : "browser job missing");
    const seconds = job.startedAt && job.completedAt ? Math.max(0, (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000) : null;
    const output = request(["run", "view", String(id), "--repo", repo, "--job", String(job.databaseId), "--attempt", String(info.attempt), "--log"]);
    const evidence = parseBrowserLog({ runId: id, attempt: info.attempt, event: info.event, jobName: job.name, jobConclusion: job.conclusion, log: output, wallSeconds: seconds });
    if (evidence.checkoutSha) {
      try {
        const commit = CommitSchema.safeParse(JSON.parse(request(["api", `repos/${repo}/commits/${evidence.checkoutSha}`])));
        const tree = commit.success && commit.data.sha === evidence.checkoutSha ? commit.data.commit.tree.sha : null;
        evidence.checkoutTree = tree && SHA.test(tree) ? tree.toLowerCase() : null;
        if (!evidence.checkoutTree) evidence.evidenceErrors.push("browser checkout tree lookup failed");
      } catch {
        evidence.evidenceErrors.push("browser checkout tree lookup failed or timed out");
      }
    }
    return evidence;
  } catch {
    return emptyEvidence(id, null, "GitHub lookup failed or timed out");
  }
}
function emptyEvidence(id: number, attempt: number | null, error: string): BrowserEvidence {
  return { runId: id, attempt, event: null, jobName: "unknown", jobConclusion: null, checkoutSha: null, checkoutTree: null, scope: "unknown", passed: null, failed: null, skipped: null, runtime: [], wallSeconds: null, evidenceErrors: [error] };
}

export function parseArgs(argv: string[]): PairArguments {
  let repo = "";
  const pairs: [number, number][] = [];
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    const value = argv[i + 1];
    if ((option === "--repo" || option === "--pair") && value) {
      i++;
      if (option === "--repo") repo = value;
      else {
        const match = value.match(/^(\d+):(\d+)$/u);
        if (!match) throw new Error("malformed CLI: --pair must be PR_RUN:PUSH_RUN");
        pairs.push([Number(match[1]), Number(match[2])]);
      }
    } else throw new Error(`malformed CLI: unexpected or incomplete argument ${option}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo) || pairs.length === 0 || pairs.length > MAX_RUNS || pairs.flat().some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("malformed CLI: provide --repo owner/name and 1 to 20 --pair PR_RUN:PUSH_RUN values");
  }
  return { repo, pairs } satisfies PairArguments;
}

function main(): void {
  if (process.argv.includes("--help")) {
    console.log("Usage: bun scripts/browser-ci-analyzer.ts --repo owner/name --pair PR_RUN:PUSH_RUN [--pair ...]");
    console.log("Read-only. Starts no Actions. Candidate never means safe to reuse or skip.");
    return;
  }
  let parsed: PairArguments;
  try { parsed = parseArgs(process.argv.slice(2)); } catch (error) { console.error(String(error)); process.exitCode = 2; return; }
  const results = parsed.pairs.map(([prId, pushId]) => classifyPair(loadBrowserEvidence(parsed.repo, prId), loadBrowserEvidence(parsed.repo, pushId)));
  console.log(JSON.stringify({ repository: parsed.repo, results, safety: "No safe reuse certified. Candidate is measurement only; never skip a job." }, null, 2));
}

if (import.meta.main) main();
