#!/usr/bin/env bun
// Run the Playwright specs this branch can reach, locally.
//
// `scripts/e2e-selection.ts` already answers "which specs does this diff
// reach"; until now only CI asked it, so a lane changing three files waited out
// all 35 specs before every push. This is the same decision with a local front
// end: it reuses `selectSpecs` and the checked-in map rather than growing a
// second set of globs, and it hands the mapped paths to `bun run test:e2e`.
//
// Three outcomes, the same three the selector has:
//   affected — spawn Playwright with the mapped paths as positional filters.
//   full     — spawn Playwright with no filters, after saying why.
//   skip     — spawn nothing and exit 0, because nothing in the diff can reach
//              a browser.
//
// Fail closed everywhere: an unreadable diff, an unexpected mode, or an
// `affected` scope with no specs all end in the full suite. The expensive
// answer is allowed to be wrong; the silent one is not.
//
// Four output lines, and the fourth is the one a pasted decision needs:
//   mode= / specs= / reason=   the selector's contract, byte-identical to CI's
//   source=git|files|dirty     where the decision came from
// `--files` prints a contract byte-shaped exactly like a git decision, and can
// override an always_full verdict, so a decision that does not say which it is
// proves nothing about the branch. `dirty` means the diff is `merge-base..HEAD`
// while tracked files have uncommitted edits turbo's affected set *would* see.
//
// The diff is `<merge-base>..HEAD`, and CI is not reading that: the `changes`
// job diffs `base.sha..head.sha` (on a stacked PR, the parent branch) and
// overrides the decision for `push`, `workflow_dispatch` and the `e2e:full`
// label. The map is shared; the range and the overrides are not.
//
// Run it as `bun run test:e2e:changed`. `bun scripts/e2e-changed.ts` works too,
// but the npm-script spelling is the one the bash heavy-work guard recognises,
// and the queue is not something this script can join for itself.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { contractLines, selectSpecs, specPaths, type Scope } from "./e2e-selection";
import { parseFlags, usageFailure, type FlagSpec } from "./lib/args";

export const DEFAULT_BASE = "origin/develop";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE =
  "usage: bun run test:e2e:changed [--base <ref>] [--files <path>[,<path>...]] [--dry-run|--help]";

const FLAGS: FlagSpec[] = [
  { name: "--base", kind: "value" },
  { name: "--files", kind: "value" },
  { name: "--dry-run", kind: "switch" },
];

export type ParsedArgs =
  | { ok: true; base: string; files: string[] | null; dryRun: boolean }
  | { ok: false; error: string };

// Git Bash and Explorer hand out `apps\web\src\...`. The map is written with
// forward slashes, so a backslash path matches no row, falls through to
// `unmapped path`, and silently runs the full suite.
const normalisePath = (path: string) => path.trim().replace(/\\/gu, "/");

export function parseArgs(argv: string[]): ParsedArgs {
  // The flag grammar is `scripts/lib/args.ts`, shared with test-affected.ts. The
  // two used to be hand-rolled, and `--base=origin/develop` worked on this tier
  // and exited 2 on the other.
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return { ok: false, error: parsed.message };

  const base = parsed.values.get("--base")?.[0] ?? DEFAULT_BASE;
  const list = parsed.values.get("--files")?.[0];

  // `--files` decides from the list it is given and never reads git, so a `--base`
  // beside it was parsed and thrown away: `--dry-run --base origin/nope --files
  // apps/web/src/pages/items.tsx` exited 0, printed `source=files`, and never said
  // the base was discarded. A caller who typed both meant one of them, and
  // guessing which is how a decision ends up describing a base nobody used.
  if (list !== undefined && parsed.values.has("--base")) {
    return { ok: false, error: "--files and --base cannot be combined: --files decides from the paths you give it, so --base would be ignored" };
  }

  if (list === undefined) {
    return { ok: true, base, files: null, dryRun: parsed.switches.has("--dry-run") };
  }
  const files = list
    .split(",")
    .map(normalisePath)
    .filter((path) => path !== "");
  if (files.length === 0) return { ok: false, error: "--files needs at least one path" };
  return { ok: true, base, files, dryRun: parsed.switches.has("--dry-run") };
}

