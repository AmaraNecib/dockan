import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  BASE_REF,
  dryRunArgs,
  enumeratePackages,
  hasRef,
  main,
  planAffected,
  runSteps,
  turboArgs,
  type Plan,
  type Step,
  type TurboSelection,
} from "./test-affected";

// `test:affected` narrows the unit suite to the packages a branch can move.
// The filter string is pinned exactly, because the three turbo spellings mean
// three different package sets and only one of them is the gate this repo
// wants. Measured on turbo 2.10.11 with a contracts-only commit:
//   --filter=[HEAD~1]      -> @dokan/contracts
//   --filter=...[HEAD~1]   -> @dokan/api, @dokan/contracts, @dokan/web
//   --filter=[HEAD~1]...   -> @dokan/contracts
// Only the middle one runs the dependents, which is what "affected" has to
// mean: a contracts edit is a web and api edit.
//
// The diff is an *input* here, never a read of this checkout: a test that asked
// git about the branch under review would pass or fail depending on what the
// lane happened to be editing. `planAffected` takes the reader for that reason.
const ROOT = join(import.meta.dir, "..");

/**
 * Every workspace package this repo declares, read from disk.
 *
 * Derived rather than listed: a hardcoded list stops noticing a package the
 * workspace gained, and the claim under test is "every package", not "these
 * five".
 */
function workspaceNames(): string[] {
  const names: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(ROOT, group, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      // SAFETY: a workspace manifest is a file this repo owns, and only its
      // `name` is read; a manifest without one is skipped rather than guessed at.
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (parsed.name !== undefined) names.push(parsed.name);
    }
  }
  return names.sort();
}

const inScope = () => ["apps/web/src/pages/backups.tsx", "packages/contracts/src/items.ts"];

describe("turboArgs", () => {
  // turbo.json declares `build`, `typecheck` and `test` for the workspace
  // packages and nothing for the root `//` package. So a filter that selects
  // only `//` runs zero tasks and exits 0 — measured on this branch's own diff:
  //   Packages in scope: //
  //   WARNING  No tasks were executed as part of this run.
  //   0 successful, 0 total
  // A `test:affected` that reports that as a pass tests no package at all.
  test("a diff entirely inside workspace packages keeps the impacted filter", () => {
    const plan = turboArgs(inScope(), "origin/develop");
    expect(plan.args).toEqual(["--filter=...[origin/develop]"]);
    expect(plan.scope).toBe("filtered");
    expect(plan.reason).toContain("origin/develop");
  });

  test("one root file widens to every package, because no workspace owns it", () => {
    // package.json, turbo.json, bun.lock, tsconfig.base.json and scripts/ can
    // break every package's tests, and none of them is a workspace package.
    for (const rootFile of [
      "package.json",
      "turbo.json",
      "bun.lock",
      "tsconfig.base.json",
      "scripts/test-affected.ts",
      "docs/ci.md",
      "oxlint.config.ts",
    ]) {
      const plan = turboArgs([...inScope(), rootFile], "origin/develop");
      expect({ rootFile, args: plan.args }).toEqual({ rootFile, args: [] });
      expect({ rootFile, scope: plan.scope }).toEqual({ rootFile, scope: "full" });
      expect(plan.reason).toContain(rootFile);
    }
  });

  test("a top-level directory is not a workspace even when it holds code", () => {
    // `args: []` alone does not say WHY it is empty: the empty diff, a bare
    // `apps`, and a path outside every package all produce it. The scope and the
    // reason are what tell this rule from the others.
    const plan = turboArgs(["tests/e2e/backups.spec.ts"], "origin/develop");
    expect({ args: plan.args, scope: plan.scope }).toEqual({ args: [], scope: "full" });
    expect(plan.reason).toContain("tests/e2e/backups.spec.ts");
    expect(plan.reason).toContain("every package");
  });

  test("an empty diff runs every package instead of reporting nothing to do", () => {
    // Nothing to narrow on is not evidence that nothing can break. The
    // expensive answer is allowed to be wrong; the empty one is not.
    const plan = turboArgs([], "origin/develop");
    expect(plan.args).toEqual([]);
    expect(plan.reason).toContain("empty");
  });

  test("a workspace prefix needs a package name and a path under it", () => {
    // `apps/` alone, a bare `apps`, and a nested workspace-looking path are all
    // not a workspace package: the pattern is `apps/<name>/` or `packages/<name>/`.
    for (const notAWorkspace of ["apps/", "apps", "apps/web", "packages/contracts"]) {
      expect({ notAWorkspace, args: turboArgs([notAWorkspace], "origin/develop").args }).toEqual({
        notAWorkspace,
        args: [],
      });
    }
  });

  test("Windows backslashes count as separators, so a lane on Git Bash still narrows", () => {
    expect(turboArgs(["apps\\web\\src\\pages\\backups.tsx"], "origin/develop").args).toEqual([
      "--filter=...[origin/develop]",
    ]);
  });
});

