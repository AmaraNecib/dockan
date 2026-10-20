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
 * The discrimination that makes the gate possible, measured on bun 1.4.3 (the
 * `packageManager` pin, so this is the bun CI installs) and re-checked on 1.4.2
 * (a dev machine's global bun):
 *
 *   - a load error and a real assertion failure BOTH exit 1;
 *   - bun writes the junit report only when the file loaded at all, so a
 *     missing report means "the parent could not load this file";
 *   - a real assertion red reports `<failure type="AssertionError">`, and a
 *     `beforeEach` / `beforeAll` throw reports `<failure type="Error">`. The
 *     `type` attribute is the whole discriminator on 1.4.3. An earlier version
 *     of this gate also required `assertions != 0`, justified by a 1.3.14 probe
 *     where every failure was typed `AssertionError`; on the pinned 1.4.3 that
 *     counter is not load-bearing, and it misread a `node:assert` red (also
 *     `AssertionError`, but `assertions="0"`) as a wrong-reason red. The
 *     measured table and the residual hole are on `isAssertionRed`.
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
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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
/** The bun this process is running on, which is the bun every child run inherits. */
export function bunVersion(): string {
  // SAFETY: `process.versions` is a plain object and bun adds a `bun` key to it.
  return (process.versions as { bun?: string }).bun ?? "unknown";
}

const WAIVER_MARKER = "red-on-parent-waive";
const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;
/** The cold `bun install` in the base worktree. Inside the lock, so the lock
 * wait budget has to cover it. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** The slack a waiting run gets past the work it knows can be inside the lock. */
export const LOCK_WAIT_SLACK_MS = 60_000;

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
   * matchers ran. null when the attribute is absent. Recorded, not consulted:
   * measured on bun 1.4.3 it is `0` for a `node:assert` red as well as for a
   * hook throw, so it cannot separate them — the failure `type` does that.
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
  | "RED_ON_CHANGE"
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
  waivers: Waiver[];
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
  /** Problems the file's waivers raise on their own (a waiver covering every test). */
  problems: string[];
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
 * The `file` attribute of the suite enclosing the testcase starting at `index`.
 *
 * bun's junit puts `file` on the outermost suite and nests one suite per
 * `describe` without repeating it, so the nearest opening tag that carries one
 * is the file this testcase came from.
 */
function enclosingSuiteFile(xml: string, index: number): string | null {
  const openings = [...xml.slice(0, index).matchAll(/<testsuite\b([^>]*)>/gu)];
  for (let position = openings.length - 1; position >= 0; position -= 1) {
    const file = attribute(openings[position]?.[1] ?? "", "file");
    if (file !== null) return file;
  }
  return null;
}

/** Whether a junit `file` attribute names the test file the gate is judging. */
function sameTestFile(reported: string, gated: string): boolean {
  const normalise = (path: string): string => path.split("\\").join("/");
  const reportedPath = normalise(reported);
  const gatedPath = normalise(gated);
  // bun reports the path relative to the cwd it ran in, so a gate that ran from a
  // workspace subdirectory sees `src/x.test.ts` for `apps/api/src/x.test.ts`.
  return (
    reportedPath === gatedPath ||
    gatedPath.endsWith(`/${reportedPath}`) ||
    reportedPath.endsWith(`/${gatedPath}`)
  );
}

/**
 * Read bun's junit report. The report nests `<testsuite>` per `describe`, so
 * testcases are matched anywhere in the document; `classname` carries the
 * chain, reversed and joined with " > ".
 */
export function parseJunit(xml: string, onlyFile?: string): TestResult[] {
  const results: TestResult[] = [];
  const testcase = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu;
  for (const match of xml.matchAll(testcase)) {
    // No file filter: the gate imports exactly the file it judges, so every
    // testcase in its report belongs to that file. `onlyFile` is for callers
    // that ran a bare path filter instead — bun's positional argument is a
    // *substring* filter, so `cart.test.ts` matches `cart.test.tsx` too, and
    // those testcases belong to a file the caller is not judging.
    if (onlyFile !== undefined) {
      const reported = enclosingSuiteFile(xml, match.index ?? 0);
      if (reported !== null && !sameTestFile(reported, onlyFile)) continue;
    }
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
    // A test that is red on the change is broken, and a waiver says why a test
    // is green on the parent: it cannot excuse a broken test.
    case "RED_ON_CHANGE":
    case "WAIVER_MISFILED":
    case "RUN_INCOMPLETE":
      return false;
  }
}

function matches(waiver: Waiver, result: TestResult): boolean {
  const re = new RegExp(waiver.pattern, "u");
  return re.test(displayName(result)) || re.test(result.name);
}

/**
 * Waivers that match every test in a file with more than one test, and so
 * excuse the whole file.
 *
 * `// red-on-parent-waive: ".*"` matches all three tests of a three-test file,
 * which is the broad file-level skip the design forbids: the pattern names no
 * test, so a reviewer cannot tell which one it was written for, and every
 * characterization test in the file drops out of the "must be red" check at
 * once. The design does allow several tests to share one waiver line, and that
 * still works — the line is refused only when it covers the whole file. A
 * one-test file is exempt, because there "the only test" and "the test it
 * names" are the same thing.
 */
function fileLevelWaiverProblems(
  file: string,
  waivers: Waiver[],
  results: TestResult[],
): string[] {
  if (results.length < 2) return [];
  return waivers
    .filter((waiver) => results.every((result) => matches(waiver, result)))
    .map(
      (waiver) =>
        `${file}: the waiver on line ${waiver.line} matches all ${results.length} tests in this file, so it is a file-level skip — name the test it is for`,
    );
}

function classifyResult(
  file: string,
  result: TestResult,
  waiver: Waiver | null,
  matching: Waiver[],
): Verdict {
  const test = displayName(result);
  if (result.status === "skipped") {
    return {
      file,
      test,
      name: "GREEN_ON_PARENT",
      detail: `the test is skipped (or a todo) on the parent, so it pins nothing`,
      waiver,
      waivers: matching,
    };
  }
  if (result.status === "passed") {
    return {
      file,
      test,
      name: "GREEN_ON_PARENT",
      detail: `the test passes on the parent, so it pins no behaviour the change adds`,
      waiver,
      waivers: matching,
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
        waivers: matching,
      };
    }
    return {
      file,
      test,
      name: "RIGHT_REASON_RED",
      detail: `fails on the parent with an assertion on the behaviour the change adds`,
      waiver: null,
      waivers: [],
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
    waivers: matching,
  };
}

/**
 * A real assertion red, by the only signal bun gives us: the failure type.
 *
 * Measured, in a scratch directory, on the pinned bun 1.4.3:
 *
 * | test shape                                | type            | assertions |
 * | ----------------------------------------- | --------------- | ---------- |
 * | `expect(1).toBe(2)`                       | AssertionError  | 1          |
 * | `expect(...).toThrow("ZERO")` mismatch    | AssertionError  | 1          |
 * | `assert.equal(1, 2)` (node:assert)        | AssertionError  | 0          |
 * | `throw new Error("boom")` in the body     | Error           | 0          |
 * | `throw new Error("x")` in `beforeEach`    | Error           | 0          |
 * | `throw new Error("x")` in `beforeAll`     | Error           | 0          |
 * | `expect.fail(...)`                        | TypeError       | 0          |
 *
 * So `type` alone separates a hook throw from an assertion red, and the
 * counter separates nothing: it is 0 for a `node:assert` red too. This gate
 * used to require `assertions != 0` on the strength of a bun 1.3.14 probe,
 * where every failure was typed `AssertionError` — a version CI does not run
 * (the repo pins `packageManager: bun@1.4.3`). On 1.4.3 that clause bought
 * nothing and cost a genuine `node:assert` red its RIGHT REASON RED verdict.
 *
 * The residual hole, stated honestly because junit cannot close it: an
 * assertion that fails *inside a hook* is indistinguishable from one that
 * fails in the body — a hook doing `expect(...)` reports `AssertionError` with
 * assertions="1", and a hook doing `assert.equal` reports it with "0", so no
 * counter rule ever caught the first shape and the second only by accident.
 * `expect.fail` on 1.4.3 is not a function at all (TypeError, assertions="0"),
 * so a test that calls it needs a waiver; nothing in this repo does.
 */
function isAssertionRed(result: TestResult): boolean {
  return result.failureType === "AssertionError";
}

/** Why a failing test is not a right-reason red, in wording bun does not vary. */
function failureReason(result: TestResult): string {
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
  changeResults: TestResult[] = [],
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
      waivers: [],
    });
    return { verdicts, usedWaiverLines: used, problems: [] };
  }

  if (run.junit === null) {
    const reason = loadFailureReason(run.stdout);
    const waiverProblems = fileLevelWaiverProblems(run.file, waivers, changeResults);
    // Nothing ran on the parent, so its test list is empty and a waiver cannot
    // be judged against it. The change side still knows which tests the file
    // registers, and that is the only list available here. This used to attach
    // `waivers[0]` whatever it named and mark every waiver used, so a file that
    // never loaded printed PASS with no test judged at all.
    //
    // A waiver names the tests it excuses, not the file it sits in. With the
    // change-side names in hand, every test is judged on its own: the ones a
    // waiver names are excused, the ones no waiver names stay unexcused and
    // fail. `.some` over the change-side names used to excuse the whole file
    // for one waiver, and the other tests in it were never judged and never
    // named — the broad file-level skip the design doc forbids.
    if (changeResults.length === 0) {
      const explainsNothing =
        waivers.length > 0
          ? " — and no waiver here names a test the change registers (none found)"
          : "";
      verdicts.push({
        file: run.file,
        test: "(whole file)",
        name: "WRONG_REASON_RED",
        detail: `${reason}${explainsNothing}`,
        waiver: null,
        waivers: [],
      });
      return { verdicts, usedWaiverLines: used, problems: waiverProblems };
    }
    for (const result of changeResults) {
      const matching = waivers.filter((candidate) => matches(candidate, result));
      const waiver = matching[0] ?? null;
      for (const candidate of matching) used.add(candidate.line);
      verdicts.push({
        file: run.file,
        test: displayName(result),
        name: "WRONG_REASON_RED",
        detail: `${reason} — the parent never ran this test, so nothing was judged there${
          waiver === null
            ? ", and no waiver names it"
            : ` — covered by the waiver on line ${waiver.line}`
        }`,
        waiver,
        waivers: matching,
      });
    }
    return { verdicts, usedWaiverLines: used, problems: waiverProblems };
  }

  // No file filter, for the same reason the caller passes none: the run
  // imported exactly this file, and the report's suite name is the entry.
  const results = parseJunit(run.junit);
  // The file-level check asks whether a waiver excuses the *whole file*, and
  // the file is the change's, not the parent's. A test registered behind a
  // condition the change newly satisfies is absent from the parent's report, so
  // judging against that list calls a waiver that covers two of the change's
  // three tests a file-level skip — and fails a correct change. The change-side
  // run is the only list of every test the file declares. When it enumerated
  // nothing, that run has already produced a problem of its own and this verdict
  // is added to an already-failing file, so falling back to the parent's list
  // costs nothing but keeps the message readable.
  const changeSideList = changeResults.length > 0 ? changeResults : results;
  const waiverProblems = fileLevelWaiverProblems(run.file, waivers, changeSideList);
  // A waiver is used when it matches a test, not when it is the one this run
  // happened to pick. A broad pattern ("case") matches "case one" as well as a
  // narrower "case one" does, and attaching only the first made the second look
  // like it matched no test at all — a factually wrong message on a file that was
  // fine. Every match is kept, so the report can show each reason.
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
      waivers: [],
    });
    return { verdicts, usedWaiverLines: used, problems: waiverProblems };
  }

  for (const result of results) {
    const matching = waivers.filter((candidate) => matches(candidate, result));
    const waiver = matching[0] ?? null;
    if (waiver !== null) used.add(waiver.line);
    verdicts.push(classifyResult(run.file, result, waiver, matching));
  }
  return { verdicts, usedWaiverLines: used, problems: waiverProblems };
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
    const matching = waivers.filter((candidate) => matches(candidate, result));
    const waiver = matching[0] ?? null;
    // Every pattern that matched is used, not only the first: the rest would
    // otherwise be reported as matching no test in the file, and a correctly
    // waived run would fail on a waiver that did exactly its job.
    for (const candidate of matching) used.add(candidate.line);
    verdicts.push({
      file,
      test,
      name: "NOT_ON_PARENT",
      detail:
        "the change registers this test and the parent's run never reported it, so the gate has no red to judge for it",
      waiver,
      waivers: matching,
    });
  }
  return { verdicts, usedWaiverLines: used, problems: [] };
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
      waivers: [waiver],
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

