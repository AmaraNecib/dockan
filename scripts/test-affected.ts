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

const USAGE = "usage: bun scripts/test-affected.ts [--base <ref>]";

// Each step's first element is the program (`turbo` or `bun`); the driver
// resolves it so a plan can be asserted without pinning a machine path.
export type Step = string[];
export type Plan = { steps: Step[]; note: string };

export function hasRef(ref: string, cwd: string): boolean {
  const probe = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    stdio: "ignore",
  });
  return probe.status === 0;
}

export function planAffected(base: string, cwd: string): Plan {
  const turbo = ["turbo", "run", "test", "--concurrency=2"];
  const scripts = ["bun", "test", "./scripts/"];
  if (!hasRef(base, cwd)) {
    return {
      steps: [turbo, scripts],
      note: `${base} does not resolve in this checkout, so every package runs (an impacted filter needs the ref)`,
    };
  }
  return {
    steps: [[...turbo, `--filter=...[${base}]`], scripts],
    note: `packages changed since ${base}, plus the packages that depend on them`,
  };
}

function runStep(step: Step, cwd: string): number {
  const [program = "", ...args] = step;
  // Both steps run through bun: `bun <shim> ...` for turbo, `bun test ...` for
  // the scripts suite. No shell, so no quoting to get wrong per platform.
  const argv = program === "turbo" ? [TURBO_BIN, ...args] : args;
  const child = spawnSync("bun", argv, { cwd, stdio: "inherit" });
  if (child.error) {
    console.error(`test:affected: could not start ${program}: ${child.error.message}`);
    return 1;
  }
  return child.status ?? 1;
}

export function main(argv: string[], cwd: string = ROOT): number {
  let base = BASE_REF;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") {
      const value = argv[i + 1]?.trim();
      if (!value) {
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
