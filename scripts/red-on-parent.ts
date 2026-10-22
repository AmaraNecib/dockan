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
 *     measured table and the residual hole are on `isOwnRed`.
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
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { GateError } from "./lib/gate-error";
import { INSTALL_TIMEOUT_MS, testTimeoutMs } from "./lib/gate-limits";
import { acquireWorktreeLock, lockWaitBudget } from "./lib/worktree-lock";

// The lock lifecycle lives in its own module — a 2,800-line script is not where
// a reader finds "who may hold the base worktree and how a dead holder is
// removed". Its names stay exported from here so a caller of the gate keeps one
// import, and so the module's seam can move again without touching them.
export {
  claimReclaimGeneration,
  claimStillLicensed,
  effectiveWaitDeadline,
  lockContentionMessage,
  lockHolderIsGone,
  lockPidFileContent,
  lockWaitBudget,
  observeLockHolder,
  RECLAIM_CLAIM_PREFIX,
  RECLAIM_RELEASED_MARKER,
  reclaimClaimName,
  reclaimStaleLock,
  releaseWorktreeLock,
  type LockIdentity,
  type ReclaimClaim,
  type ReclaimOutcome,
} from "./lib/worktree-lock";
// The typed refusal and the run limits moved out with it: the lock module has to
// throw a GateError and size its budget from the same timeouts, and a library
// that imports the script it was extracted from is the seam pointing backwards.
export { GateError };
export { INSTALL_TIMEOUT_MS, LOCK_WAIT_SLACK_MS, testTimeoutMs } from "./lib/gate-limits";

const BUN = process.execPath;

/**
 * `process.versions`, with bun's own key named.
 *
 * Bun adds `bun` to `process.versions` and the type does not list it. The cast
 * lives here once because three readers need it: `bunOnlyRefusal`,
 * `bunVersion` and `runGate` (which forwards to the first). Three copies of the
 * cast and two copies of the default-parameter expression were three places for
 * a later edit to miss one.
 */
function bunVersions(): { bun?: string } {
  // SAFETY: `process.versions` is a plain object and bun adds a `bun` key to it,
  // so reading an optional property cannot throw; the cast only names that key.
  return process.versions as { bun?: string };
}

/**
 * The refusal text when the gate is not running under bun, or null when it is.
 *
 * Node 22+ strips TypeScript types, so `node scripts/red-on-parent.ts` starts
 * cleanly and then spawns `node test <file>` for every parent-side run. Every
 * file then reads as a whole-file load failure, and a waiver on such a file
 * would turn that into a PASS. The gate cannot tell its bun is not bun unless it
 * asks, so it asks once, before any work.
 */
export function bunOnlyRefusal(versions: { bun?: string } = bunVersions()): string | null {
  if (versions.bun !== undefined) return null;
  return "red-on-parent: run this with bun, not node — every parent-side run spawns `bun test` from process.execPath, and under node each file reads as a whole-file load failure\n";
}
/** The bun this process is running on, which is the bun every child run inherits. */
export function bunVersion(): string {
  return bunVersions().bun ?? "unknown";
}

const WAIVER_MARKER = "red-on-parent-waive";
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
  | "CANNOT_HOLLOW"
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
    // inside the gate, and it covers one narrower case: bun's positional
    // argument is a *substring* filter, so a caller that ran `bun test ./cart`
    // gets the cases of `cart.test.tsx` alongside `cart.test.ts`, one suite per
    // entry with its own `file` attribute. Filtering on that attribute separates
    // them.
    //
    // What it cannot do is attribute the cases of a test file reached through an
    // import. Measured on bun 1.4.2: a run whose entry `a.test.ts` imports
    // `b.test.ts` writes `file="a.test.ts"` on **both** testcases, including the
    // one `b.test.ts` declared, so asking for `b.test.ts` returns nothing and the
    // report cannot say whose case it holds. The import scan is what refuses that
    // shape, and this filter is not an alternative to it.
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
 * The `ScriptKind` a file's extension asks for.
 *
 * The extension decides, because the same characters mean two different things
 * in the two files: `<Foo>"ok";` is a type assertion in `.ts` and a JSX element
 * in `.tsx`. A scan that picked one reading for both would either invent an
 * element or miss one, and the gate judges `.test.ts` and `.test.tsx` alike.
 * `createSourceFile` is given this, so the parser reads the file with the same
 * rule the runtime will.
 */
function scriptKindFor(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".mts") || lower.endsWith(".cts") || lower.endsWith(".ts")) {
    return ts.ScriptKind.TS;
  }
  if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

/** Where a comment is in a file, and whether it is a line comment. */
type CommentRange = { pos: number; end: number; lineComment: boolean };

/** The comments a file declares, and where each of its code tokens ends. */
type SourceScan = { comments: CommentRange[]; tokenEnds: number[] };

/**
 * The comments in a source file, read where the parser says trivia is.
 *
 * The scanner loop this replaced never called `reScanTemplateToken`, so the
 * closing backtick of an interpolated template (`x${1}y`) was read as an opener
 * and swallowed every waiver below it. That was not one bug: a backtick inside a
 * regex literal, a block comment in front of a marker on the same line, a BOM
 * and a CR-only file all lost waivers through the same property — a lexer
 * driven by hand has to re-derive, token by token, the state the parser already
 * tracks, and each gap was one state it did not re-derive.
 *
 * So the ranges come from the tree. Every node and every token the parser
 * produced names two positions, `getFullStart()` and `getEnd()`, and
 * `getLeadingCommentRanges` / `getTrailingCommentRanges` read the trivia at
 * those with the parser's own scanner, where the enclosing literal, template or
 * regex is already known. `getChildren` is walked as well as `forEachChild`,
 * because a comment on its own line at the end of a block is leading trivia of
 * the closing `}` — a token, not a node — and a node-only walk drops every
 * waiver written after the last test in a `describe`.
 *
 * JSX child text is prose, so that node is skipped outright and any comment a
 * trivia scan still claims inside it is dropped. A `//` at the start of a line
 * of prose is a comment to any scanner that reaches it, and prose is not code.
 *
 * `tokenEnds` serves the rule that a waiver is the first thing on its line: a
 * comment declares a waiver only when no code token ends on the same line before
 * it. Another comment may precede it (a block comment, then the marker on the
 * same line); code may not (`const x = 1; // marker`).
 */
function scanSource(source: string, kind: ts.ScriptKind): SourceScan {
  const file = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    // Parents are set because `getChildren` needs them to resolve every token.
    /* setParentNodes */ true,
    kind,
  );
  const comments: CommentRange[] = [];
  const tokenEnds: number[] = [];
  const prose: ts.TextRange[] = [];
  const seen = new Set<number>();
  const collect = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      comments.push({
        pos: range.pos,
        end: range.end,
        lineComment: range.kind === ts.SyntaxKind.SingleLineCommentTrivia,
      });
    }
  };
  const walk = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      prose.push({ pos: node.getStart(file), end: node.end });
      tokenEnds.push(node.end);
      return;
    }
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.getEnd()));
    const children = node.getChildren(file);
    if (children.length === 0) {
      tokenEnds.push(node.getEnd());
      return;
    }
    for (const child of children) walk(child);
  };
  walk(file);
  return {
    comments: comments
      .filter(
        (comment) => !prose.some((range) => comment.pos >= range.pos && comment.pos < range.end),
      )
      .sort((left, right) => left.pos - right.pos),
    tokenEnds: tokenEnds.sort((left, right) => left - right),
  };
}

/**
 * Waivers live in the added file as a line comment, one per test name pattern:
 *
 *   // red-on-parent-waive: "gr passes" — characterizes behaviour the refactor kept
 *
 * The reason is required: the marker is what a reviewer reads in the diff, and
 * a waiver with no reason is a waiver nobody can judge.
 *
 * The markers are read from the comment ranges the parser reports and from
 * nowhere else, so a marker that is a string's contents, a template literal's
 * data or a JSX child's prose is not a waiver this file declared. A waiver also
 * has to be the first thing on its line — another comment may come first, code
 * may not.
 *
 * `path` is required, and it is the path the file really has. It decides how the
 * file is parsed, because `<Foo>"ok"` is a type assertion in `.ts` and a JSX
 * element in `.tsx`; a default would have let a `.tsx` file be read as `.ts` and
 * reported a waiver set the real file never declares.
 */
