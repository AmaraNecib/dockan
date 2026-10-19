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
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const BUN = process.execPath;

/**
 * The refusal text when the gate is not running under bun, or null when it is.
 *
 * Node 22+ strips TypeScript types, so `node scripts/red-on-parent.ts` starts
 * cleanly and then spawns `node test <file>` for every parent-side run. Every
 * file then reads as a whole-file load failure, and a waiver on such a file
 * would turn that into a PASS. The gate cannot tell its bun is not bun unless it
 * asks, so it asks once, before any work.
 */
export function bunOnlyRefusal(
  // SAFETY: `process.versions` is a plain object and bun adds a `bun` key to it,
  // so reading an optional property cannot throw; the cast only names that key.
  versions: { bun?: string } = process.versions as { bun?: string },
): string | null {
  if (versions.bun !== undefined) return null;
  return "red-on-parent: run this with bun, not node — every parent-side run spawns `bun test` from process.execPath, and under node each file reads as a whole-file load failure\n";
}
const WAIVER_MARKER = "red-on-parent-waive";
const TEST_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;
/** The cold `bun install` in the base worktree. Inside the lock, so the lock
 * wait budget has to cover it. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** The slack a waiting run gets past the work it knows can be inside the lock. */
const LOCK_WAIT_SLACK_MS = 60_000;

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
  | "NOT_ON_PARENT"
  | "GREEN_ON_PARENT"
  | "WAIVER_MISFILED"
  | "RUN_INCOMPLETE";

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
  const startsAsWaiver = new RegExp(`^[ \\t]*//[ \\t]*${WAIVER_MARKER}`, "u");
  let line = 0;
  // Split on CRLF too: a Windows checkout hands this a file with `\r` at the end
  // of every line, and the `$` anchor in the pattern does not match before `\r`.
  for (const raw of text.split(/\r?\n/u)) {
    line += 1;
    // Only a line that *is* a waiver counts. A line that merely mentions the
    // marker — documenting the convention, or a string literal — used to be
    // parsed, fail the anchored pattern, and fail the whole run.
    if (!startsAsWaiver.test(raw)) continue;
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
    case "NOT_ON_PARENT":
    case "GREEN_ON_PARENT":
      return verdict.waiver !== null;
    case "WAIVER_MISFILED":
    case "RUN_INCOMPLETE":
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
export function classifyFileRun(
  run: FileRun,
  waivers: Waiver[],
  changeNames: string[] = [],
): Classification {
  const used = new Set<number>();
  const verdicts: Verdict[] = [];

  // A run that did not finish produced no result anyone can judge. It is not a
  // load failure — the file may never have been read — and no waiver covers it:
  // a waiver says why a test is green on the parent, and a timeout says nothing
  // at all. Without this branch the `junit === null` path below attaches the
  // first waiver to a timeout and calls the file covered.
  if (run.error.length > 0) {
    verdicts.push({
      file: run.file,
      test: "(whole file)",
      name: "RUN_INCOMPLETE",
      detail: run.error,
      waiver: null,
    });
    return { verdicts, usedWaiverLines: used };
  }

  if (run.junit === null) {
    const reason = loadFailureReason(run.stdout);
    // Nothing ran on the parent, so its test list is empty and a waiver cannot
    // be judged against it. The change side still knows which tests the file
    // registers, and that is the only list available here. This used to attach
    // `waivers[0]` whatever it named and mark every waiver used, so a file that
    // never loaded printed PASS with no test judged at all.
    const covers = (waiver: Waiver): boolean => {
      const re = new RegExp(waiver.pattern, "u");
      return changeNames.some((name) => re.test(name));
    };
    const waiver = waivers.find(covers) ?? null;
    for (const candidate of waivers) if (covers(candidate)) used.add(candidate.line);
    const explainsNothing =
      waiver === null && waivers.length > 0
        ? ` — and no waiver here names a test the change registers (${changeNames.join(", ") || "none found"})`
        : "";
    verdicts.push({
      file: run.file,
      test: "(whole file)",
      name: "WRONG_REASON_RED",
      detail: `${reason}${waiver === null ? explainsNothing : ` — covered by the waiver on line ${waiver.line}`}`,
      waiver,
    });
    return { verdicts, usedWaiverLines: used };
  }

  const results = parseJunit(run.junit);
  // A waiver is used when it matches a test, not when it is the one this run
  // happened to pick. `firstWaiver` returns the first match, so a broad pattern
  // ("case") hid a later narrow one ("case one") and the narrow one was then
  // reported as matching no test in the file — a factually wrong message on a
  // file that was fine.
  for (const waiver of waivers) {
    if (results.some((result) => matches(waiver, result))) used.add(waiver.line);
  }
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

/**
 * The tests the change registers that the parent's report never names.
 *
 * The parent's junit is the only test list the gate trusts, and it is a subset
 * of what the file declares whenever a test is registered behind a condition
 * the change newly satisfies:
 *
 *   import * as mod from "./helper";
 *   if ("brandNew" in mod) test("brandNew ...", ...);
 *
 * That test is exactly the one the gate exists for, and it is absent from the
 * parent's report — so the remaining tests would carry the file to a pass with
 * no red and no waiver for it. The change's own run supplies the names; every
 * one of them must appear on the parent or carry a waiver.
 */
export function unregisteredVerdicts(
  file: string,
  parentResults: TestResult[],
  changeResults: TestResult[],
  waivers: Waiver[],
): Classification {
  const used = new Set<number>();
  const verdicts: Verdict[] = [];
  // Counts, not a set. A loop can register the same display name more than once
  // on the change and only once on the parent; a set would answer "covered" for
  // every occurrence and the extra case would never be judged.
  const onParent = new Map<string, number>();
  for (const result of parentResults) {
    const name = displayName(result);
    onParent.set(name, (onParent.get(name) ?? 0) + 1);
  }
  for (const result of changeResults) {
    const test = displayName(result);
    const remaining = onParent.get(test) ?? 0;
    if (remaining > 0) {
      onParent.set(test, remaining - 1);
      continue;
    }
    const waiver = firstWaiver(waivers, result);
    if (waiver !== null) used.add(waiver.line);
    verdicts.push({
      file,
      test,
      name: "NOT_ON_PARENT",
      detail:
        "the change registers this test and the parent's run never reported it, so the gate has no red to judge for it",
      waiver,
    });
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

/** Whether `path` differs from HEAD in the working tree (`git diff --quiet` exits 1). */
function modifiedInWorkingTree(repo: string, path: string): boolean {
  return git(repo, ["diff", "--quiet", "HEAD", "--", path]).status !== 0;
}

/**
 * The directory bun must run `file` from, and the path to pass it.
 *
 * Bun loads the `bunfig.toml` of its *working directory*, not of the test file.
 * Running `apps/web/src/x.test.tsx` from the repo root therefore skips
 * `apps/web/bunfig.toml`, and with it the preload that defines `document` — so a
 * React test that correctly tests the change dies at load and the gate calls it
 * WRONG-REASON RED. Each file runs from the nearest ancestor directory that owns
 * a `bunfig.toml`, under its path relative to that directory.
 */
function runFrom(root: string, file: string, junitPath: string): CommandResult {
  const here = relativeToWorkspace(root, file);
  return run(
    BUN,
    ["test", here.path, "--reporter=junit", `--reporter-outfile=${junitPath}`],
    here.cwd,
    TEST_TIMEOUT_MS,
  );
}

/** Where bun must run a test file, and the path to pass it. */
type WorkspaceRun = { cwd: string; path: string };

function relativeToWorkspace(root: string, file: string): WorkspaceRun {
  const parts = file.split("/");
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    const dir = parts.slice(0, depth).join("/");
    if (existsSync(join(root, dir, "bunfig.toml"))) {
      return { cwd: join(root, dir), path: parts.slice(depth).join("/") };
    }
  }
  return { cwd: root, path: file };
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

const LOCK_RETRY_MS = 250;
/**
 * How long a lock directory may exist without its pid file before it is read as
 * abandoned. The pid is written immediately after `mkdirSync` takes the lock, so
 * anything older than this lost the writer in that window.
 */
const LOCK_PID_GRACE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether the process that wrote this lock's pid file is gone. */
export function lockHolderIsGone(lockPath: string): boolean {
  const pidFile = join(lockPath, "pid");
  if (!existsSync(pidFile)) {
    // A crash between taking the lock and writing its pid leaves a lock that no
    // run can ever reclaim if "no pid" means "holder alive": every later run
    // waits its whole budget and refuses, forever. Grader than the write itself,
    // the directory's own age is the only evidence left.
    try {
      return Date.now() - statSync(lockPath).mtimeMs > LOCK_PID_GRACE_MS;
    } catch {
      // It went away between the EEXIST and this stat; the caller retries and
      // takes it.
      return false;
    }
  }
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ESRCH: no such process, so the holder died without releasing. EPERM: it
    // exists but belongs to another user — treat that as alive.
    // SAFETY: `process.kill` is the only throw source here and rejects with a
    // NodeJS.ErrnoException, whose string `code` is what this test reads.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Serialize every run that touches one base worktree.
 *
 * Two invocations from the same checkout and the same base copy their added
 * files into the same paths, and `--fresh` deletes the directory the other run
 * is testing in. The lock directory is the atomic acquire available on both
 * platforms (`mkdir` fails with EEXIST, unlike a test-then-write). A holder that
 * died is detected by its pid and its lock is renamed away before removal, so
 * unknown has to cover the whole worst case: wait too little and a legitimate
 * second run is refused with "wait for it to finish", which is advice it cannot
 * follow because the deadline has already fired. The caller therefore derives
 * the budget from the work it is about to do. `RED_ON_PARENT_LOCK_WAIT_MS`
 * overrides it, which is how the lock's refusal is pinned in milliseconds.
 */
function acquireWorktreeLock(lockPath: string, lockWaitMs: number): () => void {
  // The cache root does not exist on a cold first run, and `mkdirSync(lockPath)`
  // stays non-recursive because that is exactly what makes it the exclusive
  // acquire. Create the lock's parent first, never the lock itself.
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      // SAFETY: `mkdirSync` rejects with a NodeJS.ErrnoException, and its `code`
      // is the documented way to tell "already held" from a real failure.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockHolderIsGone(lockPath)) {
        const tombstone = `${lockPath}.stale-${process.pid}`;
        try {
          renameSync(lockPath, tombstone);
          rmSync(tombstone, { recursive: true, force: true });
        } catch {
          // Another run broke it first; the retry below takes the lock.
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new GateError(
          `another red-on-parent run is using ${lockPath}; wait for it to finish, or delete that directory if no run is alive`,
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  writeFileSync(join(lockPath, "pid"), `${process.pid}\n`);
  return () => rmSync(lockPath, { recursive: true, force: true });
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
  const marker = join(modules, ".red-on-parent-installed");
  if (!existsSync(lock)) return "";
  // A failed or interrupted install leaves `node_modules` behind, so its
  // existence is not proof that the install finished: reusing it produces
  // missing-module failures that look like the parent's fault. Only the marker
  // a completed install writes is that proof, and it lives inside the directory
  // it describes, so a rebuilt worktree cannot inherit a stale one.
  if (existsSync(marker)) return "";
  const install = run(BUN, ["install", "--frozen-lockfile"], worktree, INSTALL_TIMEOUT_MS);
  if (!install.ok) {
    throw new GateError(
      `bun install --frozen-lockfile failed in the parent worktree: ${
        install.stderr.trim() || install.error
      }`,
    );
  }
  mkdirSync(modules, { recursive: true });
  writeFileSync(marker, `${process.pid}\n`);
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
  // `-z`: git quotes any path holding a non-ASCII byte, and a quoted
  // `"packages/core/src/caf\303\251.test.ts"` fails `isGatedTestPath` on both
  // its leading quote and its trailing one, so such a file would be skipped in
  // silence. NUL separation carries the raw bytes, so nothing is trimmed here.
  const changed = gitText(repo, ["diff", "--name-only", "-z", "--no-renames", mergeBase, head])
    .split("\0")
    .filter((path) => path.length > 0);
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
  // `-z` for the same reason as `addedTestFiles`: porcelain quotes a non-ASCII
  // path, and the quoting hides it from `isGatedTestPath`.
  return gitText(repo, ["status", "--porcelain", "-z", "--no-renames"])
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
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

/**
 * The tests the change's own run registers, for comparison with the parent's.
 *
 * It runs the file where the author runs it — the change's checkout, which
 * already holds the modules the change adds — rather than in the base worktree,
 * where the file is deliberately being tested without them. The file itself must
 * match HEAD, or the names enumerated belong to a version the gate is not
 * judging; that is reported instead of guessed at.
 */
function changeSideResults(
  repo: string,
  file: string,
  junitPath: string,
  problems: string[],
): TestResult[] {
  if (modifiedInWorkingTree(repo, file)) {
    problems.push(
      `${file}: has uncommitted changes, so the gate cannot tell which tests this change registers — commit it and run again`,
    );
    return [];
  }
  rmSync(junitPath, { force: true });
  const result = runFrom(repo, file, junitPath);
  if (!existsSync(junitPath)) {
    problems.push(
      `${file}: the change's own run wrote no junit report (${
        result.error.length > 0 ? result.error : "the file did not run to completion"
      }), so the gate cannot tell which tests this change registers`,
    );
    return [];
  }
  return parseJunit(readFileSync(junitPath, "utf8"));
}

/** How long a run waits for the lock, given what can legitimately be inside it. */
export function lockWaitBudget(fileCount: number): number {
  const override = Number.parseInt(process.env.RED_ON_PARENT_LOCK_WAIT_MS ?? "", 10);
  if (Number.isInteger(override) && override > 0) return override;
  return INSTALL_TIMEOUT_MS + fileCount * TEST_TIMEOUT_MS + LOCK_WAIT_SLACK_MS;
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
  // Two runs from the same checkout and the same base share this worktree, and
  // one of them copying files into it or `--fresh`-deleting it would corrupt the
  // other's verdicts. The lock covers everything that reads or writes it, so the
  // wait budget covers the install plus one timeout per file: a shorter budget
  // would refuse a legitimate second run that is simply behind a slow first one.
  const lockWaitMs = lockWaitBudget(files.length);
  const release = acquireWorktreeLock(join(cacheRoot(repo), `wt-${baseSha}.lock`), lockWaitMs);
  try {
    return gateBaseWorktree({ repo, head, baseSha, files, uncommitted, fresh });
  } finally {
    release();
  }
}

/** The part of the run that reads and writes the cached base worktree. */
function gateBaseWorktree(input: {
  repo: string;
  head: string;
  baseSha: string;
  files: string[];
  uncommitted: string[];
  fresh: boolean;
}): GateRun {
  const { repo, head, baseSha, files, uncommitted, fresh } = input;
  const { path: worktree, created } = ensureBaseWorktree(repo, baseSha, fresh);
  const installLog = ensureBaseNodeModules(worktree);

  const outDir = mkdtempSync(join(tmpdir(), "dokan-red-on-parent-junit-"));
  const verdicts: Verdict[] = [];
  const stdoutByFile = new Map<string, string>();
  const problems: string[] = [];
  const copied: string[] = [];
  // The parent side runs the file *at `head`*, copied into the base worktree.
  // The change side has to run the checkout's own modules, so it can only
  // enumerate the tests of the commit that is checked out. Reviewing any other
  // commit would compare the requested revision's parent list against today's
  // tests, and a test that vanishes between them would escape NOT_ON_PARENT.
  // `head` arrives as whatever the author typed: a branch, a short sha, a tag.
  // An annotated tag has its own object id, so a plain `rev-parse` on one
  // returns that id and not the commit it points at — the check then tells an
  // author to check out the very commit they are already on. `^{commit}` peels
  // every ref kind to a commit, and `--verify` stops a path that happens to
  // share a ref's name from resolving. The base is resolved the same way.
  const checkoutDiffers =
    gitText(repo, ["rev-parse", "--verify", `${head}^{commit}`]).trim() !=
    gitText(repo, ["rev-parse", "HEAD"]).trim();
  if (checkoutDiffers) {
    problems.push(
      `--head ${head} is not the checked-out commit, so the tests it registers cannot be enumerated — check that commit out, or drop --head`,
    );
  }

  try {
    for (const file of files) {
      const source = readAtRevision(repo, head, file);
      const destination = join(worktree, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, source);
      copied.push(file);

      const junitPath = join(outDir, `${copied.length}.xml`);
      rmSync(junitPath, { force: true });
      const result = runFrom(worktree, file, junitPath);
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
      const parentResults = junit === null ? [] : parseJunit(junit);
      // Only a file the parent could load can register *fewer* tests there than
      // on the change. A file that did not load is already one whole-file
      // failure, and comparing its empty parent list against the change would
      // restate it once per test. It is still enumerated when a waiver is
      // present, because the names the change registers are the only test list a
      // whole-file waiver can be judged against.
      const enumerateChange =
        !checkoutDiffers && (parentResults.length > 0 || parsed.waivers.length > 0);
      const changeResults = enumerateChange
        ? changeSideResults(repo, file, join(outDir, `${copied.length}-change.xml`), problems)
        : [];
      const classified = classifyFileRun(
        fileRun,
        parsed.waivers,
        changeResults.flatMap((changeResult) => [changeResult.name, displayName(changeResult)]),
      );
      const unregistered =
        parentResults.length === 0
          ? { verdicts: [], usedWaiverLines: new Set<number>() }
          : unregisteredVerdicts(file, parentResults, changeResults, parsed.waivers);
      verdicts.push(...classified.verdicts, ...unregistered.verdicts);
      const usedLines = new Set([...classified.usedWaiverLines, ...unregistered.usedWaiverLines]);
      verdicts.push(...unusedWaiverVerdicts(file, parsed.waivers, usedLines));
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

export const VERDICT_GUIDE: ReadonlyArray<{ name: VerdictName; title: string; fixes: readonly string[] }> = [
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
      "land the module/export/fixture the test needs on the base branch in its own change, then rebase — the parent is the merge-base, so a commit inside this change is still after it and the import stays broken",
      "or point the gate at a parent that already has it: `bun scripts/red-on-parent.ts --base <rev>`",
      "if the missing module IS the change (a rename, a moved file), add `// red-on-parent-waive: \"<test name>\" — rename: the test moved with the file`",
    ],
  },
  {
    name: "NOT_ON_PARENT",
    title: "the change registers a test the parent's run never reported, so there is no red to judge for it",
    fixes: [
      "build the test so the parent registers it too — the gate has to run it on the parent before it can trust the red",
      "if the parent genuinely cannot register it, add `// red-on-parent-waive: \"<test name>\" — <why the parent cannot run it>`",
    ],
  },
  {
    name: "RUN_INCOMPLETE",
    title: "the test run did not finish, so there is no result to judge",
    fixes: [
      "re-run the gate — a timeout or a failed process start says nothing about the change",
      "no waiver covers this: a waiver says why a test is green on the parent, not why no result arrived",
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
    // A waiver-line problem and a run problem (a `--base` or `--head` the gate
    // cannot use) both land here, and only the first kind is about a waiver.
    // Waiver entries name their own file and line, so one accurate heading
    // covers both without misfiling a ref problem under a waiver heading.
    lines.push("", "PROBLEMS (any entry here fails the run)");
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
  const order: VerdictName[] = [
    "RIGHT_REASON_RED",
    "WRONG_REASON_RED",
    "NOT_ON_PARENT",
    "GREEN_ON_PARENT",
    "WAIVER_MISFILED",
    "RUN_INCOMPLETE",
  ];
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

export function main(argv: string[]): number {
  const refusal = bunOnlyRefusal();
  if (refusal !== null) {
    process.stderr.write(refusal);
    return 2;
  }
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