/** A file whose name says it holds tests. */
const TEST_LIKE_BASENAME = /\.(test|spec)(\.[cm]?[jt]sx?)?$/u;

/**
 * The source with its comments removed.
 *
 * A commented-out import is not an import, and a text scan that cannot tell
 * the two reads `// import "./setup.test.ts"` as a real one — which would name
 * an import that never happens and fail a correct change. String literals are
 * kept: a specifier lives inside one, and a `//` inside a string is not a
 * comment.
 */
function withoutComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index]!;
        if (inner === "\\") {
          out += inner + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        out += inner;
        index += 1;
        if (inner === quote) break;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Whether an import clause names only types, and is therefore erased before
 * the file runs.
 *
 * `import type { X } from` and `export type { X } from` are erased, and so is
 * `import { type X } from` — but `import { type X, Y } from` still imports Y
 * at runtime, and so does `import X, { type Y } from`.
 */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return true;
  if (!trimmed.startsWith("{")) return false;
  const end = trimmed.lastIndexOf("}");
  if (end < 0) return false;
  const entries = trimmed
    .slice(1, end)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.length > 0 && entries.every((entry) => entry === "type" || entry.startsWith("type "));
}

/**
 * The test files a source file imports, directly.
 *
 * Bun names every testcase of a run after the entry file — measured on bun
 * 1.4.2 and on the 1.4.3 CI installs, the `<testcase file=...>` attribute
 * carries the entry's name for every case, including the ones a second file
 * contributed. So a file that imports another test file brings that file's
 * cases into its own report and the report cannot say whose case it holds.
 * The import is found in the source instead, because the report cannot be
 * asked.
 *
 * Two shapes are not seen, and both mix the reports the same way: a dynamic
 * import whose specifier is a variable (`await import(name)`), and an import
 * of a module that itself imports a test file. They are known limits of a
 * source scan, not a claim that the gate covers them.
 */
