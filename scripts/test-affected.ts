#!/usr/bin/env bun
// Run only the packages this branch can move.
//
// `bun run test` runs every workspace's suite. On an iteration loop that is a
// minute of tests for packages the diff cannot reach, which is how a lane ends
// up pushing without running anything. This is the targeted tier: turbo's
// impacted filter, which selects the packages changed since `origin/develop`
// *and the packages that depend on them*.
//
// The filter spelling is load-bearing and was measured, not guessed. On turbo
// 2.10.11, with a commit that touched only `packages/contracts`:
//   --filter=[HEAD~1]      -> @dokan/contracts
//   --filter=...[HEAD~1]   -> @dokan/api, @dokan/contracts, @dokan/web
//   --filter=[HEAD~1]...   -> @dokan/contracts
// `...` before the selector means dependents, so only the middle spelling runs
// the suites a contracts edit actually moves.
//
// The filter is conditional on the diff, and that condition is the whole point.
// turbo.json declares `build`, `typecheck` and `test` for the workspace packages
// and nothing for the root `//` package, so a filter that selects only `//` runs
// zero tasks and exits **0** — measured on this branch's own diff:
//   Packages in scope: //
//   WARNING  No tasks were executed as part of this run.
//   0 successful, 0 total
// A root-only diff (package.json, turbo.json, bun.lock, tsconfig.base.json,
// scripts/, docs/) is exactly that shape, and every one of those files can break
// every package's tests. So the argv follows the diff: a diff entirely inside
// `apps/<name>/` or `packages/<name>/` keeps the impacted filter, and anything
// outside them drops it and says why.
//
// The invocation is an argv array handed to `spawnSync`, never a shell string:
// `--filter='...[origin/develop]'` survives `bun run` on this machine, but a
// quoted filter inside a `package.json` script is one shell's quoting rule away
// from silently filtering by the wrong thing. Neither is a missing ref — turbo
// exits non-zero when it cannot resolve one, which a lane would read as a red
// gate, so that case falls back to every package and says why.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_REF = "origin/develop";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The JS shim, run under bun, rather than `node_modules/.bin/turbo`: a `.cmd`
// shim cannot be spawned without a shell on Windows, and a shell is what this
// file exists to avoid.
const TURBO_BIN = join(ROOT, "node_modules", "turbo", "bin", "turbo");

const USAGE = "usage: bun scripts/test-affected.ts [--base <ref>] [--dry-run]";

// A workspace package is a directory with a name under `apps/` or `packages/`.
// The trailing slash matters: `apps`, `apps/`, `apps/web` and
// `packages/contracts` are not files inside a package, and a bare `apps` entry
// in a diff means the directory itself changed.
const WORKSPACE_PATH = /^(?:apps|packages)\/[^/]+\//;

// Each step's first element is the program (`turbo` or `bun`); the driver
// resolves it so a plan can be asserted without pinning a machine path.
export type Step = string[];
export type DiffScope = "filtered" | "full";
export type Plan = { steps: Step[]; scope: DiffScope; note: string };
export type TurboPlan = { args: string[]; scope: DiffScope; reason: string };

export function hasRef(ref: string, cwd: string): boolean {
  const probe = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    stdio: "ignore",
  });
  return probe.status === 0;
}

// Returns `null` — not `[]` — when git cannot answer. An empty list is a claim
// that nothing changed; a failure is not evidence of that.
export type DiffReader = (base: string, cwd: string) => string[] | null;