describe("test:affected plan", () => {
  // The plan consults turbo before it commits to a filter, so every test that
  // expects a FILTERED plan has to say what turbo would answer. A stub that
  // returns a real package set is the fixture; the default (the real turbo, on
  // the real base ref) would answer for this branch rather than for the injected
  // diff, and the plan would widen for a reason the test never injected — which
  // is exactly the incoherence this seam removes.
  const selects = (...packages: string[]) => (): TurboSelection => ({ packages, refusal: null });
  const SELECTS_WEB = selects("//", "@dokan/web");
  // The filter carries the merge-base COMMIT, not the ref name, so a fixed sha is
  // part of the fixture wherever a filtered plan is expected.
  const MERGE_BASE = "abc123def456";
  const AT_MERGE_BASE = () => MERGE_BASE;

  test("a workspace-only diff selects the changed packages and their dependents", () => {
    const plan = planAffected("origin/develop", ROOT, inScope, {
      select: SELECTS_WEB,
      mergeBase: AT_MERGE_BASE,
    });
    expect(plan.steps[0]).toEqual([
      "turbo",
      "run",
      "test",
      "--concurrency=2",
      `--filter=...[${MERGE_BASE}]`,
    ]);
    // The scripts suite holds the e2e map's drift guard; it is cheap and it is
    // the suite a narrowed run must not lose.
    expect(plan.steps[1]).toEqual(["bun", "test", "./scripts/"]);
    expect(plan.scope).toBe("filtered");
    expect(plan.note).toContain("origin/develop");
  });

  test("a root file drops the filter, so turbo cannot report zero tasks as a pass", () => {
    const plan = planAffected("origin/develop", ROOT, () => ["package.json"], {
      select: SELECTS_WEB,
    });
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.scope).toBe("full");
    expect(plan.note).toContain("package.json");
    expect(plan.note).toContain("every package");
  });

  test("a missing base falls back to every package and says why", () => {
    // A fresh clone without the remote-tracking ref, or a lane whose fetch
    // failed: a filter on a ref git cannot resolve makes turbo exit non-zero,
    // which would read as a failing gate. Run everything and name the cause.
    const plan = planAffected("origin/not-a-ref", ROOT, inScope, { select: SELECTS_WEB });
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.scope).toBe("full");
    expect(plan.note).toContain("origin/not-a-ref");
    expect(plan.note).toContain("every package");
  });

  test("a diff git cannot produce falls back to every package", () => {
    const plan = planAffected("origin/develop", ROOT, () => null, { select: SELECTS_WEB });
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.scope).toBe("full");
    expect(plan.note).toContain("cannot read the diff");
  });

  test("the fallback keeps the scripts suite", () => {
    expect(
      planAffected("origin/not-a-ref", ROOT, inScope, { select: SELECTS_WEB }).steps[1],
    ).toEqual(["bun", "test", "./scripts/"]);
  });

  // -------------------------------------------------------------------------
  // The empty-selection guard.
  //
  // turbo.json declares `test` for the workspace packages and nothing for the
  // root `//` package, so a filter that selects only `//` runs zero tasks and
  // EXITS 0 — measured on this branch's own diff, where the impact filter really
  // does answer ["//"]. A filtered plan that selects nothing is therefore the one
  // shape that reports a pass while testing nothing, and it is reachable on every
  // lane whose diff sits entirely inside `apps/` or `packages/` but touches no
  // package turbo considers changed.
  //
  // The `changedSince -> null` branch already fails closed. This is the same rule
  // for the branch that looks successful.
  // -------------------------------------------------------------------------
  const ROOT_ONLY = selects("//");

  test("a filter that selects only the root package widens instead of running nothing", () => {
    const plan = planAffected("origin/develop", ROOT, inScope, { select: ROOT_ONLY });
    expect(plan.scope).toBe("full");
    // The FILTER IS GONE from the argv, not merely labelled unfiltered: the
    // widened plan has to be the one that runs every package.
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.note).toContain("selects no package");
    expect(plan.note).toContain("`//`");
  });

  test("a filter that selects nothing at all widens too", () => {
    const plan = planAffected("origin/develop", ROOT, inScope, { select: selects() });
    expect(plan.scope).toBe("full");
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.note).toContain("selects no package");
  });

  test("a dry run turbo could not answer widens, and names the refusal", () => {
    // Not a green pass and not a silent narrowing: a refusal is "unproven", and
    // unproven runs everything.
    const plan = planAffected("origin/develop", ROOT, inScope, {
      select: () => ({ packages: [], refusal: "turbo's dry run exited 1" }),
    });
    expect(plan.scope).toBe("full");
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.note).toContain("turbo's dry run exited 1");
  });

  test("a filter that selects a real package stays narrowed", () => {
    const plan = planAffected("origin/develop", ROOT, inScope, {
      select: selects("@dokan/contracts", "@dokan/api"),
      mergeBase: AT_MERGE_BASE,
    });
    expect(plan.scope).toBe("filtered");
    expect(plan.steps[0]).toContain(`--filter=...[${MERGE_BASE}]`);
  });

  // -------------------------------------------------------------------------
  // The base is the fork point, not the other side's tip.
  //
  // `git diff origin/develop` compares the other branch's TIP against this
  // working tree, so a lane a few hours old picks up everything merged since,
  // widens to every package, and blames a file the lane never touched. Measured
  // on one such branch: the tip diff was 27 paths, the merge-base diff 12.
  // -------------------------------------------------------------------------
  test("the diff and the filter both use the merge-base commit", () => {
    const seen: string[] = [];
    const plan = planAffected("origin/develop", ROOT, (base) => {
      seen.push(base);
      return inScope();
    }, {
      select: SELECTS_WEB,
      mergeBase: () => "abc123def456",
    });
    expect(seen).toEqual(["abc123def456"]);
    expect(plan.steps[0]).toContain("--filter=...[abc123def456]");
    // The note still names the ref a human passed, because that is what they
    // typed and what they will re-run.
    expect(plan.note).toContain("origin/develop");
    expect(plan.note).toContain("abc123def456");
  });

  test("a merge base git cannot find widens and says so", () => {
    const plan = planAffected("origin/develop", ROOT, inScope, {
      select: SELECTS_WEB,
      mergeBase: () => null,
    });
    expect(plan.scope).toBe("full");
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.note).toContain("merge-base");
  });
});