export function importedTestFiles(source: string): string[] {
  const code = withoutComments(source);
  const specifiers = new Set<string>();
  const add = (specifier: string | undefined): void => {
    if (specifier === undefined) return;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
    const name = specifier.split("/").pop() ?? "";
    if (!TEST_LIKE_BASENAME.test(name)) return;
    specifiers.add(specifier);
  };
  // `import ... from "x"` and `export ... from "x"`. The clause says whether
  // the statement imports anything at runtime.
  for (const match of code.matchAll(/\b(?:import|export)\s+([^;'"]*?)\s*from\s*["']([^"']+)["']/gu)) {
    if (isTypeOnlyClause(match[1] ?? "")) continue;
    add(match[2]);
  }
  for (const match of code.matchAll(/\bimport\s*["']([^"']+)["']/gu)) add(match[1]);
  for (const match of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu)) add(match[1]);
  for (const match of code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/gu)) add(match[1]);
  return [...specifiers];
}

/** A test file of any kind, gated or not. */
export function isTestLikePath(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path.replaceAll("\\", "/"));
}

/** Why the gate does not gate this path, or null when the path is in scope. */
export function skipReason(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (!/^(apps|packages)\//u.test(normalized)) return "outside apps/ and packages/";
  if (normalized.includes("/e2e/") || normalized.includes("/tests/e2e/")) {
    return "under an e2e directory";
  }
  if (/\.spec\.[cm]?[jt]sx?$/u.test(normalized)) return "a Playwright spec";
  return null;
}

/** A test file the diff touches and the gate does not gate. */
export type SkippedTestFile = { path: string; reason: string };

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
 *
 * The file is selected through a one-line entry beside the junit report, not by
 * passing its path to `bun test`: that positional argument is a substring
 * filter over the discovered files, so `cart.test.ts` also runs `cart.test.tsx`.
 * The sibling's `beforeAll` can then hang or rewrite a shared fixture, and this
 * run reports the added file as RUN INCOMPLETE or judges it against a tree the
 * sibling changed. Importing the one file is the only exact selection bun has,
 * and it also means the report holds one file's testcases and needs no filter by
 * suite name — bun names the report's suite after the entry, not the file.
 *
 * Only the working directory survives from that: the path is inside the entry,
 * so nothing here passes it to bun a second time.
 */
function runFrom(root: string, file: string, junitPath: string): CommandResult {
  const here = relativeToWorkspace(root, file);
  const entry = join(dirname(junitPath), `${basename(junitPath, ".xml")}.entry.test.ts`);
  const absolute = join(root, file).split("\\").join("/");
  writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(absolute).href)};\n`);
  return run(
    BUN,
    ["test", entry, "--reporter=junit", `--reporter-outfile=${junitPath}`],
    here.cwd,
    testTimeoutMs(),
  );
}

/** The directory bun must run a test file from. */
type WorkspaceRun = { cwd: string };

function relativeToWorkspace(root: string, file: string): WorkspaceRun {
  const parts = file.split("/");
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    const dir = parts.slice(0, depth).join("/");
    if (existsSync(join(root, dir, "bunfig.toml"))) {
      return { cwd: join(root, dir) };
    }
  }
  return { cwd: root };
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

/** Write the list of files copied into the base worktree. */
export function writeManifest(path: string, copied: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(copied, null, 2)}\n`);
}

