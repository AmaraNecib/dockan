import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverE2eSpecs, isRunnableE2eSpec } from "./e2e-discovery";
import { selectSpecs } from "./e2e-selection";

const ROOT = join(import.meta.dir, "..");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "e2e-discovery-"));
  writeFileSync(
    join(root, "playwright.config.ts"),
    readFileSync(join(ROOT, "playwright.config.ts"), "utf8"),
  );
  const tests = join(root, "tests", "e2e");
  mkdirSync(join(tests, "nested", "ignored"), { recursive: true });
  return { root, tests };
}

describe("e2e test discovery", () => {
  test("enumerates nested runnable extensions, including Git-ignored candidates", () => {
    const { root, tests } = fixture();
    try {
      writeFileSync(join(root, ".gitignore"), "tests/e2e/nested/ignored/\n");
      for (const name of [
        "account.spec.ts",
        "nested/flow.test.tsx",
        "nested/ignored/new.spec.mts",
        "nested/legacy.test.cjs",
        "notes.ts",
        "flow.spec.json",
      ]) {
        writeFileSync(join(tests, name), "export {};\n");
      }
      expect(discoverE2eSpecs(root)).toEqual({
        ok: true,
        specs: ["account.spec.ts", "nested/flow.test.tsx", "nested/ignored/new.spec.mts", "nested/legacy.test.cjs"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("matches Playwright collection, including ignored supported extensions", () => {
    const fixtureName = `discovery-contract-${process.pid}-${Date.now()}`;
    const fixtureDir = join(ROOT, "tests", "e2e", fixtureName, "ignored");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, ".gitignore"), "*.spec.mts\n*.test.cjs\n");
    writeFileSync(
      join(fixtureDir, "new.spec.mts"),
      'import { test } from "@playwright/test"; test("discovery fixture", () => {});\n',
    );
    writeFileSync(
      join(fixtureDir, "legacy.test.cjs"),
      'const { test } = require("@playwright/test"); test("legacy discovery fixture", () => {});\n',
    );
    try {
      const listed = spawnSync(process.execPath, ["run", "test:e2e", "--list"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect({ status: listed.status, error: listed.error?.message }).toEqual({ status: 0, error: undefined });
      const runnerSpecs = [...new Set(
        [...listed.stdout.matchAll(/^\s*(.+\.(?:spec|test)\.(?:[cm]?[jt]sx?)):\d+:\d+ ›/gmu)]
          .map((match) => (match[1] ?? "").replace(/^tests[\\/]+e2e[\\/]+/u, "").replace(/\\/gu, "/")),
      )].sort();
      const discovery = discoverE2eSpecs(ROOT);
      expect(discovery).toEqual({ ok: true, specs: runnerSpecs });
      expect(runnerSpecs).toContain(`${fixtureName}/ignored/new.spec.mts`);
      expect(runnerSpecs).toContain(`${fixtureName}/ignored/legacy.test.cjs`);
    } finally {
      rmSync(join(ROOT, "tests", "e2e", fixtureName), { recursive: true, force: true });
    }
  });

  test("a filtered Playwright list includes a real unregistered nested candidate", () => {
    const fixtureName = `orphan-filter-${process.pid}-${Date.now()}`;
    const fixtureDir = join(ROOT, "tests", "e2e", fixtureName, "nested");
    const relativeSpec = `${fixtureName}/nested/new-flow.spec.ts`;
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, ".gitignore"), "*.spec.ts\n");
    writeFileSync(
      join(fixtureDir, "new-flow.spec.ts"),
      'import { test } from "@playwright/test"; test("orphan selection fixture", () => {});\n',
    );
    try {
      const unfiltered = spawnSync(process.execPath, ["run", "test:e2e", "--list"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect({ status: unfiltered.status, error: unfiltered.error?.message }).toEqual({ status: 0, error: undefined });
      const inventory = [...new Set(
        [...unfiltered.stdout.matchAll(/^\s*(.+\.(?:spec|test)\.(?:[cm]?[jt]sx?)):\d+:\d+ ›/gmu)]
          .map((match) => (match[1] ?? "").replace(/^tests[\\/]+e2e[\\/]+/u, "").replace(/\\/gu, "/")),
      )].sort();
      const discovery = discoverE2eSpecs(ROOT);
      expect(discovery).toEqual({ ok: true, specs: inventory });
      expect(inventory).toContain(relativeSpec);

      const scope = selectSpecs(["apps/web/src/pages/backups.tsx"]);
      expect(scope).toEqual({
        mode: "affected",
        specs: expect.arrayContaining(["backups.spec.ts", relativeSpec]),
        reason: expect.any(String),
      });
      if (!scope || scope.mode !== "affected") return;
      const filtered = spawnSync(process.execPath, ["run", "test:e2e", "--list", ...scope.specs.map((spec) => `tests/e2e/${spec}`)], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect({ status: filtered.status, error: filtered.error?.message }).toEqual({ status: 0, error: undefined });
      const filteredSpecs = [...new Set(
        [...filtered.stdout.matchAll(/^\s*(.+\.(?:spec|test)\.(?:[cm]?[jt]sx?)):\d+:\d+ ›/gmu)]
          .map((match) => (match[1] ?? "").replace(/^tests[\\/]+e2e[\\/]+/u, "").replace(/\\/gu, "/")),
      )].sort();
      expect(filteredSpecs).toContain(relativeSpec);
      expect(filteredSpecs).toContain("backups.spec.ts");
      expect(filteredSpecs).not.toContain("vault.spec.ts");
    } finally {
      rmSync(join(ROOT, "tests", "e2e", fixtureName), { recursive: true, force: true });
    }
  });

  test("both CLI suites pass while an unregistered spec exists", () => {
    const fixtureName = `orphan-cli-${process.pid}-${Date.now()}`;
    const fixtureDir = join(ROOT, "tests", "e2e", fixtureName);
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, "new-flow.spec.ts"),
      'import { test } from "@playwright/test"; test("orphan CLI fixture", () => {});\n');
    try {
      // Passing CLI suites alone also worked before automatic discovery. Pin
      // the new behavior first: this unregistered file must actually be picked.
      expect(selectSpecs(["apps/web/src/pages/backups.tsx"])).toEqual({
        mode: "affected",
        specs: expect.arrayContaining(["backups.spec.ts", `${fixtureName}/new-flow.spec.ts`]),
        reason: expect.any(String),
      });
      // Curated helper injection cannot protect real subprocess assertions.
      const cliSuites = spawnSync(process.execPath, ["test", "scripts/e2e-selection.test.ts", "scripts/e2e-changed.test.ts"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect({ status: cliSuites.status, error: cliSuites.error?.message }).toEqual({ status: 0, error: undefined });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("an unregistered nested candidate joins mapped specs for an affected path", () => {
    const { root, tests } = fixture();
    try {
      mkdirSync(join(tests, "ignored"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), "tests/e2e/ignored/\n");
      writeFileSync(join(tests, "backups.spec.ts"), "export {};\n");
      writeFileSync(join(tests, "ignored", "new-flow.test.tsx"), "export {};\n");
      const map = {
        always_full: [],
        skip_e2e: ["**/*.md"],
        features: [{ match: ["apps/web/src/pages/backups.tsx"], specs: ["backups.spec.ts"] }],
      };
      expect(selectSpecs(["apps/web/src/pages/backups.tsx"], map, discoverE2eSpecs(root))).toEqual({
        mode: "affected",
        specs: ["backups.spec.ts", "ignored/new-flow.test.tsx"],
        reason: "2 spec(s) selected from 1 file(s)",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("matches only Playwright's explicit spec and test extension forms", () => {
    for (const name of ["a.spec.ts", "a.test.tsx", "a.spec.mjs", "a.test.cts", "a.spec.mtsx"]) {
      expect(isRunnableE2eSpec(name)).toBe(true);
    }
    for (const name of ["a.ts", "a.spec.json", "a.spec.jsx.map", "a.test.d.ts"]) {
      expect(isRunnableE2eSpec(name)).toBe(false);
    }
  });

  test("dead settings, spreads, and differently formatted projects cannot prove discovery", () => {
    const { root, tests } = fixture();
    const current = readFileSync(join(ROOT, "playwright.config.ts"), "utf8");
    try {
      writeFileSync(join(tests, "one.spec.ts"), "export {};\n");
      const variants = [
        `${current.replace("export default defineConfig(", "const unused = defineConfig(")}\nexport default { testDir: "./other-tests" };\n`,
        current.replace('testDir: "./tests/e2e",', 'testDir: "./tests/e2e", projects : [{ testDir: "./other-tests" }],'),
        current.replace('testDir: "./tests/e2e",', 'testDir: "./tests/e2e", ...{ testDir: "./other-tests" },'),
      ];
      for (const source of variants) {
        writeFileSync(join(root, "playwright.config.ts"), source);
        const result = discoverE2eSpecs(root);
        expect(result).toEqual({ ok: false, reason: expect.any(String) });
        if (!result || result.ok) return;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing, empty, unreadable, or unsupported config cannot prove discovery", () => {
    const { root, tests } = fixture();
    try {
      expect(discoverE2eSpecs(join(root, "missing"))).toEqual({ ok: false, reason: expect.any(String) });
      rmSync(join(tests), { recursive: true, force: true });
      mkdirSync(tests, { recursive: true });
      expect(discoverE2eSpecs(root)).toEqual({ ok: false, reason: expect.any(String) });
      writeFileSync(join(tests, "one.spec.ts"), "export {};\n");
      writeFileSync(join(root, "playwright.config.ts"), "export default {};\n");
      expect(discoverE2eSpecs(root)).toEqual({ ok: false, reason: expect.any(String) });
      writeFileSync(
        join(root, "playwright.config.ts"),
        'import { E2E_TEST_MATCH } from "./scripts/e2e-discovery";\nexport default defineConfig({ testDir: "./tests/e2e", testMatch: E2E_TEST_MATCH, respectGitIgnore: false, testIgnore: "**/private/**" });\n',
      );
      expect(discoverE2eSpecs(root)).toEqual({ ok: false, reason: expect.any(String) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
