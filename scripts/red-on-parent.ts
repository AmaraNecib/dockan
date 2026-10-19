#!/usr/bin/env bun
/**
 * Red-on-parent gate.
 *
 * A test that is green on the parent of the change that adds it pins nothing:
 * it would pass whether or not the change exists. This gate reconstructs the
 * parent of the change in a cached worktree, copies the *new* test files into
 * that worktree at their own relative paths, and runs them there. Every test in
 * an added file is expected to fail on the parent — for its own reason.
 *
 * Scope is deliberately narrow. Only files the diff *adds* are gated, never
 * files it edits: an existing test file was green on the parent by
 * construction, so gating one buys a waiver line and nothing else. Playwright
 * specs are out of unit scope because their red needs two servers running.
 *
 * The discrimination that makes the gate possible, measured on bun 1.4.2 (a
 * dev machine) and bun 1.3.14 (the `packageManager` pin, which CI installs):
 *
 *   - a load error and a real assertion failure BOTH exit 1;
 *   - bun writes the junit report only when the file loaded at all, so a
 *     missing report means "the parent could not load this file";
 *   - a real assertion red evaluates an assertion and reports
 *     `<failure type="AssertionError">`. On 1.4.2 a `beforeEach` / `beforeAll`
 *     throw is `<failure type="Error">` instead; on 1.3.14 bun writes a bare
 *     `<failure type="AssertionError" />` for EVERY failure, so the `type`
 *     attribute alone cannot separate a hook throw from an assertion red there.
 *     The `assertions="0"` counter is the tell that the test body never ran —
 *     true of a hook throw on both versions.
 *
 * A gate that greps `(fail)` accepts a hook throw as a red and is worthless.
 * This one reads the junit report, which is why it runs the file once with
 * `--reporter=junit` instead of scraping stdout.
 *
 * Because the run is per added *file* and every test in an added file is new,
 * a single whole-file run enumerates exactly the tests the diff adds. That is
 * also why there is no `-t` pattern to derive: a hand-rolled name parser would
 * be the one thing here that can silently skip a test it failed to match.
 *
 * Usage:
 *   bun scripts/red-on-parent.ts [--base <rev>] [--head <rev>] [--fresh]
 *
 * `RED_ON_PARENT_CACHE` moves the cached worktrees somewhere else (tests and CI
 * use it so nothing is shared between runs).
 *
 * Exit codes: 0 = pass, 1 = the gate failed, 2 = the gate could not run.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const BUN = process.execPath;
const WAIVER_MARKER = "red-on-parent-waive";
const TEST_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TestStatus = "passed" | "failed" | "skipped";

export type TestResult = {
  /** Test name only, as bun reports it (no `describe` chain). */
  name: string;
  /** `describe` chain, innermost first, joined by " > "; "" for a top-level test. */
  classname: string;
  status: TestStatus;
  /** The junit `<failure type>` attribute, or null when the test did not fail. */
  failureType: string | null;
  /**
   * junit's `assertions` counter for this testcase: how many `expect(...)`
   * matchers ran. null when the attribute is absent. On bun 1.3.14 this is the
   * only signal that separates a real assertion red from a hook throw, because
   * both carry `type="AssertionError"` with no message.
   */
  assertions: number | null;
};

export type Waiver = {
  /** Regex matched against the test's full display name, then its bare name. */
  pattern: string;
  /** Why this test is green on the parent on purpose. */
  reason: string;
  /** 1-based line in the added file, printed so the reviewer can find it. */
  line: number;
};

/** What `parseWaivers` found in one added file. */
export type WaiverParse = {
  waivers: Waiver[];
  /** Malformed marker lines, each a gate failure: the author must fix them. */
  problems: string[];
};

export type VerdictName =
  | "RIGHT_REASON_RED"
  | "WRONG_REASON_RED"
  | "GREEN_ON_PARENT"
  | "WAIVER_MISFILED";

