import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globToRegExp, loadMap, selectSpecs } from "./e2e-selection";

// This file is the reason the map can be trusted. It is cheap (no browser, no
// server) and runs inside `bun run test` (`turbo test` then `bun test ./scripts/`),
// so a stale map fails that job instead of silently disarming the suite. The
// wiring assertion that `bun run test` still runs this suite deliberately lives
// in `apps/desktop/scripts/ci-workflow.test.ts`: an assertion inside this file
// could not catch its own removal when the command that runs it was removed too
// (#231).
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
      expect(Array.isArray(feature.specs)).toBe(true);
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
      writeFileSync(
        file,
        JSON.stringify({ always_full: [], skip_e2e: [], features: [{ match: ["x"], specs: [] }] }),
      );
      expect(() => loadMap(file)).toThrow(/non-empty features/);
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

  test("a critical path beats a skip rule", () => {
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
    const scope = selectSpecs(["", "   ", "\n"], map);
    expect(scope.mode).toBe("full");
    expect(scope.reason).toContain("empty diff");
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
    const scope = selectSpecs(["apps/web/src/pages/backups.tsx"], map);
    expect(scope.mode).toBe("affected");
    expect(scope.specs).toEqual(["backups.spec.ts"]);
  });

  test("two features union their specs without duplicates", () => {
    const scope = selectSpecs(["apps/web/src/pages/debts.tsx", "apps/web/src/pages/activity.tsx"], map);
    expect(scope.specs).toEqual([
      "activity.spec.ts",
      "backups.spec.ts",
      "debts.spec.ts",
      "supplier-adjustment.spec.ts",
    ]);
    // pagination.spec.ts lives in several rules; a multi-rule diff must not repeat it.
    const shared = selectSpecs(["apps/web/src/pages/categories.tsx", "apps/web/src/pages/invoices.tsx"], map);
    expect(shared.specs.filter((s) => s === "pagination.spec.ts")).toHaveLength(1);
  });

  test("a feature-scoped component routes to its screens", () => {
    const scope = selectSpecs(["apps/web/src/components/receipt-view.tsx"], map);
    expect(scope.mode).toBe("affected");
    expect(scope.specs).toContain("receipts.spec.ts");
  });

  test("a component imported by more than one page is critical, not a feature rule", () => {
    // components/catalog is imported by items, sale and purchase; a single
    // feature rule would under-select, so it must force the full suite. Assert
    // the reason too: `full` is also what an unmapped path produces.
    const catalog = selectSpecs(["apps/web/src/components/catalog/item-picker-dialog.tsx"], map);
    expect(catalog.mode).toBe("full");
    expect(catalog.reason).toContain("critical path");
    const parties = selectSpecs(["apps/web/src/components/parties/party-picker.tsx"], map);
    expect(parties.mode).toBe("full");
    expect(parties.reason).toContain("critical path");
  });

  test("an invoice page edit runs the new-return form's spec (#231)", () => {
    // invoice.tsx renders ReturnsPanel (the new-return form), and returns.spec.ts
    // drives that panel through the invoice page. Dropping it let an
    // invoice.tsx edit pass PR checks without the browser covering the return
    // form.
    const scope = selectSpecs(["apps/web/src/pages/invoice.tsx"], map);
    expect(scope.mode).toBe("affected");
    expect(scope.specs).toContain("returns.spec.ts");
  });

  test("a purchase page edit is critical and its rule keeps the learnability checks (#231)", () => {
    // learnability.spec.ts pins the purchase form and its pinned bar at the two
    // short window heights. purchase.tsx is now always_full (it renders the
    // shared catalog + parties pickers and InvoiceHeader), so the page forces
    // the whole suite while the rule keeps the list for the unit-test sibling.
    const page = selectSpecs(["apps/web/src/pages/purchase.tsx"], map);
    expect(page.mode).toBe("full");
    expect(page.reason).toContain("critical path");
    const rule = selectSpecs(["apps/web/src/pages/purchase.test.tsx"], map);
    expect(rule.mode).toBe("affected");
    expect(rule.specs).toEqual(["learnability.spec.ts", "purchase-inline-product.spec.ts", "purchase-intake.spec.ts"]);
  });

  test("a debts page edit runs the supplier-credit checks (#231)", () => {
    // supplier-adjustment.spec.ts navigates to /debts and pins the supplier
    // credit label and total (lines 162-167). Dropping it let a debts.tsx edit
    // pass PR checks without the browser covering the group totals. Assert the
    // exact list so a later over-widening is visible too.
    const scope = selectSpecs(["apps/web/src/pages/debts.tsx"], map);
    expect(scope.mode).toBe("affected");
    expect(scope.specs).toEqual(["debts.spec.ts", "supplier-adjustment.spec.ts"]);
  });

  test("an activity page edit runs the backup-filename check (#231)", () => {
    // backups.spec.ts navigates to /activity and pins the activity table's
    // backup-filename render (lines 39-42).
    const scope = selectSpecs(["apps/web/src/pages/activity.tsx"], map);
    expect(scope.mode).toBe("affected");
    expect(scope.specs).toEqual(["activity.spec.ts", "backups.spec.ts"]);
  });

  test("a sale page edit runs the quick-add and party-picker checks (#231)", () => {
    // items-flow.spec.ts drives the zero-price sale quick-add and
    // customer-name-variants.spec.ts the party-picker warning. sale.tsx renders
    // the shared catalog + parties pickers, so it is always_full and the page
    // edit reaches both through the full suite; the rule keeps them listed for
    // the unit-test sibling.
    const page = selectSpecs(["apps/web/src/pages/sale.tsx"], map);
    expect(page.mode).toBe("full");
    expect(page.reason).toContain("critical path");
    const rule = selectSpecs(["apps/web/src/pages/sale.test.tsx"], map);
    expect(rule.mode).toBe("affected");
    expect(rule.specs).toEqual([
      "completion-screens.spec.ts",
      "customer-name-variants.spec.ts",
      "items-flow.spec.ts",
      "learnability.spec.ts",
      "no-write-window.spec.ts",
      "pagination.spec.ts",
      "sale-checkout.spec.ts",
    ]);
  });

  test("pages that render a critical shared component tree are critical, not feature rules (#231)", () => {
    // components/catalog/** and components/parties/** are critical because more
    // than one page renders them, and their specs span several feature rules.
    // A page that renders one of those trees is another entry to the same
    // surface, so its own rule under-selects; stock.tsx is imported by items.tsx
    // as StockForm. Round 3 promotes the page instead. Assert the reason too:
    // `full` is also what an unmapped path produces.
    const pages = [
      "apps/web/src/pages/stock.tsx",
      "apps/web/src/pages/items.tsx",
      "apps/web/src/pages/sale.tsx",
      "apps/web/src/pages/purchase.tsx",
      "apps/web/src/pages/parties.tsx",
      "apps/web/src/pages/party-detail.tsx",
    ];
    const notFull = pages.filter((page) => selectSpecs([page], map).mode !== "full");
    expect(notFull).toEqual([]);
    const uncritical = pages.filter(
      (page) => !selectSpecs([page], map).reason.includes("critical path"),
    );
    expect(uncritical).toEqual([]);
  });

  test("every feature rule has a live path (none is fully shadowed by always_full)", () => {
    // The promotions move a page out of its feature rule but leave the specs to
    // the page's unit-test sibling. If a later change promoted every path a rule
    // matches, that rule would be dead and the specs would silently drop to the
    // full suite only. Assert each rule still has one tracked path whose
    // selection is not `full`. (Rule-vs-rule shadowing is by design: the first
    // matching feature rule wins.)
    for (const feature of map.features) {
      const fires = feature.match.some((pattern) => {
        const re = globToRegExp(pattern);
        return tracked.some((f) => re.test(f) && selectSpecs([f], map).mode !== "full");
      });
      expect({ match: feature.match, fires }).toMatchObject({ fires: true });
    }
  });

  test("the vault gate is critical: shared startup, not a vault-only rule (#231)", () => {
    // RequireSession renders the gate before any route, and its useVaultStatus
    // drives the legacy plaintext startup too, so a gate edit can change how
    // every spec boots. The vault-only sibling keeps its narrow rule.
    const gate = selectSpecs(["apps/web/src/components/vault/vault-gate.tsx"], map);
    expect(gate.mode).toBe("full");
    expect(gate.reason).toContain("critical path");
    const settings = selectSpecs(["apps/web/src/components/vault/vault-settings.tsx"], map);
    expect(settings.mode).toBe("affected");
    expect(settings.specs).toEqual(["vault.spec.ts"]);
  });

  test("the #209 specs are reachable from the parties rule", () => {
    // PR #209 added phone-identity.spec.ts and rpc-helpers.spec.ts while this
    // branch was open; the drift guard fails until they are mapped. Both drive
    // the customers page (party phone identity, actAndAck over customersCreate).
    // parties.tsx is always_full now, so the rule is reached via its test sibling.
    const scope = selectSpecs(["apps/web/src/pages/parties.test.tsx"], map);
    expect(scope.specs).toContain("phone-identity.spec.ts");
    expect(scope.specs).toContain("rpc-helpers.spec.ts");
  });

  test("shared web code is critical, not a feature rule", () => {
    // lib/ is read by every screen; a change there must run the whole suite.
    const scope = selectSpecs(["apps/web/src/lib/receipt.ts"], map);
    expect(scope.mode).toBe("full");
    expect(scope.reason).toContain("critical path");
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
    const run = (lines: string) => {
      writeFileSync(changed, lines);
      return execFileSync(process.execPath, [CLI, changed], { cwd: ROOT, encoding: "utf8" });
    };
    try {
      const affected = run("apps/web/src/pages/backups.tsx\n");
      expect(affected).toContain("mode=affected\n");
      // ci.yml word-splits this line into Playwright positional filters, so the
      // tests/e2e/ prefix and the space join are part of the contract.
      expect(affected).toContain("specs=tests/e2e/backups.spec.ts\n");
      expect(affected).toMatch(/^reason=.+$/mu);
      // full and skip both emit an empty specs line, never a stale one
      expect(run("apps/api/src/rpc/router.ts\n")).toContain("mode=full\nspecs=\n");
      expect(run("docs/ci.md\n")).toContain("mode=skip\nspecs=\n");
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