// `git diff <base>` compares the ref against the **working tree**, which is the
// same diff turbo's `[ref]` selector reads. That matters: turbo's affected set
// already includes uncommitted edits, so a reader that only saw `base..HEAD`
// would filter on a different set of packages than the one turbo then runs.
export function changedSince(base: string, cwd: string): string[] | null {
  const run = spawnSync("git", ["diff", "--no-renames", "--name-only", base], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (run.error || run.status !== 0) return null;
  return (run.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// The argv decision, as a pure function of the diff. It returns the reason with
// the args rather than exposing a second helper that recomputes it: the stderr
// line and the argv it explains are the same decision, and two functions is how
// they drift.
export function turboArgs(changedPaths: string[], base: string): TurboPlan {
  // Git Bash reports `apps\web\src\...`; a backslash is a separator here too.
  const paths = changedPaths
    .map((path) => path.trim().replace(/\\/gu, "/"))
    .filter((path) => path !== "");

  if (paths.length === 0) {
    return {
      args: [],
      scope: "full",
      reason: "empty diff — nothing to narrow on, so every package runs",
    };
  }

  const outside = paths.find((path) => !WORKSPACE_PATH.test(path));
  if (outside === undefined) {
    return {
      args: [`--filter=...[${base}]`],
      scope: "filtered",
      reason: `packages changed since ${base}, plus the packages that depend on them`,
    };
  }

  return {
    args: [],
    scope: "full",
    reason: `${outside} is outside every workspace package (apps/<name>/, packages/<name>/), and turbo's root \`//\` package declares no test task — an impacted filter would run nothing and exit 0, so every package runs`,
  };
}

export function planAffected(base: string, cwd: string, readChanged: DiffReader = changedSince): Plan {
  const turbo = ["turbo", "run", "test", "--concurrency=2"];
  const scripts = ["bun", "test", "./scripts/"];
  if (!hasRef(base, cwd)) {
    return {
      steps: [turbo, scripts],
      scope: "full",
      note: `${base} does not resolve in this checkout, so every package runs (an impacted filter needs the ref)`,
    };
  }
  const changed = readChanged(base, cwd);
  if (changed === null) {
    return {
      steps: [turbo, scripts],
      scope: "full",
      note: `cannot read the diff against ${base}, so every package runs (an impacted filter would select nothing and exit 0)`,
    };
  }
  const decision = turboArgs(changed, base);
  return { steps: [[...turbo, ...decision.args], scripts], scope: decision.scope, note: decision.reason };
}

function runStep(step: Step, cwd: string): number {
  const [program = "", ...args] = step;
  // Both steps run under this bun — the one this script is already executing —
  // rather than a `bun` looked up on PATH. A PATH lookup cannot prove the runner
  // exists; `process.execPath` is the runner, so it cannot fail for that reason.
  // `bun <shim> ...` for turbo, `bun test ...` for the scripts suite: no shell,
  // so no quoting to get wrong per platform.
  const argv = program === "turbo" ? [TURBO_BIN, ...args] : args;
  const child = spawnSync(process.execPath, argv, { cwd, stdio: "inherit" });
  if (child.error) {
    console.error(`test:affected: could not start ${program}: ${child.error.message}`);
    return 1;
  }
  return child.status ?? 1;
}

export function main(argv: string[], cwd: string = ROOT): number {
  let base = BASE_REF;
  let dryRun = false;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--base") {
      const value = argv[i + 1]?.trim();
      // A flag is not a base: `--base --dry-run` used to take the flag as the
      // ref, drop the dry run, and run every package.
      if (!value || value.startsWith("-")) {
        console.error(USAGE);
        return 2;
      }
      base = value;
      i += 1;
      continue;
    }
    console.error(arg?.startsWith("-") ? `unknown flag: ${arg}` : `unexpected argument: ${arg}`);
    console.error(USAGE);
    return 2;
  }

  const plan = planAffected(base, cwd);
  if (dryRun) {
    // The same shape the e2e selector prints: a decision, its reason, and the
    // argv each step would use. Pinned by the tests, so the decision can be
    // quoted in a lane report without running a suite.
    console.log(`scope=${plan.scope}`);
    console.log(`reason=${plan.note}`);
    for (const step of plan.steps) console.log(`step=${step.join(" ")}`);
    return 0;
  }
  // On stderr: a narrowed run must state its scope and the cause of a fallback,
  // and `bun run` shows both without polluting a step's stdout.
  console.error(`test:affected: ${plan.note}`);
  for (const step of plan.steps) {
    const status = runStep(step, cwd);
    if (status !== 0) return status;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
