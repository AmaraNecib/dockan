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
 *   - a hook that *asserts* rather than throws is not a wrong-reason red: it
 *     reports `AssertionError`, exactly like a test body, and the junit names
 *     the failing line. A helper a test body calls fails at that helper's
 *     line, so "the red is not the test's own" cannot be told from the report
 *     alone. The limit is stated here rather than guessed at, and the round-14
 *     test "a hook that asserts is read as the test's own red" pins it.
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
 * One file is refused outright: an added test file that imports another test
 * file. One run would report that file's cases as well, and bun names every
 * case after the entry, so the report cannot say whose test failed. The gate
 * names the import and judges nothing; no waiver covers that, because a waiver
 * over a report that mixes two files would be a lie.
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
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
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
  | "SKIPPED_ON_CHANGE"
  | "NOT_ON_CHANGE"
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
    // testcase in its report belongs to that file. `onlyFile` has no caller
    // inside the gate today — the entry file the gate generates imports one
    // test file, so the report never mixes two. It stays because the case it
    // covers is real: bun's positional argument is a *substring* filter, so a
    // caller that ran a bare path filter gets the cases of `cart.test.tsx`
    // alongside `cart.test.ts`. It is also the mechanism that would close the
    // gap the import scan leaves — a test file reached through a helper is
    // not seen by the scan, and its cases land in the report.
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
 * The last token in the code scanned so far, for telling a regex from a
 * division.
 *
 * A word run comes back whole so it can be matched against the keyword set.
 * With no word run the token is the single character before the spaces — `)`,
 * `]`, `}`, a quote, an operator — because that character is the whole answer
 * to the question being asked: can a value end here?
 *
 * Returning the empty string there was a lie the caller had to guess about.
 * In `const x = value() / total` followed on the same line by a block comment
 * that holds a fake import, the `)` produced no token, `slashStartsRegex` read
 * an empty token as "the start of the file, so a regex", and the division was
 * lexed as a regex literal ending at the block comment's opening delimiter.
 * The comment's text then survived the strip, the import scan found a test file
 * the source never imported, and the gate refused a valid file.
 */
function previousToken(out: string): string {
  let end = out.length;
  while (end > 0 && /\s/u.test(out[end - 1]!)) end -= 1;
  let start = end;
  while (start > 0 && /[\w$]/u.test(out[start - 1]!)) start -= 1;
  if (start === end && end > 0) return out[end - 1]!;
  return out.slice(start, end);
}

/** Tokens after which a `/` opens a regex literal rather than dividing. */
const REGEX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "typeof",
  "void",
  "yield",
]);

/**
 * Whether the `/` at the end of `out` starts a regex literal.
 *
 * A `/` is a regex only where a *value* cannot already stand: after an operator,
 * an opening bracket, a comma or a keyword like `return`, and never after an
 * identifier, a number, a closing bracket or a string. That test is what keeps
 * `const quote = /"/;` from being read as the start of a string: the `"` inside
 * it is a regex body character, and a scanner that does not know that blanks the
 * rest of the file from the `"` up to the next quote — including the waiver
 * comment the file really declared.
 */
function slashStartsRegex(out: string): boolean {
  const token = previousToken(out);
  // Nothing before it at all: a file — or a scan — that starts with a regex.
  // With a token in hand the character decides, which is why the empty string
  // is only ever the start of the input and never a closing bracket.
  if (token.length === 0) return true;
  if (REGEX_KEYWORDS.has(token)) return true;
  if (/^[\w$]/u.test(token)) return false;
  return "(,=:[!&|?{};+-*%<>^~".includes(token[token.length - 1]!);
}

/**
 * The index of the `/` that closes the regex literal starting at `start`, or
 * null when the run does not reach one on the same line.
 *
 * A `/` inside a character class does not close the literal, and neither does
 * an escaped one: `/[//]/` and `/\//` are both one regex.
 */
function regexLiteralEnd(source: string, start: number): number | null {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\n") return null;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      index += 1;
      continue;
    }
    if (char === "[") {
      inClass = true;
      index += 1;
      continue;
    }
    if (char === "/") return index;
    index += 1;
  }
  return null;
}

/**
 * The one scanner under both readers of a source file: the waiver parse and
 * the import scan. It is one function because there used to be two, character
 * for character the same machine with two different opinions about what to
 * keep, and a fix applied to one of them left the other misreading. One machine,
 * one place to be wrong.
 *
 * `"keep-line-comments"` is the waiver route. Waivers *are* line comments, so
 * they survive exactly; every other literal's contents become spaces. That is
 * what stops the parse from reading text that merely looks like a waiver: a
 * test that generates test source carries an embedded
 * `// red-on-parent-waive:` line inside a template literal, declares no waiver,
 * and a parse that reads the literal as one hands the file an outer waiver it
 * never wrote. `unusedWaiverVerdicts` then reports a waiver that matched nothing
 * and rejects a test whose red was good. Length is preserved character for
 * character, newlines included, so a problem's line number still points into the
 * file the author wrote.
 *
 * `"keep-code"` is the import route. A commented-out import is not an import,
 * and a text scan that cannot tell the two reads `// import "./setup.test.ts"`
 * as a real one — which names an import that never happens and fails a correct
 * change. String literals are kept here because a specifier lives inside one,
 * and a `//` inside a string is not a comment.
 *
 * A regex literal is neither a string nor a comment, and both routes depend on
 * getting it right. `const quote = /"/;` is one line of ordinary code, and a
 * scanner that takes its `"` for a string delimiter blanks everything up to the
 * next quote — which is whatever the author wrote below it, waiver comment
 * included. The file then reads as a test that declared no waiver at all, and a
 * characterization test whose red is legitimately on the parent is rejected as
 * GREEN_ON_PARENT. On the import route the same mistake ends a regex at a `*`,
 * which leaves a block comment's text standing as code.
 */
