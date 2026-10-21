import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, playwrightArgs, scopeFor, shouldSpawn } from "./e2e-changed";
import type { Scope } from "./e2e-selection";

// The local twin of the CI selector. CI answers "which specs does this PR
// reach" server-side; this answers the same question on the lane that is about
// to push, so the wait is the mapped specs instead of all 35. The spawn is
// deliberately untested here: it hands over to `bun run test:e2e`, and the
// per-spec proof lives in the lane's commit body. What is pinned is the pure
// decision — which argv the driver would hand to Playwright, and which decision
// a broken input is allowed to produce.
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "scripts", "e2e-changed.ts");

const affected = (specs: string[]): Scope => ({
  mode: "affected",
  specs,
  reason: `${specs.length} spec(s) mapped from 1 file(s)`,
});

describe("e2e-changed spawn decision", () => {
  test("an affected scope becomes positional tests/e2e/ filters", () => {
    // The `tests/e2e/` prefix and the spec names are the argument shape
    // `playwright test` accepts; the same shape the CI selector emits.
    expect(playwrightArgs(affected(["backups.spec.ts"]))).toEqual(["tests/e2e/backups.spec.ts"]);
  });

  test("an affected scope keeps the selector's order and count", () => {
    expect(playwrightArgs(affected(["activity.spec.ts", "backups.spec.ts"]))).toEqual([
      "tests/e2e/activity.spec.ts",
      "tests/e2e/backups.spec.ts",
    ]);
  });

  test("full hands Playwright no filters, which is the whole suite", () => {
    expect(playwrightArgs({ mode: "full", specs: [], reason: "critical path: package.json" })).toEqual([]);
  });

  test("skip hands Playwright no filters either; the caller is what stops the spawn", () => {
    expect(playwrightArgs({ mode: "skip", specs: [], reason: "docs only" })).toEqual([]);
    expect(shouldSpawn({ mode: "skip", specs: [], reason: "docs only" })).toBe(false);
  });

  test("an affected scope with no specs fails closed to the whole suite", () => {
    // `affected` + an empty list is the fail-open shape: it would spawn
    // Playwright with no filters, which is exactly the full suite, so the argv
    // must be empty rather than a bogus empty filter.
    const scope = affected([]);
    expect(playwrightArgs(scope)).toEqual([]);
    expect(shouldSpawn(scope)).toBe(true);
  });

  test("an unexpected mode runs the suite instead of nothing", () => {
    // SAFETY: JSON.parse is the boundary for a shape this build's types forbid;
    // the literal is in the test, and the cast is what puts a mode outside the
    // union in front of the pure functions. A selector that starts emitting a
    // fourth mode must widen the run, never silence it.
    const rogue = JSON.parse('{"mode":"later","specs":[],"reason":"unknown mode"}') as Scope;
    expect(shouldSpawn(rogue)).toBe(true);
    expect(playwrightArgs(rogue)).toEqual([]);
  });

  test("full and affected both spawn", () => {
    expect(shouldSpawn({ mode: "full", specs: [], reason: "unmapped path: x" })).toBe(true);
    expect(shouldSpawn(affected(["backups.spec.ts"]))).toBe(true);
  });
});

describe("e2e-changed arguments", () => {
  test("defaults to origin/develop, a real diff and a real run", () => {
    expect(parseArgs([])).toEqual({ ok: true, base: "origin/develop", files: null, dryRun: false });
  });

  test("--files splits on commas and skips git", () => {
    expect(parseArgs(["--files", "a.ts,b.ts"])).toEqual({
      ok: true,
      base: "origin/develop",
      files: ["a.ts", "b.ts"],
      dryRun: false,
    });
  });

  test("--base, --files and --dry-run combine", () => {
    expect(parseArgs(["--base", "develop", "--files", "docs/ci.md", "--dry-run"])).toEqual({
      ok: true,
      base: "develop",
      files: ["docs/ci.md"],
      dryRun: true,
    });
  });

  test("--flag=value is the same as --flag value", () => {
    expect(parseArgs(["--base=develop", "--files=a.ts"])).toEqual({
      ok: true,
      base: "develop",
      files: ["a.ts"],
      dryRun: false,
    });
  });

  test("a flag with no value, an empty list, an unknown flag and a stray argument all fail", () => {
    for (const argv of [["--base"], ["--files"], ["--files", " , "], ["--nope"], ["stray"]]) {
      const parsed = parseArgs(argv);
      expect({ argv, ok: parsed.ok }).toEqual({ argv, ok: false });
    }
  });

  test("any base other than origin/develop is opt-in and reported", () => {
    const parsed = parseArgs(["--base", "origin/main"]);
    expect(parsed.ok && parsed.base).toBe("origin/main");
  });
});

describe("e2e-changed CLI", () => {
  test("--dry-run prints the same contract lines the CI selector prints", () => {
    // Two front ends, one map. Comparing the two outputs is what keeps the local
    // driver from drifting away from the server-side selector it reuses.
    const dir = mkdtempSync(join(tmpdir(), "e2e-changed-"));
    const changed = join(dir, "changed.txt");
    try {
      writeFileSync(changed, "apps/web/src/pages/backups.tsx\n");
      const ci = execFileSync(process.execPath, [join(ROOT, "scripts", "e2e-selection.ts"), changed], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const local = execFileSync(process.execPath, [CLI, "--dry-run", "--files", "apps/web/src/pages/backups.tsx"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(local).toBe(ci);
      expect(local).toContain("mode=affected\n");
      expect(local).toContain("specs=tests/e2e/backups.spec.ts\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mapped list stays short instead of widening to the suite", () => {
    const out = execFileSync(process.execPath, [CLI, "--dry-run", "--files", "apps/web/src/pages/backups.tsx"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out).not.toContain("mode=full");
  });

  test("a critical path forces full and emits an empty specs line", () => {
    const out = execFileSync(process.execPath, [CLI, "--dry-run", "--files", "package.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("mode=full\nspecs=\n");
    expect(out).toContain("reason=critical path: package.json");
  });

  test("a docs-only list skips", () => {
    const out = execFileSync(process.execPath, [CLI, "--dry-run", "--files", "docs/ci.md"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("mode=skip\nspecs=\n");
  });

  test("--dry-run prints the contract and nothing else", () => {
    // Three lines, nothing on stderr: a dry run that had quietly spawned the
    // suite would leave Playwright's own output behind.
    const run = Bun.spawnSync({
      cmd: [process.execPath, CLI, "--dry-run", "--files", "apps/web/src/pages/backups.tsx"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trimEnd().split("\n")).toHaveLength(3);
    expect(run.stderr.toString()).toBe("");
  });

  test("an unresolvable base fails closed to the full suite and says why", () => {
    const run = Bun.spawnSync({
      cmd: [process.execPath, CLI, "--dry-run", "--base", "origin/does-not-exist"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("mode=full\nspecs=\n");
    expect(run.stdout.toString()).toContain("origin/does-not-exist");
  });

  test("an unknown flag exits 2 with usage instead of guessing", () => {
    const run = Bun.spawnSync({
      cmd: [process.execPath, CLI, "--nope"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("usage:");
  });

  test("a real diff against origin/develop resolves without arguments", () => {
    // No --files: the driver asks git. This branch's own diff touches
    // package.json, so `full` is the correct answer; the assertion is that the
    // git path produces a decision at all rather than throwing.
    const parsed = parseArgs([]);
    if (!parsed.ok) throw new Error("defaults must parse");
    const scope = scopeFor({ base: parsed.base, files: null }, ROOT);
    expect(["full", "affected", "skip"]).toContain(scope.mode);
  });
});