// A git call answers with a result instead of throwing: the reason a diff is
// unavailable is printed to the user, so it is a value, not an exception.
export type GitOutcome = { error?: { message: string }; status: number | null; stdout: string; stderr: string };
export type GitRunner = (args: string[], cwd: string) => GitOutcome;
export type DiffResult = { ok: true; files: string[] } | { ok: false; reason: string };

export const spawnGit: GitRunner = (args, cwd) =>
  spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function git(args: string[], cwd: string, run: GitRunner): GitResult {
  const outcome = run(args, cwd);
  if (outcome.error) return { ok: false, reason: outcome.error.message };
  if (outcome.status !== 0) {
    // git's own first line is the message a human needs; the wrapper's
    // "Command failed: git ..." prefix only buries it.
    const stderr = (outcome.stderr ?? "").trim();
    if (stderr === "") {
      return { ok: false, reason: `git ${args.join(" ")} exited ${outcome.status ?? "unknown"}` };
    }
    return { ok: false, reason: stderr.split("\n")[0] ?? stderr };
  }
  return { ok: true, stdout: outcome.stdout ?? "" };
}

type GitResult = { ok: true; stdout: string } | { ok: false; reason: string };

// `--no-renames` is not cosmetic: a detected rename reports only its
// destination, so a file moved *out* of a mapped path would list the destination
// and the selector would never see the path that stopped being covered. Listing
// the move as a delete plus an add can only over-run the gate (#231).
export function changedFilesFromGit(base: string, cwd: string, run: GitRunner = spawnGit): DiffResult {
  const mergeBase = git(["merge-base", base, "HEAD"], cwd, run);
  if (!mergeBase.ok) return mergeBase;
  const root = mergeBase.stdout.trim();
  if (root === "") return { ok: false, reason: `git merge-base ${base} HEAD produced no commit` };
  const diff = git(["diff", "--no-renames", "--name-only", root, "HEAD"], cwd, run);
  if (!diff.ok) return diff;
  return {
    ok: true,
    files: diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  };
}

// Tracked files only: untracked paths are not what turbo's `[ref]` selector
// disagrees with here, and an untracked file has no committed version to be
// stale against. `null` means git could not answer — unknown, never "clean".
export function dirtyTracked(cwd: string, run: GitRunner = spawnGit): string[] | null {
  const status = git(["status", "--porcelain", "--untracked-files=no"], cwd, run);
  if (!status.ok) return null;
  return status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    // Porcelain is `XY <path>`: two status characters and a space. Slicing
    // after a trim would eat the first character of the path.
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== "");
}

export type Decision = { scope: Scope; source: "git" | "files" | "dirty" };
export type DecisionSources = { diff?: DiffReader; dirty?: DirtyReader };
export type DiffReader = (base: string, cwd: string) => DiffResult;
export type DirtyReader = (cwd: string) => string[] | null;

function dirtyNote(dirty: string[]): string {
  const named = dirty.slice(0, 3).join(", ");
  const more = dirty.length > 3 ? `, +${dirty.length - 3} more` : "";
  return `${dirty.length} tracked file(s) have uncommitted edits this decision does not see (${named}${more}) — commit first, or pass --files`;
}

/** What a `git status` outcome means: a caveat, and whether the decision came from it. */
export type DirtyReading = { source: "git" | "dirty"; note: string | null };

/**
 * Reads a `git status` outcome into the caveat `decide` prints.
 *
 * `null` is "git could not answer", and it is NOT clean. The helper
 * (`dirtyTracked`) says so in its own comment, and this call site collapsed `null`
 * and `[]` into "no caveat": a lane whose status call failed got a narrowed or
 * skip answer with no warning that uncommitted edits were invisible to it.
 *
 * `source` is `dirty` only when there ARE uncommitted edits, because it reports
 * where the decision came from and the decision came from the committed tree in
 * both other cases.
 */
