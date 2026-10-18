/**
 * Regression tests for the #252 ablation gate.
 *
 * Greptile round 4 (PR #267) named two holes in mutation-proof.ts:
 *
 *   #252-1 "Gate passes without running tests" — no green baseline was required.
 *   #252-2 "Test crashes count as proof" — any non-zero exit counted as a caught
 *          mutation, so a run that never loaded its dependencies passed the gate.
 *
 * Run: bun test .scratch/reviews/252/mutation-proof-gate.test.ts   (cwd = repo root)
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { gateProblem, parseFailures, runSuites } from "./mutation-proof-gate";

const CRASH_FIXTURE = fileURLToPath(new URL("./fixtures/crashes-on-load.test.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("mutation-proof gate (#252-1: the baseline must be green)", () => {
  test("a baseline that crashed is a problem", () => {
    expect(gateProblem({ exit: 1, failures: [] }, "baseline")).toBeString();
  });

  test("a baseline with a failing test is a problem", () => {
    expect(gateProblem({ exit: 1, failures: ["(fail) suite > test [1.00ms]"] }, "baseline")).toBeString();
  });

  test("a green baseline passes", () => {
    expect(gateProblem({ exit: 0, failures: [] }, "baseline")).toBeNull();
  });
});

describe("mutation-proof gate (#252-2: a crash is not a catch)", () => {
  test("a mutation exit with no named test failure is a problem, not a catch", () => {
    const problem = gateProblem({ exit: 1, failures: [] }, "mutation");
    expect(problem).toBeString();
    expect(problem).toContain("no named test failure");
  });

  test("a mutation caught by a named test failure passes", () => {
    expect(gateProblem({ exit: 1, failures: ["(fail) suite > test [1.00ms]"] }, "mutation")).toBeNull();
  });

  test("a mutation that leaves the suites green did not redden", () => {
    expect(gateProblem({ exit: 0, failures: [] }, "mutation")).toContain("did NOT redden");
  });
});

describe("mutation-proof gate: parsing", () => {
  test("only named (fail) lines count, and duplicates collapse", () => {
    const output = [
      "bun test v1.4.2",
      "error: Cannot find module 'x' from 'y'",
      " 1 fail",
      "      (fail) SupplierAdjustPanel (issue 176) > reddens [867.06ms]",
      "      (fail) SupplierAdjustPanel (issue 176) > reddens [867.06ms]",
    ].join("\n");
    expect(parseFailures(output)).toEqual(["(fail) SupplierAdjustPanel (issue 176) > reddens [867.06ms]"]);
  });

  test("a load error yields no named failures", () => {
    expect(parseFailures("# Unhandled error between tests\nerror: Cannot find module 'x'\n 1 fail")).toEqual([]);
  });
});

describe("mutation-proof gate: end to end through a real bun test process", () => {
  test("a suite that cannot load its dependency fails the gate (#252-2)", () => {
    const outcome = runSuites(REPO_ROOT, [CRASH_FIXTURE]);
    expect(outcome.exit).not.toBe(0);
    expect(outcome.failures).toEqual([]);
    const mutationProblem = gateProblem(outcome, "mutation");
    expect(mutationProblem).toBeString();
    expect(mutationProblem).toContain("no named test failure");
    expect(gateProblem(outcome, "baseline")).toBeString();
  });
});
