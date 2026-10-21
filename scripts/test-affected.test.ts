import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { hasRef, planAffected } from "./test-affected";

// `test:affected` narrows the unit suite to the packages a branch can move.
// The filter string is pinned exactly, because the three turbo spellings mean
// three different package sets and only one of them is the gate this repo
// wants. Measured on turbo 2.10.11 with a contracts-only commit:
//   --filter=[HEAD~1]      -> @dokan/contracts
//   --filter=...[HEAD~1]   -> @dokan/api, @dokan/contracts, @dokan/web
//   --filter=[HEAD~1]...   -> @dokan/contracts
// Only the middle one runs the dependents, which is what "affected" has to
// mean: a contracts edit is a web and api edit.
const ROOT = join(import.meta.dir, "..");

describe("test:affected plan", () => {
  test("a resolvable base selects the changed packages and their dependents", () => {
    const plan = planAffected("origin/develop", ROOT);
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
    expect(plan.note).toContain("origin/develop");
  });

  test("a missing base falls back to every package and says why", () => {
    // A fresh clone without the remote-tracking ref, or a lane whose fetch
    // failed: a filter on a ref git cannot resolve makes turbo exit non-zero,
    // which would read as a failing gate. Run everything and name the cause.
    const plan = planAffected("origin/not-a-ref", ROOT);
    expect(plan.steps[0]).toEqual(["turbo", "run", "test", "--concurrency=2"]);
    expect(plan.note).toContain("origin/not-a-ref");
    expect(plan.note).toContain("every package");
  });

  test("the fallback keeps the scripts suite", () => {
    expect(planAffected("origin/not-a-ref", ROOT).steps[1]).toEqual(["bun", "test", "./scripts/"]);
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
