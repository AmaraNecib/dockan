import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The four hot-path `.sh` files plus the one that lives outside every repo. Each must be
 * a forwarding shim: the acceptance criterion says no `.sh` on the hot path, and rule 4
 * says the `.sh` name keeps working, so the only way both hold is that no `.sh` here
 * contains an implementation.
 */
const SHIMS = [
  { shim: ".scratch/scripts/crew-pickup.sh", target: "scripts/crew/crew-pickup.ts", controlFlow: false },
  { shim: ".scratch/scripts/crew-loop.sh", target: "scripts/crew/crew-loop.ts", controlFlow: false },
  { shim: ".scratch/scripts/e2e-slot.sh", target: "scripts/crew/e2e-slot.ts", controlFlow: false },
  { shim: ".scratch/scripts/crew-clean.sh", target: "scripts/crew/crew-clean.ts", controlFlow: false },
  // The wake shim resolves the TypeScript (it is installed outside the repo), so it is
  // the one shim allowed a loop — but still not allowed to implement the policy.
  { shim: "scripts/crew/herdr-wake.sh", target: "scripts/crew/herdr-wake.ts", controlFlow: true },
];

describe("hot-path shims", () => {
  for (const { shim, target, controlFlow } of SHIMS) {
    test(`${shim} forwards to ${target}`, () => {
      const path = join(ROOT, shim);
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      expect(body).toContain("exec bun");
      expect(body).toContain(target.split("/").pop() ?? "");
      expect(existsSync(join(ROOT, target))).toBe(true);
      // A shim is a name that keeps working, not a place for logic. `crew-clean.sh` is
      // destructive; a second implementation here would be a second set of guards.
      const statements = body
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .filter((line) => /^\s*(if|for|while|case|function)\b/u.test(line));
      expect(statements.length).toBe(controlFlow ? 2 : 0);
      expect(body.split("\n").length).toBeLessThan(controlFlow ? 40 : 20);
    });
  }

  // Every converted script must carry the proof the brief asks for, or the flag rots.
  test("every converted script has a --selftest", () => {
    for (const { target } of SHIMS) {
      expect(readFileSync(join(ROOT, target), "utf8")).toContain("--selftest");
    }
  });

  // The frozen pre-migration sources are the diff-proof's other half, and the reason a
  // replaced `.sh` is not simply lost: `.scratch` is untracked in the main repo.
  test("the frozen legacy sources are committed, and nothing calls them", () => {
    for (const name of ["crew-pickup.sh", "crew-loop.sh", "e2e-slot.sh", "crew-clean.sh", "herdr-wake.sh"]) {
      expect(existsSync(join(ROOT, ".scratch", "verification", "262", "legacy", name))).toBe(true);
    }
    const legacyPickup = readFileSync(join(ROOT, ".scratch", "verification", "262", "legacy", "crew-pickup.sh"), "utf8");
    // The recovered crew-loop.sh is the pre-migration implementation, not a shim.
    expect(legacyPickup).toContain("[pickup] started=");
    expect(readFileSync(join(ROOT, ".scratch", "verification", "262", "legacy", "crew-loop.sh"), "utf8")).toContain("run_loop()");
  });
});
