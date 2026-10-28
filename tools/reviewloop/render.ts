#!/usr/bin/env bun
/**
 * reviewloop renderer: one to three lens reports in, a Greptile-shaped review out.
 *
 * The parent verifies reports, extracts findings and records owner approvals.
 * This renderer checks declared identities and the following two rules:
 *
 *   1. The lens families are checked against the author's family. A review run on
 *      the author's family is refused, not graded, unless the owner recorded an
 *      `independence` exception for a week with no other family left.
 *   2. The confidence score is computed from the findings and acts as a CEILING.
 *      A `scoreOverride` can lower it with a written reason; nothing can raise it.
 *
 * Everything else is presentation: the same markers, badges and sections the
 * existing workflow already greps for, so `cli-review`, `greploop`, `guard` and
 * the 5/5 merge gate keep working without an edit.
 *
 *   bun tools/reviewloop/render.ts --issue 312
 *   bun tools/reviewloop/render.ts --issue 312 --head <sha> --base develop
 *   Commit named files before reviewing; --worktree is refused as unpinned evidence.
 *   bun tools/reviewloop/render.ts --issue 312 --print        # body to stdout
 *   bun tools/reviewloop/render.ts --issue 312 --json         # {body, created}
 *
 * Writes, under `.scratch/reviews/<issue>/`:
 *   <head>-greptile-local.json   { body, created }   drop-in for the CLI contract
 *   <head>-greptile-local.md     the body on its own
 *   <head>-inline.json           review-comment payloads for anchored findings
 *
 * Exit codes: 0 clean (5/5, no P0/P1) - 1 findings remain - 2 review refused/incomplete.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { parseFlags } from "../../scripts/lib/args";

export type Severity = "P0" | "P1" | "P2";
type Impact = "Critical" | "High" | "Medium" | "Low";
export type Lens = {
  /** debate | test-audit | code-review */
  name: string;
  /** provider/model the lens actually ran on. */
  model: string;
  /** Raw report path, absolute or relative to the repo root. */
  report?: string;
  /** Present only when the lens genuinely did not apply. */
  skipped?: string;
};

/** A recorded owner decision, only for a week when no independent family is left. */
export type Independence = {
  approvedBy: string;
  reason: string;
};

export type Finding = {
  /** Shared defect identity assigned during extraction. Omit it to keep findings separate. */
  id?: string;
  lens: string;
  severity: Severity;
  title: string;
  path: string;
  line: number;
  endLine?: number;
  body: string;
  fix?: string;
  /** A ```suggestion block, already fenced. */
  suggestion?: string;
  /** The file:line outside the diff that proves it, or `self-evident: <why>`. */
  evidence?: string;
  /** Discussion permalink once the review is posted; blob link is used until then. */
  permalink?: string;
};

export type Payload = {
  /** The model that wrote the diff, as the lane's commit trailer records it. */
  authorModel: string;
  lenses: Lens[];
  /** Present only when the owner approved a review with no independent family. */
  independence?: Independence;
  summary: {
    /** Blast radius of the change, not the worst finding. */
    impact: Impact;
    /** One line: what the change does. */
    what: string;
    /** One line: what blocks the merge. Empty when nothing does. */
    verdict: string;
    /** Prose for the Summary section; defaults to `what`. */
    summary?: string;
    bullets?: string[];
    /** One line on what was and was not run (tests, typecheck, browser). */
    checks?: string;
    /** Findings looked at and deliberately not reported. */
    dismissed?: Array<{ title: string; reason: string }>;
    diagram?: string;
  };
  /** May only lower the computed score, and only with a reason. */
  scoreOverride?: { score: number; reason: string };
  findings: Finding[];
};

const payloadSchema: z.ZodType<Payload> = z.object({
  authorModel: z.string(),
  lenses: z.array(z.object({
    name: z.string(), model: z.string(), report: z.string().optional(), skipped: z.string().optional(),
  })),
  independence: z.object({ approvedBy: z.string(), reason: z.string() }).optional(),
  summary: z.object({
    impact: z.enum(["Critical", "High", "Medium", "Low"]),
    what: z.string(), verdict: z.string(), summary: z.string().optional(),
    bullets: z.array(z.string()).optional(), checks: z.string().optional(),
    dismissed: z.array(z.object({ title: z.string(), reason: z.string() })).optional(),
    diagram: z.string().optional(),
  }),
  scoreOverride: z.object({ score: z.number(), reason: z.string() }).optional(),
  findings: z.array(z.object({
    id: z.string().optional(), lens: z.string(), severity: z.enum(["P0", "P1", "P2"]),
    title: z.string(), path: z.string(), line: z.number(), endLine: z.number().optional(),
    body: z.string(), evidence: z.string().optional(), fix: z.string().optional(),
    suggestion: z.string().optional(), permalink: z.string().optional(),
  })),
});