export type Verdict = {
  file: string;
  /** Display name of the test, or `(whole file)` for a run-level failure. */
  test: string;
  name: VerdictName;
  detail: string;
  waiver: Waiver | null;
};

export type FileRun = {
  file: string;
  /** null when bun wrote no junit report: the parent could not load the file. */
  junit: string | null;
  stdout: string;
  /** Non-empty when the run itself could not be interpreted (timeout, spawn error). */
  error: string;
};

export type Classification = {
  verdicts: Verdict[];
  usedWaiverLines: Set<number>;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const XML_ENTITIES: Array<readonly [string, string]> = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
];

export function decodeXml(text: string): string {
  let out = text;
  for (const [entity, char] of XML_ENTITIES) out = out.split(entity).join(char);
  // `&amp;` last, so `&amp;lt;` decodes to `&lt;` and not to `<`.
  return out.split("&amp;").join("&");
}

/** The string bun's `-t` filter (and this gate's waivers) match a test against. */
export function displayName(result: Pick<TestResult, "name" | "classname">): string {
  if (result.classname.length === 0) return result.name;
  const chain = result.classname.split(" > ").reverse().join(" ");
  return `${chain} ${result.name}`;
}

function attribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(source);
  return match === null ? null : decodeXml(match[1] ?? "");
}

/** An integer attribute, or null when it is absent or not a number. */
function numericAttribute(source: string, name: string): number | null {
  const raw = attribute(source, name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? null : value;
}

/**
 * Read bun's junit report. The report nests `<testsuite>` per `describe`, so
 * testcases are matched anywhere in the document; `classname` carries the
 * chain, reversed and joined with " > ".
 */
export function parseJunit(xml: string): TestResult[] {
  const results: TestResult[] = [];
  const testcase = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu;
  for (const match of xml.matchAll(testcase)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const name = attribute(attributes, "name");
    if (name === null) continue;
    const skipped = /<skipped\b/u.test(body);
    const failure = /<failure\b/u.test(body);
    let status: TestStatus = "passed";
    if (skipped) status = "skipped";
    else if (failure) status = "failed";
    results.push({
      name,
      classname: attribute(attributes, "classname") ?? "",
      status,
      failureType: failure ? attribute(body, "type") : null,
      assertions: numericAttribute(attributes, "assertions"),
    });
  }
  return results;
}

// Built per call, and deliberately not `g`: it is applied to one line at a
// time, and a `g` regex carries `lastIndex` between inputs — reusing one across
// lines skips a waiver whenever the previous line was longer than this one.
const waiverLinePattern = () =>
  /^[ \t]*\/\/[ \t]*red-on-parent-waive[ \t]*:[ \t]*(?:"([^"]*)"|'([^']*)')[ \t]*(?:[—–]{1,2}|-{1,2}|:)?[ \t]*(.*)$/u;

/**
 * Waivers live in the added file as a line comment, one per test name pattern:
 *
 *   // red-on-parent-waive: "gr passes" — characterizes behaviour the refactor kept
 *
 * The reason is required: the marker is what a reviewer reads in the diff, and
 * a waiver with no reason is a waiver nobody can judge.
 */
