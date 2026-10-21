import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { hasRef, planAffected, turboArgs } from "./test-affected";

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