const BADGE = "https://greptile-static-assets.s3.amazonaws.com/badges";
const LENS_NAMES = ["debate", "test-audit", "code-review"] as const;

// ---------------------------------------------------------------------------
// Arguments and repository position
// ---------------------------------------------------------------------------

const args = parseFlags(process.argv.slice(2), [
  { name: "--issue", kind: "value" },
  { name: "--base", kind: "value" },
  { name: "--head", kind: "value" },
  { name: "--worktree", kind: "switch" },
  { name: "--print", kind: "switch" },
  { name: "--json", kind: "switch" },
]);
function arg(name: string): string | undefined;
function arg(name: string, fallback: string): string;
function arg(name: string, fallback?: string) {
  if (!args.ok) fail(args.message);
  return args.values.get(`--${name}`)?.[0] ?? fallback;
}
const flag = (name: string) => {
  if (!args.ok) fail(args.message);
  return args.switches.has(`--${name}`);
};

const git = (...cmd: string[]) =>
  execFileSync("git", cmd, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** A refused payload. Thrown so the rules are testable; `main` turns it into exit 2. */
export class ReviewloopError extends Error {}

function main() {
  try {
    run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`reviewloop: ${error instanceof ReviewloopError ? detail : `could not complete review: ${detail}`}`);
    process.exit(2);
  }
}