describe("test:affected ref probe", () => {
  test("a real remote-tracking ref resolves; a made-up one does not", () => {
    expect(hasRef("origin/develop", ROOT)).toBe(true);
    expect(hasRef("origin/not-a-ref", ROOT)).toBe(false);
  });

  test("an unknown repository path resolves nothing instead of throwing", () => {
    expect(hasRef("origin/develop", join(ROOT, "no-such-directory"))).toBe(false);
  });
});

describe("the impacted filter, live against turbo", () => {
  // The string pin above is the decision as the author measured it. What it
  // cannot see is turbo changing what `...` MEANS across a version bump: the
  // string stays green while the selected package set changes. `--dry-run=json`
  // enumerates that set without running a suite (~0.6 s), so the behaviour is
  // asserted here instead of being trusted.
  //
  // The selector used for the dependents check is package-scoped rather than
  // `[origin/develop]`, and that is deliberate: this repo's branches usually
  // touch no workspace package, so `...[origin/develop]` selects only `//` and a
  // test demanding a dependent there would be green only on PRs that touch a
  // package — content-dependent, which is the flake this suite exists to avoid.
  // `...@dokan/contracts` asks turbo the same question with an answer that does
  // not depend on the branch.
  const ALL = workspaceNames();

  function selected(step: Step): string[] {
    const result = enumeratePackages(step, ROOT);
    if (result.refusal !== null) throw new Error(result.refusal);
    return result.packages;
  }

  test("the ref the filter names resolves here, or this test says which ref is missing", () => {
    // Not a skip: a shallow clone without the remote-tracking ref would otherwise
    // pass this suite while asserting nothing, and the fix is `git fetch origin`.
    // The assertion carries the ref in its payload rather than throwing, so the
    // failure names it AND the verdict stays an assertion red: a `throw` here
    // reports `Error`, which the gate reads as "the body never ran" — true of a
    // hollowed module, and exactly the shape this file must not produce.
    expect({ ref: BASE_REF, resolves: hasRef(BASE_REF, ROOT) }).toEqual({
      ref: BASE_REF,
      resolves: true,
    });
  });

  test("`...` before a selector selects the package and the packages that depend on it", () => {
    const packages = selected([
      "turbo",
      "run",
      "test",
      "--concurrency=2",
      "--filter=...@dokan/contracts",
    ]);
    expect(packages).toContain("@dokan/contracts");
    // A dependent the filter never named: this is what `...` buys.
    expect(packages).toContain("@dokan/api");
    // And it is a narrowing, not "everything": if a version bump made `...` a
    // no-op this would be the whole workspace and the assertion above would still
    // pass.
    expect(packages.length).toBeLessThan(ALL.length);
  });

  test("`...` after a selector selects its dependencies, so the two sides stay distinct", () => {
    // The other direction. turbo 2.10.11 measured: `...foo` is foo + dependents,
    // `foo...` is foo + dependencies. A bump that swapped them breaks exactly one
    // of these two tests, which is the point of asserting both.
    const packages = selected([
      "turbo",
      "run",
      "test",
      "--concurrency=2",
      "--filter=@dokan/contracts...",
    ]);
    expect(packages).toEqual(["@dokan/contracts"]);
  });

  test("the unfiltered argv from turboArgs selects every workspace package", () => {
    // A root file drops the filter, so the argv is turbo's own: every package,
    // and nothing silently left out of the run the fallback promises.
    const plan = planAffected(BASE_REF, ROOT, () => ["package.json"]);
    expect(plan.scope).toBe("full");
    expect(selected(plan.steps[0] ?? []).sort()).toEqual([...ALL].sort());
  });

  test("a filter over a selector the test controls selects real packages, not zero", () => {
    // This test used to ask turbo about the real `origin/develop` and then loop
    // over whatever came back — and on any branch that touches no workspace
    // package the answer is ["//"], so the loop body never ran and the test was
    // green while asserting nothing. Measured on this repo's own branches:
    //   --filter=...[HEAD]            -> []
    //   --filter=//                   -> ["//"]
    //   --filter=...[origin/develop]  -> ["//"]  (a docs/scripts lane)
    //
    // The selector is package-scoped now, so the base is one the test controls
    // and the answer does not depend on what the lane happened to edit — and the
    // assertion is that the selection is NON-EMPTY before it is a subset.
    const packages = selected([
      "turbo",
      "run",
      "test",
      "--concurrency=2",
      "--filter=...@dokan/contracts",
    ]);
    const real = packages.filter((name) => name !== "//");
    // A loop over an empty list is not a test: the count comes first.
    expect(real.length).toBeGreaterThan(0);
    for (const name of real) {
      expect({ name, known: ALL.includes(name) }).toEqual({ name, known: true });
    }
  });

  test("a plan never hands turbo a filter that selects nothing", () => {
    // The live invariant, on this branch, with the real merge-base and the real
    // turbo: whatever the answer is, a plan that CLAIMS to be narrowed must
    // actually select a package, because a filter that selects only `//` runs
    // zero tasks and exits 0. The old test looped over the answer and was green
    // when the answer was empty, which is the case it existed for.
    const plan = planAffected(BASE_REF, ROOT, () => ["apps/web/src/pages/sale.tsx"]);
    if (plan.scope === "filtered") {
      const live = selected(plan.steps[0] ?? []).filter((name) => name !== "//");
      expect(live.length).toBeGreaterThan(0);
      for (const name of live) expect(ALL).toContain(name);
      return;
    }
    // Widened: the filter is gone from the argv and the reason says which rule
    // fired. On a lane that touches no package this is the merge-base answer
    // ([`//`]), which is exactly the shape the guard exists for.
    expect(plan.steps[0]).not.toContain("--filter=...[origin/develop]");
    expect(plan.note).toMatch(/selects no package|could not confirm/u);
  });

  test("a dry run that prints no JSON is a refusal naming the argv, not an empty selection", () => {
    const result = enumeratePackages(["turbo", "run", "test"], ROOT, () => ({
      status: 0,
      stdout: "not json at all",
      stderr: "turbo exploded",
      error: "",
    }));
    expect(result.packages).toEqual([]);
    expect(result.refusal).toContain("turbo run test");
    expect(result.refusal).toContain("turbo exploded");
  });

  test("a dry run that cannot start is a refusal, not an empty selection", () => {
    const result = enumeratePackages(["turbo", "run", "test"], ROOT, () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: "spawn ENOTDIR",
    }));
    expect(result.packages).toEqual([]);
    expect(result.refusal).toContain("spawn ENOTDIR");
  });

  test("a dry run JSON without a packages array is refused, not read as nothing selected", () => {
    const result = enumeratePackages(["turbo", "run", "test"], ROOT, () => ({
      status: 0,
      stdout: '• turbo 2.10.11\n{ "id": "x", "tasks": [] }',
      stderr: "",
      error: "",
    }));
    expect(result.packages).toEqual([]);
    expect(result.refusal).toContain("packages");
  });
});