export function readManifest(path: string): string[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The gate writes this file, so a manifest it cannot read was written by
    // something else. The run cannot clear what it does not know about, and it
    // cannot safely guess either: it says so and stops.
    throw new GateError(`the copy manifest at ${path} is not readable JSON`);
  }
  if (!Array.isArray(parsed)) return [];
  // SAFETY: the gate writes this file as a JSON array of path strings, and
  // that is the contract this cast states. Every entry is checked again
  // against the worktree before it names a file, so an entry that is not a
  // usable path can remove nothing.
  return (parsed as string[]).filter((entry) => entry.length > 0);
}

/**
 * The file a manifest entry names, or null when it names something outside the
 * worktree.
 *
 * The manifest lives under the cache root, which is a shared temp directory
 * unless `RED_ON_PARENT_CACHE` says otherwise, so an entry in it is not a path
 * the gate may delete: `join` normalises `..`, and an entry like
 * `../../../apps/api/src/index.ts` would delete a file outside the worktree.
 */
export function manifestTarget(worktree: string, relative: string): string | null {
  if (relative.length === 0) return null;
  const root = resolve(worktree);
  let target: string;
  try {
    target = resolve(root, relative);
  } catch {
    // A hand-edited manifest can hold something that is not a path at all. It
    // names no file, so nothing is removed.
    return null;
  }
  if (target === root) return null;
  return target.startsWith(`${root}${sep}`) ? target : null;
}

/**
 * Copy one added file into the base worktree and name it in the manifest.
 *
 * The manifest is written on every copy, not after the loop: a run that dies
 * half way — a `git show` that fails, an interrupt — would otherwise leave the
 * copied files in the cached worktree with nothing naming them, and the next
 * run's `bun test <path>` (a substring filter over the discovered files) would
 * pick the orphan up and judge a file that is not part of the change.
 */