function run() {
  const issue = arg("issue");
  if (!issue) fail("--issue <id> is required; it names `.scratch/reviews/<id>/`.");
  if (!/^[A-Za-z0-9._-]+$/.test(issue) || issue === "." || issue === "..") {
    fail(`--issue "${issue}" is not a plain folder name.`);
  }

  if (flag("worktree")) {
    fail("--worktree cannot produce commit-pinned evidence. Commit the reviewed files and omit --worktree.");
  }

  process.chdir(git("rev-parse", "--show-toplevel"));

  const head = git("rev-parse", "--verify", "--end-of-options", `${arg("head") || "HEAD"}^{commit}`);
  const base = arg("base", "develop");
  const dir = `.scratch/reviews/${issue}`;
  const inputPath = `${dir}/${head}-findings.json`;

  if (!existsSync(inputPath)) {
    fail(
      `missing ${inputPath}\n` +
        `Write the extracted findings there first; the reviewloop skill, step 4, has the schema.`,
    );
  }

  const parsedJson: unknown = (() => {
    try {
      return JSON.parse(readFileSync(inputPath, "utf8"));
    } catch (error) {
      fail(
        `${inputPath} is not valid JSON.\n  ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  const parsed = payloadSchema.safeParse(parsedJson);
  if (!parsed.success) fail(`${inputPath} has invalid field types.\n${parsed.error.message}`);
  const payload = parsed.data;

  const boundary = `${base}...${head}`;
  const { hunks, raw } = readDiff(base, head);
  if (raw.length === 0) {
    fail(
      `the diff ${boundary} is empty.\n` +
        `  An empty diff is a bad ref, not a clean review; pass the right --base or --head.`,
    );
  }
  if (hunks.length === 0) {
    fail(
      `the diff ${boundary} has content but no file header could be read.\n` +
        `  A review with no readable diff is not a review; check the refs and the path quoting.`,
    );
  }
  validate(payload, inputPath, hunks, head);

  const merged = dedupe(
    payload.findings.map((f) => ({ ...f, anchored: isAnchored(hunks, f) })),
  ).sort(bySeverity);
  validateMerged(payload, merged, inputPath);

  const ruleScore = computeScore(merged);
  const score = scoreOverride(payload, ruleScore);

  const body = renderBody({ payload, head, base, score, findings: merged });
  const json = { body, created: new Date().toISOString() };

  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${head}-greptile-local.json`, JSON.stringify(json));
  writeFileSync(`${dir}/${head}-greptile-local.md`, body);
  writeFileSync(
    `${dir}/${head}-inline.json`,
    JSON.stringify(merged.filter((f) => f.anchored).map(inlinePayload), null, 2),
  );

  if (flag("json")) {
    console.log(JSON.stringify(json));
  } else if (flag("print")) {
    console.log(body);
  } else {
    const inlineCount = merged.filter((f) => f.anchored).length;
    console.log(`reviewloop ${issue} @ ${head.slice(0, 7)}  (base ${base})`);
    console.log(`  score      ${score}/5${payload.scoreOverride ? " (override)" : ""}`);
    console.log(`  findings   ${merged.length}  (${countBy(merged, "P0")} P0, ${countBy(merged, "P1")} P1, ${countBy(merged, "P2")} P2)`);
    console.log(`  anchored   ${inlineCount} inline, ${merged.length - inlineCount} outside diff`);
    console.log(
      `  lenses     ${payload.lenses
        .map((l) => `${l.name}=${l.model}${l.skipped ? ` (skipped: ${l.skipped})` : ""}`)
        .join(", ")}`,
    );
    console.log(`  evidence   ${dir}/${head}-greptile-local.json`);
    for (const f of merged) {
      console.log(`  - ${f.severity} ${f.path}:${f.line} ${f.title} [${f.lenses.join("+")}]`);
    }
    if (payload.independence) {
      console.log(
        `  ! independence exception approved by ${payload.independence.approvedBy}: ` +
          `${payload.independence.reason}`,
      );
    }
  }

  const clean = score === 5 && !merged.some((f) => f.severity === "P0" || f.severity === "P1");
  process.exit(clean ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Validation: the two guards that keep the loop honest
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new ReviewloopError(msg);
}

/**
 * Families, not exact IDs: free and paid DeepSeek are the same opinion. The
 * version marker is the first segment shaped like `-v4`, `-5`, `-m3` or `-k3`.
 */
export function modelFamily(model: string): string {
  const id = model.split("/").pop()?.toLowerCase() ?? model.toLowerCase();
  // A split always yields one segment; the fallback satisfies the indexed-access check.
  const versioned = id.replace(/^([a-z]+)(?=\d)/, "$1-");
  return versioned.replace(/-free$/, "").split(/-[a-z]?\d/)[0] ?? versioned;
}

/** A family keeps its name across suffixes: `deepseek` and `deepseek-chat` are one opinion. */
function familyMatches(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

/** Same model family, the way the owner's rule means it: a route is not an opinion. */
export function sameFamily(a: string, b: string): boolean {
  return familyMatches(modelFamily(a), modelFamily(b));
}

export type IndependenceStatus = {
  allowed: boolean;
  families: number;
  /** Lens names that ran on the author's family. Empty is the normal case. */
  sameFamily: string[];
  reason?: string;
};

/**
 * The owner's rule: a different family reviews, and three lenses are not one
 * opinion counted three times. The exception exists for a week when the budget
 * leaves no other family, and it has to be recorded to be used.
 */
export function independenceOf(
  lenses: Lens[],
  authorModel: string,
  approval?: Independence,
): IndependenceStatus {
  const ran = lenses.filter((l) => !l.skipped);
  const author = modelFamily(authorModel);
  const lensFamilies = ran.map((l) => modelFamily(l.model));
  const unique: string[] = [];
  for (const family of lensFamilies) {
    if (!unique.some((known) => familyMatches(known, family))) unique.push(family);
  }
  const onAuthorFamily = ran.filter((l) => sameFamily(l.model, authorModel)).map((l) => l.name);
  const families = unique.length;
  const approved = Boolean(approval?.approvedBy.trim() && approval.reason.trim());

  if (onAuthorFamily.length > 0 && !approved) {
    return {
      allowed: false,
      families,
      sameFamily: onAuthorFamily,
      reason: `lens ${onAuthorFamily.map((name) => `"${name}"`).join(", ")} ran on the author's family (${author})`,
    };
  }
  if (ran.length > 1 && families < 2 && !approved) {
    return {
      allowed: false,
      families,
      sameFamily: onAuthorFamily,
      reason: `every lens ran on one family (${unique.join(", ")})`,
    };
  }
  return { allowed: true, families, sameFamily: onAuthorFamily };
}

export function validate(p: Payload, where: string, diff: Hunk[], head: string) {
  if (!p.authorModel?.trim()) {
    fail(`${where}: authorModel is required. The reviewer has to prove it is not the author.`);
  }
  if (!Array.isArray(p.lenses) || p.lenses.length < 1 || p.lenses.length > LENS_NAMES.length) {
    fail(`${where}: lenses must list one to three of ${LENS_NAMES.join(", ")}.`);
  }

  const seen = new Set<string>();
  for (const lens of p.lenses) {
    if (!isLensName(lens.name)) {
      fail(`${where}: lens "${lens.name}" is not one of ${LENS_NAMES.join(", ")}.`);
    }
    if (seen.has(lens.name)) fail(`${where}: lens "${lens.name}" is listed twice.`);
    seen.add(lens.name);
    if (!lens.model?.trim()) fail(`${where}: lens "${lens.name}" has no model.`);
    if (!lens.skipped && (!lens.report || !existsSync(lens.report))) {
      fail(
        `${where}: lens "${lens.name}" has no report at ${lens.report ?? "(unset)"}.\n` +
          `  Run the lens and save its report, or mark it { "skipped": "<why it does not apply>" }.`,
      );
    }
    if (!lens.skipped) checkReport(lens, p.authorModel, head, where);
  }

  if (p.lenses.every((l) => l.skipped)) {
    fail(`${where}: every lens is skipped; a round with no lens is not a review.`);
  }

  if (p.independence && (!p.independence.approvedBy?.trim() || !p.independence.reason?.trim())) {
    fail(`${where}: independence needs both approvedBy and reason.`);
  }

  const independence = independenceOf(p.lenses, p.authorModel, p.independence);
  if (!independence.allowed) {
    fail(
      `${where}: ${independence.reason}.\n` +
        `  Dispatch the lens on another model family. Only when none is left may the owner` +
        ` approve an exception in "independence": { "approvedBy": "...", "reason": "..." }.`,
    );
  }

  if (!p.summary?.what?.trim()) fail(`${where}: summary.what is required (one line: what the change does).`);
  if (p.summary.verdict === undefined) {
    fail(`${where}: summary.verdict is required; write "" when nothing blocks the merge.`);
  }
  if (!["Critical", "High", "Medium", "Low"].includes(p.summary.impact)) {
    fail(`${where}: summary.impact must be Critical, High, Medium or Low.`);
  }
  if (!Array.isArray(p.findings)) fail(`${where}: findings must be an array; [] is a valid clean run.`);

  const touched = new Set(diff.map((h) => h.path));
  // A skipped lens did not read the diff, so it cannot be named as a reviewer.
  const ran = new Set(p.lenses.filter((l) => !l.skipped).map((l) => l.name));
  for (const [i, f] of p.findings.entries()) {
    const at = `${where}: findings[${i}]`;
    if (!isLensName(f.lens)) {
      fail(`${at}.lens must be one of ${LENS_NAMES.join(", ")}.`);
    }
    if (!ran.has(f.lens)) {
      fail(
        `${at}.lens "${f.lens}" did not run; this round ran ${[...ran].join(", ")}.\n` +
          `  Attribute the finding to a lens that actually read the diff.`,
      );
    }
    if (!["P0", "P1", "P2"].includes(f.severity)) fail(`${at}.severity must be P0, P1 or P2.`);
    if (f.id !== undefined && !f.id.trim()) fail(`${at}.id must not be blank.`);
    if (!f.title?.trim()) fail(`${at}.title is required.`);
    if (!f.path) fail(`${at}.path is required.`);
    if (!existsSync(f.path) && !touched.has(f.path)) {
      fail(`${at}.path is neither in this checkout nor in the diff: ${f.path}`);
    }
    if (!Number.isInteger(f.line) || f.line < 1) fail(`${at}.line must be a positive line number.`);
    if (f.endLine !== undefined && (!Number.isInteger(f.endLine) || f.endLine < f.line)) {
      fail(`${at}.endLine must be an integer at or after line.`);
    }
    if (!f.body?.trim()) fail(`${at}.body is required; say why it is wrong, not that it is wrong.`);
    if (f.severity !== "P2" && !f.evidence?.trim()) {
      fail(
        `${at}.evidence is required for ${f.severity}.\n` +
          `  Name the file:line that proves it, or write "self-evident: <why the hunk is enough>".`,
      );
    }
  }

  if (p.scoreOverride) {
    if (!Number.isInteger(p.scoreOverride.score) || p.scoreOverride.score < 1 || p.scoreOverride.score > 5) {
      fail(`${where}: scoreOverride.score must be an integer 1-5.`);
    }
    if (!p.scoreOverride.reason?.trim()) {
      fail(`${where}: scoreOverride needs a reason; an override with no reason is an unlogged decision.`);
    }
  }

  if (!p.summary.verdict?.trim() && p.findings.some((f) => f.severity !== "P2")) {
    fail(`${where}: summary.verdict is required while a P0 or P1 is open; say what blocks the merge.`);
  }
}

/**
 * A report is evidence for one head and one pair of models. Without this check a
 * payload can point at last week's report and still produce a fresh artifact.
 */
function checkReport(lens: Lens, authorModel: string, head: string, where: string) {
  const report = lens.report ?? "";
  if (basename(report) !== `${head}-${lens.name}.md`) {
    fail(
      `${where}: lens "${lens.name}" points at ${report}, which is not named for ${head} and ${lens.name}.\n` +
        `  A report is evidence for one head only; rerun the lens and save it as <head>-${lens.name}.md.`,
    );
  }

  const opening = readFileSync(report, "utf8").split(/\r?\n/);
  const reviewer = opening[0]?.match(/^Reviewer model:\s*(\S+)\s*$/)?.[1];
  const author = opening[1]?.match(/^Author model:\s*(\S+)\s*$/)?.[1];
  if (!reviewer || !author) {
    fail(
      `${where}: ${report} does not open with the two model lines.\n` +
        `  "Reviewer model: <id>" then "Author model: <id>", nothing between them.`,
    );
  }
  if (!sameModel(reviewer, lens.model)) {
    fail(`${where}: lens "${lens.name}" says it ran ${lens.model}, but its report says ${reviewer}.`);
  }
  if (!sameModel(author, authorModel)) {
    fail(
      `${where}: lens "${lens.name}" reviewed ${author}, but the payload claims the author is ${authorModel}.`,
    );
  }
}

/** The commit trailer carries the harness (`pi/opencode-go/...`); the model is what follows. */
function sameModel(a: string, b: string) {
  const norm = (m: string) => m.trim().toLowerCase().replace(/^pi\//, "");
  return norm(a) === norm(b);
}

/** Agreement promotes inside `dedupe`, so the raw checks are applied again to the merged list. */
export function validateMerged(p: Payload, merged: Merged[], where: string) {
  for (const [i, f] of merged.entries()) {
    if (f.severity !== "P2" && !f.evidence?.trim()) {
      fail(
        `${where}: merged finding ${i + 1} is ${f.severity} at ${f.path}:${f.line} with no evidence.\n` +
          `  Agreement promoted it past the raw check; name the file:line that proves it.`,
      );
    }
  }

  if (p.summary.verdict?.trim()) return;
  const blocking = merged.find((f) => f.severity !== "P2");
  if (blocking) {
    fail(
      `${where}: summary.verdict is required while a ${blocking.severity} is open.\n` +
        `  ${blocking.path}:${blocking.line} was promoted by lens agreement; say what blocks the merge.`,
    );
  }
}

export function scoreOverride(p: Payload, rule: number): number {
  if (!p.scoreOverride) return rule;
  if (p.scoreOverride.score > rule) {
    fail(
      `scoreOverride ${p.scoreOverride.score}/5 raises the rule's ${rule}/5.\n` +
        `  The rule is a ceiling: fix the findings, do not grade around them.`,
    );
  }
  return p.scoreOverride.score;
}

/** The band Greptile's own scores describe: P0 <= 2, one P1 = 4, two P1 = 3, P2-only = 5. */
export function computeScore(findings: Finding[]): number {
  const p0 = countBy(findings, "P0");
  const p1 = countBy(findings, "P1");
  if (p0 >= 2) return 1;
  if (p0 === 1) return 2;
  if (p1 >= 2) return 3;
  if (p1 === 1) return 4;
  return 5;
}

// ---------------------------------------------------------------------------
// Diff anchoring
// ---------------------------------------------------------------------------

export type Hunk = { path: string; ranges: Array<[number, number]> };

type Diff = { hunks: Hunk[]; raw: string };

const quotedPath = /^"(?:[^"\\]|\\(?:[0-7]{1,3}|[abfnrtv"\\]))*"$/;

/** Decode Git's C-quoted path tokens, including octal UTF-8 bytes. */
function decodePath(raw: string): string {
  if (!raw.startsWith('"')) {
    if (raw.includes('"') || [...raw].some((char) => char.charCodeAt(0) < 32)) {
      fail(`unreadable diff path: ${raw}`);
    }
    return raw;
  }
  if (!quotedPath.test(raw)) {
    fail(`unreadable quoted diff path: ${raw}`);
  }
  const escapes = new Map([
    ["a", "\x07"], ["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"],
    ["t", "\t"], ["v", "\v"], ['"', '"'], ["\\", "\\"],
  ]);
  const chunks: Buffer[] = [];
  for (const match of raw.slice(1, -1).matchAll(/\\([0-7]{1,3}|[abfnrtv"\\])|([^\\]+)/g)) {
    const escape = match[1];
    if (escape && /^[0-7]/.test(escape)) {
      chunks.push(Buffer.from([Number.parseInt(escape, 8)]));
    } else if (escape) {
      chunks.push(Buffer.from(escapes.get(escape) ?? fail(`unknown diff path escape: ${escape}`)));
    } else {
      chunks.push(Buffer.from(match[2] ?? ""));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    fail(`not a UTF-8 filename: ${raw}`);
  }
}

/** Spaces are legal in both names. Equal names disambiguate mode-only and binary headers. */
function headerPaths(raw: string): { from: string; to: string } | null {
  const candidates: Array<{ from: string; to: string }> = [];
  const completeToken = (path: string) => path.startsWith('"') ? quotedPath.test(path) : !path.includes('"');
  for (let i = raw.indexOf(" "); i >= 0; i = raw.indexOf(" ", i + 1)) {
    const left = raw.slice(0, i);
    const right = raw.slice(i + 1);
    // A split inside a quoted name is not a candidate boundary.
    if (!completeToken(left) || !completeToken(right)) continue;
    const from = decodePath(left);
    const to = decodePath(right);
    if (from.startsWith("a/") && to.startsWith("b/")) {
      candidates.push({ from: from.slice(2), to: to.slice(2) });
    }
  }
  const equal = candidates.filter((pair) => pair.from === pair.to);
  return equal.length === 1 ? equal[0] ?? null : candidates.length === 1 ? candidates[0] ?? null : null;
}

/**
 * Hunk ranges for the added lines, keyed by path.
 *
 * A deletion-only, rename-only, mode-only or binary file still yields an entry
 * with no ranges: `validate` then knows the path was reviewed, and `isAnchored`
 * sends any finding on it outside the diff instead of rejecting the payload.
 *
 * The `diff --git` header is the only place a mode-only or binary file names
 * itself, so it is held until the file's `---`/`+++` pair proves whether a
 * better path is available. Registering it eagerly would turn a path that
 * contains " b/" into a phantom entry.
 */
export function parseDiff(raw: string): Hunk[] {
  const files = new Map<string, Hunk>();
  const at = (path: string) => {
    let hunk = files.get(path);
    if (!hunk) {
      hunk = { path, ranges: [] };
      files.set(path, hunk);
    }
    return hunk;
  };
  // Git appends a TAB to a `---`/`+++` path that contains a space.
  const clean = (line: string, prefix: string) => decodePath(line.slice(prefix.length).replace(/\t$/, ""));

  let current: Hunk | null = null;
  let removed: string | null = null;
  let header: { from: string; to: string } | null = null;
  let headerRaw: string | null = null;
  let paired = false;
  let inHunk = false;

  // End the file: a header that never met a `---`/`+++` pair is a mode-only or
  // binary change, and both of its names were reviewed. Also drop `current`, so
  // a header the parser cannot read (a quoted path) cannot leak its hunks into
  // the previous file.
  const flush = () => {
    if (headerRaw && !paired) {
      if (!header) fail(`unreadable or ambiguous diff header: ${headerRaw}`);
      at(header.from);
      at(header.to);
    }
    header = null;
    headerRaw = null;
    paired = false;
    inHunk = false;
    current = null;
    removed = null;
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      headerRaw = line.slice("diff --git ".length);
      header = headerPaths(headerRaw);
    } else if (line.startsWith("@@")) {
      inHunk = true;
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (!m || !current) continue;
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      if (len > 0) current.ranges.push([start, start + len - 1]);
    } else if (inHunk) {
      // Added/deleted content can start with +++/---. Only diff headers end a file.
      continue;
    } else if (line.startsWith("--- ") && line !== "--- /dev/null") {
      const path = clean(line, "--- ");
      if (!path.startsWith("a/")) fail(`unreadable removed path: ${line}`);
      removed = path.slice(2);
    } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
      const path = clean(line, "+++ ");
      if (!path.startsWith("b/")) fail(`unreadable added path: ${line}`);
      paired = true;
      current = at(path.slice(2));
      removed = null;
    } else if (line.startsWith("+++ /dev/null")) {
      paired = true;
      if (removed) at(removed);
      current = null;
      removed = null;
    } else if (line.startsWith("rename from ")) {
      paired = true;
      at(clean(line, "rename from "));
    } else if (line.startsWith("rename to ")) {
      paired = true;
      at(clean(line, "rename to "));
    }
  }

  flush();
  return [...files.values()];
}

function readDiff(baseRef: string, headRef: string): Diff {
  // Request C-quoted non-ASCII bytes so invalid UTF-8 cannot silently become
  // replacement characters. Prefix spelling must also ignore user configuration.
  const stable = ["-c", "core.quotePath=true", "-c", "diff.noprefix=false"];
  let raw = "";
  try {
    raw = git(...stable, "diff", "--unified=0", "--no-color", `${baseRef}...${headRef}`);
  } catch (error) {
    fail(
      `could not read the diff ${baseRef}...${headRef}.\n` +
        `  A review with no boundary is not a review; pass --base <ref> or fetch it first.\n` +
        `  ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }

  return { hunks: parseDiff(raw), raw };
}

export function isAnchored(diff: Hunk[], f: Finding): boolean {
  const file = diff.find((h) => h.path === f.path);
  if (!file) return false;
  const end = f.endLine ?? f.line;
  // GitHub rejects a multi-line comment whose range leaves the hunk, so the
  // whole range has to sit inside one changed range for the finding to go inline.
  return file.ranges.some(([a, b]) => f.line >= a && end <= b);
}

// ---------------------------------------------------------------------------
// Merge: dedupe across lenses, and let agreement promote a nit
// ---------------------------------------------------------------------------

export type Merged = Finding & { anchored: boolean; lenses: string[] };

export function dedupe(findings: Array<Finding & { anchored: boolean }>): Merged[] {
  const sorted = [...findings].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const out: Merged[] = [];

  for (const f of sorted) {
    // Nearby lines are not proof of agreement. The extractor assigns a shared
    // ID only after verifying that the lenses describe the same defect.
    const near = out.find(
      (o) => Boolean(f.id) && o.id === f.id && o.path === f.path &&
        !o.lenses.includes(f.lens) && Math.abs(o.line - f.line) <= 1,
    );
    if (!near) {
      out.push({ ...f, lenses: [f.lens] });
      continue;
    }
    near.lenses.push(f.lens);
    if (f.body.length > near.body.length) {
      near.body = f.body;
      near.title = f.title;
      near.fix = f.fix ?? near.fix;
      if (
        f.suggestion && f.line === near.line &&
        (f.endLine ?? f.line) === (near.endLine ?? near.line)
      ) {
        near.suggestion = f.suggestion;
      }
    }
    near.evidence = f.evidence || near.evidence;
    near.severity = worse(near.severity, f.severity);
    // `anchored` describes the retained `line`-`endLine`, which this merge never
    // changes, so it must not be borrowed from the finding that was folded in.
  }

  // Agreement is the one signal a single reviewer cannot produce. It promotes a
  // P2 to P1 and stops there: P0 is reserved for evidence of real damage.
  for (const f of out) {
    if (f.lenses.length >= 2 && f.severity === "P2") f.severity = "P1";
  }
  return out;
}

export function worse(a: Severity, b: Severity): Severity {
  if (a === "P0" || b === "P0") return "P0";
  if (a === "P1" || b === "P1") return "P1";
  return "P2";
}

/** Worst first, the way Greptile lists them; path and line break the tie. */
function bySeverity(a: Merged, b: Merged): number {
  const rank = { P0: 0, P1: 1, P2: 2 } satisfies Record<Severity, number>;
  return rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.line - b.line;
}

function isLensName(name: string): name is (typeof LENS_NAMES)[number] {
  return LENS_NAMES.some((known) => known === name);
}

// ---------------------------------------------------------------------------
// Render: the artifact the rest of the workflow already reads
// ---------------------------------------------------------------------------

export function renderBody(opts: {
  payload: Payload;
  head: string;
  base: string;
  score: number;
  findings: Merged[];
}) {
  const { payload, head, base, score, findings } = opts;
  const repo = repoUrl();
  const s = payload.summary;
  const outside = findings.filter((f) => !f.anchored);
  const L: string[] = [];

  L.push("<!-- greptile_summary -->", "");
  L.push(`<h2>Confidence Score: ${score}/5</h2>`, "");
  L.push(`**[${s.impact} impact]** ${s.what}`, "");
  L.push(s.verdict || "No blocking defect was found.", "");

  if (payload.scoreOverride) {
    L.push(`<sub>Score override ${score}/5: ${html(payload.scoreOverride.reason)}</sub>`, "");
  }

  if (payload.independence) {
    L.push(
      `<sub>Independence exception approved by ${html(payload.independence.approvedBy)}: ` +
        `${html(payload.independence.reason)}.</sub>`,
      "",
    );
  }

  if (findings.length) {
    L.push("<h2>Findings</h2>", "");
    findings.forEach((f, i) => {
      const link = ` <a href="${html(findingUrl(repo, head, f))}">▶</a>`;
      const agree = f.lenses.length > 1 ? ` <sub>(${f.lenses.join(" + ")})</sub>` : "";
      L.push(`${i + 1}. ${badge(f.severity)}&nbsp;**${inlineSafe(f.title)}**${agree}${link}`);
    });
    L.push("");

    L.push("<details><summary>Fix with agent prompt</summary>", "");
    L.push("`````markdown");
    findings.forEach((f, i) => {
      L.push(`### Issue ${i + 1}`);
      L.push(`${f.path}:${lineRange(f)}`);
      L.push(uncode(f.body));
      if (f.fix) L.push("", uncode(f.fix));
      if (f.suggestion) L.push("", uncode(f.suggestion));
      if (f.evidence && !/^self-evident/i.test(f.evidence)) L.push("", `Evidence: ${uncode(f.evidence)}`);
      L.push("");
    });
    L.push("---", "");
    L.push("For each issue above, determine whether it is valid and should be fixed. If so, fix it directly.");
    L.push("`````", "", "</details>", "");
  }

  L.push("<h3>Summary</h3>", "");
  L.push(s.summary ?? s.what, "");
  if (s.bullets?.length) {
    for (const b of s.bullets) L.push(`- ${b}`);
    L.push("");
  }
  if (s.checks) L.push(`Checks: ${s.checks}`, "");

  if (s.dismissed?.length) {
    L.push("Acknowledged and not reported:", "");
    for (const d of s.dismissed) L.push(`- **${inlineSafe(d.title)}** — ${d.reason}`);
    L.push("");
  }

  if (s.diagram) {
    L.push("<details open><summary><h3>Diagram</h3></summary>", "");
    L.push("```mermaid", s.diagram, "```");
    L.push("</details>", "");
  }

  if (outside.length) {
    L.push("<!-- greptile_outside_diff -->", "");
    L.push("<h3>Comments Outside Diff</h3>", "");
    L.push("These findings could not be posted inline.", "");
    for (const f of outside) {
      L.push(
        `- ${badge(f.severity)}&nbsp;**${inlineSafe(f.title)}** \`${f.path}:${f.line}\` ` +
          `<a href="${blobUrl(repo, head, f)}">▶</a>`,
        "",
      );
      L.push(`  ${oneLine(f.body)}`, "");
    }
  }

  L.push(`<!-- greptile_confidence_score:${score} -->`, "");
  if (payload.independence) L.push("<!-- reviewloop_independence_exception -->", "");

  const subject = commitSubject(head);
  const lenses = payload.lenses
    .map((l) => (l.skipped ? `${l.name} (skipped)` : `${l.name} (${l.model})`))
    .join(", ");
  L.push(
    `<sub>Reviews (1) · Last reviewed commit: ["${html(subject)}"](${repo}/commit/${head}) · ` +
      `reviewloop on ${html(payload.authorModel)} · base \`${html(base)}\` · ${html(lenses)}</sub>`,
  );

  return L.join("\n") + "\n";
}

function inlinePayload(f: Merged) {
  const comment = [f.body, f.fix, f.suggestion].filter((part) => part !== undefined).map(uncode).join("\n\n");
  const body = [
    `<a href="#">${badge(f.severity)}</a> **${inlineSafe(f.title)}**`,
    "",
    comment,
    "",
    "<details><summary>Prompt To Fix With AI</summary>",
    "",
    "`````markdown",
    "This is a comment left during a code review.",
    `Path: ${f.path}`,
    `Line: ${lineRange(f)}`,
    "",
    "Comment:",
    comment,
    "",
    "---",
    "",
    "For each issue above, determine whether it is valid and should be fixed. If so, fix it directly.",
    "`````",
    "",
    "</details>",
  ].join("\n");

  const commentPayload = {
    path: f.path,
    line: f.endLine ?? f.line,
    side: "RIGHT" as const,
    body,
  };
  return f.endLine && f.endLine !== f.line
    ? { ...commentPayload, start_line: f.line, start_side: "RIGHT" as const }
    : commentPayload;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function findingUrl(repo: string, head: string, f: Finding): string {
  if (f.permalink && URL.canParse(f.permalink)) {
    const url = new URL(f.permalink);
    if (url.protocol === "https:" || url.protocol === "http:") {
      url.username = "";
      url.password = "";
      return url.href;
    }
  }
  return blobUrl(repo, head, f);
}

function blobUrl(repo: string, head: string, f: Finding) {
  const range = f.endLine && f.endLine !== f.line ? `L${f.line}-L${f.endLine}` : `L${f.line}`;
  const path = f.path.split("/").map(encodeURIComponent).join("/");
  return `${repo}/blob/${head}/${path}#${range}`;
}

function lineRange(f: Finding) {
  return f.endLine && f.endLine !== f.line ? `${f.line}-${f.endLine}` : `${f.line}`;
}

function badge(severity: Severity) {
  return `<img alt="${severity}" src="${BADGE}/${severity.toLowerCase()}.svg?v=9" align="top">`;
}

function repoUrl(): string {
  try {
    const remote = git("remote", "get-url", "origin");
    const scp = remote.match(/^git@([^:]+):(.+)$/);
    const transport = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
    const url = transport.protocol === "ssh:"
      ? new URL(`https://${transport.hostname}${transport.pathname}`)
      : transport;
    if (url.protocol !== "https:" && url.protocol !== "http:") return "https://example.invalid/repo";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "").replace(/\.git$/, "");
  } catch {
    return "https://example.invalid/repo";
  }
}

function commitSubject(ref: string) {
  try {
    return git("log", "-1", "--format=%s", ref);
  } catch {
    return ref;
  }
}

function countBy(fs: Finding[], s: Severity) {
  return fs.filter((f) => f.severity === s).length;
}

/** GitHub renders a single newline inside a paragraph as a space, so keep bodies one paragraph. */
function oneLine(s: string) {
  return s.replace(/\r?\n+/g, " ").trim();
}

/** The fix block is delimited by five backticks; four inside it is safe, five is not. */
function uncode(s: string) {
  return s.replace(/`{5,}/g, "````").trim();
}

function html(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Keep a title from breaking the bold wrapper, and never let it inject HTML. */
function inlineSafe(s: string) {
  return html(s).replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

// Runs last: `main` reads classes and consts declared above, so calling it from
// the top of the module would hit the temporal dead zone.
if (import.meta.main) main();
