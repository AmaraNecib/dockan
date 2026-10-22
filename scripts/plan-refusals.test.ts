/**
 * `planAugmentedModules` reports every refusal, not only the first.
 *
 * The planner collects one refusal per module it cannot mirror. It used to return
 * `refusals[0]` behind an interface that claims `refusal: string | null`, so a
 * second refused module stayed invisible until the author fixed the first and
 * re-ran — and because nothing pinned which one surfaced, replacing
 * `refusals[0]` with `refusals[last]` passed the whole suite (#350 round 8).
 *
 * These tests pin the list itself: every refused module, the file's own import
 * order, the sibling stand-in a refusal must not take down with it, and the count
 * the report's summary line prints for them.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { planAugmentedModules, type Refusal } from "./red-on-parent";

const ROOT = join(import.meta.dir, "..");
const GATE = join(ROOT, "scripts", "red-on-parent.ts");

// ---------------------------------------------------------------------------
// Plan level: which modules a plan refuses, and in what order
// ---------------------------------------------------------------------------

describe("red-on-parent — the augment plan reports a refusal per module", () => {
  // Two modules the parent cannot resolve, each reached through a package
  // specifier, so `starExportNames` refuses each one on its own. The names the
  // test asks for are the ones the change adds, so neither module is skipped for
  // "the parent already has this".
  const PARENT_A = `export * from "nowhere-a-pkg";\n`;
  const PARENT_B = `export * from "nowhere-b-pkg";\n`;
  const CHANGE_A = `${PARENT_A}export function nameA(): number {\n  return 1;\n}\n`;
  const CHANGE_B = `${PARENT_B}export function nameB(): number {\n  return 2;\n}\n`;
  const TOUCHED = new Set(["scripts/a.ts", "scripts/b.ts"]);

  const readChange = (path: string): string | null =>
    path === "scripts/a.ts" ? CHANGE_A : path === "scripts/b.ts" ? CHANGE_B : null;
  const readParent = (path: string): string | null =>
    path === "scripts/a.ts" ? PARENT_A : path === "scripts/b.ts" ? PARENT_B : null;

  const planFor = (testFile: string, source: string) =>
    planAugmentedModules(testFile, source, TOUCHED, readChange, readParent);

  // `path` and `reason` are the whole interface the report reads, so a pin that
  // saw only the reason text could not tell a refusal attributed to the wrong
  // module from one attributed to the right one.
  const refusalRows = (refusals: Refusal[] | undefined): Array<{ path: string; reason: string }> =>
    (refusals ?? []).map((refusal) => ({ path: refusal.path, reason: refusal.reason }));

  test("both refusable modules are reported, in the file's own import order", () => {
    const forwards = planFor(
      "scripts/two-refusals.test.ts",
      `import { nameA } from "./a";\nimport { nameB } from "./b";\n`,
    );
    expect(forwards.modules).toEqual([]);
    expect(refusalRows(forwards.refusals)).toEqual([
      { path: "scripts/a.ts", reason: expect.stringContaining("nowhere-a-pkg") },
      { path: "scripts/b.ts", reason: expect.stringContaining("nowhere-b-pkg") },
    ]);
    // Each reason is about its own module, so the row for `a` cannot carry `b`'s
    // specifier: that would be one refusal printed twice, not two refusals.
    expect(forwards.refusals[0]?.reason).not.toContain("nowhere-b-pkg");
    expect(forwards.refusals[1]?.reason).not.toContain("nowhere-a-pkg");
    // Every reason already opens with the module it is about, which is what lets
    // the report print one row per module without repeating the attribution.
    for (const refusal of forwards.refusals) {
      expect(refusal.reason.startsWith(`${refusal.path}: `)).toBe(true);
    }
  });

  test("the order is the file's imports, not the modules' sort order", () => {
    // The same two modules, imported the other way round. Sorting by path would
    // print `a` first in both cases, so this is what separates "the file's order"
    // from "the order the modules happen to sort in".
    const reversed = planFor(
      "scripts/two-refusals-reversed.test.ts",
      `import { nameB } from "./b";\nimport { nameA } from "./a";\n`,
    );
    expect(refusalRows(reversed.refusals).map((refusal) => refusal.path)).toEqual([
      "scripts/b.ts",
      "scripts/a.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// End to end: the gate's report, and the stand-in a refusal must not erase
// ---------------------------------------------------------------------------

type FixtureFile = { path: string; text: string };

type Fixture = {
  repo: string;
  base: string;
  cache: string;
  cleanup: () => void;
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeFiles(root: string, files: FixtureFile[]): void {
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text);
  }
}

function commitAll(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, [
    "-c",
    "user.email=gate@fixture.invalid",
    "-c",
    "user.name=gate fixture",
    // A machine with `commit.gpgsign = true` has no key for this fixture's
    // identity, and the command-line `-c` outranks the machine's config.
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

/** A throwaway repo with a `base` commit, then a `change` commit on top. */
function createFixture(baseFiles: FixtureFile[], changeFiles: FixtureFile[]): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "ronp-refusals-repo-"));
  const cache = mkdtempSync(join(tmpdir(), "ronp-refusals-cache-"));
  git(repo, ["init", "-q"]);
  writeFiles(repo, baseFiles);
  commitAll(repo, "base");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFiles(repo, changeFiles);
  commitAll(repo, "change");
  const cleanup = () => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  };
  return { repo, base, cache, cleanup };
}

