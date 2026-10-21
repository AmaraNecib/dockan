import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  BASE_REF,
  enumeratePackages,
  hasRef,
  planAffected,
  turboArgs,
  type Step,
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
    expect(turboArgs(["tests/e2e/backups.spec.ts"], "origin/develop").args).toEqual([]);
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
  test("a workspace-only diff selects the changed packages and their dependents", () => {
    const plan = planAffected("origin/develop", ROOT, inScope);
    expect(plan.steps[0]).toEqual([
      "turbo",
      "run",
      "test",
      "--concurrency=2",
      "--filter=...[origin/develop]",
    ]);
    // The scripts suite holds the e2e map's drift guard; it is cheap and it is
    // the suite a narrowed run must not lose.
    expect(plan.steps[1]).toEqual(["bun", "test", "./scripts/"]);
    expect(plan.scope).toBe("filtered");
    expect(plan.note).toContain("origin/develop");
  });

  test("a root file drops the filter, so turbo cannot report zero tasks as a pass", () => {
    const plan = planAffected("origin/develop", ROOT, () => ["package.json"]);
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.scope).toBe("full");
    expect(plan.note).toContain("package.json");
    expect(plan.note).toContain("every package");
  });

  test("a missing base falls back to every package and says why", () => {
    // A fresh clone without the remote-tracking ref, or a lane whose fetch
    // failed: a filter on a ref git cannot resolve makes turbo exit non-zero,
    // which would read as a failing gate. Run everything and name the cause.
    const plan = planAffected("origin/not-a-ref", ROOT, inScope);
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.scope).toBe("full");
    expect(plan.note).toContain("origin/not-a-ref");
    expect(plan.note).toContain("every package");
  });

  test("a diff git cannot produce falls back to every package", () => {
    const plan = planAffected("origin/develop", ROOT, () => null);
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.scope).toBe("full");
    expect(plan.note).toContain("cannot read the diff");
  });

  test("the fallback keeps the scripts suite", () => {
    expect(planAffected("origin/not-a-ref", ROOT, inScope).steps[1]).toEqual(["bun", "test", "./scripts/"]);
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
    if (!hasRef(BASE_REF, ROOT)) {
      throw new Error(
        `${BASE_REF} does not resolve in ${ROOT}, so turbo cannot enumerate anything for it — run \`git fetch origin\` and re-run. CI's checks job already fetches with depth 0.`,
      );
    }
    expect(hasRef(BASE_REF, ROOT)).toBe(true);
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

  test("the filtered argv from a workspace diff selects only packages this repo has", () => {
    const plan = planAffected(BASE_REF, ROOT, () => ["apps/web/src/pages/sale.tsx"]);
    expect(plan.scope).toBe("filtered");
    const packages = selected(plan.steps[0] ?? []);
    // Whatever the branch's own diff is, `...[base]` can only narrow: `//` is
    // turbo's root package and every other entry must be a real workspace.
    for (const name of packages) {
      if (name === "//") continue;
      expect({ name, known: ALL.includes(name) }).toEqual({ name, known: true });
    }
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