export function parseWaivers(text: string): WaiverParse {
  const waivers: Waiver[] = [];
  const problems: string[] = [];
  const linePattern = waiverLinePattern();
  let line = 0;
  // Split on CRLF too: a Windows checkout hands this a file with `\r` at the end
  // of every line, and the `$` anchor in the pattern does not match before `\r`.
  for (const raw of text.split(/\r?\n/u)) {
    line += 1;
    if (!raw.includes(WAIVER_MARKER)) continue;
    const match = linePattern.exec(raw);
    if (match === null) {
      problems.push(
        `line ${line}: a ${WAIVER_MARKER} marker must read \`// ${WAIVER_MARKER}: "<test name>" — <reason>\``,
      );
      continue;
    }
    const pattern = (match[1] ?? match[2] ?? "").trim();
    const reason = (match[3] ?? "").trim();
    if (pattern.length === 0) {
      problems.push(`line ${line}: the waiver names no test pattern`);
      continue;
    }
    if (reason.length === 0) {
      problems.push(`line ${line}: the waiver names no reason — say why this test is green on the parent`);
      continue;
    }
    try {
      new RegExp(pattern, "u");
    } catch {
      problems.push(`line ${line}: the waiver pattern ${JSON.stringify(pattern)} is not a valid regex`);
      continue;
    }
    waivers.push({ pattern, reason, line });
  }
  return { waivers, problems };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function verdictPasses(verdict: Verdict): boolean {
  switch (verdict.name) {
    case "RIGHT_REASON_RED":
      return true;
    case "WRONG_REASON_RED":
    case "GREEN_ON_PARENT":
      return verdict.waiver !== null;
    case "WAIVER_MISFILED":
      return false;
  }
}

function matches(waiver: Waiver, result: TestResult): boolean {
  const re = new RegExp(waiver.pattern, "u");
  return re.test(displayName(result)) || re.test(result.name);
}

function firstWaiver(waivers: Waiver[], result: TestResult): Waiver | null {
  return waivers.find((waiver) => matches(waiver, result)) ?? null;
}

function classifyResult(file: string, result: TestResult, waiver: Waiver | null): Verdict {
  const test = displayName(result);
  if (result.status === "skipped") {
    return {
      file,
      test,
      name: "GREEN_ON_PARENT",
      detail: `the test is skipped (or a todo) on the parent, so it pins nothing`,
      waiver,
    };
  }
  if (result.status === "passed") {
    return {
      file,
      test,
      name: "GREEN_ON_PARENT",
      detail: `the test passes on the parent, so it pins no behaviour the change adds`,
      waiver,
    };
  }
  if (isAssertionRed(result)) {
    if (waiver !== null) {
      return {
        file,
        test,
        name: "WAIVER_MISFILED",
        detail: `waived, but the test already fails on the parent with an AssertionError — delete the waiver`,
        waiver,
      };
    }
    return {
      file,
      test,
      name: "RIGHT_REASON_RED",
      detail: `fails on the parent with an assertion on the behaviour the change adds`,
      waiver: null,
    };
  }
  return {
    file,
    test,
    name: "WRONG_REASON_RED",
    detail: `fails on the parent before evaluating the test body (${failureReason(
      result,
    )}), so it proves nothing about the change`,
    waiver,
  };
}

/**
 * A real assertion red evaluated an assertion and got `AssertionError`.
 *
 * The counter is load-bearing on bun 1.3.14, the repo's `packageManager` pin and
 * what CI installs: there bun writes a bare `<failure type="AssertionError" />`
 * for EVERY failure, so a `beforeEach` throw and an assertion red are
 * byte-identical in junit. `assertions="0"` is then the only tell that the test
 * body never ran. On 1.4.2 the `type` says it too (`Error`) and the counter
 * agrees. A report with no counter at all (hand-written, or a bun that never
 * emitted one) keeps the `type`-only rule rather than failing closed on unknown.
 *
 * One measured cost, on 1.3.14 only: `expect.fail(...)` also reports
 * `assertions="0"` with a bare AssertionError, so this calls it WRONG-REASON
 * RED. Failing closed on an undecidable shape costs one waiver line; letting a
 * hook throw through would defeat the gate. Nothing in this repo uses it.
 */
function isAssertionRed(result: TestResult): boolean {
  return result.failureType === "AssertionError" && result.assertions !== 0;
}

/** Why a failing test is not a right-reason red, in wording bun does not vary. */
function failureReason(result: TestResult): string {
  if (result.assertions === 0) return `no assertion was evaluated (junit assertions="0")`;
  return `junit failure type ${JSON.stringify(result.failureType ?? "unknown")}`;
}

/**
 * Classify one added file's run. A missing junit report is the load-error
 * signal: the file did not load, or declared no tests at all. Either way every
 * test in it is unproven, and the file's waivers cover the failure (that is the
 * rename case — the import resolves only on the change, and the module's
 * existence IS the change).
 */
export function classifyFileRun(run: FileRun, waivers: Waiver[]): Classification {
  const used = new Set<number>();
  const verdicts: Verdict[] = [];

  if (run.junit === null) {
    const reason = run.error.length > 0 ? run.error : loadFailureReason(run.stdout);
    const waiver = waivers[0] ?? null;
    if (waiver !== null) for (const w of waivers) used.add(w.line);
    verdicts.push({
      file: run.file,
      test: "(whole file)",
      name: "WRONG_REASON_RED",
      detail: `${reason}${waiver === null ? "" : ` — covered by the waiver on line ${waiver.line}`}`,
      waiver,
    });
    return { verdicts, usedWaiverLines: used };
  }

  const results = parseJunit(run.junit);
  if (results.length === 0) {
    verdicts.push({
      file: run.file,
      test: "(whole file)",
      name: "WRONG_REASON_RED",
      detail: "the junit report carries no testcase, so the file pins nothing",
      waiver: null,
    });
    return { verdicts, usedWaiverLines: used };
  }

  for (const result of results) {
    const waiver = firstWaiver(waivers, result);
    if (waiver !== null) used.add(waiver.line);
    verdicts.push(classifyResult(run.file, result, waiver));
  }
  return { verdicts, usedWaiverLines: used };
}

export function loadFailureReason(stdout: string): string {
  if (/Ran 0 tests/u.test(stdout)) return "the file declares no tests";
  if (/# Unhandled error between tests/u.test(stdout)) {
    return `the parent could not load the file (see the transcript below)`;
  }
  return "bun wrote no junit report, so the file did not run to completion";
}

/** Waivers that matched no test at all. Each is a failure: it excuses nothing. */
export function unusedWaiverVerdicts(file: string, waivers: Waiver[], used: Set<number>): Verdict[] {
  return waivers
    .filter((waiver) => !used.has(waiver.line))
    .map((waiver) => ({
      file,
      test: "(no test)",
      name: "WAIVER_MISFILED" as const,
      detail: `the waiver on line ${waiver.line} matches no test in this file — delete it, or fix the pattern`,
      waiver,
    }));
}

// ---------------------------------------------------------------------------
// Which files are gated
// ---------------------------------------------------------------------------

/**
 * New unit-test files, and only those. A `.spec.ts` is Playwright (its red
 * needs both servers); a file under an `e2e` directory is the same thing; and
 * nothing outside `apps/` and `packages/` is a product test.
 */
export function isGatedTestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!/^(apps|packages)\//u.test(normalized)) return false;
  if (normalized.includes("/e2e/") || normalized.includes("/tests/e2e/")) return false;
  if (/\.spec\.[cm]?[jt]sx?$/u.test(normalized)) return false;
  return /\.test\.[cm]?[jt]sx?$/u.test(normalized);
}