export function copyIntoBaseWorktree(
  manifest: string,
  worktree: string,
  file: string,
  source: string,
  copied: string[],
): void {
  const destination = join(worktree, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
  copied.push(file);
  writeManifest(manifest, copied);
}

function clearPreviousCopies(repo: string, worktree: string, baseSha: string): void {
  const manifest = manifestPath(repo, baseSha);
  for (const relative of readManifest(manifest)) {
    const target = manifestTarget(worktree, relative);
    // A path that resolves outside the worktree names nothing the gate may
    // delete, so it is skipped rather than removed.
    if (target === null) continue;
    // A manifest entry may name a directory. `rmSync` on a directory without
    // `recursive` throws EISDIR and kills the run before any verdict is
    // printed, so skip directory entries instead of removing them.
    if (existsSync(target) && statSync(target).isDirectory()) continue;
    rmSync(target, { force: true });
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

/**
 * What a lock directory says about its holder, and how strongly.
 *
 * `holder` names a pid whose process is gone (ESRCH). `unclaimed` is a
 * directory with no pid file that is older than the grace: the only evidence a
 * crash between `mkdirSync` and the pid write leaves behind.
 */
type LockObservation =
  | { kind: "alive" }
  | { kind: "holder"; pid: number }
  | { kind: "unclaimed"; mtimeMs: number };

/**
 * Observe the lock without deciding, so a reclaimer can bind its rename to the
 * exact state it judged stale.
 *
 * The pid file's existence is not checked separately from reading it: a release
 * can `rmSync` the directory between the two calls, and an unguarded
 * `readFileSync` then throws ENOENT out of `acquireWorktreeLock` (which only
 * catches `EEXIST`) and kills the run with a stack trace instead of retrying.
 * A vanished pid file is "not gone": the waiter retries and the next pass either
 * takes the lock or judges the directory it now sees.
 */
export function observeLockHolder(lockPath: string): LockObservation {
  const pidFile = join(lockPath, "pid");
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf8");
  } catch {
    // No pid file. If the directory is gone too, or young, there is no evidence
    // of a dead holder: retry rather than reclaim.
    try {
      const mtimeMs = statSync(lockPath).mtimeMs;
      return Date.now() - mtimeMs > LOCK_PID_GRACE_MS
        ? { kind: "unclaimed", mtimeMs }
        : { kind: "alive" };
    } catch {
      return { kind: "alive" };
    }
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "alive" };
  try {
    process.kill(pid, 0);
    return { kind: "alive" };
  } catch (error) {
    // ESRCH: no such process, so the holder died without releasing. EPERM: it
    // exists but belongs to another user — treat that as alive.
    // SAFETY: `process.kill` is the only throw source here and rejects with a
    // NodeJS.ErrnoException, whose string `code` is what this test reads.
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? { kind: "holder", pid }
      : { kind: "alive" };
  }
}

/** Whether the process that wrote this lock's pid file is gone. */
export function lockHolderIsGone(lockPath: string): boolean {
  return observeLockHolder(lockPath).kind !== "alive";
}

/**
 * Remove the lock `observed` described, unless the name now holds a different,
 * live lock.
 *
 * `renameSync` is the only step that can race: between observing a dead holder
 * and renaming its directory away, another waiter can reclaim the same lock and
 * take it, so the name about to be renamed can hold a fresh lock by then. The
 * rename is therefore a claim on the directory, verified against `observed`, and
 * undone when it moved something else. Without the check the second waiter
 * renamed and deleted the first waiter's live lock, and both runs then held "the
 * lock" and shared one worktree.
 */
export function reclaimStaleLock(lockPath: string, observed: LockObservation): void {
  if (observed.kind === "alive") return;
  const tombstone = `${lockPath}.stale-${process.pid}`;
  try {
    renameSync(lockPath, tombstone);
  } catch {
    // Another run broke it (or reclaimed it) first; the retry takes the lock.
    return;
  }
  const moved = observeLockHolder(tombstone);
  const sameLock =
    observed.kind === "holder"
      ? moved.kind === "holder" && moved.pid === observed.pid
      : moved.kind === "unclaimed" && moved.mtimeMs === observed.mtimeMs;
  if (sameLock) {
    rmSync(tombstone, { recursive: true, force: true });
    return;
  }
  // We moved a lock that is not the one we judged stale — a live run now holds
  // it. Put it back; if the name is taken again, leave the directory where it is
  // rather than delete a live lock.
  try {
    renameSync(tombstone, lockPath);
  } catch {
    // The tombstone stays behind, named for a run that is not its holder.
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
      const observed = observeLockHolder(lockPath);
      if (observed.kind !== "alive") {
        reclaimStaleLock(lockPath, observed);
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

/**
 * Put a reused base worktree back to the commit it is keyed to.
 *
 * The worktree is cached per base SHA, and the tests that ran in it are the
 * change's own tests. One that writes a fixture — or a source file it imports —
 * leaves the tree changed, and the next run then judges the parent against that
 * changed tree instead of the commit. Only the files the last run copied are
 * known by name, so the rest is restored the way git can: tracked files back to
 * the commit, untracked files removed. `reset --hard` rather than `checkout -- .`
 * because a test that ran `git add` leaves the change in the index, and a
 * checkout from the index restores the change it was meant to discard. Ignored
 * files are left alone, which is what keeps `node_modules` from being
 * reinstalled on every run.
 */
export function resetBaseWorktree(worktree: string): void {
  gitText(worktree, ["reset", "--hard", "HEAD"]);
  gitText(worktree, ["clean", "-fd"]);
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
      resetBaseWorktree(worktree);
      return { path: worktree, created: false };
    }
  }
  if (existsSync(worktree)) {
    rmSync(worktree, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
  }
  rmSync(manifestPath(repo, baseSha), { force: true });
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

/**
 * How long a `bun test` run may take before the gate calls it unfinished.
 *
 * `RED_ON_PARENT_TEST_TIMEOUT_MS` overrides it. A hard-coded two minutes
 * cannot be tested: a fixture whose test hangs would have to wait that long
 * to prove that a run that did not finish is RUN INCOMPLETE and that no
 * waiver covers it.
 */
export function testTimeoutMs(): number {
  const override = Number.parseInt(process.env.RED_ON_PARENT_TEST_TIMEOUT_MS ?? "", 10);
  if (Number.isInteger(override) && override > 0) return override;
  return DEFAULT_TEST_TIMEOUT_MS;
}

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
  /** Test files the diff touches that the gate does not gate, with the reason. */
  skipped: SkippedTestFile[];
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
  const added: string[] = [];
  for (const path of changedPaths(repo, mergeBase, head)) {
    if (!isGatedTestPath(path)) continue;
    // Present at the parent => an edited file, never gated. Absent => added.
    if (git(repo, ["cat-file", "-e", `${mergeBase}:${path}`]).ok) continue;
    added.push(path);
  }
  return added.sort();
}

/** The paths the diff touches, with the raw bytes of every name. */
function changedPaths(repo: string, mergeBase: string, head: string): string[] {
  // `-z`: git quotes any path holding a non-ASCII byte, and a quoted
  // `"packages/core/src/caf\303\251.test.ts"` fails `isGatedTestPath` on both
  // its leading quote and its trailing one, so such a file would be skipped in
  // silence. NUL separation carries the raw bytes, so nothing is trimmed here.
  return gitText(repo, ["diff", "--name-only", "-z", "--no-renames", mergeBase, head])
    .split("\0")
    .filter((path) => path.length > 0);
}

/**
 * The test files the diff touches that the gate does not gate, with the reason.
 *
 * The report used to say "no added test files" whether the diff added none or
 * added five outside the gate's scope, so a change that added a test the gate
 * never looked at read as a change that added no test at all. This gate on its
 * own pull request is the case: it adds `scripts/red-on-parent.test.ts` and
 * gates nothing.
 */
export function skippedTestFiles(
  repo: string,
  mergeBase: string,
  head: string,
): SkippedTestFile[] {
  const added = new Set(addedTestFiles(repo, mergeBase, head));
  const skipped: SkippedTestFile[] = [];
  for (const path of changedPaths(repo, mergeBase, head)) {
    if (added.has(path)) continue;
    if (!isTestLikePath(path)) continue;
    skipped.push({ path, reason: skipReason(path) ?? "edited, not added" });
  }
  return skipped;
}

/**
 * Test files the working tree holds that HEAD does not. The gate reads HEAD, so
 * an uncommitted test file is invisible to it — and a run that judged nothing
 * must not pass.
 */
export function uncommittedTestFiles(repo: string): string[] {
  // `-z` for the same reason as `addedTestFiles`: porcelain quotes a non-ASCII
  // path, and the quoting hides it from `isGatedTestPath`.
  const entries = gitText(repo, ["status", "--porcelain", "-z", "--no-renames", "-uall"])
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .filter((path) => isGatedTestPath(path));
  // A file HEAD holds is either edited or deleted: the gate reads HEAD, and an
  // edited test file is out of scope by design. A file HEAD does NOT hold is
  // invisible to the gate, and that is the case that must not pass quietly.
  return entries.filter((path) => !git(repo, ["cat-file", "-e", `HEAD:${path}`]).ok);
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
export function changeSideResults(
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
  // Two runs per file, not one: the lock covers the parent-side run and the
  // change-side run the classifier compares it against. A budget of one run per
  // file expires while the holder is still doing the second, and the waiter is
  // told to wait for a run that has not finished — with a deadline that has.
  return INSTALL_TIMEOUT_MS + fileCount * 2 * testTimeoutMs() + LOCK_WAIT_SLACK_MS;
}

export function runGate(options: GateOptions): GateRun {
  const { repo, head, fresh } = options;
  const baseSha = gitText(repo, ["merge-base", options.base, head]).trim();
  const uncommitted = uncommittedTestFiles(repo);
  const files = addedTestFiles(repo, baseSha, head);
  const skipped = skippedTestFiles(repo, baseSha, head);
  // A test file the working tree holds and HEAD does not is invisible to the
  // gate: it is neither in the diff nor in the commit the gate reads. Naming
  // it was not enough — the run exited 0, so the file that was about to be
  // committed was judged by nothing. It is a problem now: any entry here fails
  // the run.
  const uncommittedProblems = uncommitted.map(
    (path) =>
      `${path}: is in the working tree but not in HEAD, so the gate cannot judge it — commit it and run again`,
  );
  // `merge-base(base, head)` is `head` itself when the base already contains the
  // change, so the diff is empty and the gate would print PASS having judged
  // nothing — indistinguishable from "this change adds no test". `--base HEAD`
  // after a local merge, or a gate wired into the target branch's own push job,
  // both land here and both look green forever.
  const headSha = gitText(repo, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
  const baseContainsHead = git(repo, ["merge-base", "--is-ancestor", headSha, options.base]).ok;
  if (files.length === 0) {
    const problems: string[] = [];
    if (baseContainsHead) {
      problems.push(
        `--base ${options.base} already contains ${head}: there is no change to gate, so this run would pass having judged nothing. Point --base at the branch this change targets.`,
      );
    }
    for (const problem of uncommittedProblems) problems.push(problem);
    return {
      baseSha,
      worktree: "(none)",
      worktreeCreated: false,
      installLog: "",
      files,
      verdicts: [],
      stdoutByFile: new Map(),
      problems,
      uncommitted,
      skipped,
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
    return gateBaseWorktree({ repo, head, baseSha, files, uncommitted, skipped, fresh });
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
  skipped: SkippedTestFile[];
  fresh: boolean;
}): GateRun {
  const { repo, head, baseSha, files, uncommitted, skipped, fresh } = input;
  const { path: worktree, created } = ensureBaseWorktree(repo, baseSha, fresh);
  const installLog = ensureBaseNodeModules(worktree);

  const outDir = mkdtempSync(join(tmpdir(), "dokan-red-on-parent-junit-"));
  const verdicts: Verdict[] = [];
  const stdoutByFile = new Map<string, string>();
  const problems: string[] = uncommitted.map(
    (path) =>
      `${path}: is in the working tree but not in HEAD, so the gate cannot judge it — commit it and run again`,
  );
  const copied: string[] = [];
  const manifest = manifestPath(repo, baseSha);
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
      const parsed = parseWaivers(source);
      for (const problem of parsed.problems) problems.push(`${file}: ${problem}`);
      // A file that imports another test file pulls that file's cases into its
      // own report, and bun names every case after the entry, so the report
      // cannot say whose test failed. Judging it would put the other file's
      // green case against this file — and demand a waiver for a test this
      // file does not contain. The gate names the import and judges nothing.
      const imports = importedTestFiles(source);
      if (imports.length > 0) {
        problems.push(
          `${file}: imports another test file (${imports.join(", ")}), so one run would report that file's cases as well and the gate could not tell whose test failed — this file was not judged; keep each file's cases in its own file`,
        );
        continue;
      }
      copyIntoBaseWorktree(manifest, worktree, file, source, copied);

      const junitPath = join(outDir, `${copied.length}.xml`);
      rmSync(junitPath, { force: true });
      const result = runFrom(worktree, file, junitPath);

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
      // No file filter: the run imported exactly this file, so every testcase in
      // the report is one this pass is judging (the report's suite name is the
      // entry, which is not the file's name).
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
      const classified = classifyFileRun(fileRun, parsed.waivers, changeResults);
      for (const problem of classified.problems) problems.push(problem);
      const unregistered =
        parentResults.length === 0
          ? { verdicts: [], usedWaiverLines: new Set<number>(), problems: [] }
          : unregisteredVerdicts(file, parentResults, changeResults, parsed.waivers);
      verdicts.push(...classified.verdicts, ...unregistered.verdicts);
      // A test that is red on the change as well is a broken test: it pins
      // nothing, and the guide used to promise that a right-reason red "passes
      // on the change" while nothing read the change side's status. The
      // change's own run is already made, so its statuses cost nothing to read.
      // Only an *unexcused* NOT ON PARENT row already fails the run, so only
      // that row makes a second RED ON CHANGE row redundant. When the NOT ON
      // PARENT row passes — a waiver excused it — the change-side red must still
      // be reported: a waiver says why the parent could not run the test, not
      // that the test works. Skipping it unconditionally printed PASS over a
      // test that fails on the change.
      const unexcusedNotOnParent = new Set(
        unregistered.verdicts
          .filter((verdict) => !verdictPasses(verdict))
          .map((verdict) => verdict.test),
      );
      for (const changeResult of changeResults) {
        if (changeResult.status !== "failed") continue;
        const test = displayName(changeResult);
        if (unexcusedNotOnParent.has(test)) continue;
        verdicts.push({
          file,
          test,
          name: "RED_ON_CHANGE",
          detail:
            "the test fails on the change as well, so it pins nothing the parent can be asked about",
          waiver: null,
          waivers: [],
        });
      }
      const usedLines = new Set([...classified.usedWaiverLines, ...unregistered.usedWaiverLines]);
      // A waiver can only be judged against tests the run actually enumerated.
      // When nothing was enumerated (a load failure with no change-side names,
      // or a run that could not judge the file), a waiver naming a real test
      // must not be reported misfiled: we do not know whether it names a real
      // test or not.
      if (changeResults.length > 0) {
        verdicts.push(...unusedWaiverVerdicts(file, parsed.waivers, usedLines));
      }
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
    skipped,
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
    name: "RED_ON_CHANGE",
    title: "the test fails on the change as well, so it pins nothing",
    fixes: [
      "run the test in your checkout and fix it — a test that is red on the change is broken, whatever the parent says",
      "if your working tree has uncommitted changes, commit them and run the gate again: the change's own run reads the working tree, not the commit",
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
    `red-on-parent: base ${run.baseSha.slice(0, 12)} (worktree ${run.worktree}${run.worktreeCreated ? ", created" : ", cached"}) · bun ${bunVersion()}`,
  );
  if (run.uncommitted.length > 0) {
    lines.push(
      `NOT JUDGED: ${run.uncommitted.length} test file(s) in the working tree are not in HEAD, so the gate cannot see them. Commit first: ${run.uncommitted.join(", ")}`,
    );
  }
  if (files === 0) {
    lines.push("no added test files this gate covers: nothing to gate");
    lines.push("added test files: 0");
    // The files the gate decided not to gate are named, with the reason. "No
    // added test files" used to cover both "this change adds no test" and "this
    // change adds five tests the gate never looked at".
    if (run.skipped.length > 0) {
      lines.push(
        "skipped test files (only *.test.* and *.spec.* names are recognised; a test file named any other way is not listed):",
      );
      for (const entry of run.skipped) lines.push(`  ${entry.path} — ${entry.reason}`);
    }
    // A run that judged nothing still owes its problems: an empty diff is the
    // shape a misconfigured `--base` produces, and swallowing the reason here is
    // what turned that misconfiguration into a green result.
    if (problems.length > 0) {
      lines.push("");
      lines.push("PROBLEMS (any entry here fails the run)");
      for (const problem of problems) lines.push(`  ${problem}`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (run.installLog.length > 0) lines.push(`installed the parent's dependencies: ${run.installLog}`);
  lines.push("");

  const fileWidth = Math.max(12, ...run.verdicts.map((v) => v.file.length));
  const testWidth = Math.max(12, ...run.verdicts.map((v) => v.test.length));
  lines.push(`${pad("FILE", fileWidth)}  ${pad("TEST", testWidth)}  ${pad("VERDICT", 18)}  WAIVED`);
  for (const verdict of run.verdicts) {
    // Two patterns can accept the same test, and a reviewer needs each reason.
    const waived =
      verdict.waivers.length === 0
        ? "-"
        : verdict.waivers.map((waiver) => `line ${waiver.line}`).join(", ");
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
  // The files the gate decided not to gate are named, with the reason: a
  // change that added a test the gate never looked at must not read as a
  // change that added no test.
  if (run.skipped.length > 0) {
    lines.push(
      "skipped test files (only *.test.* and *.spec.* names are recognised; a test file named any other way is not listed):",
    );
    for (const entry of run.skipped) lines.push(`  ${entry.path} — ${entry.reason}`);
  }
  const failed = failing.length > 0 || problems.length > 0;
  lines.push(failed ? "red-on-parent: FAIL" : "red-on-parent: PASS");
  return `${lines.join("\n")}\n`;
}

/** Every waiver that actually excused something, once, in file order. */
function usedWaiverList(verdicts: Verdict[]): Array<{ file: string; waiver: Waiver }> {
  const seen = new Set<string>();
  const used: Array<{ file: string; waiver: Waiver }> = [];
  for (const verdict of verdicts) {
    // Every matching waiver is listed, not only the first: the report exists so a
    // reviewer can read why each exception was accepted, and dropping the second
    // pattern hides its reason entirely.
    for (const waiver of verdict.waivers) {
      const key = `${verdict.file}:${waiver.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      used.push({ file: verdict.file, waiver });
    }
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
    "RED_ON_CHANGE",
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
      parsed.base = flagValue(argv, "--base", index);
      index += 1;
    } else if (arg.startsWith("--base=")) {
      parsed.base = inlineValue("--base", arg);
    } else if (arg === "--head") {
      parsed.head = flagValue(argv, "--head", index);
      index += 1;
    } else if (arg.startsWith("--head=")) {
      parsed.head = inlineValue("--head", arg);
    } else throw new GateError(`unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`);
  }
  return parsed;
}

/**
 * The value after a flag, refusing a missing or flag-shaped one.
 *
 * `--base` with no value used to leave `base === null`, which `resolveBase`
 * reads as "use origin/develop" — the gate then judged a different parent than
 * the one the caller named, and could PASS on a diff nobody asked about. A
 * missing value is a usage error, not a fallback.
 */
function flagValue(argv: string[], flag: string, index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new GateError(`${flag} needs a value\n\n${USAGE}`);
  }
  return value;
}

/** The value of an `--flag=value` argument, refusing an empty one. */
function inlineValue(flag: string, arg: string): string {
  const value = arg.slice(`${flag}=`.length);
  if (value.length === 0) throw new GateError(`${flag} needs a value\n\n${USAGE}`);
  return value;
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
    // Anything that is not a GateError is still "the gate could not run", not a
    // verdict. An uncaught throw exits 1, the same code as a legitimate gate
    // failure, so a caller that retries on 1 and gives up on 2 is misled. The
    // documented contract is 0 pass / 1 failed / 2 could not run; this makes it
    // true for a filesystem error as well as a typed refusal, and keeps the
    // stack in the log so a real bug is still diagnosable.
    if (error instanceof GateError) {
      process.stderr.write(`red-on-parent: cannot run — ${error.message}\n`);
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`red-on-parent: cannot run — unexpected error: ${detail}\n`);
      if (error instanceof Error && error.stack !== undefined) {
        process.stderr.write(`${error.stack}\n`);
      }
    }
    return 2;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