describe("tier 1 runs both steps at once, and either red reddens the exit", () => {
  // Verification tier 1 is `bun run test:affected` (see
  // docs/development-workflow.md §7); tier 0 is typecheck+lint and tier 2 is
  // test:e2e:changed. The names here used to say "tier 0", which taught the
  // opposite of the document a lane reads.
  //
  // The two steps cannot reach each other: turbo runs the workspace suites, the
  // scripts suite runs the gate's own tests. They were spawned one after the
  // other and fail-fast, which spent the shorter step's time twice and made the
  // fail-fast loop invisible — flipping `if (status !== 0) return status` left
  // every test green while a red package suite was masked by a green scripts run.
  const STEPS: Step[] = [
    ["turbo", "run", "test", "--concurrency=2"],
    ["bun", "test", "./scripts/"],
  ];

  test("both steps start, and two green steps exit 0", async () => {
    const started: string[] = [];
    const result = await runSteps(STEPS, ROOT, async (step) => {
      started.push(step[0] ?? "");
      return 0;
    });
    expect(started).toEqual(["turbo", "bun"]);
    expect(result.results.map((entry) => entry.status)).toEqual([0, 0]);
    expect(result.status).toBe(0);
  });

  test("a red first step reddens the combined exit", async () => {
    const result = await runSteps(STEPS, ROOT, async (step) => (step[0] === "turbo" ? 1 : 0));
    expect(result.results.map((entry) => entry.status)).toEqual([1, 0]);
    expect(result.status).toBe(1);
  });

  test("a red second step reddens the combined exit when the first was green", async () => {
    // The fail-fast shape returned the first step's status before the second ran,
    // so this case could not exist: a green first step ended the run at 0.
    const result = await runSteps(STEPS, ROOT, async (step) => (step[0] === "bun" ? 1 : 0));
    expect(result.results.map((entry) => entry.status)).toEqual([0, 1]);
    expect(result.status).toBe(1);
  });

  test("a failing first step does not stop the second from starting", async () => {
    // One pass with both verdicts is the point: a short-circuit is a regression.
    const started: string[] = [];
    const result = await runSteps(STEPS, ROOT, async (step) => {
      started.push(step[0] ?? "");
      return step[0] === "turbo" ? 2 : 0;
    });
    expect(started).toEqual(["turbo", "bun"]);
    expect(result.results.map((entry) => entry.status)).toEqual([2, 0]);
    expect(result.status).toBe(2);
  });

  test("the combined status is the first failure in plan order, not the last to finish", async () => {
    // Two children finish in whatever order they finish; the exit code has to be
    // the same on every run, so it is chosen from the plan, not from arrival.
    const result = await runSteps(STEPS, ROOT, async (step) => {
      if (step[0] === "turbo") {
        await Bun.sleep(20);
        return 2;
      }
      return 3;
    });
    expect(result.results.map((entry) => entry.status)).toEqual([2, 3]);
    expect(result.status).toBe(2);
  });

  test("a step that cannot start counts as a failure, and the other step still runs", async () => {
    const started: string[] = [];
    const result = await runSteps(STEPS, ROOT, async (step) => {
      started.push(step[0] ?? "");
      if (step[0] === "turbo") throw new Error("could not start turbo");
      return 0;
    });
    expect(started).toEqual(["turbo", "bun"]);
    expect(result.results.map((entry) => entry.status)).toEqual([1, 0]);
    expect(result.status).toBe(1);
  });
});