export function parseWaivers(text: string, path: string): WaiverParse {
  const waivers: Waiver[] = [];
  const problems: string[] = [];
  const linePattern = waiverLinePattern();
  const startsAsWaiver = new RegExp(`^[ \\t]*//[ \\t]*${WAIVER_MARKER}`, "u");
  const { comments, tokenEnds } = scanSource(text, scriptKindFor(path));
  // The line and its start, walked once in comment order rather than by
  // splitting the text: the line is the address a problem is reported at. `\r`
  // alone ends a line as well as `\n` does, because a file written with CR only
  // is still a file with lines; in CRLF the `\n` is the one counted, so the pair
  // is one break.
  let line = 1;
  let lineStart = 0;
  let walked = 0;
  let tokenIndex = 0;
  for (const range of comments) {
    while (walked < range.pos) {
      const char = text[walked];
      if (char === "\n" || (char === "\r" && text[walked + 1] !== "\n")) {
        line += 1;
        lineStart = walked + 1;
      }
      walked += 1;
    }
    // The end of the last code token before this comment. Trivia and tokens
    // never overlap, so one forward pass serves every comment.
    while (tokenIndex < tokenEnds.length && (tokenEnds[tokenIndex] ?? 0) <= range.pos) {
      tokenIndex += 1;
    }
    const codeEndsAt = tokenIndex > 0 ? (tokenEnds[tokenIndex - 1] ?? 0) : 0;
    // A waiver is a line comment whose line begins with the marker. A line that
    // merely mentions the marker, or carries it after code, is not one; the
    // anchored pattern says the first, and `codeEndsAt <= lineStart` says the
    // second. Another comment before it on the line is still trivia, so
    // `/* note */ // marker` is read.
    if (!range.lineComment || codeEndsAt > lineStart) continue;
    const raw = text.slice(range.pos, range.end);
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

/**
 * The gate's whole product, named once.
 *
 * A run passes when nothing was reported as a problem and every verdict
 * passes. `main` decides the exit code from this and `renderReport` prints the
 * last line from this: the same expression written twice is how a reviewer ends
 * up reading PASS while CI exits 1, which is the one thing a gate cannot do.
 */
export function runPasses(run: { verdicts: Verdict[]; problems: string[] }): boolean {
  return run.problems.length === 0 && run.verdicts.every(verdictPasses);
}

export function verdictPasses(verdict: Verdict): boolean {
  switch (verdict.name) {
    case "RIGHT_REASON_RED":
      return true;
    case "WRONG_REASON_RED":
    case "NOT_ON_PARENT":
    case "CANNOT_HOLLOW":
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
  hollowed: boolean,
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
  if (isOwnRed(result, hollowed)) {
    if (waiver !== null) {
      return {
        file,
        test,
        name: "WAIVER_MISFILED",
        detail: `waived, but the test already fails on the parent for its own reason — delete the waiver`,
        waiver,
        waivers: matching,
      };
    }
    return {
      file,
      test,
      name: "RIGHT_REASON_RED",
      detail: hollowed
        ? `fails on the parent against the hollow stand-in, for a reason the test itself produced (${failureReason(result)})`
        : `fails on the parent with an assertion on the behaviour the change adds`,
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
function isOwnRed(result: TestResult, hollowed: boolean): boolean {
  if (result.failureType === "AssertionError") return true;
  // A hollow module's functions return `undefined` and its consts are
  // `undefined`, so a test that reads a property of what the module produced dies
  // with a TypeError before any assertion runs — `turboArgs(...).args` on a hollow
  // is `undefined.args`. That red is caused by the module the change adds, and the
  // test only reaches it by using the module, so it is the test's own red on a
  // hollowed file.
  //
  // ACCEPTED BY DESIGN, and it is the gate's weakest verdict. `hollowed` covers
  // both stand-in kinds, so this also accepts the same TypeError in a file whose
  // module was AUGMENTED — where the parent's real code still runs, so the
  // TypeError has a second possible cause the gate cannot see. Two shapes pass on
  // a stand-in that asserts nothing:
  //
  //   1. a test that dereferences what a stand-in returned —
  //      `turboArgs([], "x").args` is `undefined.args`, a TypeError;
  //   2. a test that only checks a const stand-in exists —
  //      `expect(NEW_LIMIT).toBeDefined()` is `undefined` against a
  //      stand-in whose value is `undefined`, an AssertionError.
  //
  // Both are pinned as fixtures (`accepted by design, not a defect`). What the
  // gate proves is narrower than "this test asserts a behaviour": it proves the
  // test REACHES the change and fails there. Sharper discrimination needs more
  // than junit's failure type, which is a design change, not a fix.
  //
  // The residual hole, stated because a gate that hides it is the thing this gate
  // exists against: a `beforeEach` that dereferences the hollow makes every test
  // in the file read as its own red without a body running, so a vacuous test
  // behind such a hook passes. RED ON CHANGE still catches a test that is broken
  // on the change, and the hook is code the reviewer reads in the diff. The
  // alternative — waiving twelve rows of a file whose only defect is this shape —
  // buries the same fact in twelve lines nobody reads.
  return hollowed && result.failureType === "TypeError";
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
  options: { hollowed?: boolean } = {},
): Classification {
  const hollowed = options.hollowed === true;
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
    verdicts.push(classifyResult(run.file, result, waiver, matching, hollowed));
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

/**
 * The export bun could not find, and the module it looked in.
 *
 * `missingExport` answers "which name"; this answers "which name, in which
 * file", which is what tells an export the change ADDS to a module the parent
 * already has (a real, waivable "the parent cannot run this file") from a module
 * the parent is missing altogether (which the hollow path already handles).
 */
export function missingExportDetail(stdout: string): { name: string; module: string } | null {
  const match = /Export named ['"]([^'"]+)['"] not found in module ['"]([^'"]+)['"]/u.exec(stdout);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { name: match[1], module: match[2] };
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

/**
 * Why the parent cannot run an added test file, when the cause is an export the
 * parent's copy of a module the diff *edits* does not have.
 *
 * The hollow path cannot fix this one: the parent HAS the module, so replacing it
 * with a stand-in would erase behaviour the parent really carries, and a test that
 * pins that behaviour would then fail on the parent and be read as a right-reason
 * red — a false PASS.
 *
 * Round 25 gives the gate a narrower move for the same case: keep the parent's
 * module and append stand-ins for the names the change adds
 * (`augmentModuleSource`). This function is the residue — the transcript said the
 * parent is missing an export after the augmentation pass, so the name arrived by
 * a route that pass cannot see (a chain, a second spelling of the same module, or
 * a shape an appended declaration cannot carry). One row, one waiver, still the
 * honest answer: the file is unjudgeable on this parent.
 *
 * Without this, the file got one WRONG REASON RED row per test it registers (the
 * round-8 rule: a waiver must name the test it excuses), which is 40 waiver lines
 * for one cause in this repo's `scripts/e2e-changed.test.ts` — and
 * `fileLevelWaiverProblems` refuses a pattern that names all of them at once. A
 * gate nobody can satisfy is a gate that gets bypassed.
 */
export function editedModuleExportRefusal(
  stdout: string,
  touched: ReadonlySet<string>,
): string | null {
  const detail = missingExportDetail(stdout);
  if (detail === null) return null;
  const modulePath = detail.module.replaceAll("\\", "/");
  const touchedPath = [...touched].find(
    (path) => modulePath === path || modulePath.endsWith(`/${path}`),
  );
  if (touchedPath === undefined) return null;
  return `${touchedPath}: the parent has this module but not its \`${detail.name}\` export, and the gate could not append a stand-in for that name to the parent's own copy — so the parent cannot load the file, and a whole-module stand-in would erase behaviour the parent really carries`;
}

/**
 * The waiver spelling that clears a whole file, and it is the only one.
 *
 * The docs advertise `red-on-parent-waive: "whole file" — …` for the one verdict
 * whose only escape hatch is a whole-file waiver (CANNOT HOLLOW). The matcher used
 * to probe two strings — `(whole file)` and `whole file` — with the waiver as a
 * regex, so `"file"`, `"whole"`, `"^whole"`, `"."` and `".*"` all cleared the
 * file. That is the broad-file waiver `fileLevelWaiverProblems` exists to refuse,
 * reintroduced through the one verdict where it is allowed, and it is reachable by
 * a one-character typo.
 *
 * The spelling is compared, not matched: the pattern has to BE `whole file` for
 * the file to be waived. A pattern that names a real test still cannot clear this
 * row, because the row's name is not a test's name.
 */
const WHOLE_FILE_WAIVER = /^whole file$/u;

/**
 * The one row a file gets when the gate cannot write a faithful stand-in for an
 * added module it imports, or cannot append one to a module the parent already
 * has.
 *
 * It replaces the parent's rows rather than joining them, because the parent's run
 * never judged the file: it read a checkout that is missing the module, or missing
 * the export. The row's test name is `(whole file)`, the same name the gate
 * already uses for a run that produced no verdict.
 *
 * A waiver here excuses the whole file because the whole file is what the parent
 * could not run. That is the case `fileLevelWaiverProblems` exists to forbid, and
 * this is the one verdict where a whole-file waiver is also the only thing a
 * waiver can mean — the alternative was one waiver per test for one cause, and
 * `fileLevelWaiverProblems` refuses a pattern that names all of them at once. A
 * gate nobody can satisfy is a gate that gets bypassed.
 *
 * Because the escape hatch is the whole file, the spelling is exact
 * (`WHOLE_FILE_WAIVER`), so it cannot be reached by a pattern that accidentally
 * covers everything.
 */
export function cannotHollowVerdict(file: string, refusal: string, waivers: Waiver[]): Verdict {
  const test = "(whole file)";
  const matching = waivers.filter((waiver) => WHOLE_FILE_WAIVER.test(waiver.pattern));
  return {
    file,
    test,
    name: "CANNOT_HOLLOW",
    detail: `${refusal} — so the parent cannot load this file, and nothing was judged there`,
    waiver: matching[0] ?? null,
    waivers: matching,
  };
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
 * needs both servers), and a file under an `e2e` directory is the same thing.
 *
 * `scripts/` is in scope because its tests are tests: the round-2 change added
 * 26 of them and the gate judged none. The cost of leaving them out was measured
 * — a vacuous assertion sat in one of those files, unchallenged, because no gate
 * ever asked the parent to run it. The cost of including them is the hollow-module
 * path below, which is what makes such a file runnable on a parent that does not
 * have the module it imports.
 */
export function isGatedTestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!/^(apps|packages|scripts)\//u.test(normalized)) return false;
  if (normalized.includes("/e2e/") || normalized.includes("/tests/e2e/")) return false;
  if (/\.spec\.[cm]?[jt]sx?$/u.test(normalized)) return false;
  return /\.test\.[cm]?[jt]sx?$/u.test(normalized);
}

/** A file whose name says it holds tests. */
const TEST_LIKE_BASENAME = /\.(test|spec)(\.[cm]?[jt]sx?)?$/u;

/**
 * Whether a module reference names only types, and is therefore erased before
 * the file runs.
 *
 * `import type { X } from` and `export type { X } from` are erased, and so is
 * `import { type X } from` — but `import { type X, Y } from` still imports Y at
 * runtime, and so does `import X, { type Y } from`. The parser already decided
 * all of that: `isTypeOnly` is set on the clause or on each specifier, so this
 * asks the node instead of re-reading the clause's text.
 */
function isTypeOnlyReference(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return false;
    const elements = clause.elements;
    return elements.length > 0 && elements.every((element) => element.isTypeOnly);
  }
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  // A default or namespace binding is a runtime import whatever the named list
  // says: `import Default, { type A } from` still evaluates the module.
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
  const elements = bindings.elements;
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
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
 * asked: `loadedRelativeSpecifiers` walks the tree, and this function decides
 * which of the modules it names are test files. An alias resolved by the
 * package's `tsconfig` paths — `@/lib/fixtures.test.ts` — is invisible to that
 * walk, so a file that reaches another test file that way is judged on a mixed
 * report.
 */
export function importedTestFiles(source: string, path: string): string[] {
  return loadedRelativeSpecifiers(source, path).filter((specifier) =>
    TEST_LIKE_BASENAME.test(specifier.split("/").pop() ?? ""),
  );
}

/**
 * The names a source file imports at runtime, per relative specifier.
 *
 * `loadedRelativeSpecifiers` answers "which module" and this answers "which
 * name", because an augmentation needs both: the module the parent already has, and
 * the export its copy does not declare.
 *
 * Only named imports are recorded, and a type-only specifier is dropped, because
 * the loader drops it: `import { type Scope, specPaths }` loads `specPaths` and
 * nothing else. A namespace import (`import * as m`) records nothing, because a
 * missing name reached through a namespace object is `undefined` rather than a
 * load error — there is no failure for a stand-in to prevent. A default import
 * records `default`, which an appended declaration can never mirror; the plan
 * refuses it instead of guessing.
 */
export function importedModuleBindings(
  source: string,
  path: string,
): Array<{ specifier: string; names: string[] }> {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  const bindings = new Map<string, string[]>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.startsWith("./") && !specifier.text.startsWith("../")) continue;
    // The whole-clause form is erased, and so is each `type`-marked specifier; a
    // clause that names one value still loads that value.
    if (isTypeOnlyReference(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    const names = bindings.get(specifier.text) ?? [];
    if (clause.name !== undefined) names.push("default");
    if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        // `propertyName` is the exported name the module must carry; `name` is
        // only the local alias.
        names.push((element.propertyName ?? element.name).text);
      }
    }
    bindings.set(specifier.text, names);
  }
  return [...bindings].map(([specifier, names]) => ({ specifier, names: [...new Set(names)] }));
}

/**
 * Every relative module a source file loads, in the order the file names them.
 *
 * One walk serves two readers, because they must agree on what counts as a load:
 * `importedTestFiles` refuses a file that mixes a second file's cases into its
 * report, and `planHollowModules` decides which added module the parent has to be
 * given a stand-in for. A specifier one of them saw and the other did not would
 * either let a mixed report through or leave the parent unable to load the file.
 *
 * The specifiers come from the AST, not from a text scan. That is what makes a
 * commented-out import impossible to report: `// import "./setup.test.ts"` is not
 * a node, so there is nothing here to find. The text scan this replaced needed a
 * mask over every comment and literal in the file to make the same distinction,
 * and each of the mask's four bugs was a shape it read as code that was not code.
 * `path` decides how the file is parsed, because `<Foo>"ok"` is a type assertion
 * in `.ts` and JSX in `.tsx`, and it is required: a default let a `.tsx` file be
 * read as `.ts`, and the same source then reported an import the real file does
 * not have (or missed one it does).
 *
 * Only **relative** specifiers (`./`, `../`) are read. An alias resolved by the
 * package's `tsconfig` paths — `@/lib/fixtures.test.ts` — is invisible here.
 *
 * `require("…")` and `import("…")` are read too, from the call nodes, since both
 * load a module the report cannot attribute. A specifier written as a
 * no-substitution template (a dynamic import whose argument is a backtick
 * literal) is as static as a quoted one, import attributes after it change
 * nothing, and `require` is recognised bare, qualified (`module.require`),
 * element-accessed (`module["require"]`) and parenthesised (`(require)`). Three
 * shapes are still not seen, and all three mix the reports the same way: a
 * specifier that is a variable (`await import(name)`), a dynamic specifier
 * computed at run time, and an import of a module that itself imports a test
 * file. They are known limits of asking the source, not a claim that the gate
 * covers them.
 */
function loadedRelativeSpecifiers(source: string, path: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    // Parents are set because the walk asks nodes for their own text; the gate
    // reads nothing but the tree.
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  const specifiers = new Set<string>();
  const add = (specifier: string | undefined): void => {
    if (specifier === undefined) return;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
    specifiers.add(specifier);
  };
  /**
   * A specifier the loader resolves without running anything: a quoted string, or
   * a no-substitution template, which is the same literal with different quotes.
   */
  const staticText = (node: ts.Expression | undefined): string | undefined => {
    if (node === undefined) return undefined;
    return ts.isStringLiteralLike(node) ? node.text : undefined;
  };
  /**
   * Whether a callee is `require`, in any spelling the loader accepts.
   *
   * The qualified forms matter: `module.require` and `module["require"]` take the
   * same path in Bun's loader, and the text scan this replaced saw both. A
   * bare-identifier test let a file import another test file and still be judged
   * on the mixed report — the refusal this scan exists to make.
   */
  const namesRequire = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) return expression.text === "require";
    // `(require)(...)`: the parentheses change nothing about what is called.
    if (ts.isParenthesizedExpression(expression)) return namesRequire(expression.expression);
    if (ts.isPropertyAccessExpression(expression)) {
      return ts.isIdentifier(expression.name) && expression.name.text === "require";
    }
    if (ts.isElementAccessExpression(expression)) {
      return staticText(expression.argumentExpression) === "require";
    }
    return false;
  };
  const addModule = (node: ts.ImportDeclaration | ts.ExportDeclaration): void => {
    const module = node.moduleSpecifier;
    if (module === undefined || !ts.isStringLiteral(module)) return;
    if (isTypeOnlyReference(node)) return;
    add(module.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addModule(node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import X = require("x")`, which is also what the old text scan saw as a
      // bare `require("x")`.
      const reference = node.moduleReference;
      if (!node.isTypeOnly && ts.isExternalModuleReference(reference)) {
        add(staticText(reference.expression));
      }
    } else if (ts.isCallExpression(node)) {
      // The first argument, whatever follows it: `import("./a.test.ts", { with:
      // { type: "text" } })` names the same module as the bare call, and a
      // specifier that is not a literal is not one this scan can name.
      const specifier = staticText(node.arguments[0]);
      if (specifier !== undefined) {
        const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (dynamic || namesRequire(node.expression)) add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...specifiers];
}

/** A test file of any kind, gated or not. */
export function isTestLikePath(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path.replaceAll("\\", "/"));
}

/** Why the gate does not gate this path, or null when the path is in scope. */
export function skipReason(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (!/^(apps|packages|scripts)\//u.test(normalized)) return "outside apps/, packages/ and scripts/";
  if (normalized.includes("/e2e/") || normalized.includes("/tests/e2e/")) {
    return "under an e2e directory";
  }
  if (/\.spec\.[cm]?[jt]sx?$/u.test(normalized)) return "a Playwright spec";
  return null;
}

/** A test file the diff touches and the gate does not gate. */
export type SkippedTestFile = { path: string; reason: string };

// ---------------------------------------------------------------------------
// Hollow stand-ins for the modules a change adds
// ---------------------------------------------------------------------------

/**
 * Why the gate fakes a module at all.
 *
 * A test file the diff adds usually imports a module the same diff adds. On the
 * parent that module does not exist, so the file does not load: bun writes no
 * junit, every case reads WRONG REASON RED, and one waiver line clears all of
 * them. A test that asserts `true` is then indistinguishable from a test that
 * pins the new behaviour — which is not a hypothetical. The round-2 change added
 * 26 tests under `scripts/` that the gate never looked at, and a vacuous
 * assertion sat in one of them.
 *
 * So the parent gets a HOLLOW version of the module, written at its own path:
 * the same export names, no behaviour. A test that pins nothing then runs on the
 * parent and passes there (GREEN ON PARENT, rejected), and a real test fails for
 * its own assertion reason. That is the discrimination the gate exists to make.
 *
 * A hollow is a mirror, and a wrong mirror is worse than a refusal: one that
 * carries behaviour lets a vacuous test through, and one that drops an export
 * makes a real test fail for a reason the change did not cause. So anything the
 * mirror cannot reproduce faithfully is refused with CANNOT HOLLOW, which fails
 * closed and is cleared only by the waiver grammar every other unjudgeable case
 * uses.
 */

/** A module the gate faked into the parent, and the file that needed it. */
export type HollowedModule = { path: string; importedBy: string };

export type HollowResult = { ok: true; text: string } | { ok: false; refusal: string };

export type HollowPlan = {
  modules: Array<HollowedModule & { text: string }>;
  refusal: string | null;
};

const HOLLOW_HEADER = [
  "// Hollow stand-in, written by scripts/red-on-parent.ts for the parent checkout:",
  "// this module is added by the change under review, so the parent does not have",
  "// it. Same export names, no behaviour — a test that pins nothing passes here.",
].join("\n");

/**
 * The header an appended stand-in carries, and why it is not the hollow's.
 *
 * The two are different promises and a reader has to be able to tell them
 * apart. A hollow stands in for a module the parent has none of. An appended
 * stand-in sits *beside* the parent's real source, in a module the parent does
 * have, and everything the parent really does still works. A single header would make
 * the stronger claim about the weaker change.
 */
const AUGMENT_HEADER = [
  "// Appended stand-in, written by scripts/red-on-parent.ts for the parent checkout:",
  "// the parent HAS this module and keeps its real source above; only this export is",
  "// added by the change under review. Same name, no behaviour.",
].join("\n");

/** Which kind of stand-in is being written, which decides the header it carries. */
export type MirrorKind = "hollow" | "augment";

const MIRROR_HEADER = {
  hollow: HOLLOW_HEADER,
  augment: AUGMENT_HEADER,
} satisfies Record<MirrorKind, string>;

/** The extensions a relative specifier is resolved against, in bun's order. */
const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Whether a node carries one of the keywords a declaration can be written with.
 *
 * Asked per keyword through `getModifiers`, which takes any node and answers for
 * the ones that can have modifiers, rather than through
 * `getCombinedModifierFlags`, whose signature takes a `Declaration`: the loop
 * below walks `Statement`s, and an expression statement's lack of modifiers is
 * the answer rather than a type error to work around.
 */
function hasKeyword(node: ts.Node, keyword: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === keyword);
}

/**
 * The names one variable declaration binds, in source order.
 *
 * An identifier is the ordinary `const x = 1`. Everything else is a binding
 * pattern, and a pattern binds one name per element: `const { a, b: c } = x`
 * binds `a` and `c` — the BINDING name, not the property name —
 * `const [first, , third] = y` binds `first` and `third` (the hole binds
 * nothing), and `const { outer: { inner } } = z` binds `inner` because a nested
 * pattern recurses.
 *
 * The pattern is the one shape whose name node is not an identifier, and reading
 * only identifiers contributed NOTHING for it. That is how the parent's own
 * `export const { value } = { value: 7 }` read as exporting no `value`: a stand-in
 * was appended over the real export, and a test of the parent's behaviour failed
 * against the shadow and was scored RIGHT-REASON-RED — a false pass.
 *
 * Three readers share this walk — `declaredExportNames`, `runtimeExportNames` and
 * `topLevelBindingNames` — because they have to agree about which names a variable
 * statement declares. The reader that decides "the parent already supplies this"
 * and the reader that checks the mirror declares exactly that are the two halves
 * whose disagreement is the bug, so one walk feeds all of them and they cannot
 * drift again.
 */
function variableBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...variableBindingNames(element.name));
  }
  return names;
}

/**
 * The names a module exports, sorted.
 *
 * Read from the tree twice: once for the real module and once for the mirror the
 * gate wrote, so the mirror must declare exactly the export names the module
 * does.
 *
 * Two shapes name an export without declaring one, and both are read here:
 * `export { a, b as c }` and `export { a } from "./y"` name their names
 * literally, and `export * as ns from "./y"` names `ns`. A default export names
 * nothing here — every one of those is refused before a mirror is written, so
 * the lists the gate compares stay comparable rather than merely similar.
 *
 * Reading the literal forms is not a nicety. This set answers "might the parent
 * already supply this name", and answering "no" for a name the parent really
 * supplies is how an appended stand-in SHADOWS the parent's working export —
 * the false pass `planAugmentedModules` refuses to risk. `export *` is the one
 * shape that names nothing this file can answer: its names are the target's, and
 * that chain is resolved in the parent worktree (see `starExportNames`).
 */
export function declaredExportNames(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  const names: string[] = [];
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) continue;
      if (ts.isNamedExports(clause)) {
        // `propertyName` is the module-local name; `name` is the name the
        // module exports, so `export { a as b }` contributes `b`.
        for (const element of clause.elements) names.push(element.name.text);
        continue;
      }
      names.push(clause.name.text);
      continue;
    }
    if (!hasKeyword(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push(...variableBindingNames(declaration.name));
      }
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      const name = statement.name;
      if (name !== undefined && ts.isIdentifier(name)) names.push(name.text);
    }
  }
  return names.sort();
}

/**
 * The names a module exports that exist **at runtime**, sorted.
 *
 * `declaredExportNames` answers "what shape does this module declare"; this one
 * answers "what can a running import bind". The two differ by every shape
 * TypeScript erases, and asking the wrong one is a false "the parent already has
 * it": `export type { value } from "./types"` is gone before the module
 * executes, so a plan built on the declared list appends no stand-in for the
 * runtime `value` the change adds, the parent's `import { value }` fails to
 * resolve, and a file the gate could judge becomes CANNOT-HOLLOW plus a
 * whole-file waiver.
 *
 * Dropped: `export type { … }` (the whole declaration, including
 * `export type * from`), a `type`-marked specifier inside an export list, a type
 * alias, an interface, and an ambient `declare` export — the last for the reason
 * `hollowModuleSource` already refuses to mirror one, that it "emits no runtime
 * value". Kept: everything else `declaredExportNames` keeps, because a function,
 * a class, a `const`/`let`/`var`, an enum, a namespace and `export * as ns` all
 * bind a value.
 *
 * `declaredExportNames` itself is deliberately left alone, because its other
 * callers are not asking a runtime question: `hollowModuleSource` compares the
 * real module's declared shape against its mirror's and must read both sides the
 * same way (an interface is mirrored *because* the real file declares one), and
 * `augmentModuleSource`'s clash check asks which names one statement declares —
 * a scope question, not a runtime one. `export *` names nothing here either; its
 * names are the target's and are resolved in the parent worktree by
 * `starExportNames`.
 */
export function runtimeExportNames(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  const names: string[] = [];
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      // `export type { … }` and `export type * from …` carry nothing that runs.
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      // A bare `export *` names nothing here; `starExportNames` resolves it.
      if (clause === undefined) continue;
      if (ts.isNamedExports(clause)) {
        // `export { type a, b }` keeps `b` and drops `a`.
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          names.push(element.name.text);
        }
        continue;
      }
      // `export * as ns from "./y"` binds the namespace object.
      names.push(clause.name.text);
      continue;
    }
    if (!hasKeyword(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasKeyword(statement, ts.SyntaxKind.DeclareKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push(...variableBindingNames(declaration.name));
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      const name = statement.name;
      if (name !== undefined && ts.isIdentifier(name)) names.push(name.text);
    }
  }
  return names.sort();
}