// ---------------------------------------------------------------------------
// Git and the base worktree
// ---------------------------------------------------------------------------

type CommandResult = {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
};

/** The cached parent checkout, and whether this run created it. */
type BaseWorktree = {
  path: string;
  created: boolean;
};

function run(cmd: string, args: string[], cwd: string, timeout: number): CommandResult {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error === undefined ? "" : result.error.message,
  };
}

function git(repo: string, args: string[]): CommandResult {
  return run("git", args, repo, GIT_TIMEOUT_MS);
}

function gitText(repo: string, args: string[]): string {
  const result = git(repo, args);
  if (!result.ok) {
    throw new GateError(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.error}`);
  }
  return result.stdout;
}

function cacheRoot(repo: string): string {
  const override = process.env.RED_ON_PARENT_CACHE;
  if (override !== undefined && override.length > 0) return resolve(override);
  // Keyed by repo path so two different repos with the same base SHA never
  // share (and fight over) one worktree.
  const key = createHash("sha1").update(resolve(repo).toLowerCase()).digest("hex").slice(0, 12);
  return join(tmpdir(), "dokan-red-on-parent", key);
}

/** Files this run copied into the base worktree, so the next run can clear them. */
function manifestPath(repo: string, baseSha: string): string {
  return join(cacheRoot(repo), `${baseSha}.copied.json`);
}

function readManifest(path: string): string[] {
  if (!existsSync(path)) return [];
  // SAFETY: this script writes the manifest as a JSON array of repo-relative
  // path strings. A corrupt file can only under-clear copies, and every path it
  // could name was already proved absent at the base before it was copied.
  const parsed = JSON.parse(readFileSync(path, "utf8")) as string[];
  return Array.isArray(parsed) ? parsed : [];
}

function clearPreviousCopies(repo: string, worktree: string, baseSha: string): void {
  const manifest = manifestPath(repo, baseSha);
  for (const relative of readManifest(manifest)) {
    rmSync(join(worktree, relative), { force: true });
  }
  rmSync(manifest, { force: true });
}

function ensureBaseWorktree(
  repo: string,
  baseSha: string,
  fresh: boolean,
): BaseWorktree {
  const worktree = join(cacheRoot(repo), `wt-${baseSha}`);
  const initialized = existsSync(join(worktree, ".git"));
  if (initialized && !fresh) {
    const head = git(worktree, ["rev-parse", "HEAD"]);
    if (head.ok && head.stdout.trim() === baseSha) {
      clearPreviousCopies(repo, worktree, baseSha);
      return { path: worktree, created: false };
    }
  }
  if (existsSync(worktree)) {
    rmSync(worktree, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
  }
  mkdirSync(dirname(worktree), { recursive: true });
  const added = git(repo, ["worktree", "add", "--detach", worktree, baseSha]);
  if (!added.ok) {
    throw new GateError(
      `could not create a worktree for the parent ${baseSha}: ${added.stderr.trim() || added.error}`,
    );
  }
  clearPreviousCopies(repo, worktree, baseSha);
  return { path: worktree, created: true };
}

/**
 * The parent's own dependency tree. The install is run once per base SHA (the
 * worktree is cached), ~13 s warm in this repo. It is installed rather than
 * junctioned from the change's checkout because in bun's layout every
 * workspace's `node_modules/@dokan/<pkg>` is a symlink into the *change*: an
 * added test importing a workspace package would then load the change's source
 * and pass a gate that is supposed to be testing the parent.
 */
function ensureBaseNodeModules(worktree: string): string {
  const lock = join(worktree, "bun.lock");
  const modules = join(worktree, "node_modules");
  if (existsSync(modules) || !existsSync(lock)) return "";
  const install = run(BUN, ["install", "--frozen-lockfile"], worktree, 10 * 60_000);
  if (!install.ok) {
    throw new GateError(
      `bun install --frozen-lockfile failed in the parent worktree: ${
        install.stderr.trim() || install.error
      }`,
    );
  }
  return install.stdout.trim();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export class GateError extends Error {}

export type GateOptions = {
  repo: string;
  base: string;
  head: string;
  fresh: boolean;
};

export type GateRun = {
  baseSha: string;
  worktree: string;
  worktreeCreated: boolean;
  installLog: string;
  files: string[];
  verdicts: Verdict[];
  stdoutByFile: Map<string, string>;
  problems: string[];
  /** Test files in the working tree that HEAD does not hold: the gate cannot see them. */
  uncommitted: string[];
};

function resolveBase(repo: string, requested: string | null): string {
  if (requested !== null) {
    const resolved = git(repo, ["rev-parse", "--verify", `${requested}^{commit}`]);
    if (!resolved.ok) throw new GateError(`--base ${requested} is not a commit`);
    return resolved.stdout.trim();
  }
  for (const candidate of ["origin/develop", "develop"]) {
    const resolved = git(repo, ["rev-parse", "--verify", `${candidate}^{commit}`]);
    if (resolved.ok) return resolved.stdout.trim();
  }
  throw new GateError(
    "no `origin/develop` and no local `develop` to diff against; pass --base <rev>",
  );
}

export function addedTestFiles(repo: string, mergeBase: string, head: string): string[] {
  const changed = gitText(repo, ["diff", "--name-only", "--no-renames", mergeBase, head])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const added: string[] = [];
  for (const path of changed) {
    if (!isGatedTestPath(path)) continue;
    // Present at the parent => an edited file, never gated. Absent => added.
    if (git(repo, ["cat-file", "-e", `${mergeBase}:${path}`]).ok) continue;
    added.push(path);
  }
  return added.sort();
}

/**
 * Test files the working tree holds but HEAD does not. The gate reads HEAD, so
 * an uncommitted test file is invisible to it — a silent pass if nobody says so.
 */
export function uncommittedTestFiles(repo: string): string[] {
  return gitText(repo, ["status", "--porcelain", "--no-renames"])
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => isGatedTestPath(path));
}

/** The file's content as of `head`, not as of the working tree. */
function readAtRevision(repo: string, head: string, path: string): string {
  const result = git(repo, ["show", `${head}:${path}`]);
  if (!result.ok) {
    throw new GateError(`cannot read ${path} at ${head}: ${result.stderr.trim() || result.error}`);
  }
  return result.stdout;
}

export function runGate(options: GateOptions): GateRun {
  const { repo, head, fresh } = options;
  const baseSha = gitText(repo, ["merge-base", options.base, head]).trim();
  const files = addedTestFiles(repo, baseSha, head);
  const uncommitted = uncommittedTestFiles(repo);
  if (files.length === 0) {
    return {
      baseSha,
      worktree: "(none)",
      worktreeCreated: false,
      installLog: "",
      files,
      verdicts: [],
      stdoutByFile: new Map(),
      problems: [],
      uncommitted,
    };
  }
  const { path: worktree, created } = ensureBaseWorktree(repo, baseSha, fresh);
  const installLog = ensureBaseNodeModules(worktree);

  const outDir = mkdtempSync(join(tmpdir(), "dokan-red-on-parent-junit-"));
  const verdicts: Verdict[] = [];
  const stdoutByFile = new Map<string, string>();
  const problems: string[] = [];
  const copied: string[] = [];

  try {
    for (const file of files) {
      const source = readAtRevision(repo, head, file);
      const destination = join(worktree, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, source);
      copied.push(file);

      const junitPath = join(outDir, `${copied.length}.xml`);
      rmSync(junitPath, { force: true });
      const result = run(
        BUN,
        ["test", file, "--reporter=junit", `--reporter-outfile=${junitPath}`],
        worktree,
        TEST_TIMEOUT_MS,
      );
      const parsed = parseWaivers(source);
      for (const problem of parsed.problems) problems.push(`${file}: ${problem}`);

      const junit = existsSync(junitPath) ? readFileSync(junitPath, "utf8") : null;
      const fileRun: FileRun = {
        file,
        junit,
        stdout: `${result.stdout}${result.stderr}`,
        error:
          result.status === null
            ? `bun test did not complete${result.error.length > 0 ? ` (${result.error})` : ""}`
            : "",
      };
      stdoutByFile.set(file, fileRun.stdout);
      const classified = classifyFileRun(fileRun, parsed.waivers);
      verdicts.push(...classified.verdicts);
      verdicts.push(...unusedWaiverVerdicts(file, parsed.waivers, classified.usedWaiverLines));
    }
    if (copied.length > 0) {
      mkdirSync(dirname(manifestPath(repo, baseSha)), { recursive: true });
      writeFileSync(manifestPath(repo, baseSha), `${JSON.stringify(copied, null, 2)}\n`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  return {
    baseSha,
    worktree,
    worktreeCreated: created,
    installLog,
    files,
    verdicts,
    stdoutByFile,
    problems,
    uncommitted,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const VERDICT_GUIDE: ReadonlyArray<{ name: VerdictName; title: string; fixes: [string, string] }> = [
  {
    name: "RIGHT_REASON_RED",
    title: "the test fails on the parent for its own reason, and passes on the change",
    fixes: [
      "nothing — keep the test as it is",
      "do not waive it: a waiver on a right-reason red is misfiled and the gate will say so",
    ],
  },
  {
    name: "WRONG_REASON_RED",
    title: "the test could not be evaluated on the parent (load error, or a non-assertion throw)",
    fixes: [
      "commit the module/export/fixture the test needs as the change's first commit, so the parent can evaluate its body",
      "if the missing module IS the change (a rename, a moved file), add `// red-on-parent-waive: \"<test name>\" — rename: the test moved with the file`",
    ],
  },
  {
    name: "GREEN_ON_PARENT",
    title: "the test passes on the parent, so it pins nothing the change adds",
    fixes: [
      "add `// red-on-parent-waive: \"<test name>\" — <why this behaviour already worked>` to the added file",
      "or make the change actually change this behaviour; if it already does, the test is asserting the wrong thing",
    ],
  },
  {
    name: "WAIVER_MISFILED",
    title: "a waiver that a reviewer can see, but that the run does not support",
    fixes: [
      "delete the `red-on-parent-waive` line — the red you were looking for is already there",
      "or, if it excuses no test at all, correct the pattern so it names the test it is for",
    ],
  },
];