describe("dryRunArgs asks turbo about the argv the plan would run", () => {
  // The live tests below import this seam, and its comment claimed "the argv
  // under test and the argv that runs are the same one". Nothing asserted it, so
  // inverting the function left every live test spawning a real suite.
  const STEP: Step = ["turbo", "run", "test", "--concurrency=2", "--filter=...[abc123]"];

  test("it is the step's own argv plus the dry-run flag, and nothing else", () => {
    expect(dryRunArgs(STEP)).toEqual([
      "run",
      "test",
      "--concurrency=2",
      "--filter=...[abc123]",
      "--dry-run=json",
    ]);
  });

  // The "the program name is dropped" case is not a test of its own: the exact
  // `toEqual` above already pins that `turbo` is not in the output, and the
  // weaker `not.toContain("turbo")` assertion was refused by the red-on-parent
  // gate for good reason — against a hollow `dryRunArgs` it dereferences
  // `undefined` and cannot be evaluated, so it proved nothing there.
  test("the flag is last, so the plan's own argv survives verbatim", () => {
    // A test that asked turbo a different question than the run asks is the
    // drift this pin exists to prevent.
    const args = dryRunArgs(STEP);
    expect(args.slice(0, -1)).toEqual(STEP.slice(1));
    expect(args.at(-1)).toBe("--dry-run=json");
  });
});