/**
 * Every name declared in a module's top-level scope, exported or not.
 *
 * This, not `declaredExportNames`, is the set an appended declaration can
 * collide with: a declaration redeclares any binding in the same scope, and the
 * ordinary way a module gains an export is to promote a module-local binding to
 * one (`const specPaths = ["a"]` → `export const specPaths = ["a"]`). That case
 * is invisible to the export list, and writing the stand-in anyway produces a
 * module with two `specPaths` in one scope — a file that does not load, so every
 * test in the importing file reads as a whole-file failure.
 *
 * Import bindings are included for the same reason: `import { readFileSync }`
 * occupies the top-level scope exactly as a `const` does, and appending a
 * declaration of that name is the same duplicate.
 */
export function topLevelBindingNames(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  const names: string[] = [];
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      // A destructured binding (`const { a, b } = x`, `const [c] = y`) declares
      // one name per element, and those names are top-level bindings too. One
      // walk, shared with the two export readers, so the clash set and the
      // export sets cannot disagree about what a statement declares.
      for (const declaration of statement.declarationList.declarations) {
        names.push(...variableBindingNames(declaration.name));
      }
      continue;
    }
    if (ts.isImportDeclaration(statement)) {
      // An import binding occupies the top-level scope exactly as a `const`
      // does. `import x` / `import * as x` / `import { a as b }` are three
      // spellings of the same declaration.
      const clause = statement.importClause;
      if (clause === undefined) continue;
      if (clause.name !== undefined) names.push(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        names.push(bindings.name.text);
        continue;
      }
      for (const element of bindings.elements) names.push(element.name.text);
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      const name = statement.name;
      if (name !== undefined && ts.isIdentifier(name)) names.push(name.text);
    }
  }
  return names.sort();
}