/** What one gate invocation printed and exited with. */
type GateOutput = { status: number | null; stdout: string };

/** The gate, run against the fixture's base commit. */
function runGateFixture(fixture: Fixture): GateOutput {
  const result = spawnSync(process.execPath, [GATE, "--base", fixture.base], {
    cwd: fixture.repo,
    encoding: "utf8",
    timeout: 45_000,
    env: { ...process.env, RED_ON_PARENT_CACHE: fixture.cache },
  });
  return { status: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const PKG: FixtureFile = { path: "package.json", text: `{ "name": "fixture", "type": "module" }\n` };
// Two modules no appended stand-in can help, and one the gate can still mirror.
const REFUSER_A = `export * from "nowhere-a-pkg";\nexport function existingA(): number {\n  return 1;\n}\n`;
const REFUSER_A_AFTER = `${REFUSER_A}export function nameA(): number {\n  return 1;\n}\n`;
const REFUSER_B = `export * from "nowhere-b-pkg";\nexport function existingB(): number {\n  return 2;\n}\n`;
const REFUSER_B_AFTER = `${REFUSER_B}export function nameB(): number {\n  return 2;\n}\n`;
const SIBLING = `export const other = 1;\n`;
const SIBLING_AFTER = `${SIBLING}export function brandNewC(): number {\n  return 3;\n}\n`;

const TEST_USING_BOTH_AND_SIBLING = `import { expect, test } from "bun:test";
import { nameA } from "./refuser-a";
import { nameB } from "./refuser-b";
import { brandNewC } from "./sibling";
test("uses the refuses and the sibling", () => {
  expect(nameA()).toBe(1);
  expect(nameB()).toBe(2);
  expect(brandNewC()).toBe(3);
});
`;

describe("red-on-parent — a refusal beside a sibling's stand-in, end to end", () => {
  test("each refusal is reported and the sibling's stand-in is still written", () => {
    const fixture = createFixture(
      [
        PKG,
        { path: "scripts/refuser-a.ts", text: REFUSER_A },
        { path: "scripts/refuser-b.ts", text: REFUSER_B },
        { path: "scripts/sibling.ts", text: SIBLING },
      ],
      [
        { path: "scripts/refuser-a.ts", text: REFUSER_A_AFTER },
        { path: "scripts/refuser-b.ts", text: REFUSER_B_AFTER },
        { path: "scripts/sibling.ts", text: SIBLING_AFTER },
        { path: "scripts/refusals-e2e.test.ts", text: TEST_USING_BOTH_AND_SIBLING },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // Both refusals reach the report, each about its own module. Before the fix
      // only the first one was printed, so the second module's cause was invisible
      // until the author fixed the first and re-ran.
      expect(stdout).toContain("scripts/refuser-a.ts: the parent's copy re-exports everything from `nowhere-a-pkg`");
      expect(stdout).toContain("scripts/refuser-b.ts: the parent's copy re-exports everything from `nowhere-b-pkg`");
      // The sibling is not collateral: its stand-in is both reported and on disk.
      expect(stdout).toContain("scripts/sibling.ts — appended brandNewC");
      const written = readFileSync(
        join(fixture.cache, `wt-${fixture.base}`, "scripts/sibling.ts"),
        "utf8",
      );
      expect(written.startsWith(SIBLING)).toBe(true);
      expect(written).toContain("Appended stand-in");
      expect(written).toContain("export function brandNewC");
      // Still a refusal of the file, never an accept: it never loaded on the parent.
      expect(stdout).toContain("red-on-parent: FAIL");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent — the summary counts every refusal", () => {
  test("two refused modules are two cannot-hollow rows, not one", () => {
    const fixture = createFixture(
      [PKG, { path: "scripts/refuser-a.ts", text: REFUSER_A }, { path: "scripts/refuser-b.ts", text: REFUSER_B }],
      [
        { path: "scripts/refuser-a.ts", text: REFUSER_A_AFTER },
        { path: "scripts/refuser-b.ts", text: REFUSER_B_AFTER },
        {
          path: "scripts/refusals-count.test.ts",
          text: `import { expect, test } from "bun:test";
import { nameA } from "./refuser-a";
import { nameB } from "./refuser-b";
test("uses both refuses", () => {
  expect(nameA()).toBe(1);
  expect(nameB()).toBe(2);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // The summary line is the line a reviewer reads: one refusal for two
      // refused modules would understate what the author has to fix.
      expect(stdout).toContain("2 cannot hollow");
      expect(stdout).not.toContain("1 cannot hollow");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});