describe("test:affected main", () => {
  // `main` had NO test: it could return 0 unconditionally and every other test in
  // this file stayed green, which is the shape of a gate nobody checks. The two
  // seams below are what make it testable without a suite: the plan (so no git and
  // no turbo is asked) and the step runner.
  const PLAN: Plan = {
    steps: [
      ["turbo", "run", "test", "--concurrency=2"],
      ["bun", "test", "./scripts/"],
    ],
    scope: "full",
    note: "injected plan for the main tests",
  };
  const planFor = (seen: string[]) => (base: string) => {
    seen.push(base);
    return PLAN;
  };

  test("the plan's exit code is main's exit code", async () => {
    expect(await main([], ROOT, { plan: () => PLAN, run: async () => 0 })).toBe(0);
    expect(await main([], ROOT, { plan: () => PLAN, run: async () => 7 })).toBe(7);
  });

  test("--base is parsed and handed to the plan, and the default is BASE_REF", async () => {
    const seen: string[] = [];
    await main(["--base", "origin/main"], ROOT, { plan: planFor(seen), run: async () => 0 });
    await main([], ROOT, { plan: planFor(seen), run: async () => 0 });
    expect(seen).toEqual(["origin/main", BASE_REF]);
  });

  test("--base=ref is the same as --base ref", async () => {
    // The spelling tier 2 accepted and tier 1 rejected with exit 2.
    const seen: string[] = [];
    expect(await main(["--base=origin/main"], ROOT, { plan: planFor(seen), run: async () => 0 })).toBe(0);
    expect(seen).toEqual(["origin/main"]);
  });

  test("--dry-run prints the decision and the argv, and runs nothing", async () => {
    const started: Step[] = [];
    const printed: string[] = [];
    const original = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      const code = await main(["--dry-run"], ROOT, {
        plan: () => PLAN,
        run: async (step) => {
          started.push(step);
          return 0;
        },
      });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(started).toEqual([]);
    expect(printed).toEqual([
      "scope=full",
      "reason=injected plan for the main tests",
      "step=turbo run test --concurrency=2",
      "step=bun test ./scripts/",
    ]);
  });

  test("a flag may not swallow the flag after it", async () => {
    // `--base --dry-run` used to take the flag as the ref, drop the dry run, and
    // run every package.
    const started: Step[] = [];
    const run = async (step: Step) => {
      started.push(step);
      return 0;
    };
    const stderr: string[] = [];
    const original = console.error;
    console.error = (line: string) => stderr.push(line);
    try {
      expect(await main(["--base", "--dry-run"], ROOT, { plan: () => PLAN, run })).toBe(2);
    } finally {
      console.error = original;
    }
    expect(started).toEqual([]);
    expect(stderr.join("\n")).toContain("usage:");
  });

  test("an unknown flag exits 2 and runs nothing", async () => {
    for (const argv of [["--nope"], ["stray"], ["--files", "a.ts"]]) {
      const started: Step[] = [];
      const original = console.error;
      console.error = () => {};
      try {
        const code = await main(argv, ROOT, {
          plan: () => PLAN,
          run: async (step) => {
            started.push(step);
            return 0;
          },
        });
        expect({ argv, code }).toEqual({ argv, code: 2 });
      } finally {
        console.error = original;
      }
      expect({ argv, started }).toEqual({ argv, started: [] });
    }
  });

  test("--help prints the usage on stdout and exits 0", async () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      expect(await main(["--help"], ROOT, { plan: () => PLAN, run: async () => 1 })).toBe(0);
    } finally {
      console.log = original;
    }
    expect(printed.join("\n")).toContain("usage:");
  });
});