/**
 * The hollow mirror of one module, or the reason it cannot be mirrored.
 *
 * Every export mirror is chosen so that calling it cannot throw: a function with
 * an empty body returns `undefined`, a `const` is `undefined`, a `let` is
 * uninitialised, a class is empty. A hollow that threw on call would make a
 * vacuous test fail for the harness's reason and read as a real red.
 *
 * Imports are dropped rather than mirrored. Importing a module runs it, and a
 * hollow's whole contract is that it runs nothing — so a chain of added modules
 * cannot put behaviour back through it. That is why the nested case needs no
 * chain walk: after hollowing, nothing in the module loads anything.
 */
export function hollowModuleSource(
  source: string,
  path: string,
  kind: MirrorKind = "hollow",
): HollowResult {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  const refuse = (why: string): HollowResult => ({ ok: false, refusal: `${path}: ${why}` });
  const lines: string[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      // `export import X = require(…)` re-exports, so it is not an import to drop.
      if (hasKeyword(statement, ts.SyntaxKind.ExportKeyword)) {
        return refuse("it exports an `import =` alias, which a hollow cannot mirror");
      }
      continue;
    }
    // `export { a }` and `export default x` carry no `export` *modifier* — the
    // statement kind is the export — so they are refused before the modifier
    // check below, which would otherwise read them as behaviour with no name to
    // mirror and drop them in silence.
    if (ts.isExportDeclaration(statement)) {
      return refuse(
        "it re-exports from another module (`export … from`), and a hollow has nothing to re-export",
      );
    }
    if (ts.isExportAssignment(statement)) {
      return refuse(statement.isExportEquals ? "it uses `export =`" : "it has an `export default`");
    }
    // A statement with no `export` modifier is behaviour with no name to mirror,
    // which is exactly what a hollow leaves out.
    if (!hasKeyword(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasKeyword(statement, ts.SyntaxKind.DefaultKeyword)) {
      return refuse("it has an `export default`, whose meaning is the whole module's value");
    }
    if (hasKeyword(statement, ts.SyntaxKind.DeclareKeyword)) {
      return refuse(
        "it declares an ambient (`declare`) export, which emits no runtime value — mirroring it would invent an export the real module does not have",
      );
    }
    const decorators = ts.canHaveDecorators(statement) ? ts.getDecorators(statement) : undefined;
    if (decorators !== undefined && decorators.length > 0) {
      return refuse("an exported declaration is decorated, and a decorator is behaviour");
    }
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name;
      if (name === undefined) return refuse("it exports a function with no name");
      // `..._args` rather than the real signature: the parent's copy is never
      // type-checked, and a test that calls it with anything must reach its own
      // assertion instead of a load error. No annotation, and no return
      // annotation either — this is the one body for every language, because
      // `scriptKindFor` parses `.js`, `.mjs` and `.cjs` as JavaScript and bun
      // does not type-check. A TypeScript signature emitted into a JavaScript
      // file is a syntax error: bun answers `Expected ")" but found ":"`, the
      // stand-in never loads, and a valid test is scored WRONG_REASON_RED
      // instead of being judged against a runnable parent. One shape that loads
      // everywhere, rather than two shapes chosen by extension.
      lines.push(`export function ${name.text}(..._args) {\n  return undefined;\n}`);
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      const name = statement.name;
      if (name === undefined) return refuse("it exports a class with no name");
      lines.push(`export class ${name.text} {}`);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      const keyword =
        (flags & ts.NodeFlags.Const) !== 0 ? "const" : (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          return refuse("it exports a destructured binding, whose names are not one declaration each");
        }
        // `let`/`var` without an initialiser is already `undefined`; `const`
        // needs one to parse.
        lines.push(
          keyword === "const"
            ? `export const ${declaration.name.text} = undefined;`
            : `export ${keyword} ${declaration.name.text};`,
        );
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      // Erased by the runtime, so an empty one is not a lie — the mirror must
      // *declare* it only because the real module does.
      lines.push(`export interface ${statement.name.text} {}`);
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      lines.push(`export type ${statement.name.text} = unknown;`);
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      return refuse("it exports an enum, whose members are runtime values a hollow cannot reproduce");
    }
    if (ts.isModuleDeclaration(statement)) {
      return refuse("it exports a namespace, whose members are runtime values a hollow cannot reproduce");
    }
    return refuse(
      `it exports a ${ts.SyntaxKind[statement.kind]} declaration, which a hollow does not mirror`,
    );
  }

  const text = [MIRROR_HEADER[kind], "", ...lines].join("\n") + "\n";
  // The last line of defence, and the reason the mirror is parsed again rather
  // than trusted: an emission that lost or invented an export name would be a
  // hollow that lies about the module's shape, and refusing is always available.
  const wanted = declaredExportNames(path, source);
  const mirrored = declaredExportNames(path, text);
  if (wanted.join("\u0000") !== mirrored.join("\u0000")) {
    return refuse(
      `a hollow would export ${mirrored.join(", ") || "nothing"} where the module exports ${wanted.join(", ") || "nothing"}`,
    );
  }
  return { ok: true, text };
}

