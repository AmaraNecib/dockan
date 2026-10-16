import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globToRegExp, loadMap, selectSpecs } from "./e2e-selection";

// This file is the reason the map can be trusted. It is cheap (no browser, no
// server) and runs inside `bun run test` (`turbo test` then `bun test ./scripts/`),
// so a stale map fails that job instead of silently disarming the suite. The
// last test asserts that wiring, so removing `bun test ./scripts/` cannot
// retire this guard quietly.
const ROOT = join(import.meta.dir, "..");
const SPEC_DIR = join(ROOT, "tests", "e2e");
const CLI = join(ROOT, "scripts", "e2e-selection.ts");

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
  test("has the shape the selector reads", () => {
    expect(Array.isArray(map.always_full)).toBe(true);
    expect(Array.isArray(map.skip_e2e)).toBe(true);
    expect(Array.isArray(map.features)).toBe(true);
    for (const feature of map.features) {
      expect(Array.isArray(feature.match)).toBe(true);
      expect(feature.match.length).toBeGreaterThan(0);
      // An empty `specs` would classify the file as "feature hit" and then
      // pick nothing, which selectSpecs turns into `skip`: a silent disarm.
      expect(feature.specs.length).toBeGreaterThan(0);
    }
  });

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
      // (`docs/**` matches nothing only if docs/ is empty). Accept it when its
      // literal prefix exists. An exact pattern's prefix is the path itself, so
      // a deleted file is dead.
      const wildcard = p.search(/[*?]/);
      const prefix = wildcard === -1 ? p : p.slice(0, wildcard);
      return !(prefix && existsSync(join(ROOT, prefix.replace(/\/$/, ""))));
    });
    expect(dead).toEqual([]);
  });

  test("a malformed map file throws instead of classifying anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-map-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ always_full: [] }));
    try {
      expect(() => loadMap(file)).toThrow(/must have always_full/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a feature rule beats a skip rule", () => {
    // `apps/web/src/pages/items.test.tsx` is both a feature match and a
    // `**/*.test.tsx` skip match; the feature rule must win.
    const scope = selectSpecs(["apps/web/src/pages/items.test.tsx"], map);
    expect(scope.mode).toBe("affected");
  });

  test("a critical path beats a feature rule for the same file", () => {
    // No checked-in path is both, so pin the precedence on a synthetic map.
    const overlapping = {
      always_full: ["apps/web/src/lib/shared.ts"],
      skip_e2e: ["**/*.test.ts"],
      features: [{ match: ["apps/web/src/lib/shared.ts"], specs: ["debts.spec.ts"] }],
    };
    const scope = selectSpecs(["apps/web/src/lib/shared.ts"], overlapping);
    expect(scope.mode).toBe("full");
    expect(scope.specs).toEqual([]);
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

  test("fail-closed on a blank diff", () => {
    expect(selectSpecs(["", "   ", "\n"], map).mode).toBe("full");
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

  test("two features union their specs without duplicates", () => {
    const scope = selectSpecs(["apps/web/src/pages/debts.tsx", "apps/web/src/pages/activity.tsx"], map);
    expect(scope.specs).toEqual(["activity.spec.ts", "debts.spec.ts"]);
    // pagination.spec.ts lives in several rules; a multi-rule diff must not repeat it.
    const shared = selectSpecs(["apps/web/src/pages/items.tsx", "apps/web/src/pages/sale.tsx"], map);
    expect(shared.specs.filter((s) => s === "pagination.spec.ts")).toHaveLength(1);
  });

  test("a feature-scoped component routes to its screens", () => {
    const scope = selectSpecs(["apps/web/src/components/receipt-view.tsx"], map);
    expect(scope.mode).toBe("affected");
    expect(scope.specs).toContain("receipts.spec.ts");
  });

  test("a component imported by more than one page is critical, not a feature rule", () => {
    // components/catalog is imported by items, sale and purchase; a single
    // feature rule would under-select, so it must force the full suite.
    expect(selectSpecs(["apps/web/src/components/catalog/item-picker-dialog.tsx"], map).mode).toBe("full");
    expect(selectSpecs(["apps/web/src/components/parties/party-picker.tsx"], map).mode).toBe("full");
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

  test("a literal dot in a pattern does not match another character", () => {
    const re = globToRegExp("apps/web/index.html");
    expect(re.test("apps/web/index.html")).toBe(true);
    expect(re.test("apps/web/indexXhtml")).toBe(false);
  });

  test("`?` matches one path segment character and never a slash", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a/b.ts")).toBe(false);
  });
});

describe("e2e-selection CLI", () => {
  test("emits the mode/specs/reason contract the workflow parses", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-cli-"));
    const changed = join(dir, "changed.txt");
    writeFileSync(changed, "apps/web/src/pages/debts.tsx\n");
    try {
      const out = execFileSync(process.execPath, [CLI, changed], { cwd: ROOT, encoding: "utf8" });
      expect(out).toContain("mode=affected\n");
      // ci.yml word-splits this line into Playwright positional filters, so the
      // tests/e2e/ prefix and the space join are part of the contract.
      expect(out).toContain("specs=tests/e2e/debts.spec.ts\n");
      expect(out).toMatch(/^reason=.+$/mu);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits non-zero without a changed-file argument", () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [CLI], { cwd: ROOT, stdio: "pipe" });
    } catch (error) {
      // SAFETY: execFileSync throws a Node-shaped error; the optional field is
      // only read to report the exit code.
      status = (error as { status?: number }).status ?? 0;
    }
    expect(status).toBe(2);
  });
});

describe("e2e-selection wiring", () => {
  test("`bun run test` runs the scripts suite, so this guard cannot be retired", () => {
    // SAFETY: package.json is this repo's own file; the `toContain` below is
    // the assertion that the field exists with the expected value.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toContain("bun test ./scripts/");
  });
});