type MaskMode = "keep-line-comments" | "keep-code";

function maskSource(source: string, mode: MaskMode): string {
  const keepLineComments = mode === "keep-line-comments";
  let out = "";
  let index = 0;
  const blank = (char: string): string => (char === "\n" ? "\n" : " ");
  while (index < source.length) {
    const char = source[index]!;
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += keepLineComments ? source[index]! : blank(source[index]!);
        index += 1;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      out += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        out += blank(source[index]!);
        index += 1;
      }
      if (index < source.length) {
        out += "  ";
        index += 2;
      }
      continue;
    }
    if (char === "/" && slashStartsRegex(out)) {
      const closing = regexLiteralEnd(source, index);
      if (closing !== null) {
        const start = index;
        index = closing + 1;
        while (index < source.length && /[A-Za-z]/u.test(source[index]!)) index += 1;
        if (keepLineComments) {
          // The delimiters and the flags stay, so the next `/` is still read as
          // a division; only the body becomes spaces, so no quote or `//` in it
          // can start a string or a comment.
          out += "/";
          for (let inner = start + 1; inner < closing; inner += 1) out += blank(source[inner]!);
          out += "/" + source.slice(closing + 1, index);
        } else {
          // Whole, and for the other reason: `/[//]/` holds a `//` that is a
          // character class, not the start of a comment, and a scan that read
          // it as one would drop the rest of the line — the line a real import
          // could be on.
          out += source.slice(start, index);
        }
        continue;
      }
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index]!;
        if (inner === "\\") {
          out += keepLineComments
            ? blank(inner) + blank(source[index + 1] ?? " ")
            : inner + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (inner === quote) {
          out += quote;
          index += 1;
          break;
        }
        out += keepLineComments ? blank(inner) : inner;
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

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
  // The text under the scan is the file with its literals blanked out, so a
  // marker that is a string's contents is not a waiver the file declared.
  for (const raw of maskSource(text, "keep-line-comments").split(/\r?\n/u)) {
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
    case "SKIPPED_ON_CHANGE":
    case "NOT_ON_CHANGE":
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

/**
 * The verdicts the change's own run adds to the parent's.
 *
 * The parent's report says what happened on the parent. Two things about the
 * change are only visible from the change's side, and both can turn a run that
 * looks green into one that judged nothing:
 *
 * - a test that is red on the change as well is a broken test: it pins
 *   nothing, and a waiver says why the *parent* could not run it, not that the
 *   test works;
 * - a test the change *skips* never runs there, so it pins nothing either.
 *   `test.skipIf(condition)` runs on the parent — where the condition the
 *   change satisfies is absent — and is skipped on the change, so the parent's
 *   red says nothing about a test the change never executes.
 *
 * A right-reason red only passes when the change's side agrees the test runs
 * there, and the change's status is read independently of the parent's
 * waivers.
 */
export function changeSideVerdicts(
  file: string,
  parentVerdicts: Verdict[],
  changeResults: TestResult[],
): Verdict[] {
  const verdicts: Verdict[] = [];
  // Only an *unexcused* NOT ON PARENT row makes a RED ON CHANGE row
  // redundant: that row already fails the run, so the second row would say the
  // same thing twice. A waived one does not — the waiver explains the parent,
  // and the change's own status is a separate question.
  const unexcusedNotOnParent = new Set(
    parentVerdicts
      .filter((verdict) => verdict.name === "NOT_ON_PARENT" && !verdictPasses(verdict))
      .map((verdict) => verdict.test),
  );
  const parentByTest = new Map<string, Verdict>();
  for (const verdict of parentVerdicts) parentByTest.set(verdict.test, verdict);
  for (const changeResult of changeResults) {
    const test = displayName(changeResult);
    if (changeResult.status === "failed") {
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
      continue;
    }
    if (changeResult.status !== "skipped") continue;
    // A test the change skips does not run there, so the change does not
    // exercise it. That is fatal when the parent's own run judged the test —
    // its red was about that test — and it is just as fatal when the parent
    // never judged it at all: a load failure a waiver excuses, or a test the
    // parent never registered. The test then runs nowhere, and the file as
    // committed pins nothing. Only a parent verdict that already fails the run
    // on its own suppresses the row.
    const parentVerdict = parentByTest.get(test);
    const alreadyFailing =
      parentVerdict !== undefined &&
      (parentVerdict.name === "WAIVER_MISFILED" ||
        parentVerdict.name === "RUN_INCOMPLETE" ||
        (parentVerdict.name === "NOT_ON_PARENT" && !verdictPasses(parentVerdict)));
    if (alreadyFailing) continue;
    verdicts.push({
      file,
      test,
      name: "SKIPPED_ON_CHANGE",
      detail:
        "the test is skipped on the change, so it never runs there and pins nothing — the parent's red was about a test the change does not execute",
      waiver: null,
      waivers: [],
    });
  }
  return verdicts;
}

/**
 * The module the parent does not have, when the file failed to load for that
 * reason. Bun says `Cannot find module './helper' from '<the file>'`.
 */
export function missingModule(stdout: string): string | null {
  const match = /Cannot find module ['"]([^'"]+)['"]/u.exec(stdout);
  return match?.[1] ?? null;
}

/**
 * The export the parent does not have, when the file failed to load for that
 * reason. Bun says `SyntaxError: Export named 'guard' not found`.
 */
export function missingExport(stdout: string): string | null {
  const match = /Export named ['"]([^'"]+)['"] not found/u.exec(stdout);
  return match?.[1] ?? null;
}

export function loadFailureReason(stdout: string): string {
  if (/Ran 0 tests/u.test(stdout)) return "the file declares no tests";
  // The report says what the parent was missing, not only that it could not
  // load the file. A reviewer reading a waived row has to judge the waiver,
  // and "the parent could not load the file" does not tell them what to fix.
  const module = missingModule(stdout);
  if (module !== null) {
    return `the parent could not load the file (the parent has no ${module})`;
  }
  const exported = missingExport(stdout);
  if (exported !== null) {
    return `the parent could not load the file (the parent has no export ${exported})`;
  }
  if (/# Unhandled error between tests/u.test(stdout)) {
    return `the parent could not load the file (see the transcript below)`;
  }
  return "bun wrote no junit report, so the file did not run to completion";
}

/**
 * The tests the parent's run registered and the change's run did not.
 *
 * Both runs read the same file; only the sources differ. A test the parent's
 * run registered and the change's run did not is a test the change does not
 * execute: the parent's red was about it, and the file as committed runs fewer
 * tests than the gate judged. Nothing else reports this — the NOT ON PARENT
 * row is the other direction (the change registers a test the parent never
 * reported), and a change that registers no test at all produces no change-side
 * name for that row to compare against.
 */
export function notRegisteredOnChange(
  file: string,
  parentResults: TestResult[],
  changeResults: TestResult[],
): Verdict[] {
  // Counts, not a set: a loop can register the same display name more than
  // once, and the extra case is a test of its own.
  const onChange = new Map<string, number>();
  for (const result of changeResults) {
    const name = displayName(result);
    onChange.set(name, (onChange.get(name) ?? 0) + 1);
  }
  const verdicts: Verdict[] = [];
  for (const result of parentResults) {
    const test = displayName(result);
    const remaining = onChange.get(test) ?? 0;
    if (remaining > 0) {
      onChange.set(test, remaining - 1);
      continue;
    }
    verdicts.push({
      file,
      test,
      name: "NOT_ON_CHANGE",
      detail:
        "the parent's run registered this test and the change's run did not, so the change does not execute it — the parent's red was about a test the change does not run",
      waiver: null,
      waivers: [],
    });
  }
  return verdicts;
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
 * The source with its comments removed, for the import scan.
 *
 * A commented-out import is not an import, and a text scan that cannot tell
 * the two reads `// import "./setup.test.ts"` as a real one — which would name
 * an import that never happens and fail a correct change. String literals are
 * kept: a specifier lives inside one, and a `//` inside a string is not a
 * comment. A regex literal is kept whole for the same reason: `/[//]/` holds a
 * `//` that is a character class, not the start of a comment, and a scan that
 * read it as one would drop the rest of the line — the line a real import could
 * be on.
 *
 * This is `maskSource` in its `"keep-code"` mode, not a second scanner: the
 * two readers of a source file used to carry the same machine twice, and a fix
 * applied to one of them left the other misreading.
 */
function withoutComments(source: string): string {
  return maskSource(source, "keep-code");
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
 * The tracked files whose working-tree content differs from HEAD.
 *
 * The change side runs the added file in the checkout, so it reads the
 * checkout's sources and not the commit's. An uncommitted edit to a source the
 * test imports can stop the file registering a test — a `if ("newExport" in
 * mod)` guard the edit satisfies, say — and the change side then enumerates a
 * list no commit holds. The test the commit registers is invisible to the gate
 * and the run passes over it. A dirty tree is therefore a problem, not a
 * detail, and the gate fails closed on it.
 */
export function modifiedTrackedFiles(repo: string): string[] {
  // `-z` for the same reason as `addedTestFiles`: git quotes a non-ASCII path,
  // and the quoting hides it.
  const names = gitText(repo, ["diff", "--name-only", "-z", "HEAD"])
    .split("\0")
    .filter((path) => path.length > 0);
  // A path HEAD does not hold is an added file, not a modified one: the added
  // test files are what this run is judging, and an added file is reported by
  // `uncommittedTestFiles` instead.
  return names.filter((path) => git(repo, ["cat-file", "-e", `HEAD:${path}`]).ok);
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
 * A directory's identity, which its name does not carry.
 *
 * A reclaim deletes a *directory*, and the only thing standing between it and
 * the wrong directory is a name another run can reuse the instant the name is
 * freed. `dev`/`ino` name the object rather than the name, and `birthMs` covers
 * the one case inode numbering hands a fresh directory the number its
 * predecessor had: the three together are what a successor cannot share with
 * the directory it replaced.
 */
export type LockIdentity = { dev: number; ino: number; birthMs: number };

/**
 * What a lock directory says about its holder, and how strongly.
 *
 * `holder` names a pid whose process is gone (ESRCH). `unclaimed` is a
 * directory with no pid file that is older than the grace: the only evidence a
 * crash between `mkdirSync` and the pid write leaves behind. `identity` is the
 * directory all of that was read from, so a later removal can be bound to the
 * object and not to the name.
 */
type LockObservation =
  | { kind: "alive"; token?: string; fileCount?: number; identity?: LockIdentity }
  | { kind: "holder"; pid: number; token?: string; fileCount?: number; identity?: LockIdentity }
  | { kind: "unclaimed"; mtimeMs: number; identity?: LockIdentity };

/**
 * The pid file's owner: a pid, and a token only the run that wrote it knows.
 *
 * The pid alone is not an identity. The operating system hands a dead holder's
 * pid to a later process, and the pid file of a *live* lock then reads exactly
 * like the dead one a reclaimer judged stale. The token is written once, by
 * the run that took the lock, and is never reused, so a lock that was replaced
 * carries a different one and the reclaimer can tell the two apart.
 */
type LockOwner = { pid: number; token: string; fileCount: number };

/**
 * The pid file's content: the pid, the token, and how many files the holder is
 * judging.
 *
 * The count is what a waiter needs. The lock may be held by a run that judges
 * twenty files while the waiter judges one, and a waiter that waits for its
 * own guess gives up while the holder is still working.
 */
export function lockPidFileContent(pid: number, token: string, fileCount: number): string {
  return `${pid} ${token} ${fileCount}\n`;
}

/**
 * The owner a pid file names, or null when it names none.
 */
function readLockOwner(raw: string): LockOwner | null {
  const parts = raw.trim().split(/\s+/u);
  const pid = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // The holder's own file count, when it wrote one. A lock written before this
  // field existed has none, and a waiter that cannot see the count waits for
  // its own guess.
  const fileCount = Number.parseInt(parts[2] ?? "", 10);
  return {
    pid,
    token: parts[1] ?? "",
    fileCount: Number.isInteger(fileCount) && fileCount > 0 ? fileCount : 0,
  };
}

/**
 * Whether two observations name the same directory.
 *
 * Undefined on either side is false: an observation that carries no identity
 * cannot bind anything, and a reclaim built on it is refused rather than
 * trusted.
 */
function sameIdentity(a: LockIdentity | undefined, b: LockIdentity | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.dev === b.dev && a.ino === b.ino && a.birthMs === b.birthMs;
}

/**
 * Whether two observations name the same lock.
 *
 * The identity has to match as well as the evidence. The evidence is
 * re-readable and the object is not: a live lock that took the name after the
 * caller observed a stale one can hand back a pid file the old code read as
 * identical — a recycled pid, a token it never looked at — and a comparison on
 * content alone then called two different directories the same lock.
 */
function sameLock(a: LockObservation, b: LockObservation): boolean {
  if (a.kind !== b.kind) return false;
  if (!sameIdentity(a.identity, b.identity)) return false;
  if (a.kind === "holder" && b.kind === "holder") {
    return a.pid === b.pid && (a.token ?? "") === (b.token ?? "");
  }
  if (a.kind === "unclaimed" && b.kind === "unclaimed") return a.mtimeMs === b.mtimeMs;
  return false;
}

/** Whether a pid belongs to a running process (EPERM counts as running). */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but belongs to another user.
    // SAFETY: `process.kill` is the only throw source here and rejects with a
    // NodeJS.ErrnoException, whose string `code` is what this test reads.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The directory at `lockPath`, named by object rather than by path. */
function lockIdentity(lockPath: string): LockIdentity | undefined {
  try {
    const stats = statSync(lockPath);
    return { dev: stats.dev, ino: stats.ino, birthMs: stats.birthtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Observe the lock without deciding, so a reclaimer can bind its removal to
 * the exact state it judged stale.
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
  } catch (error) {
    // A read error that is not "the file is not there" says nothing about the
    // holder: a sharing violation or a permission problem is not evidence of a
    // dead one, and reading it as one lets a reclaimer take a live lock away
    // from the run that holds it. Only a missing pid file is the evidence.
    // SAFETY: `readFileSync` is the only throw source here and rejects with a
    // NodeJS.ErrnoException, whose string `code` is what this test reads.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { kind: "alive", identity: lockIdentity(lockPath) };
    }
    // No pid file. If the directory is gone too, or young, there is no evidence
    // of a dead holder: retry rather than reclaim.
    try {
      const stats = statSync(lockPath);
      const identity = { dev: stats.dev, ino: stats.ino, birthMs: stats.birthtimeMs };
      return Date.now() - stats.mtimeMs > LOCK_PID_GRACE_MS
        ? { kind: "unclaimed", mtimeMs: stats.mtimeMs, identity }
        : { kind: "alive", identity };
    } catch {
      return { kind: "alive" };
    }
  }
  const owner = readLockOwner(raw);
  // The identity is read beside the pid file, not before it: a reclaim is bound
  // to the directory the evidence came out of, and here the evidence is the pid
  // file this call just read.
  const identity = lockIdentity(lockPath);
  if (owner === null) return { kind: "alive", identity };
  return processIsAlive(owner.pid)
    ? { kind: "alive", token: owner.token, fileCount: owner.fileCount, identity }
    : { kind: "holder", pid: owner.pid, token: owner.token, fileCount: owner.fileCount, identity };
}

/** Whether the process that wrote this lock's pid file is gone. */
export function lockHolderIsGone(lockPath: string): boolean {
  return observeLockHolder(lockPath).kind !== "alive";
}

/**
 * What a reclaim did.
 *
 * `reclaimed` is the stale lock removed. `refused` is the name left exactly
 * where it was — another run holds the lock, another run holds the reclaim, or
 * the name now holds a directory the caller never observed. `not-stale` is an
 * observation that named a live holder, so there was nothing to reclaim.
 */
export type ReclaimOutcome = "reclaimed" | "refused" | "not-stale";

/**
 * The file a reclaimer creates inside the lock it is removing.
 *
 * A fixed name, because that is what makes taking it exclusive: `wx` on one
 * name inside one directory has exactly one winner.
 */
export const RECLAIM_CLAIM_FILE = "reclaim";

type ReclaimClaim = { path: string; token: string };

/**
 * Take the exclusive right to remove this lock, or report that someone else has
 * it.
 */
function takeReclaimClaim(lockPath: string): ReclaimClaim | null {
  const claimPath = join(lockPath, RECLAIM_CLAIM_FILE);
  const token = randomUUID();
  const body = lockPidFileContent(process.pid, token, 0);
  const create = (): boolean => {
    try {
      writeFileSync(claimPath, body, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (create()) return { path: claimPath, token };
  // The name is taken. A live owner is another run removing the same lock, and
  // this one waits. A dead owner is a claim left behind by a reclaimer that was
  // killed between claiming and removing, and leaving it there would block
  // every later run on this lock forever. Clearing it is still exclusive: a
  // rename of one name succeeds once, so of the runs that decide the claim is
  // dead exactly one moves it — and even that one has to win the name back,
  // because a third run can create its own claim in the gap.
  //
  // What moves below is the CLAIM FILE inside the lock, never the lock
  // directory. A lock directory is removed only by `reclaimStaleLock` or
  // `releaseWorktreeLock`, and both of those compare the `dev`/`ino`/`birthtimeMs`
  // they observed; neither renames it, and neither decides on the pid file's
  // content alone, which a replacement directory can reproduce byte for byte.
  let raw: string;
  try {
    raw = readFileSync(claimPath, "utf8");
  } catch {
    return null;
  }
  const owner = readLockOwner(raw);
  if (owner === null) {
    // No readable owner: only age is evidence, exactly as for a lock directory
    // whose writer died before it wrote its pid.
    try {
      if (Date.now() - statSync(claimPath).mtimeMs <= LOCK_PID_GRACE_MS) return null;
    } catch {
      return null;
    }
  } else if (processIsAlive(owner.pid)) {
    return null;
  }
  if (!clearDeadClaim(claimPath, raw)) return null;
  return create() ? { path: claimPath, token } : null;
}

/**
 * Remove a claim whose owner is gone, binding the removal to the bytes that were
 * observed.
 *
 * The `wx` create is what makes claiming exclusive, but a rename proves only
 * that ONE run moved a name — not that the name still held the dead claim that
 * run read. Between the read and the rename, a reclaimer that already cleared
 * the dead claim can create its own LIVE one at the same path; a blind rename
 * then carries that away and unlinks it, so the run that owns it believes it
 * still holds the claim, a second run takes the name, and both enter the
 * worktree. So the moved file must still read as the bytes that were observed.
 *
 * Anything else is put back where its owner expects it. If the name has been
 * taken again in the meantime the tombstone stays inside the lock and goes with
 * it — far better than a claim deleted under a live owner.
 */
export function clearDeadClaim(claimPath: string, observed: string): boolean {
  const claimTombstone = `${claimPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(claimPath, claimTombstone);
  } catch {
    return false;
  }
  let moved: string;
  try {
    moved = readFileSync(claimTombstone, "utf8");
  } catch {
    return false;
  }
  if (moved !== observed) {
    try {
      if (!existsSync(claimPath)) renameSync(claimTombstone, claimPath);
    } catch {
      // The name is taken again; the tombstone goes with the lock.
    }
    return false;
  }
  try {
    unlinkSync(claimTombstone);
  } catch {
    // The tombstone stays behind inside the lock directory; it goes with it.
  }
  return true;
}

/** Drop this run's claim, and only its own. */
function releaseReclaimClaim(claim: ReclaimClaim): void {
  let raw: string;
  try {
    raw = readFileSync(claim.path, "utf8");
  } catch {
    return;
  }
  const owner = readLockOwner(raw);
  if (owner === null || owner.pid !== process.pid || owner.token !== claim.token) return;
  try {
    unlinkSync(claim.path);
  } catch {
    // The directory is going, or gone, and takes the claim with it.
  }
}

/**
 * Whether the name still holds the lock that was observed.
 *
 * An `unclaimed` observation cannot be re-read as one: the claim just created
 * inside the directory refreshed its mtime, so its age is gone. What is left is
 * that the directory is still the same object and that no pid file has
 * appeared in it. A `holder` observation is re-read whole, pid and token
 * included, because that content is what a replacement cannot reproduce.
 */
function stillObservedLock(lockPath: string, observed: LockObservation): boolean {
  const current = observeLockHolder(lockPath);
  if (!sameIdentity(current.identity, observed.identity)) return false;
  if (observed.kind === "holder") return sameLock(current, observed);
  if (observed.kind === "unclaimed") return !existsSync(join(lockPath, "pid"));
  return false;
}

/**
 * Remove the stale lock `observed` described, and only that lock.
 *
 * Two properties have to hold, and neither is enough alone.
 *
 * **Recovery is exclusive.** The removal is one `rmSync` of one name, and two
 * runs that read the same dead pid would both reach it: one replaces the
 * directory and starts work, the other deletes the live lock it just took. So a
 * reclaimer takes a claim *inside* the directory with `wx` before it removes
 * anything. Exactly one caller can win that create, so at most one run is ever
 * removing a given lock. The claim is released when the lock is left alone and
 * disappears with the directory when the removal succeeds.
 *
 * **The removal is bound to the observed object.** The claim can be taken
 * inside a *different* directory than the one observed: between the caller's
 * observation and the claim, another run can remove the stale lock and take the
 * name with a live one. Removing by name after that deletes a live run's lock,
 * and that run then writes its pid file into a directory that is no longer at
 * the name — so the lock is gone but two runs still hold the worktree. The
 * directory's identity is therefore compared with the identity captured in the
 * observation, and the evidence re-read, before anything is removed.
 *
 * Those two guards together are why the three reported findings are one defect.
 * With recovery exclusive there is no second reclaimer to race at all, and with
 * the removal bound to the identity the one window left — the lock replaced
 * under the claim — can only ever refuse. There is no per-call-site check to
 * forget, because there is one removal and it is guarded by both.
 */
export function reclaimStaleLock(lockPath: string, observed: LockObservation): ReclaimOutcome {
  if (observed.kind === "alive") return "not-stale";
  // An observation with no identity binds nothing, so it is refused rather than
  // trusted: a hand-built observation must not become a licence to delete.
  if (observed.identity === undefined) return "refused";
  const claim = takeReclaimClaim(lockPath);
  if (claim === null) return "refused";
  if (!stillObservedLock(lockPath, observed)) {
    releaseReclaimClaim(claim);
    return "refused";
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // A parent directory that will not let the entry go, or a directory in use.
    // Leaving the lock is the safe half: the waiter sleeps and its budget runs
    // out with a message naming the lock, instead of a throw out of the loop.
    releaseReclaimClaim(claim);
    return "refused";
  }
  return "reclaimed";
}

/**
 * Serialize every run that touches one base worktree.
 *
 * Two invocations from the same checkout and the same base copy their added
 * files into the same paths, and `--fresh` deletes the directory the other run
 * is testing in. The lock directory is the atomic acquire available on both
 * platforms (`mkdir` fails with EEXIST, unlike a test-then-write). A holder that
 * died is detected by its pid and removed under an exclusive claim, so
 * unknown has to cover the whole worst case: wait too little and a legitimate
 * second run is refused with "wait for it to finish", which is advice it cannot
 * follow because the deadline has already fired. The caller therefore derives
 * the budget from the work it is about to do. `RED_ON_PARENT_LOCK_WAIT_MS`
 * overrides it, which is how the lock's refusal is pinned in milliseconds.
 */
function acquireWorktreeLock(lockPath: string, lockWaitMs: number, fileCount = 0): () => void {
  // The cache root does not exist on a cold first run, and `mkdirSync(lockPath)`
  // stays non-recursive because that is exactly what makes it the exclusive
  // acquire. Create the lock's parent first, never the lock itself.
  mkdirSync(dirname(lockPath), { recursive: true });
  let deadline = Date.now() + lockWaitMs;
  // The holder whose file count the budget was already extended for.
  let countedHolder: string | null = null;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      // SAFETY: `mkdirSync` rejects with a NodeJS.ErrnoException, and its `code`
      // is the documented way to tell "already held" from a real failure.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = observeLockHolder(lockPath);
      // The holder's own file count says what the lock is working on. The
      // waiter's count is a guess, and a budget that expires while the holder
      // is still judging its files tells the waiter to delete a live lock. The
      // count is taken once per holder: a deadline that grew on every pass
      // would never expire.
      if (observed.kind !== "unclaimed" && observed.token !== countedHolder) {
        countedHolder = observed.token ?? null;
        deadline = effectiveWaitDeadline(deadline, observed, Date.now());
      }
      if (Date.now() > deadline) {
        throw new GateError(lockContentionMessage(lockPath, observed));
      }
      if (observed.kind !== "alive" && reclaimStaleLock(lockPath, observed) === "reclaimed") {
        // The stale lock is gone, so the next `mkdirSync` can take the name.
        continue;
      }
      // A reclaim that refused leaves the lock exactly where it was, and the
      // next pass would observe the same stale lock and reclaim it again. The
      // `continue` this used to take skipped both the deadline check and the
      // sleep, so a lock that could not be reclaimed spun the run at full speed
      // until somebody killed it.
      sleepSync(LOCK_RETRY_MS);
    }
  }
  // The directory this run took, named by object, before anything is written
  // into it: the release below is the second place a lock directory is removed,
  // and it is bound to this the way the reclaim is bound to its observation.
  const identity = lockIdentity(lockPath);
  // The pid file carries a token as well as the pid, so a later run can tell
  // this lock from one that took the same pid after the operating system
  // handed that pid out again.
  const token = randomUUID();
  writeFileSync(join(lockPath, "pid"), lockPidFileContent(process.pid, token, fileCount));
  return () => {
    releaseWorktreeLock(lockPath, token, identity);
  };
}

/**
 * Remove the lock this run holds, and only that one.
 *
 * This is the second of the two places a lock directory is removed —
 * `reclaimStaleLock` is the first — and it is bound the same way: to the token
 * this run wrote *and* to the object it wrote it into. The token alone names the
 * pid file's content, and content is the one thing a replacement can reproduce:
 * a directory that took the name after this run's lock was reclaimed can carry
 * a pid file that reads identically, and a release comparing content alone then
 * deletes the live lock of the run that holds the name now. The identity is
 * captured by the acquire and compared before anything is read, so there is one
 * rule for both removals and no per-call-site check to forget.
 *
 * An acquire that could not stamp its own directory keeps the lock instead of
 * removing it. A lock left behind is recovered by the next run once this process
 * is gone, because its pid file names a dead holder; a lock removed blind is
 * not recoverable at all.
 *
 * Returns whether the directory is gone.
 */
export function releaseWorktreeLock(
  lockPath: string,
  token: string,
  identity: LockIdentity | undefined,
): boolean {
  if (identity === undefined) return false;
  if (!sameIdentity(lockIdentity(lockPath), identity)) return false;
  let raw: string;
  try {
    raw = readFileSync(join(lockPath, "pid"), "utf8");
  } catch {
    return false;
  }
  const owner = readLockOwner(raw);
  if (owner === null || owner.pid !== process.pid || owner.token !== token) return false;
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    // A directory in use on Windows, or a parent that will not let the entry go.
    // It stays, and the next run reclaims it once this pid is dead.
    return false;
  }
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
 * Whether a run's junit report can be read as evidence.
 *
 * Both halves of the process result decide this, and neither alone is enough.
 *
 * A non-zero *exit* is not a run that failed to finish. The change's own run
 * executes the test this change adds, and a test that is red there exits 1 —
 * that red is exactly what RED_ON_CHANGE is made of, so `status` alone may not
 * refuse the report.
 *
 * A non-empty `error` is the other half: `spawnSync` sets it when the child was
 * never spawned (ENOENT, EACCES), when its budget killed it (ETIMEDOUT), or when
 * it overran the output buffer (ENOBUFS). A process that ended that way did not
 * write a report on purpose, and the report on disk is then the report some
 * earlier process left, or a file bun had already flushed. `status === null`
 * covers the killed cases in practice, because a killed child reports a signal
 * rather than a status; the `error` clause is what keeps the rule true when it
 * does not.
 *
 * One predicate, used by both sides, is the point: a report is read in exactly
 * one place per side and nowhere else, so there is no path that reads a report
 * the process result did not license.
 */
export function runFinished(result: { status: number | null; error: string }): boolean {
  return result.status !== null && result.error.length === 0;
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
  // The runner is a parameter so a test can hand back the one result this
  // function must refuse and no real `bun test` can be made to produce: a
  // report on disk and a process that did not finish. The gate passes nothing,
  // so it always runs the file itself.
  runFile: (
    repo: string,
    file: string,
    junitPath: string,
  ) => { status: number | null; stdout: string; error: string } = runFrom,
): TestResult[] {
  if (modifiedInWorkingTree(repo, file)) {
    problems.push(
      `${file}: has uncommitted changes, so the gate cannot tell which tests this change registers — commit it and run again`,
    );
    return [];
  }
  // The file itself is committed, but the sources it imports are read from the
  // working tree, and an uncommitted edit to one of them can change which
  // tests the file registers. The change side would then enumerate a version of
  // the change that no commit holds, and a test the commit registers would be
  // invisible to the gate.
  const dirty = modifiedTrackedFiles(repo);
  if (dirty.length > 0) {
    const named = dirty.slice(0, 5).join(", ");
    problems.push(
      `${file}: the working tree differs from HEAD in ${dirty.length} file(s) (${named}${
        dirty.length > 5 ? ", …" : ""
      }), and the change's own run reads the working tree — so the tests it registers are not the commit's. Commit the change and run the gate again`,
    );
    return [];
  }
  rmSync(junitPath, { force: true });
  const result = runFile(repo, file, junitPath);
  // The report is accepted only from a run that finished, and "finished" is
  // `runFinished` — both halves of the process result. This is checked before
  // the report is looked at, so a killed or errored run is reported as such
  // whether or not it left a file behind. A non-zero exit is not this test's
  // business: a red test on the change legitimately exits 1, and refusing that
  // report would report RED_ON_CHANGE as an unreadable run.
  if (!runFinished(result)) {
    problems.push(
      `${file}: the change's own run did not finish (${
        result.error.length > 0 ? result.error : "the process was killed"
      }), so any junit report it left behind is not evidence of the tests this change registers`,
    );
    return [];
  }
  if (!existsSync(junitPath)) {
    // bun writes no junit for a file that registers no test at all, and no
    // junit for a file that did not load. The two need different words: the
    // first is a file that pins nothing, the second is a file that did not run.
    const reason =
      result.error.length > 0
        ? result.error
        : /Ran 0 tests/u.test(result.stdout)
          ? "the file registers no test, so the change's own run reported nothing"
          : "the file did not run to completion";
    problems.push(
      `${file}: the change's own run wrote no junit report (${reason}), so the gate cannot tell which tests this change registers`,
    );
    return [];
  }
  return parseJunit(readFileSync(junitPath, "utf8"));
}

/**
 * What a waiter says when the lock is still held.
 *
 * The holder's own file count is in the message when there is one: a waiter
 * that gave up after a budget computed from its own file count otherwise reads
 * the holder as idle, and the advice to delete the directory breaks a live run.
 */
export function lockContentionMessage(lockPath: string, observed: LockObservation): string {
  const count = observed.kind === "unclaimed" ? 0 : observed.fileCount ?? 0;
  const note =
    count > 0
      ? ` (it says it is judging ${count} file${count === 1 ? "" : "s"}, so it may still be working)`
      : "";
  return `another red-on-parent run is using ${lockPath}${note}; wait for it to finish, or delete that directory if no run is alive`;
}

/** How long a run waits for the lock, given what can legitimately be inside it. */
export function lockWaitBudget(fileCount: number, holderFileCount = 0): number {
  const override = Number.parseInt(process.env.RED_ON_PARENT_LOCK_WAIT_MS ?? "", 10);
  const own = Number.isInteger(override) && override > 0
    ? override
    : INSTALL_TIMEOUT_MS + fileCount * 2 * testTimeoutMs() + LOCK_WAIT_SLACK_MS;
  // The holder's own work is not the waiter's to shorten. A waiter that judges
  // one file waits for one file's worth of time, while the lock may be held by
  // a run that judges twenty; the holder says how many in its pid file, and the
  // wait covers that many. The install is not counted here: the waiter cannot
  // know whether the holder paid it.
  const holderNeed = holderFileCount * 2 * testTimeoutMs();
  return Math.max(own, holderNeed);
}

/**
 * The deadline a waiter works to, given what the lock's holder says it is doing.
 *
 * The waiter's own file count is a guess about a lock it cannot see into. The
 * holder writes its own count into its pid file, so a waiter that reads it can
 * wait for the work that is actually there instead of for its own guess.
 */
export function effectiveWaitDeadline(
  deadline: number,
  observed: LockObservation,
  now: number,
): number {
  const count = observed.kind === "unclaimed" ? undefined : observed.fileCount;
  if (count === undefined || count <= 0) return deadline;
  return Math.max(deadline, now + lockWaitBudget(count, count));
}

export function runGate(
  options: GateOptions,
  // SAFETY: `process.versions` is a plain object and bun adds a `bun` key to
  // it, so reading an optional property cannot throw; the cast only names
  // that key.
  versions: { bun?: string } = process.versions as { bun?: string },
): GateRun {
  // The gate asks once, before any work, whether it is running under bun. The
  // ask used to live in `main` alone, so a caller that used the exported
  // `runGate` skipped it: every parent-side run then read as a whole-file load
  // failure, and a waiver turned that into a PASS.
  const refusal = bunOnlyRefusal(versions);
  if (refusal !== null) {
    throw new GateError(
      "this gate has to run under bun, not node — every parent-side run spawns `bun test` from process.execPath, and under node each file reads as a whole-file load failure",
    );
  }
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
  const release = acquireWorktreeLock(
    join(cacheRoot(repo), `wt-${baseSha}.lock`),
    lockWaitMs,
    files.length,
  );
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
      // The parent worktree is restored before *each* file's copy, not only
      // once before the loop. A test run leaves the tree the way it left it:
      // one that writes a tracked fixture and then fails for its own reason
      // restores nothing, and the next file would be judged against that
      // fixture instead of the parent's. A test that is green on the parent
      // then fails there with an `AssertionError` — the fixture the run left
      // behind supplies what the parent lacks — and the gate reads that red as
      // RIGHT-REASON RED. A false PASS is the expensive direction, so the
      // restore is per file. It costs two `git` calls per file, and `clean`
      // leaves ignored paths alone, so the installed `node_modules` survives.
      resetBaseWorktree(worktree);
      copyIntoBaseWorktree(manifest, worktree, file, source, copied);

      const junitPath = join(outDir, `${copied.length}.xml`);
      rmSync(junitPath, { force: true });
      const result = runFrom(worktree, file, junitPath);

      // The parent's report is read on the same rule as the change's: only a
      // run that finished wrote it. Both halves of the result decide, because a
      // killed or errored run leaves a file that says what reached it, not what
      // the file registers.
      const finished = runFinished(result);
      const junit = finished && existsSync(junitPath) ? readFileSync(junitPath, "utf8") : null;
      const fileRun: FileRun = {
        file,
        junit,
        stdout: `${result.stdout}${result.stderr}`,
        error: finished
          ? ""
          : `bun test did not complete${result.error.length > 0 ? ` (${result.error})` : ""}`,
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
      const problemsBeforeChange = problems.length;
      const changeResults = enumerateChange
        ? changeSideResults(repo, file, join(outDir, `${copied.length}-change.xml`), problems)
        : [];
      // The change's own run produced a report when it raised no problem of its
      // own. A run that wrote no junit, or that was refused because the
      // working tree is dirty, registers nothing — and comparing that against
      // the parent's list would restate the problem once per test.
      const changeSideRan = enumerateChange && problems.length === problemsBeforeChange;
      const classified = classifyFileRun(fileRun, parsed.waivers, changeResults);
      for (const problem of classified.problems) problems.push(problem);
      const unregistered =
        parentResults.length === 0
          ? { verdicts: [], usedWaiverLines: new Set<number>(), problems: [] }
          : unregisteredVerdicts(file, parentResults, changeResults, parsed.waivers);
      // The parent's run and the change's run read the same file. A test the
      // parent's run registered and the change's did not is a test the change
      // does not execute, and the parent's red was about it.
      const notOnChange = changeSideRan
        ? notRegisteredOnChange(file, parentResults, changeResults)
        : [];
      verdicts.push(...classified.verdicts, ...unregistered.verdicts, ...notOnChange);
      // The change's own run is already made, so its statuses cost nothing to
      // read. They are read independently of the parent's waivers: a waiver says
      // why the parent could not run a test, not that the test works on the
      // change.
      verdicts.push(
        ...changeSideVerdicts(file, [...classified.verdicts, ...unregistered.verdicts], changeResults),
      );
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
    name: "SKIPPED_ON_CHANGE",
    title: "the test is skipped on the change, so it never runs there and pins nothing",
    fixes: [
      "run the test on the change — a skipped test proves nothing about the change",
      "if the skip is deliberate, make the parent skip it too, so the two sides agree about what ran",
    ],
  },
  {
    name: "NOT_ON_CHANGE",
    title: "the parent's run registered this test and the change's run did not, so the change does not execute it",
    fixes: [
      "make the change register the test the parent's run registered — the gate judged the parent's run of it",
      "if the change really does not run it, the file as committed pins less than the gate judged, and no waiver covers that",
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
    // The report states its verdict in every other shape. A run that judged
    // nothing still decided something, and a reader who cannot find the
    // verdict cannot tell a decided run from a silent one.
    lines.push(problems.length > 0 ? "red-on-parent: FAIL" : "red-on-parent: PASS");
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
  if (failed) {
    lines.push("red-on-parent: FAIL");
  } else {
    // A run that passes on waivers says so in the last line, which is the
    // line a reviewer reads. "PASS" alone, next to a table of waived rows,
    // reads like the gate judged those tests; it did not.
    const waived = run.verdicts.filter((verdict) => verdict.waiver !== null && verdictPasses(verdict));
    if (waived.length === 0) {
      lines.push("red-on-parent: PASS");
    } else {
      lines.push(`red-on-parent: PASS (${waived.length} waived)`);
      const unjudged = waived.filter((verdict) => verdict.name === "WRONG_REASON_RED").length;
      if (unjudged > 0) {
        lines.push(
          `  ${unjudged} of them: the parent could not run the test, so nothing was judged there`,
        );
      }
    }
  }
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
    "SKIPPED_ON_CHANGE",
    "NOT_ON_CHANGE",
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