/**
 * How many syntax errors TypeScript finds in a source file.
 *
 * `transpileModule` reports syntactic diagnostics only — a type error is not one
 * — which is exactly the question here: a file that does not parse cannot be
 * appended to, and a file that parses but would not typecheck is the parent's
 * normal state (the parent checkout is never typechecked by this gate).
 *
 * Not `SourceFile.parseDiagnostics`: that array is on the runtime object and
 * absent from the public typings, so reading it means a cast that a minor
 * TypeScript upgrade can turn into a silent zero — and a silent zero here
 * augments broken text instead of refusing it.
 */
function syntaxErrorCount(source: string, path: string): number {
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return result.diagnostics?.length ?? 0;
}

/** Whether a module's source carries a default export, in either spelling. */
function hasDefaultExport(source: string, path: string): boolean {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  return file.statements.some(
    (statement) =>
      (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
      hasKeyword(statement, ts.SyntaxKind.DefaultKeyword),
  );
}

/**
 * Where one export name is declared in a module's source, or why it cannot be
 * mirrored by appending a declaration.
 *
 * `.` is the declaration to mirror; the other two are refusals with a reason a
 * human can act on, because an appended stand-in has to be about *this* name and
 * nothing else.
 */
type ExportLookup =
  | { kind: "declaration"; statement: ts.Statement }
  | { kind: "unmirrorable"; why: string }
  | { kind: "missing" };

function exportLookup(source: string, path: string, name: string): ExportLookup {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  // A direct declaration first: a module can carry `export *` beside the name an
  // appended stand-in is for, and the name it really declares is the one to
  // mirror.
  for (const statement of file.statements) {
    if (!hasKeyword(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      const declares = statement.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) ? declaration.name.text === name : false,
      );
      if (declares) return { kind: "declaration", statement };
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      const declared = statement.name;
      if (declared !== undefined && ts.isIdentifier(declared) && declared.text === name) {
        return { kind: "declaration", statement };
      }
    }
  }
  // Then the export statements, which name the export without declaring it.
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      if (!clause.elements.some((element) => element.name.text === name)) continue;
      return {
        kind: "unmirrorable",
        why:
          statement.moduleSpecifier === undefined
            ? `the change exports \`${name}\` through an export list (\`export { … }\`), which carries no declaration an appended stand-in could mirror`
            : `the change re-exports \`${name}\` from another module, and an appended stand-in cannot re-export`,
      };
    }
    if (statement.moduleSpecifier !== undefined) {
      return {
        kind: "unmirrorable",
        why: `the change re-exports from another module and may re-export \`${name}\` that way, and an appended stand-in cannot re-export`,
      };
    }
  }
  return { kind: "missing" };
}

/**
 * The parent's copy of a module with stand-ins appended for the export names it
 * lacks, or the reason that cannot be done faithfully.
 *
 * This is the third thing the gate can do with a module, and the narrow one:
 *
 *   - the change ADDS the module: the parent gets a hollow (same names, no
 *     behaviour);
 *   - the parent HAS the module and the test only uses names the parent's copy
 *     declares: the parent's own file is left alone;
 *   - the parent HAS the module and the change adds a name to it: the parent's
 *     source is kept byte for byte and a stand-in for that name is appended.
 *
 * The middle case is why this is not a hollow. A stand-in for the whole module
 * would erase behaviour the parent really carries, and a test of that behaviour
 * would then fail on the parent and be read as a right-reason red — a false pass
 * for a test that pins nothing the change adds. Appending leaves every existing
 * export real, so that test still passes on the parent and is rejected.
 *
 * Everything an appended declaration cannot carry is refused, in the same
 * vocabulary the hollow writer refuses: a default, a re-export, an export list,
 * an enum, a namespace, an ambient `declare`, a destructured binding, a
 * decorator. So is a parent copy that does not parse, and a declaration that
 * shares a statement with a name the parent's scope already binds — appending it
 * would declare that name twice and the augmented file would not load at all.
 *
 * The clash set is `topLevelBindingNames`, not `declaredExportNames`: a
 * declaration collides with a module-local binding as surely as with an export,
 * and promoting a local binding to an export (`const x = 1` → `export const x =
 * 1`) is the ordinary way a module gains a name. See that function.
 *
 * `names` is the planner's answer, and `parentSupplied` is the other half of it:
 * every export the parent's copy RESOLVES at runtime, and where it comes from.
 * The planner is where a parent's `export *` chain is resolved
 * (`starExportNames`), because this function cannot read another file. It must
 * be told rather than guess, for the reason the sibling check below exists.
 *
 * A mirrored statement is appended whole, so it can declare a name the caller
 * did not ask for. That is fine when the parent does not supply the sibling
 * (`export const a = 1, b = 2` with a test that imports only `a`). It is a
 * shadow when the parent does: `export * from "./base"` supplies `b` without
 * binding it locally, so the parent's binding set cannot see it, and appending
 * the change's `export const a = 1, b = 7` replaces the parent's working `b`
 * with the stand-in's `undefined`. A test of the parent's own `b` then fails
 * against the fake and the gate scores it RIGHT-REASON-RED — a false pass, and
 * the worst one this gate can print, because the untouched parent passes that
 * test. So a sibling the parent supplies is a refusal here, not a "not my
 * problem" the clash set happens not to cover.
 */