function pad(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, width - 1)}…`;
}

export function renderReport(run: GateRun, problems: string[]): string {
  const lines: string[] = [];
  const files = run.files.length;
  lines.push(
    `red-on-parent: base ${run.baseSha.slice(0, 12)} (worktree ${run.worktree}${run.worktreeCreated ? ", created" : ", cached"})`,
  );
  if (run.uncommitted.length > 0) {
    lines.push(
      `WARNING: ${run.uncommitted.length} test file(s) in the working tree are not in HEAD, so the gate cannot see them. Commit first: ${run.uncommitted.join(", ")}`,
    );
  }
  if (files === 0) {
    lines.push("no added test files: nothing to gate");
    return `${lines.join("\n")}\n`;
  }
  if (run.installLog.length > 0) lines.push(`installed the parent's dependencies: ${run.installLog}`);
  lines.push("");

  const fileWidth = Math.max(12, ...run.verdicts.map((v) => v.file.length));
  const testWidth = Math.max(12, ...run.verdicts.map((v) => v.test.length));
  lines.push(`${pad("FILE", fileWidth)}  ${pad("TEST", testWidth)}  ${pad("VERDICT", 18)}  WAIVED`);
  for (const verdict of run.verdicts) {
    const waived = verdict.waiver === null ? "-" : `line ${verdict.waiver.line}`;
    lines.push(
      `${pad(verdict.file, fileWidth)}  ${pad(verdict.test, testWidth)}  ${pad(verdict.name.replaceAll("_", "-"), 18)}  ${waived}`,
    );
  }

  const failing = run.verdicts.filter((verdict) => !verdictPasses(verdict));
  if (failing.length > 0) {
    lines.push("", "FAILURES");
    for (const verdict of failing) {
      lines.push(`  ${verdict.file}`);
      lines.push(`    ${verdict.name.replaceAll("_", " ")}: ${verdict.test} — ${verdict.detail}`);
      const transcript = run.stdoutByFile.get(verdict.file);
      if (verdict.name === "WRONG_REASON_RED" && transcript !== undefined) {
        for (const line of loadErrorExcerpt(transcript)) lines.push(`      | ${line}`);
      }
    }
  }

  const usedWaivers = usedWaiverList(run.verdicts);
  if (usedWaivers.length > 0) {
    lines.push("", "WAIVERS (a reviewer reads these in the diff)");
    for (const entry of usedWaivers) {
      lines.push(`  ${entry.file}:${entry.waiver.line}  "${entry.waiver.pattern}" — ${entry.waiver.reason}`);
    }
  }

  const present = new Set(run.verdicts.map((verdict) => verdict.name));
  lines.push("", "VERDICT GUIDE");
  for (const entry of VERDICT_GUIDE) {
    if (!present.has(entry.name)) continue;
    lines.push(`  ${entry.name.replaceAll("_", " ")} — ${entry.title}`);
    entry.fixes.forEach((fix, index) => lines.push(`    ${index + 1}. ${fix}`));
  }

  if (problems.length > 0) {
    lines.push("", "WAIVER LINE PROBLEMS");
    for (const problem of problems) lines.push(`  ${problem}`);
  }

  const counts = countVerdicts(run.verdicts);
  lines.push("", `added test files: ${files} · ${summaryLine(counts)}`);
  const failed = failing.length > 0 || problems.length > 0;
  lines.push(failed ? "red-on-parent: FAIL" : "red-on-parent: PASS");
  return `${lines.join("\n")}\n`;
}

