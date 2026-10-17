/**
 * The verdict logic of the #252 ablation gate, split out so it can be tested.
 *
 * Two Greptile findings (PR #267, round 4) are closed here:
 *
 *   #252-1 "Gate passes without running tests" — a green baseline is now a
 *          precondition: the unmutated suites must pass before any mutation
 *          result is allowed to count.
 *   #252-2 "Test crashes count as proof" — a non-zero test exit with no named
 *          "(fail)" line is a *problem*, not a caught mutation. That shape is
 *          what a load error or a crashed suite produces.
 *
 * `gateProblem` returns `null` when the phase is satisfied and a reason string
 * otherwise, so the caller only maps a reason to a problem line.
 *
 * Tests: .scratch/reviews/252/mutation-proof-gate.test.ts
 */

export interface Outcome {
  readonly exit: number;
  readonly failures: readonly string[];
}

export type Phase = "baseline" | "mutation";

/** Named test failures only: a `bun test` line that marks a specific test. */
export function parseFailures(output: string): string[] {
  const named = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.includes("(fail)")) continue;
    named.add(line.trim());
  }
  return [...named];
}

export function gateProblem(outcome: Outcome, phase: Phase): string | null {
  const namedFailures = outcome.failures.length;
  if (phase === "baseline") {
    if (outcome.exit === 0 && namedFailures === 0) return null;
    return `baseline not green — exit=${outcome.exit}, named failures=${namedFailures}; mutation results prove nothing until the unmutated suites pass`;
  }
  if (outcome.exit === 0) return "did NOT redden — this mutation is not covered";
  if (namedFailures === 0) {
    return `failed with no named test failure — exit=${outcome.exit} and zero "(fail)" lines, so the suites could not load or crashed before any assertion ran; that is NOT a caught mutation`;
  }
  return null;
}

export function runSuites(cwd: string, tests: readonly string[]): Outcome {
  const proc = Bun.spawnSync(["bun", "test", ...tests], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  return { exit: proc.exitCode ?? -1, failures: parseFailures(out) };
}