export function augmentModuleSource(
  parentSource: string,
  changeSource: string,
  path: string,
  names: string[],
  parentSupplied: ReadonlyMap<string, ParentSupply>,
): HollowResult {
  const refuse = (why: string): HollowResult => ({ ok: false, refusal: `${path}: ${why}` });
  if (names.length === 0) return { ok: true, text: parentSource };
  if (syntaxErrorCount(parentSource, path) > 0) {
    return refuse(
      "the parent's copy of this module does not parse, so appending to it would produce text that still loads nowhere",
    );
  }
  if (syntaxErrorCount(changeSource, path) > 0) {
    return refuse("the change's copy of this module does not parse");
  }
  const parentExports = new Set(declaredExportNames(path, parentSource));
  // Every name the parent's module scope already binds, so an appended
  // declaration cannot silently redeclare one of them.
  const parentBindings = new Set(topLevelBindingNames(path, parentSource));
  // The names this call is FOR. A sibling outside this set is carried along by
  // the statement's shape, not requested, so it is the one the parent might
  // already supply.
  const requested = new Set(names);
  const blocks: string[] = [];
  // Statements already mirrored. `export const b = 2, c = 3;` declares two names,
  // so a request for both resolves to the same statement twice; appending it
  // twice would declare each name twice.
  const mirroredStatements = new Set<string>();
  // Every name the mirrored statements really declare, which is a superset of
  // `names` whenever a statement declares more than the one requested. The
  // self-check below asks what the appended text is meant to declare rather than
  // what the test happened to import. See the block comment on the comparison for
  // why that is the shape and not a hole.
  const appendedNames: string[] = [];
  for (const name of names) {
    if (name === "default") {
      return refuse(
        "the change gives this module an `export default`, whose meaning is the whole module's value — no appended declaration can stand in for it",
      );
    }
    const lookup = exportLookup(changeSource, path, name);
    if (lookup.kind === "missing") {
      return refuse(
        `the change composes \`${name}\` in a way this gate cannot read as one declaration, so no stand-in can be appended for it`,
      );
    }
    if (lookup.kind === "unmirrorable") return refuse(lookup.why);
    const statementText = lookup.statement.getText();
    // The statement may declare more than the one name. The stand-in mirrors the
    // whole statement, so every name it declares must be free in the parent's
    // scope: a bound name would be declared twice in the augmented file.
    const declared = declaredExportNames(path, statementText);
    const clash = declared.filter((candidate) => parentBindings.has(candidate));
    if (clash.length > 0) {
      // The refusal is about the STATEMENT, because that is what would be
      // appended. Naming only `name` made the message read like a gate bug when
      // the clash was a sibling (`export const b = 2, c = 3;` refused for `b`
      // because the parent already has `c`), so the message says which
      // declaration cannot be appended and why, and only then what that costs.
      const shared = declared.length > 1 ? ` (the statement \`${statementText.trim()}\` declares ${declared.map((candidate) => `\`${candidate}\``).join(", ")} together)` : "";
      if (clash.includes(name)) {
        return refuse(
          `the parent's module already binds \`${name}\`${shared}, so the stand-in that declares it cannot be appended without declaring it twice`,
        );
      }
      return refuse(
        `a stand-in for \`${name}\` would have to append \`${statementText.trim()}\`, which the parent's module already binds \`${clash.join("`, `")}\` in, so that declaration cannot be appended and \`${name}\` has no stand-in`,
      );
    }
    // A sibling the parent RESOLVES is a shadow, whether the parent binds it or
    // only re-exports it. `export * from "./base"` creates no local binding, so
    // the clash set above answers "free" for a name the running parent really
    // has; appending the statement anyway would hide the parent's real export
    // behind the fake and turn a passing test into an accepted red.
    const shadow = declared.find(
      (sibling) => !requested.has(sibling) && parentSupplied.has(sibling),
    );
    if (shadow !== undefined) {
      const supply = parentSupplied.get(shadow);
      const where =
        supply?.kind === "star"
          ? `through \`${supply.specifier}\``
          : "in its own export list";
      return refuse(
        `a stand-in for \`${name}\` would append \`${statementText.trim()}\`, which also declares \`${shadow}\`, and the parent supplies \`${shadow}\` ${where} — appending that declaration would shadow the parent's real export, so a test of the parent's own \`${shadow}\` would fail against the fake and be accepted as a right-reason red`,
      );
    }
    if (mirroredStatements.has(statementText)) continue;
    mirroredStatements.add(statementText);
    appendedNames.push(...declared);
    const mirrored = hollowModuleSource(statementText, path, "augment");
    if (!mirrored.ok) {
      // The hollow writer's reason, with the name this iteration is for. A file can
      // import several names the parent lacks, and "an enum cannot be mirrored"
      // without the name leaves the author looking through the module for it. The
      // path prefix the mirror already carries is not repeated.
      const prefix = `${path}: `;
      const why = mirrored.refusal.startsWith(prefix)
        ? mirrored.refusal.slice(prefix.length)
        : mirrored.refusal;
      return refuse(`an appended stand-in for \`${name}\` would be unfaithful — ${why}`);
    }
    blocks.push(mirrored.text);
  }
  // The parent's text verbatim, then the appended stand-ins. One blank line
  // between the halves whether or not the parent's file ends with a newline.
  const separator = parentSource.endsWith("\n") ? "\n" : "\n\n";
  const text = `${parentSource}${separator}${blocks.join("\n")}`;
  // The same last line of defence the hollow writer has: a mirror that lost or
  // invented a name is a lie about the module's shape, and refusing is always
  // available.
  //
  // What is EXPECTED is read from the change's own declarations — the requested
  // names plus every sibling the mirrored statements declare — never from the
  // emitted text, so a mirror that drops or invents a name still fails here. The
  // expectation used to be the requested names alone, and a request for one name
  // of a shared statement (`export const a = 1, b = 2`, test imports only `a`)
  // then compared `a, base` against a faithful `a, b, base` and refused a valid
  // stand-in: CANNOT-HOLLOW plus a whole-file waiver, for a file the gate could
  // judge. Splitting the statement instead was the alternative; it would have
  // meant a second emitter beside `hollowModuleSource` deciding what one
  // declaration looks like, and two emitters that disagree is the bug this
  // function's reading helpers exist to stop.
  //
  // The invariant that does not move: a stand-in is never appended over a name
  // the parent already supplies. Three checks hold it up: the clash set refuses a
  // name the parent BINDS, the shadow check above refuses a sibling the parent
  // RESOLVES but does not bind (a re-export), and the BINDING comparison below is
  // the backstop under both.
  //
  // Two checks, not one. The export set is what the importing file picks up; the
  // BINDING list is what makes the file load at all. The two compare differently,
  // on purpose. The export side is a SET, because one name can legitimately be
  // named twice there and still load: the parent's `export type { value } from
  // "./types"` beside an appended `export function value()` is exactly the shape
  // this round exists to accept. The BINDING side stays a sorted ARRAY, because a
  // name declared twice appears twice in `topLevelBindingNames` and a stray
  // duplicate must fail the comparison instead of sitting in the parent worktree
  // as a file that cannot load — which is the blocker round 25 closed.
  const wantedNames = [...new Set(names)];
  const appendedDeclared = [...new Set(appendedNames)];
  // What the appended text is meant to add, for the refusal messages as well as
  // the comparison: the request plus the siblings it dragged in with it.
  const appendedLabel = [...new Set([...wantedNames, ...appendedDeclared])];
  const wantedExports = [...new Set([...parentExports, ...appendedLabel])].sort();
  const wantedBindings = [...new Set([...parentBindings, ...appendedLabel])].sort();
  // A set on the export side, and only there. `export type { value } from
  // "./types"` beside an appended `export function value()` names `value` twice
  // in the declared export list and loads fine — that pair is the shape this
  // round exists to accept — while a genuinely duplicated declaration is caught
  // by the BINDING comparison below, which stays a multiset for exactly that
  // reason.
  const mirroredExports = [...new Set(declaredExportNames(path, text))].sort();
  const mirroredBindings = topLevelBindingNames(path, text);
  if (wantedExports.join("\u0000") !== mirroredExports.join("\u0000")) {
    return refuse(
      `an augmentation would export ${mirroredExports.join(", ") || "nothing"} where the parent's module plus \`${appendedLabel.join("`, `")}\` is ${wantedExports.join(", ") || "nothing"}`,
    );
  }
  if (wantedBindings.join("\u0000") !== mirroredBindings.join("\u0000")) {
    return refuse(
      `an augmentation would declare ${mirroredBindings.join(", ") || "nothing"} at the top level where the parent's module plus \`${appendedLabel.join("`, `")}\` is ${wantedBindings.join(", ") || "nothing"} — the augmented file would not load`,
    );
  }
  return { ok: true, text };
}

/**
 * The paths a relative specifier could name, in bun's probe order, or null when
 * the specifier is not a relative module inside the repository.
 *
 * Two callers probe this list and they have to agree: the diff's own paths ask
 * which module the change adds or edits, and an `export *` chain asks which
 * module the parent's copy re-exports from, by reading. Both land on the same
 * file the loader will, or on nothing.
 *
 * The probe order is bun's: the specifier itself (it may carry an extension),
 * then the bare extensions, then a directory index. A `..` that climbs out of the
 * repository resolves to nothing.
 */
function moduleCandidates(fromFile: string, specifier: string): string[] | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (joined.startsWith("../") || joined === ".." || posix.isAbsolute(joined)) return null;
  return [
    joined,
    ...MODULE_EXTENSIONS.map((extension) => `${joined}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => `${joined}/index${extension}`),
  ];
}

/**
 * The file a relative specifier names, out of a set of paths the gate already
 * knows.
 *
 * Two callers, one resolution: the hollow path asks it whether the diff ADDS the
 * module, and the augment path whether the diff EDITS it. Both have to land on
 * the same file the loader will, or one of them fakes a module the other already
 * judged.
 *
 * Only an exact hit against the set is accepted, so the gate never guesses at a
 * resolution it cannot confirm. See `moduleCandidates` for the probe order.
 */
function resolveModuleIn(
  fromFile: string,
  specifier: string,
  paths: ReadonlySet<string>,
): string | null {
  const candidates = moduleCandidates(fromFile, specifier);
  if (candidates === null) return null;
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

/**
 * The same resolution, probed by reading: the first candidate the parent's
 * checkout actually holds.
 *
 * `export *` names a target the diff need not have touched, so there is no path
 * set to look it up in. The read is the probe, and a `null` from every candidate
 * is the gate's answer that it cannot resolve the chain.
 */
function resolveModuleWith(
  fromFile: string,
  specifier: string,
  read: (path: string) => string | null,
): string | null {
  const candidates = moduleCandidates(fromFile, specifier);
  if (candidates === null) return null;
  return candidates.find((candidate) => read(candidate) !== null) ?? null;
}

/**
 * The targets a module re-exports everything from (`export * from "…"`), as
 * written.
 *
 * The names such a module supplies are the target's names, so this file cannot
 * answer what they are. `export type *` is skipped: its names are types, erased
 * before the file runs, so they supply no runtime export a stand-in could shadow.
 */
function starExportSpecifiers(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
  const specifiers: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    // `export { a }` and `export * as ns` name their own exports; only a bare
    // star hands the naming to another module.
    if (statement.exportClause !== undefined) continue;
    if (statement.isTypeOnly) continue;
    const module = statement.moduleSpecifier;
    if (module === undefined || !ts.isStringLiteral(module)) continue;
    specifiers.push(module.text);
  }
  return specifiers;
}

/**
 * The names a module supplies through its `export *` chain, resolved inside the
 * parent's checkout, or the reason the gate cannot resolve it.
 *
 * A name the parent supplies through `export *` is absent from the parent's own
 * export list, so asking `declaredExportNames` alone answers "missing" for a name
 * the parent really has. The appended stand-in then SHADOWS the parent's working
 * re-export: a test of the parent's own behaviour fails against the fake, and the
 * gate accepts that as a right-reason red — a test that pins nothing, scored as a
 * test that pins something.
 *
 * Resolving is the only alternative to refusing. A chain the gate cannot read — a
 * target outside the repository, a package specifier, a file the parent does not
 * have — refuses the augmentation, because assuming such a chain cannot supply
 * the name is exactly the shadow this function exists to stop.
 *
 * A cycle is followed once: a module that re-exports everything from itself adds
 * no name the first visit did not already read.
 *
 * The result is a name-to-SPECIFIER map, not a bare list: the caller has to know
 * which line of the parent's source reaches a name to refuse it in words the
 * author can act on (`through "./base"`), and a name three links down a chain is
 * not one the author wrote. A nested hop is attributed to the specifier THIS
 * module wrote, because that is the line the reader can go and look at.
 */
function starExportNames(
  path: string,
  source: string,
  read: (path: string) => string | null,
  seen: Set<string>,
): { ok: true; origins: Map<string, string> } | { ok: false; refusal: string } {
  const specifiers = starExportSpecifiers(path, source);
  if (specifiers.length === 0 || seen.has(path)) return { ok: true, origins: new Map() };
  seen.add(path);
  // Every name attributed to the specifier that reaches it from THIS module, so
  // a refusal can say `through "./base"` rather than naming a file further down
  // the chain that the author never wrote.
  const origins = new Map<string, string>();
  for (const specifier of specifiers) {
    const target = resolveModuleWith(path, specifier, read);
    const targetSource = target === null ? null : read(target);
    if (target === null || targetSource === null) {
      return {
        ok: false,
        refusal: `${path}: the parent's copy re-exports everything from \`${specifier}\`, and the gate cannot resolve that inside the parent's checkout — the names it supplies are unknowable from here, and a stand-in for one of them would shadow the parent's real export, so this module cannot be augmented`,
      };
    }
    const direct = runtimeExportNames(target, targetSource);
    for (const name of direct) {
      if (!origins.has(name)) origins.set(name, specifier);
    }
    const nested = starExportNames(target, targetSource, read, seen);
    if (!nested.ok) return nested;
    for (const name of nested.origins.keys()) {
      if (!origins.has(name)) origins.set(name, specifier);
    }
  }
  return { ok: true, origins };
}

