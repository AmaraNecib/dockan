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
//   affected — spawn Playwright with the mapped specs as positional filters.
//   full     — spawn Playwright with no filters, after saying why.
//   skip     — spawn nothing and exit 0, because nothing in the diff can reach
//              a browser.
//
// Fail closed everywhere: an unreadable diff, an unexpected mode, or an
// `affected` scope with no specs all end in the full suite. The expensive
// answer is allowed to be wrong; the silent one is not.
//
// The diff is `<merge-base>..HEAD`, the same one CI reads, so uncommitted work
// is invisible to it: commit first, or pass `--files` with the paths you are
// about to commit.
import { spawnSync } from "node:child_process";

import { contractLines, selectSpecs, type Scope } from "./e2e-selection";

export const DEFAULT_BASE = "origin/develop";

const USAGE =
  "usage: bun scripts/e2e-changed.ts [--base <ref>] [--files <path>[,<path>...]] [--dry-run]";

export type ParsedArgs =
  | { ok: true; base: string; files: string[] | null; dryRun: boolean }
  | { ok: false; error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let base = DEFAULT_BASE;
  let files: string[] | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const takeValue = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined) return null;
      i += 1;
      return next;
    };

    if (flag === "--dry-run") {
      if (inline !== null) return { ok: false, error: "--dry-run takes no value" };
      dryRun = true;
      continue;
    }
    if (flag === "--base") {
      const value = takeValue()?.trim();
      if (!value) return { ok: false, error: "--base needs a git ref" };
      base = value;
      continue;
    }
    if (flag === "--files") {
      const list = (takeValue() ?? "")
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path !== "");
      if (list.length === 0) return { ok: false, error: "--files needs at least one path" };
      files = list;
      continue;
    }
    return {
      ok: false,
      error: flag.startsWith("-") ? `unknown flag: ${flag}` : `unexpected argument: ${arg}`,
    };
  }

  return { ok: true, base, files, dryRun };
}

// A git call answers with a result instead of throwing: the reason a diff is
// unavailable is printed to the user, so it is a value, not an exception.
type GitResult = { ok: true; stdout: string } | { ok: false; reason: string };
export type DiffResult = { ok: true; files: string[] } | { ok: false; reason: string };

function git(args: string[], cwd: string): GitResult {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (run.error) return { ok: false, reason: run.error.message };
  if (run.status !== 0) {
    // git's own first line is the message a human needs; the wrapper's
    // "Command failed: git ..." prefix only buries it.
    const stderr = (run.stderr ?? "").trim();
    if (stderr === "") {
      return { ok: false, reason: `git ${args.join(" ")} exited ${run.status ?? "unknown"}` };
    }
    return { ok: false, reason: stderr.split("\n")[0] ?? stderr };
  }
  return { ok: true, stdout: run.stdout ?? "" };
}

// `--no-renames` is not cosmetic: a detected rename reports only its
// destination, so a file moved *out* of a mapped path would list the destination
// and the selector would never see the path that stopped being covered. Listing
// the move as a delete plus an add can only over-run the gate (#231).
export function changedFilesFromGit(base: string, cwd: string): DiffResult {
  const mergeBase = git(["merge-base", base, "HEAD"], cwd);
  if (!mergeBase.ok) return mergeBase;
  const root = mergeBase.stdout.trim();
  if (root === "") return { ok: false, reason: `git merge-base ${base} HEAD produced no commit` };
  const diff = git(["diff", "--no-renames", "--name-only", root, "HEAD"], cwd);
  if (!diff.ok) return diff;
  return {
    ok: true,
    files: diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  };
}

export function scopeFor(input: { base: string; files: string[] | null }, cwd: string): Scope {
  if (input.files) return selectSpecs(input.files);
  const diff = changedFilesFromGit(input.base, cwd);
  if (!diff.ok) {
    return {
      mode: "full",
      specs: [],
      reason: `cannot diff against ${input.base}: ${diff.reason} — running the full suite`,
    };
  }
  return selectSpecs(diff.files);
}

// The pure spawn decision. No filters means the whole suite, so every path but
// `affected` — including a mode this build does not know — widens instead of
// narrowing. An `affected` scope that names no specs falls back to the same
// empty list on purpose: filters would be a claim it cannot back.
export function playwrightArgs(scope: Scope): string[] {
  if (scope.mode !== "affected") return [];
  return scope.specs.map((spec) => `tests/e2e/${spec}`);
}

export function shouldSpawn(scope: Scope): boolean {
  return scope.mode !== "skip";
}

export function main(argv: string[], cwd = process.cwd()): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }

  const scope = scopeFor({ base: parsed.base, files: parsed.files }, cwd);
  for (const line of contractLines(scope)) console.log(line);
  if (parsed.dryRun) return 0;

  if (!shouldSpawn(scope)) {
    console.error(`e2e-changed: nothing to run — ${scope.reason}`);
    return 0;
  }

  // Before the hand-over, on stderr: a full run is the expensive outcome, and
  // the reason is the only thing that says whether the map is stale.
  console.error(`e2e-changed: mode=${scope.mode} — ${scope.reason}`);
  const run = spawnSync(process.execPath, ["run", "test:e2e", ...playwrightArgs(scope)], {
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
  process.exitCode = main(process.argv.slice(2));
}
