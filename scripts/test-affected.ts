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

/**
 * Turbo's answer to "which packages would this argv select", never "run them".
 *
 * The injected runner is the seam the live test uses: the test does not spawn
 * turbo itself, it asks this function, so the argv under test and the argv that
 * runs are the same one. `--dry-run=json` costs about half a second and runs no
 * suite, which is what makes a behaviour assertion affordable at all — the string
 * pin in the tests cannot see turbo changing what `...` MEANS across a bump.
 */
export type TurboOutput = { status: number | null; stdout: string; stderr: string; error: string };
export type TurboRunner = (args: string[], cwd: string) => TurboOutput;

export type TurboSelection = { packages: string[]; refusal: string | null };

/** The part of turbo's dry-run JSON this file reads. */
type DryRunJson = { packages?: string[] };

/** The same argv a step would run, asking turbo to enumerate instead of execute. */
export function dryRunArgs(step: Step): string[] {
  // `step[0]` is the program name; the rest is what turbo receives.
  return [...step.slice(1), "--dry-run=json"];
}

function spawnTurbo(args: string[], cwd: string): TurboOutput {
  const child = spawnSync(process.execPath, [TURBO_BIN, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    error: child.error === undefined ? "" : child.error.message,
  };
}

/**
 * The packages turbo selects for one step's argv.
 *
 * A refusal is returned rather than an empty list, for the same reason
 * `changedSince` returns `null` instead of `[]`: an empty selection is a claim
 * that turbo would run nothing, and a failed dry run is not evidence of that. The
 * report names the argv so a reader can reproduce it by hand.
 */
export function enumeratePackages(
  step: Step,
  cwd: string,
  run: TurboRunner = spawnTurbo,
): TurboSelection {
  const args = dryRunArgs(step);
  // The step, not the argv: a reader reproduces this by running what the plan
  // prints, and `--dry-run=json` is the only thing this added.
  const shown = step.join(" ");
  const result = run(args, cwd);
  if (result.error.length > 0) {
    return { packages: [], refusal: `turbo did not start for \`${shown}\`: ${result.error}` };
  }
  if (result.status !== 0) {
    const said = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
    return {
      packages: [],
      refusal: `turbo's dry run exited ${result.status ?? "with no status"} for \`${shown}\`${said.length > 0 ? `: ${said}` : ""}`,
    };
  }
  // turbo prints its version banner before the JSON, so the object is located
  // rather than assumed to start at byte 0.
  const start = result.stdout.indexOf("{");
  let parsed: DryRunJson;
  try {
    // SAFETY: turbo's `--dry-run=json` prints this shape, and the check below
    // refuses a payload without a package list rather than reading it as "nothing
    // selected" — the difference between a gate that ran and one that did not.
    parsed = JSON.parse(start === -1 ? "" : result.stdout.slice(start)) as DryRunJson;
  } catch {
    const said = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
    return {
      packages: [],
      refusal: `turbo's dry run printed JSON that does not parse for \`${shown}\`${said.length > 0 ? `: ${said}` : ""}`,
    };
  }
  if (!Array.isArray(parsed.packages)) {
    return {
      packages: [],
      refusal: `turbo's dry run printed no packages list for \`${shown}\`${result.stderr.trim().length > 0 ? `: ${result.stderr.trim().slice(0, 300)}` : ""}`,
    };
  }
  return { packages: parsed.packages, refusal: null };
}

export type StepStatus = { step: Step; status: number };
export type StepsOutcome = { results: StepStatus[]; status: number };

/** How one step is run. Injected so the aggregation can be asserted without a suite. */
export type StepRunner = (step: Step, cwd: string) => Promise<number>;

/**
 * One step, started and awaited as a child process.
 *
 * Both steps run under this bun — the one this script is already executing —
 * rather than a `bun` looked up on PATH. A PATH lookup cannot prove the runner
 * exists; `process.execPath` is the runner, so it cannot fail for that reason.
 * `bun <shim> ...` for turbo, `bun test ...` for the scripts suite: no shell, so
 * no quoting to get wrong per platform.
 *
 * `Bun.spawn` rather than `spawnSync`: the two steps have nothing in common, so
 * they run at once and the tier costs the longer step instead of the sum.
 */
async function runStepAsync(step: Step, cwd: string): Promise<number> {
  const [program = "", ...args] = step;
  const argv = program === "turbo" ? [TURBO_BIN, ...args] : args;
  try {
    const child = Bun.spawn({ cmd: [process.execPath, ...argv], cwd, stdio: ["inherit", "inherit", "inherit"] });
    return await child.exited;
  } catch (error) {
    console.error(
      `test:affected: could not start ${program}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/**
 * Both steps, at once, with one exit code.
 *
 * A short-circuit is the failure mode this replaces: returning the first step's
 * status stopped the second from running, so a red package suite was masked by a
 * green scripts suite whenever the plan put the scripts suite last — and the
 * fail-fast branch itself had no test that could tell it from a pass. Every step
 * starts, every step is awaited, and the code is the first failure in plan order
 * so it does not depend on which child finished first.
 */
export async function runSteps(
  steps: Step[],
  cwd: string,
  run: StepRunner = runStepAsync,
): Promise<StepsOutcome> {
  const statuses = await Promise.all(
    steps.map(async (step) => {
      try {
        return await run(step, cwd);
      } catch (error) {
        // A runner that throws has not run the step, and a step that did not run
        // is not a pass. The injected runner is the only caller that can do this;
        // `runStepAsync` reports its own failure as a status.
        console.error(
          `test:affected: ${step.join(" ")} failed to run: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
      }
    }),
  );
  const results = steps.map((step, index) => ({ step, status: statuses[index] ?? 1 }));
  for (const result of results) {
    console.error(`test:affected: ${result.step.join(" ")} → exit ${result.status}`);
  }
  const status = results.find((result) => result.status !== 0)?.status ?? 0;
  return { results, status };
}

export async function main(argv: string[], cwd: string = ROOT): Promise<number> {
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
  const outcome = await runSteps(plan.steps, cwd);
  return outcome.status;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