function classifyDirty(dirty: string[] | null): DirtyReading {
  if (dirty === null) {
    return {
      source: "git",
      note: "git could not read the working tree, so whether tracked files have uncommitted edits this decision does not see is unknown — the answer covers HEAD only",
    };
  }
  if (dirty.length === 0) return { source: "git", note: null };
  return { source: "dirty", note: dirtyNote(dirty) };
}

export function decide(
  input: { base: string; files: string[] | null },
  cwd: string,
  sources: DecisionSources = {},
): Decision {
  if (input.files) return { scope: selectSpecs(input.files), source: "files" };

  const readDiff: DiffReader = sources.diff ?? ((base, dir) => changedFilesFromGit(base, dir));
  const readDirty: DirtyReader = sources.dirty ?? ((dir) => dirtyTracked(dir));

  const diff = readDiff(input.base, cwd);
  const { source, note } = classifyDirty(readDirty(cwd));

  if (!diff.ok) {
    // `git`, never `dirty`: the decision came from git failing, and the dirty
    // check is a caveat on the answer. Reporting `dirty` here said the event came
    // from a check that had decided nothing.
    return {
      scope: {
        mode: "full",
        specs: [],
        reason: `cannot diff against ${input.base}: ${diff.reason} — running the full suite${note ? ` | ${note}` : ""}`,
      },
      source: "git",
    };
  }

  const scope = selectSpecs(diff.files);
  if (!note) return { scope, source: "git" };
  return { scope: { ...scope, reason: `${scope.reason} | ${note}` }, source };
}

// The pure spawn decision: no filters means the whole suite, so every path but
// `affected` — including a mode this build does not know — widens instead of
// narrowing. An `affected` scope that names no specs falls back to the same
// empty list on purpose: filters would be a claim it cannot back.
//
// `specPaths` IS that decision, called directly rather than through a one-line
// passthrough. A passthrough defeated the drift protection the prefix exists for:
// two functions that must agree, one of which nobody reads.

export function shouldSpawn(scope: Scope): boolean {
  return scope.mode !== "skip";
}

export type SpawnOutcome = { error?: { message: string }; status: number | null };
export type Spawn = (command: string, args: string[], options: { cwd: string; stdio: "inherit" }) => SpawnOutcome;

export const spawnProcess: Spawn = (command, args, options) => spawnSync(command, args, options);

export function main(argv: string[], cwd = process.cwd(), spawn: Spawn = spawnProcess): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const parsed = parseArgs(argv);
  if (!parsed.ok) return usageFailure(parsed.error, USAGE);

  const decision = decide({ base: parsed.base, files: parsed.files }, cwd);
  for (const line of contractLines(decision.scope)) console.log(line);
  console.log(`source=${decision.source}`);
  if (parsed.dryRun) return 0;

  if (!shouldSpawn(decision.scope)) {
    console.error(`e2e-changed: nothing to run — ${decision.scope.reason}`);
    return 0;
  }

  // Before the hand-over, on stderr: a full run is the expensive outcome, and
  // the reason is the only thing that says whether the map is stale. A dirty
  // tree is the same kind of warning — the answer is for the committed tree.
  console.error(`e2e-changed: mode=${decision.scope.mode} — ${decision.scope.reason}`);
  if (decision.source === "dirty") {
    console.error(`e2e-changed: WARNING tracked files have uncommitted edits; this decision covers HEAD only`);
  }
  const run = spawn(process.execPath, ["run", "test:e2e", ...specPaths(decision.scope)], {
    cwd,
    stdio: "inherit",
  });
  if (run.error) {
    console.error(`e2e-changed: could not start the suite: ${run.error.message}`);
    return 1;
  }
  // A signal leaves `status` null; that is not a pass.
  return run.status ?? 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), ROOT);
}
