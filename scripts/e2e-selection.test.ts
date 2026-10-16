import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { globToRegExp, loadMap, selectSpecs } from "./e2e-selection";

// This file is the reason the map can be trusted. It is cheap (no browser, no
// server) and runs inside `bun run test` (`turbo test` then `bun test ./scripts/`),
// so a stale map fails that job instead of silently disarming the suite.
const ROOT = join(import.meta.dir, "..");
const SPEC_DIR = join(ROOT, "tests", "e2e");

const map = loadMap();
const isSpec = (f: string) => f.endsWith(".spec.ts");
const onDisk = readdirSync(SPEC_DIR).filter(isSpec).sort();
// `--cached` is the committed tree; `--others --exclude-standard` adds a new
// file that is not committed yet, so a pattern for a file this change adds is
// already live when the guard runs pre-commit. Ignored trees (node_modules,
// target, dist, .turbo) never appear, so a broad glob cannot look maintained
// because a build artifact happens to match it.
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

describe("e2e-selection map", () => {
  test("every spec on disk is reachable from at least one feature rule", () => {
    const reachable = new Set(map.features.flatMap((f) => f.specs));
    const orphans = onDisk.filter((s) => !reachable.has(s));
    // An orphan spec would never run on a PR again: it would only ever fire in
    // the full suite. Either wire it up or delete the spec.
    expect(orphans).toEqual([]);
  });

  test("every spec a rule names exists on disk", () => {
    const missing = [...new Set(map.features.flatMap((f) => f.specs))].filter((s) => !onDisk.includes(s));
    expect(missing).toEqual([]);
  });

  test("every pattern is well formed and still matches reality", () => {
    const patterns = [
      ...map.always_full.filter((p) => !p.startsWith("$comment")),
      ...map.skip_e2e.filter((p) => !p.startsWith("$comment")),
      ...map.features.flatMap((f) => f.match),
    ];
    const dead = patterns.filter((p) => {
      const re = globToRegExp(p); // throws on a malformed pattern
      if (tracked.some((f) => re.test(f))) return false;
      // A directory-scoped pattern can be live without matching a tracked file
      // (`docs/**` matches nothing only if docs/ is empty; `.scratch/**` names
      // an ignored directory). Accept it when its literal prefix exists. An
      // exact pattern's prefix is the path itself, so a deleted file is dead.
      const wildcard = p.search(/[*?]/);
      const prefix = wildcard === -1 ? p : p.slice(0, wildcard);
      return !(prefix && existsSync(join(ROOT, prefix.replace(/\/$/, ""))));
    });
    expect(dead).toEqual([]);
  });

  test("a feature rule beats a skip rule", () => {
    // `apps/web/src/pages/items.test.tsx` is both a feature match and a
    // `**/*.test.tsx` skip match; the feature rule must win.
    const scope = selectSpecs(["apps/web/src/pages/items.test.tsx"], map);
    expect(scope.mode).toBe("affected");
  });

  test("a critical path beats a skip rule and a feature rule", () => {
    const scope = selectSpecs(["docs/readme.md", "apps/api/src/rpc/router.ts"], map);
    expect(scope.mode).toBe("full");
  });
});

describe("e2e-selection behaviour", () => {
  test("fail-closed on an unknown path", () => {
    const scope = selectSpecs(["apps/web/src/pages/brand-new-screen.tsx"], map);
    expect(scope.mode).toBe("full");
    expect(scope.reason).toContain("unmapped");
  });

  test("fail-closed on an empty diff", () => {
    expect(selectSpecs([], map).mode).toBe("full");
  });

  test("docs-only diff skips e2e", () => {
    expect(selectSpecs(["docs/ci.md", "README.md"], map).mode).toBe("skip");
  });

  test("a .github-only diff skips e2e", () => {
    expect(selectSpecs([".github/workflows/ci.yml"], map).mode).toBe("skip");
  });

  test("an edit to a spec forces the full suite", () => {
    // You cannot edit the tests and then claim they are unaffected.
    expect(selectSpecs(["tests/e2e/debts.spec.ts"], map).mode).toBe("full");
  });

  test("a critical path beats a skip rule for the same file", () => {
    expect(selectSpecs(["tests/e2e/README.md"], map).mode).toBe("full");
  });

  test("a feature diff selects exactly its mapped specs", () => {
    const scope = selectSpecs(["apps/web/src/pages/debts.tsx"], map);
    expect(scope.mode).toBe("affected");
    expect(scope.specs).toEqual(["debts.spec.ts"]);
  });

  test("two features union their specs", () => {
    const scope = selectSpecs(["apps/web/src/pages/debts.tsx", "apps/web/src/pages/activity.tsx"], map);
    expect(scope.specs).toEqual(["activity.spec.ts", "debts.spec.ts"]);
  });

  test("a feature-scoped component routes to its screens", () => {
    const scope = selectSpecs(["apps/web/src/components/parties/party-forms.tsx"], map);
    expect(scope.mode).toBe("affected");
    expect(scope.specs).toContain("customers.spec.ts");
  });

  test("shared web code is critical, not a feature rule", () => {
    // lib/ is read by every screen; a change there must run the whole suite.
    expect(selectSpecs(["apps/web/src/lib/receipt.ts"], map).mode).toBe("full");
  });

  test("an unlisted unit test is inert", () => {
    expect(selectSpecs(["apps/web/src/pages/ghost.test.tsx"], map).mode).toBe("skip");
  });

  test("a desktop-only diff runs no e2e", () => {
    expect(selectSpecs(["apps/desktop/src-tauri/src/lib.rs"], map).mode).toBe("skip");
  });
});