/**
 * The hollow modules one added test file needs on the parent.
 *
 * `added` is every path the diff adds, and `readAdded` reads one at `head`. A
 * specifier that names a test file is not hollowed: a file that imports another
 * test file is refused outright before this runs, because the report cannot say
 * whose case failed.
 */
export function planHollowModules(
  testFile: string,
  testSource: string,
  added: ReadonlySet<string>,
  readAdded: (path: string) => string | null,
): HollowPlan {
  const modules: HollowPlan["modules"] = [];
  const seen = new Set<string>();
  for (const specifier of loadedRelativeSpecifiers(testSource, testFile)) {
    if (TEST_LIKE_BASENAME.test(specifier.split("/").pop() ?? "")) continue;
    const path = resolveModuleIn(testFile, specifier, added);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    const source = readAdded(path);
    if (source === null) {
      return {
        modules: [],
        refusal: `${path}: the gate cannot read the module this file imports at the change's commit, so it cannot tell what the parent is missing`,
      };
    }
    const hollow = hollowModuleSource(source, path);
    if (!hollow.ok) return { modules: [], refusal: hollow.refusal };
    modules.push({ path, importedBy: testFile, text: hollow.text });
  }
  // Sorted so the report and the manifest describe one order whatever order the
  // file lists its imports in.
  modules.sort((left, right) => (left.path < right.path ? -1 : 1));
  return { modules, refusal: null };
}

/** A module the parent HAS, carried into the parent worktree with stand-ins appended. */
export type AugmentedModule = { path: string; importedBy: string; names: string[] };

/**
 * How the parent's copy supplies one runtime export name.
 *
 * `own` is the parent's own source — a local declaration, or a literal
 * `export { b } from "./x"` that names an export a running import can bind
 * without binding it locally. `star` is a bare `export * from`, which hands the
 * naming to another module entirely, so the specifier is the answer to "where
 * does this come from" for the refusal.
 */
export type ParentSupply = { kind: "own" } | { kind: "star"; specifier: string };

export type AugmentPlan = {
  modules: Array<AugmentedModule & { text: string }>;
  refusal: string | null;
};

/**
 * The modules a gated test file needs *augmented* on the parent: the ones the
 * diff edits, where the test imports a name the parent's copy does not declare.
 *
 * `touched` is every path the diff edits rather than adds, and the two sets are
 * disjoint: an added module is the hollow path's, and a module the diff does not
 * touch is identical on both sides, so it cannot be missing a name the change
 * adds.
 *
 * The names come from the test file's own imports, not from the load error bun
 * prints. The static answer is the one that can be checked before the run, and it
 * is the one that can be refused with the name and the shape in the message — a
 * transcript is only read after the fact.
 *
 * A refusal is about one module, and it survives beside the stand-ins the other
 * modules get. Two consequences worth stating, because both were bugs:
 *
 *   - the parent's own export list is asked FIRST, and a module whose requested
 *     names it answers never has its `export *` chain resolved at all. An
 *     unrelated `export * from "some-package"` used to refuse the plan, dropping
 *     a sibling module's stand-in for a name the test really needs;
 *   - a module that cannot be mirrored no longer empties `modules`. Its refusal
 *     is still reported and the file still will not load, so nothing is accepted
 *     that was not judged — the sibling's stand-in is simply not thrown away with
 *     it.
 */