/** Every waiver that actually excused something, once, in file order. */
function usedWaiverList(verdicts: Verdict[]): Array<{ file: string; waiver: Waiver }> {
  const seen = new Set<string>();
  const used: Array<{ file: string; waiver: Waiver }> = [];
  for (const verdict of verdicts) {
    if (verdict.waiver === null) continue;
    const key = `${verdict.file}:${verdict.waiver.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    used.push({ file: verdict.file, waiver: verdict.waiver });
  }
  return used;
}

function countVerdicts(verdicts: Verdict[]): Map<VerdictName, number> {
  const counts = new Map<VerdictName, number>();
  for (const verdict of verdicts) counts.set(verdict.name, (counts.get(verdict.name) ?? 0) + 1);
  return counts;
}

function summaryLine(counts: Map<VerdictName, number>): string {
  const order: VerdictName[] = ["RIGHT_REASON_RED", "WRONG_REASON_RED", "GREEN_ON_PARENT", "WAIVER_MISFILED"];
  return order
    .map((name) => `${counts.get(name) ?? 0} ${name.toLowerCase().replaceAll("_", " ")}`)
    .join(" · ");
}

function loadErrorExcerpt(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes("# Unhandled error between tests"));
  if (start !== -1) return lines.slice(start, start + 6).filter((line) => line.trim().length > 0);
  const errorLine = lines.findIndex((line) => /^\s*error:/u.test(line));
  if (errorLine !== -1) return lines.slice(errorLine, errorLine + 4).filter((line) => line.trim().length > 0);
  return lines.filter((line) => line.trim().length > 0).slice(0, 6);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: bun scripts/red-on-parent.ts [--base <rev>] [--head <rev>] [--fresh]

  --base <rev>   the parent to test against (default: the merge-base with
                 origin/develop, then develop)
  --head <rev>   the change to read the added test files from (default: HEAD)
  --fresh        discard the cached parent worktree and rebuild it
  --help         show this text

RED_ON_PARENT_CACHE overrides where the cached parent worktrees live.
`;

export type ParsedArgs = {
  base: string | null;
  head: string;
  fresh: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { base: null, head: "HEAD", fresh: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--fresh") parsed.fresh = true;
    else if (arg === "--base") {
      parsed.base = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--base=")) parsed.base = arg.slice("--base=".length);
    else if (arg === "--head") {
      parsed.head = argv[index + 1] ?? "HEAD";
      index += 1;
    } else if (arg.startsWith("--head=")) parsed.head = arg.slice("--head=".length);
    else throw new GateError(`unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`);
  }
  return parsed;
}

function main(argv: string[]): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const repo = gitText(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const base = resolveBase(repo, args.base);
    const run = runGate({ repo, base, head: args.head, fresh: args.fresh });
    process.stdout.write(renderReport(run, run.problems));
    const failed = run.verdicts.some((verdict) => !verdictPasses(verdict)) || run.problems.length > 0;
    return failed ? 1 : 0;
  } catch (error) {
    if (error instanceof GateError) {
      process.stderr.write(`red-on-parent: cannot run — ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
