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
    // #369: the whole TurboPlan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(plan).toEqual({
      args: ["--filter=...[origin/develop]"],
      scope: "filtered",
      reason: "packages changed since origin/develop, plus the packages that depend on them",
    });
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
      expect(plan).toEqual({
        args: [],
        scope: "full",
        reason: `${rootFile} is outside every workspace package (apps/<name>/, packages/<name>/), and turbo's root \`//\` package declares no test task — an impacted filter would run nothing and exit 0, so every package runs`,
      });
    }
  });

  test("a top-level directory is not a workspace even when it holds code", () => {
    // `args: []` alone does not say WHY it is empty: the empty diff, a bare
    // `apps`, and a path outside every package all produce it. The scope and the
    // reason are what tell this rule from the others.
    const plan = turboArgs(["tests/e2e/backups.spec.ts"], "origin/develop");
    expect(plan).toEqual({
      args: [],
      scope: "full",
      reason:
        "tests/e2e/backups.spec.ts is outside every workspace package (apps/<name>/, packages/<name>/), and turbo's root `//` package declares no test task — an impacted filter would run nothing and exit 0, so every package runs",
    });
  });

  test("an empty diff runs every package instead of reporting nothing to do", () => {
    // Nothing to narrow on is not evidence that nothing can break. The
    // expensive answer is allowed to be wrong; the empty one is not.
    const plan = turboArgs([], "origin/develop");
    expect(plan).toEqual({
      args: [],
      scope: "full",
      reason: "empty diff — nothing to narrow on, so every package runs",
    });
  });

  test("a workspace prefix needs a package name and a path under it", () => {
    // `apps/` alone, a bare `apps`, and a nested workspace-looking path are all
    // not a workspace package: the pattern is `apps/<name>/` or `packages/<name>/`.
    for (const notAWorkspace of ["apps/", "apps", "apps/web", "packages/contracts"]) {
      const plan = turboArgs([notAWorkspace], "origin/develop");
      expect(plan).toEqual({
        args: [],
        scope: "full",
        reason: `${notAWorkspace} is outside every workspace package (apps/<name>/, packages/<name>/), and turbo's root \`//\` package declares no test task — an impacted filter would run nothing and exit 0, so every package runs`,
      });
    }
  });

  test("Windows backslashes count as separators, so a lane on Git Bash still narrows", () => {
    expect(turboArgs(["apps\\web\\src\\pages\\backups.tsx"], "origin/develop")).toEqual({
      args: ["--filter=...[origin/develop]"],
      scope: "filtered",
      reason: "packages changed since origin/develop, plus the packages that depend on them",
    });
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
    // #369: the whole Plan. On the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError, and the
    // note is what names the ref a human typed and the commit turbo resolves.
    expect(plan).toEqual({
      steps: [
        ["turbo", "run", "test", "--concurrency=2", `--filter=...[${MERGE_BASE}]`],
        // The scripts suite holds the e2e map's drift guard; it is cheap and it
        // is the suite a narrowed run must not lose.
        ["bun", "test", "./scripts/"],
      ],
      scope: "filtered",
      note: `packages changed since origin/develop (merge-base ${MERGE_BASE}), plus the packages that depend on them`,
    });
  });

  test("a root file drops the filter, so turbo cannot report zero tasks as a pass", () => {
    const plan = planAffected("origin/develop", ROOT, () => ["package.json"], {
      select: SELECTS_WEB,
    });
    // #369: the whole Plan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(plan).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      scope: "full",
      note:
        "package.json is outside every workspace package (apps/<name>/, packages/<name>/), and turbo's root `//` package declares no test task — an impacted filter would run nothing and exit 0, so every package runs",
    });
  });

  test("a missing base falls back to every package and says why", () => {
    // A fresh clone without the remote-tracking ref, or a lane whose fetch
    // failed: a filter on a ref git cannot resolve makes turbo exit non-zero,
    // which would read as a failing gate. Run everything and name the cause.
    const plan = planAffected("origin/not-a-ref", ROOT, inScope, { select: SELECTS_WEB });
    // #369: the whole Plan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(plan).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      scope: "full",
      note:
        "origin/not-a-ref does not resolve in this checkout, so every package runs (an impacted filter needs the ref)",
    });
  });

  test("a diff git cannot produce falls back to every package", () => {
    const plan = planAffected("origin/develop", ROOT, () => null, { select: SELECTS_WEB });
    // #369: the whole Plan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(plan).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      scope: "full",
      note:
        "cannot read the diff against origin/develop, so every package runs (an impacted filter would select nothing and exit 0)",
    });
  });

  test("the fallback keeps the scripts suite", () => {
    // The same fallback as the row above, seen whole: the scripts suite is what
    // a narrowed run must not lose. #369: on the parent's hollow stand-in this
    // is `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(planAffected("origin/not-a-ref", ROOT, inScope, { select: SELECTS_WEB })).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      scope: "full",
      note:
        "origin/not-a-ref does not resolve in this checkout, so every package runs (an impacted filter needs the ref)",
    });
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
    // #369: the whole Plan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(plan).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      // The FILTER IS GONE from the argv, not merely labelled unfiltered: the
      // widened plan has to be the one that runs every package.
      scope: "full",
      note:
        "the impacted filter against origin/develop selects no package (`//`), which turbo would run as zero tasks and exit 0, so every package runs",
    });
  });

  test("a filter that selects nothing at all widens too", () => {
    const plan = planAffected("origin/develop", ROOT, inScope, { select: selects() });
    // #369: the whole Plan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(plan).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      scope: "full",
      note:
        "the impacted filter against origin/develop selects no package (nothing), which turbo would run as zero tasks and exit 0, so every package runs",
    });
  });

  test("a dry run turbo could not answer widens, and names the refusal", () => {
    // Not a green pass and not a silent narrowing: a refusal is "unproven", and
    // unproven runs everything.
    const plan = planAffected("origin/develop", ROOT, inScope, {
      select: () => ({ packages: [], refusal: "turbo's dry run exited 1" }),
    });
    // #369: the whole Plan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError, and the
    // note is what carries the refusal the module chose.
    expect(plan).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      scope: "full",
      note:
        "origin/develop would narrow to a package set, but turbo could not confirm it (turbo's dry run exited 1) — an unproven selection is not a narrowing, so every package runs",
    });
  });

  test("a filter that selects a real package stays narrowed", () => {
    const plan = planAffected("origin/develop", ROOT, inScope, {
      select: selects("@dokan/contracts", "@dokan/api"),
      mergeBase: AT_MERGE_BASE,
    });
    // #369: the whole Plan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(plan).toEqual({
      steps: [
        ["turbo", "run", "test", "--concurrency=2", `--filter=...[${MERGE_BASE}]`],
        ["bun", "test", "./scripts/"],
      ],
      scope: "filtered",
      note: `packages changed since origin/develop (merge-base ${MERGE_BASE}), plus the packages that depend on them`,
    });
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
    // #369: the whole Plan; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    expect(plan).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      scope: "full",
      note:
        "cannot find the merge-base of origin/develop and HEAD, so every package runs (an impacted filter needs a commit both sides share)",
    });
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

  // The describe's rows read `enumeratePackages` directly: a helper that threw
  // on a refusal (and so dereferenced a hollow `undefined` before any claim)
  // is gone, and every row asserts the whole TurboSelection instead. #369.

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
    // #369: the whole TurboSelection, with the subsets the row depends on named
    // asymmetrically; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError, and the
    // count assert below dereferences only after the expect has vouched.
    const selection = enumeratePackages([
      "turbo",
      "run",
      "test",
      "--concurrency=2",
      "--filter=...@dokan/contracts",
    ], ROOT);
    expect(selection).toEqual({
      packages: expect.arrayContaining(["@dokan/contracts", "@dokan/api"]),
      refusal: null,
    });
    // A dependent the filter never named: this is what `...` buys. And it is a
    // narrowing, not "everything": if a version bump made `...` a no-op this
    // would be the whole workspace and the asymmetric pin above would still
    // pass.
    expect(selection.packages.length).toBeLessThan(ALL.length);
  });

  test("`...` after a selector selects its dependencies, so the two sides stay distinct", () => {
    // The other direction. turbo 2.10.11 measured: `...foo` is foo + dependents,
    // `foo...` is foo + dependencies. A bump that swapped them breaks exactly one
    // of these two tests, which is the point of asserting both.
    // #369: the whole TurboSelection; on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError.
    const selection = enumeratePackages([
      "turbo",
      "run",
      "test",
      "--concurrency=2",
      "--filter=@dokan/contracts...",
    ], ROOT);
    expect(selection).toEqual({ packages: ["@dokan/contracts"], refusal: null });
  });

  test("the unfiltered argv from turboArgs selects every workspace package", () => {
    // A root file drops the filter, so the argv is turbo's own: every package,
    // and nothing silently left out of the run the fallback promises.
    // #369: the whole Plan first — on the parent's hollow stand-in this is
    // `expect(undefined).toEqual(...)` reding as an AssertionError — and only
    // the selection below, which needs the plan's argv, runs after it has
    // vouched. Its note is deterministic, so it is pinned string-exact.
    const plan = planAffected(BASE_REF, ROOT, () => ["package.json"]);
    expect(plan).toEqual({
      steps: [["turbo", "run", "test", "--concurrency=2"], ["bun", "test", "./scripts/"]],
      scope: "full",
      note:
        "package.json is outside every workspace package (apps/<name>/, packages/<name>/), and turbo's root `//` package declares no test task — an impacted filter would run nothing and exit 0, so every package runs",
    });
    // Membership is the claim, not turbo's print order, and a refusal would
    // make the promised run unproven rather than complete.
    const selection = enumeratePackages(plan.steps[0] ?? [], ROOT);
    expect({ packages: [...selection.packages].sort(), refusal: selection.refusal }).toEqual({
      packages: [...ALL].sort(),
      refusal: null,
    });
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
    const selection = enumeratePackages([
      "turbo",
      "run",
      "test",
      "--concurrency=2",
      "--filter=...@dokan/contracts",
    ], ROOT);
    const real = selection?.packages.filter((name) => name !== "//") ?? [];
    // #369: the vouch is one composed assert, because a hollow `undefined` has
    // to stay an AssertionError and never become a TypeError: the refusal must
    // be present-and-null (a plain `??` default would alias the honest null),
    // and a loop over an empty list is not a test, so the count comes inside
    // it. The loop below dereferences only after the expect has vouched.
    expect([selection === undefined ? "<hollow>" : selection.refusal, real.length > 0]).toEqual([
      null,
      true,
    ]);
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
    // #369: vouch on the whole Plan first — on the parent's hollow stand-in
    // this is `expect(undefined).toEqual(...)` reding as an AssertionError.
    // The vouch is deliberately thin, because either scope is a live answer on
    // this branch; the exactness lives in the arms, where the reachable shapes
    // are known, and it is what lets both arms dereference.
    expect(plan).toEqual({
      steps: [
        expect.arrayContaining(["turbo", "run", "test", "--concurrency=2"]),
        ["bun", "test", "./scripts/"],
      ],
      scope: expect.stringMatching(/^(filtered|full)$/u),
      note: expect.any(String),
    });
    if (plan.scope === "filtered") {
      const live = enumeratePackages(plan.steps[0] ?? [], ROOT);
      const real = live?.packages.filter((name) => name !== "//") ?? [];
      expect([live === undefined ? "<hollow>" : live.refusal, real.length > 0]).toEqual([
        null,
        true,
      ]);
      for (const name of real) {
        expect({ name, known: ALL.includes(name) }).toEqual({ name, known: true });
      }
      return;
    }
    // Widened: the filter is gone from the argv outright and the reason says
    // which rule fired. On a lane that touches no package this is the
    // merge-base answer ([`//`]), which is exactly the shape the guard exists
    // for; a dry run turbo refused is the other arm. Both wide reasons are
    // reachable from this row, so the note matches either.
    expect(plan.steps[0].some((arg) => arg.startsWith("--filter="))).toBe(false);
    expect(plan.note).toMatch(/selects no package|could not confirm/u);
  });

  test("a dry run that prints no JSON is a refusal naming the argv, not an empty selection", () => {
    const result = enumeratePackages(["turbo", "run", "test"], ROOT, () => ({
      status: 0,
      stdout: "not json at all",
      stderr: "turbo exploded",
      error: "",
    }));
    // #369: the whole TurboSelection, refusal pinned string-exact — the string
    // is the module's, measured off a live module probe, not guessed. On the
    // parent's hollow stand-in this is `expect(undefined).toEqual(...)`
    // reding as an AssertionError.
    expect(result).toEqual({
      packages: [],
      refusal: "turbo's dry run printed JSON that does not parse for `turbo run test`: turbo exploded",
    });
  });

  test("a dry run that cannot start is a refusal, not an empty selection", () => {
    const result = enumeratePackages(["turbo", "run", "test"], ROOT, () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: "spawn ENOTDIR",
    }));
    // #369: the whole TurboSelection, refusal pinned string-exact. An empty
    // result and a refusal-that-names-the-argv are different answers.
    expect(result).toEqual({
      packages: [],
      refusal: "turbo did not start for `turbo run test`: spawn ENOTDIR",
    });
  });

  test("a dry run JSON without a packages array is refused, not read as nothing selected", () => {
    const result = enumeratePackages(["turbo", "run", "test"], ROOT, () => ({
      status: 0,
      stdout: '• turbo 2.10.11\n{ "id": "x", "tasks": [] }',
      stderr: "",
      error: "",
    }));
    // #369: the whole TurboSelection, refusal pinned string-exact. The payload
    // in this case DID parse; it is the missing packages list that is refused.
    expect(result).toEqual({
      packages: [],
      refusal: "turbo's dry run printed no packages list for `turbo run test`",
    });
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
    // #369: the whole StepsOutcome; awaiting a hollow stub yields `undefined`,
    // so this reds there as `expect(undefined).toEqual(...)` — an AssertionError,
    // never a TypeError.
    expect(
      await runSteps(STEPS, ROOT, async (step) => (step[0] === "turbo" ? 1 : 0)),
    ).toEqual({
      results: [
        { step: ["turbo", "run", "test", "--concurrency=2"], status: 1 },
        { step: ["bun", "test", "./scripts/"], status: 0 },
      ],
      status: 1,
    });
  });

  test("a red second step reddens the combined exit when the first was green", async () => {
    // The fail-fast shape returned the first step's status before the second ran,
    // so this case could not exist: a green first step ended the run at 0.
    // #369: whole StepsOutcome, as above.
    expect(
      await runSteps(STEPS, ROOT, async (step) => (step[0] === "bun" ? 1 : 0)),
    ).toEqual({
      results: [
        { step: ["turbo", "run", "test", "--concurrency=2"], status: 0 },
        { step: ["bun", "test", "./scripts/"], status: 1 },
      ],
      status: 1,
    });
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
    // #369: whole StepsOutcome — [2, 3] in PLAN order with exit 2, though the
    // red child finished last. A hollow stub reds this as an AssertionError.
    expect(result).toEqual({
      results: [
        { step: ["turbo", "run", "test", "--concurrency=2"], status: 2 },
        { step: ["bun", "test", "./scripts/"], status: 3 },
      ],
      status: 2,
    });
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
    // #369: the whole argv re-composed from the plan's own argv plus the flag;
    // on the parent's hollow stand-in this is `expect(undefined).toEqual(...)`
    // reding as an AssertionError — the same two facts the measured literal in
    // the row above pins, stated as a derivation.
    expect(dryRunArgs(STEP)).toEqual([...STEP.slice(1), "--dry-run=json"]);
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