export function planAugmentedModules(
  testFile: string,
  testSource: string,
  touched: ReadonlySet<string>,
  readChange: (path: string) => string | null,
  readParent: (path: string) => string | null,
): AugmentPlan {
  const modules: AugmentPlan["modules"] = [];
  // Per-module, and never a reason to drop a sibling's stand-in. A refusal is
  // about one module's source; the modules this function *can* mirror are
  // still returned, so the report says what the gate actually wrote.
  const refusals: string[] = [];
  const seen = new Set<string>();
  for (const binding of importedModuleBindings(testSource, testFile)) {
    const path = resolveModuleIn(testFile, binding.specifier, touched);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    const changeSource = readChange(path);
    if (changeSource === null) {
      refusals.push(
        `${path}: the gate cannot read this module at the change's commit, so it cannot tell which exports the change adds to the parent's copy`,
      );
      continue;
    }
    const parentSource = readParent(path);
    if (parentSource === null) {
      refusals.push(
        `${path}: the diff edits this module and the parent checkout has no copy of it, so there is nothing to augment`,
      );
      continue;
    }
    // The parent's RUNTIME export set, not its declared one: this answers "can a
    // running import of this module bind the name", and a type-only export
    // cannot. Counting `export type { value } from "./types"` as present appended
    // no stand-in for the runtime `value` the change adds, so the parent's own
    // `import { value }` failed to resolve and the file became a whole-file waiver.
    //
    // A MAP, not a Set: `augmentModuleSource` mirrors a whole statement, so it
    // must also know which sibling names this set answers for, and a refusal has
    // to say where the parent has one. The name it never declares locally is the
    // dangerous one — `export * from "./base"` supplies `b` without binding it.
    const supplied = new Map<string, ParentSupply>();
    for (const name of runtimeExportNames(path, parentSource)) {
      supplied.set(name, { kind: "own" });
    }
    const parentHasDefault = hasDefaultExport(parentSource, path);
    const stillMissing = (name: string): boolean =>
      name === "default" ? !parentHasDefault : !supplied.has(name);
    let missing = binding.names.filter(stillMissing);
    if (missing.length > 0) {
      // Only now, and only for the names the parent's own export list and literal
      // export lists did not answer: a name may still arrive through `export *`,
      // and assuming it cannot is the shadow this gate exists to stop.
      //
      // Asking earlier was the Greptile P1. `starExportNames` refuses a chain it
      // cannot resolve — a package specifier, a target outside the repository —
      // and a module that merely *carries* an `export * from "some-package"`
      // beside a name the test really uses then refused the whole plan. A test
      // file importing an existing name from that module and a new name from a
      // second module lost the second module's stand-in, so a file the gate could
      // load and judge became a whole-file waiver. A chain says nothing about a
      // name the parent's own copy already supplies, so it is not consulted for
      // one.
      const starred = starExportNames(path, parentSource, readParent, new Set());
      if (!starred.ok) {
        // Scoped, not fatal. The refusal is about THIS module's chain: a sibling
        // module's stand-in is still written, because one module that cannot be
        // mirrored does not make another one unmirrorable. The file will not load
        // either way, so the refusal still stands and is still reported — this
        // only keeps the report from claiming the gate did less than it did.
        refusals.push(starred.refusal);
        continue;
      }
      // Attributed to the specifier that reaches it, so the refusal below can
      // name `./base` — the line the author wrote — instead of the gate's own
      // vocabulary. A name the parent's own source already supplied keeps its
      // `own` origin, because a local declaration wins over a star anyway.
      for (const [name, specifier] of starred.origins) {
        if (!supplied.has(name)) supplied.set(name, { kind: "star", specifier });
      }
      missing = binding.names.filter(stillMissing);
    }
    // A test that only uses names the parent's copy really declares says nothing
    // about an augmentation, and the parent's file is left exactly as it is.
    if (missing.length === 0) continue;
    const augmented = augmentModuleSource(parentSource, changeSource, path, missing, supplied);
    if (!augmented.ok) {
      refusals.push(augmented.refusal);
      continue;
    }
    modules.push({ path, importedBy: testFile, names: missing, text: augmented.text });
  }
  modules.sort((left, right) => (left.path < right.path ? -1 : 1));
  // The first refusal in the file's own import order, and only one: the report
  // prints a refusal as one row's detail, and an author who fixes the first
  // re-runs and sees the next. Reporting the last would be arbitrary; reporting
  // all of them in one row buries each path behind the previous one.
  return { modules, refusal: refusals[0] ?? null };
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
  /** Added modules the gate faked into the parent, and the file that needed each. */
  hollowed: HollowedModule[];
  /** Modules the parent HAS, carried in whole, with stand-ins appended for the names the change adds. */
  augmented: AugmentedModule[];
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

/** The paths the diff adds. A path present at the parent is an edit, not an add. */
export function addedFiles(repo: string, mergeBase: string, head: string): string[] {
  return changedPaths(repo, mergeBase, head).filter(
    (path) => !git(repo, ["cat-file", "-e", `${mergeBase}:${path}`]).ok,
  );
}

export function addedTestFiles(
  repo: string,
  mergeBase: string,
  head: string,
  added: ReadonlySet<string> = new Set(addedFiles(repo, mergeBase, head)),
): string[] {
  const files: string[] = [];
  for (const path of added) {
    if (!isGatedTestPath(path)) continue;
    files.push(path);
  }
  return files.sort();
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
  addedPaths: ReadonlySet<string> = new Set(addedFiles(repo, mergeBase, head)),
): SkippedTestFile[] {
  const added = new Set(addedTestFiles(repo, mergeBase, head, addedPaths));
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

export function runGate(options: GateOptions, versions: { bun?: string } = bunVersions()): GateRun {
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
  // Every path the diff adds, computed ONCE. It used to be computed three times
  // (here, inside `addedTestFiles`, and again below), and each computation spawns
  // `git cat-file` once per changed path — on a diff of a hundred files that is
  // three hundred subprocess spawns for one answer that cannot change inside a
  // run.
  const added = new Set(addedFiles(repo, baseSha, head));
  const files = addedTestFiles(repo, baseSha, head, added);
  const skipped = skippedTestFiles(repo, baseSha, head, added);
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
      hollowed: [],
      augmented: [],
    };
  }
  // Every path the diff adds, so the parent can be given a hollow stand-in for
  // the added module a gated test file imports. Read once above, with the test
  // list it produces.
  //
  // The modules the diff edits rather than adds. A hollow is never written for
  // one: the parent has it, and a fake would erase behaviour the parent really
  // carries. It is here so a load failure caused by one can say which export.
  const touched = new Set(
    changedPaths(repo, baseSha, head).filter((path) => !added.has(path)),
  );
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
    return gateBaseWorktree({
      repo,
      head,
      baseSha,
      files,
      uncommitted,
      skipped,
      added,
      touched,
      fresh,
    });
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
  added: ReadonlySet<string>;
  touched: ReadonlySet<string>;
  fresh: boolean;
}): GateRun {
  const { repo, head, baseSha, files, uncommitted, skipped, added, touched, fresh } = input;
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
  const hollowed: HollowedModule[] = [];
  const augmented: AugmentedModule[] = [];
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
      const parsed = parseWaivers(source, file);
      for (const problem of parsed.problems) problems.push(`${file}: ${problem}`);
      // A file that imports another test file pulls that file's cases into its
      // own report, and bun names every case after the entry, so the report
      // cannot say whose test failed. Judging it would put the other file's
      // green case against this file — and demand a waiver for a test this
      // file does not contain. The gate names the import and judges nothing.
      const imports = importedTestFiles(source, file);
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
      // The added modules this file imports are the ones the parent cannot load,
      // so they are the ones it gets a hollow copy of. Written after the restore
      // and after the test file's own copy, in the order a run needs them; the
      // next file's restore removes them, and each is named in the manifest so a
      // run that dies half way still leaves nothing behind for the next one.
      const hollow = planHollowModules(file, source, added, (path) => {
        try {
          return readAtRevision(repo, head, path);
        } catch {
          return null;
        }
      });
      for (const module of hollow.modules) {
        copyIntoBaseWorktree(manifest, worktree, module.path, module.text, copied);
        hollowed.push({ path: module.path, importedBy: module.importedBy });
      }
      // The other half: a module the parent HAS, kept byte for byte, with a
      // stand-in appended only for the export names the change adds to it. Not a
      // hollow — a hollow of this file would erase behaviour the parent really
      // carries — and it is skipped when the hollow path already refused, because
      // then the file cannot load at all and one refusal is the honest report.
      const augment =
        hollow.refusal === null
          ? planAugmentedModules(
              file,
              source,
              touched,
              (path) => {
                try {
                  return readAtRevision(repo, head, path);
                } catch {
                  return null;
                }
              },
              (path) => {
                try {
                  return readAtRevision(repo, baseSha, path);
                } catch {
                  return null;
                }
              },
            )
          : { modules: [], refusal: null };
      for (const module of augment.modules) {
        copyIntoBaseWorktree(manifest, worktree, module.path, module.text, copied);
        augmented.push({ path: module.path, importedBy: module.importedBy, names: module.names });
      }

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
      // A module the parent has but the change extends with a new export is not
      // something a mirror can stand in for, and bun names it in the transcript.
      const refusal =
        hollow.refusal ?? augment.refusal ?? editedModuleExportRefusal(fileRun.stdout, touched);
      const classified = classifyFileRun(fileRun, parsed.waivers, changeResults, {
        // Both stand-in kinds answer the same question for `isOwnRed`: did the
        // gate's own fake turn a property read into `undefined`? A test that
        // dereferences an appended stand-in dies the same way one that
        // dereferences a hollow does.
        //
        // The residual hole this flag carries, stated rather than narrowed: an
        // AUGMENTED file still runs the parent's real code, so a TypeError there
        // has a cause the gate cannot see. Keeping the two kinds together is
        // deliberate — narrowing the flag would reject a legitimate
        // "dereference the new export" test — and both accepted shapes are
        // pinned as fixtures. See `isOwnRed`.
        hollowed: hollow.modules.length > 0 || augment.modules.length > 0,
      });
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
      // A module the gate could not mirror replaces the parent's verdicts with
      // one row, because the parent's run never judged the file: it read a parent
      // that is missing the module, and every row it produced says so. Keeping
      // those rows would print "the parent could not load the file" once per test
      // and leave the real reason — an unfaithful mirror — nowhere in the report.
      //
      // That justification holds only for a file the parent could not LOAD, so
      // the replacement is bounded at both ends:
      //
      //   - a run that did not finish is never replaced. RUN_INCOMPLETE is not a
      //     load failure — the file may never have been read — and no waiver covers
      //     it. Replacing it handed the whole file to a waiver, so a module
      //     refusal (made from the source, before the run) excused a parent run
      //     that timed out;
      //   - a run that FINISHED and registered testcases is never replaced. The
      //     file loaded, so a refusal cannot explain anything about this run: the
      //     planner sees every specifier in the source, including a lazy
      //     `await import()` inside a function body that no load reaches, and can
      //     refuse a module the parent never asked for. The parent's own rows are
      //     the honest report there, and dropping a refusal is not a false pass —
      //     a test that passes on the parent is GREEN_ON_PARENT and rejected.
      const unfinished = classified.verdicts.some((verdict) => verdict.name === "RUN_INCOMPLETE");
      const replacedByRefusal: Verdict | null =
        refusal !== null && !unfinished && parentResults.length === 0
          ? cannotHollowVerdict(file, refusal, parsed.waivers)
          : null;
      const parentVerdicts: Verdict[] =
        replacedByRefusal === null
          ? [...classified.verdicts, ...unregistered.verdicts, ...notOnChange]
          : [replacedByRefusal];
      verdicts.push(...parentVerdicts);
      // The change's own run is already made, so its statuses cost nothing to
      // read. They are read independently of the parent's waivers: a waiver says
      // why the parent could not run a test, not that the test works on the
      // change.
      verdicts.push(...changeSideVerdicts(file, parentVerdicts, changeResults));
      // When the file's rows are replaced by one CANNOT HOLLOW row, the waivers
      // `classifyFileRun` matched belong to rows nobody will read — counting them
      // used would hide the per-test waiver as accepted when the run says the file
      // was never judged. So only the rows that reach the report mark waivers used.
      const usedLines = new Set<number>(
        replacedByRefusal === null
          ? [...classified.usedWaiverLines, ...unregistered.usedWaiverLines]
          : [],
      );
      for (const verdict of parentVerdicts) for (const waiver of verdict.waivers) usedLines.add(waiver.line);
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
    hollowed,
    augmented,
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
      "this proves the test REACHES the change and fails there, not that it asserts a behaviour: a test that dereferences a stand-in (a TypeError) or only checks a const stand-in exists (an AssertionError) is accepted by design",
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
      "no waiver covers this: the change's own run decides it, whatever the parent's run did",
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
      "a module this diff EDITS is different: the gate keeps the parent's copy and appends a stand-in for the names the change adds, so a load failure there is a `CANNOT_HOLLOW` row that names the shape it refused — read that row, not this one",
      "if the missing module IS the change (a rename, a moved file), add `// red-on-parent-waive: \"<test name>\" — rename: the test moved with the file`",
    ],
  },
  {
    name: "CANNOT_HOLLOW",
    title:
      "the file imports an export the gate cannot stand in for: a name of an added module that no hollow can mirror, or a name the parent's own copy lacks in a shape no appended stand-in can carry",
    fixes: [
      "the gate fakes an added module into the parent, and appends a stand-in to a module the parent already has, so this file can load there; it refuses when the mirror would be unfaithful (a default export, a re-export, an export list, an enum, a namespace, an ambient `declare`, a destructured export, a decorator, a parent copy that does not parse, or a name the parent's own module scope already binds — promoting a module-local `const` to an export is the common one)",
      'if the module really cannot be mirrored, add `// red-on-parent-waive: "whole file" — <why the parent cannot run this file>` to the added test file, spelled exactly that way: this verdict is the one whose only escape hatch is a whole-file waiver, and the pattern has to BE `whole file`, not merely match it',
      "do not waive it to get past the gate: an unfaithful mirror lets a test that pins nothing pass on the parent",
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
    lines.push(runPasses({ verdicts: run.verdicts, problems }) ? "red-on-parent: PASS" : "red-on-parent: FAIL");
    return `${lines.join("\n")}\n`;
  }
  if (run.installLog.length > 0) lines.push(`installed the parent's dependencies: ${run.installLog}`);
  // A run whose red was produced against a fake has to say so, in the transcript
  // a human reads: a hollow that quietly swallowed an export would otherwise look
  // exactly like a verdict about the change.
  if (run.hollowed.length > 0) {
    lines.push(
      "hollowed modules (the parent has none of these, so the gate wrote a stand-in — same export names, no behaviour):",
    );
    for (const entry of run.hollowed) {
      lines.push(`  ${entry.path} — hollowed for ${entry.importedBy}`);
    }
  }
  // Stated under its own heading, and after the hollows, because the two are
  // different promises: this module is the PARENT's, kept whole, and only the
  // names the change adds are faked. A reader who took it for a hollow would
  // think the parent's own behaviour had been erased.
  if (run.augmented.length > 0) {
    lines.push(
      "augmented modules (the parent HAS these, so the gate kept the parent's own source and appended stand-ins for the exports the change adds — NOT hollowed):",
    );
    for (const entry of run.augmented) {
      lines.push(`  ${entry.path} — appended ${entry.names.join(", ")} for ${entry.importedBy}`);
    }
  }
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
  const failed = !runPasses({ verdicts: run.verdicts, problems });
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
      // Two verdicts mean "there was no red to judge here": WRONG REASON RED is
      // a parent that could not run the test, NOT ON PARENT a parent that never
      // reported it. Counting only the first printed `PASS (1 waived)` with no
      // explanation for a run whose only waived row was the second, while the
      // guide for that verdict says the same thing.
      const unjudged = waived.filter(
        (verdict) =>
          verdict.name === "WRONG_REASON_RED" ||
          verdict.name === "NOT_ON_PARENT" ||
          verdict.name === "CANNOT_HOLLOW",
      ).length;
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
    "CANNOT_HOLLOW",
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
    return runPasses(run) ? 0 : 1;
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
