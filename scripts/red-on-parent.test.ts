/**
 * Tests for the red-on-parent gate.
 *
 * The gate's whole reason to exist is that a test which is green on the parent
 * pins nothing. A gate nobody tests is the failure mode this project keeps
 * paying for, so every verdict class gets a fixture here: a real temp git repo
 * with a base commit and a change commit, the gate run against it, and the
 * verdict it printed asserted. The sharp fixture is the hook-throws one: a
 * `beforeEach` throw prints a `(fail) <name>` line identical in shape to a real
 * assertion red, so a gate that greps `(fail)` calls it a pass. This suite
 * asserts both halves — the transcript *does* carry that line, and the gate
 * still classifies it WRONG-REASON RED: the failing testcase evaluated no
 * assertion. The discriminator is junit's `type`: measured on bun 1.4.3 (the
 * `packageManager` pin, which CI installs), a `beforeEach` throw is
 * `type="Error"` and an assertion red is `type="AssertionError"`. The
 * `assertions` counter does not separate them, and using it as well
 * misclassified a `node:assert` red — see `isAssertionRed` in the gate.
 *
 * These fixtures are the gate's own tests, so they live where `bun run test`
 * already looks (`bun test ./scripts/`).
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as gateModule from "./red-on-parent";
import {
  augmentModuleSource,
  bunOnlyRefusal,
  cannotHollowVerdict,
  changeSideResults,
  changeSideVerdicts,
  classifyFileRun,
  decodeXml,
  declaredExportNames,
  displayName,
  editedModuleExportRefusal,
  hollowModuleSource,
  importedTestFiles,
  isGatedTestPath,
  loadFailureReason,
  lockPidFileContent,
  main,
  missingExportDetail,
  notRegisteredOnChange,
  parseJunit,
  parseWaivers,
  planAugmentedModules,
  planHollowModules,
  reclaimClaimName,
  renderReport,
  runPasses,
  runtimeExportNames,
  runFinished,
  runGate,
  skipReason,
  topLevelBindingNames,
  unregisteredVerdicts,
  unusedWaiverVerdicts,
  verdictPasses,
  VERDICT_GUIDE,
  type FileRun,
  type GateRun,
  type TestResult,
  type TestStatus,
  type Verdict,
  type Waiver,
} from "./red-on-parent";

const ROOT = join(import.meta.dir, "..");
const GATE = join(ROOT, "scripts", "red-on-parent.ts");

/**
 * The path a waiver or import probe is parsed as.
 *
 * `parseWaivers` and `importedTestFiles` take the path the file really has,
 * because the extension decides how the file is parsed: `<Foo>"ok"` is a type
 * assertion in `.ts` and a JSX element in `.tsx`. A probe that omits the path
 * gets no reading at all, which is the point — the default it used to have read
 * a `.tsx` file as `.ts` and reported a waiver set the real file never declares.
 */
const PROBE_TS = "apps/api/src/probe.test.ts";
/** The same, for a probe whose source is JSX and has to be parsed as `.tsx`. */
const PROBE_TSX = "apps/web/src/probe.test.tsx";

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

type File = { path: string; text: string };

type Fixture = {
  repo: string;
  base: string;
  cache: string;
  cleanup: () => void;
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeFiles(root: string, files: File[]): void {
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
    // A contributor with `commit.gpgsign = true` in their config cannot run this
    // suite otherwise: the fixture's commits have no key to sign with. The
    // identity above is already set for the same reason, and a command-line `-c`
    // outranks the machine's config and `GIT_CONFIG_*`.
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

/** A throwaway repo with a `base` commit, then a `change` commit on top. */
function createFixture(baseFiles: File[], changeFiles: File[]): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "ronp-repo-"));
  const cache = mkdtempSync(join(tmpdir(), "ronp-cache-"));
  git(repo, ["init", "-q"]);
  writeFiles(repo, baseFiles);
  commitAll(repo, "base");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (changeFiles.length > 0) {
    writeFiles(repo, changeFiles);
    commitAll(repo, "change");
  }
  const cleanup = () => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  };
  return { repo, base, cache, cleanup };
}

/** What one gate invocation printed and exited with. */
type GateOutput = {
  status: number | null;
  stdout: string;
};

function runGateFixture(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
  timeoutMs = 45_000,
): GateOutput {
  const result = spawnSync(process.execPath, [GATE, "--base", fixture.base, ...extraArgs], {
    cwd: fixture.repo,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, RED_ON_PARENT_CACHE: fixture.cache, ...extraEnv },
  });
  return { status: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * The same gate, in the background, so two runs can overlap. The lock is only
 * observable when two of them race for one base worktree.
 */
function runGateAsync(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
  killAfterMs = 45_000,
): Promise<GateOutput> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [GATE, "--base", fixture.base], {
      cwd: fixture.repo,
      env: { ...process.env, RED_ON_PARENT_CACHE: fixture.cache, ...extraEnv },
    });
    let out = "";
    // A hung child would otherwise leak for the rest of the suite: spawn has no
    // timeout of its own, so this one kills it and says why.
    const timer = setTimeout(() => {
      out += `\n(the gate did not exit within ${killAfterMs}ms; killed)`;
      child.kill();
    }, killAfterMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      settle({ status, stdout: out });
    });
  });
}

/**
 * The classifier a grep-based gate would use: "a `(fail)` line with no
 * `# Unhandled error` means the test failed for its own reason". Kept here on
 * purpose, so the hook fixture can show the difference instead of asserting it.
 */
function naiveGrepVerdict(stdout: string): "RIGHT_REASON_RED" | "WRONG_REASON_RED" {
  if (stdout.includes("(fail)") && !stdout.includes("# Unhandled error between tests")) {
    return "RIGHT_REASON_RED";
  }
  return "WRONG_REASON_RED";
}

const HELPER_BEFORE = `export function guard(n: number): number {
  if (n <= 0) throw new Error("zero");
  return n;
}
`;

const HELPER_AFTER = `export function guard(n: number): number {
  if (n <= 0) throw new Error("ZERO");
  return n;
}
export function brandNew(n: number): number {
  return n;
}
`;

const PKG: File = { path: "package.json", text: `{ "name": "fixture", "type": "module" }\n` };
const HELPER: File = { path: "packages/core/src/helper.ts", text: HELPER_BEFORE };

/**
 * The hook-throws file, committed by both the e2e fixture and the capture test.
 * A `beforeEach` throw prints the same `(fail) <name>` line an assertion red
 * prints, so a gate that greps the reporter calls it a pass; junit types it
 * `Error`, because the body never ran.
 */
const HOOK_TEST = `import { beforeEach, describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("hooky", () => {
  beforeEach(() => {
    try {
      guard(0);
    } catch (error) {
      if ((error as Error).message === "zero") throw new Error("hook boom");
    }
  });
  test("never gets to assert", () => {
    expect(guard(1)).toBe(1);
  });
});
`;

// ---------------------------------------------------------------------------
// Fixtures — one per verdict, each observed end to end
// ---------------------------------------------------------------------------

describe("red-on-parent gate fixtures", () => {
  test("RIGHT-REASON RED: an assertion red on the parent passes the gate", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/red.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("guard", () => {
  test("rejects zero", () => {
    expect(() => guard(0)).toThrow("ZERO");
  });
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("CANNOT HOLLOW: a file that cannot load on the parent fails the gate", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        {
          path: "packages/core/src/helper.ts",
          // Round 25: an export the parent's copy lacks is no longer enough to
          // stop this file loading — the gate appends a stand-in for it. What
          // still stops it is a name whose declaration an appended stand-in
          // cannot carry, and an enum is one: its members are runtime values.
          text: `${HELPER_AFTER}
export enum Mode {\n  One,\n}\n`,
        },
        {
          path: "packages/core/src/load.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { Mode } from "./helper";
describe("brand", () => {
  test("returns the number", () => {
    expect(Mode.One).toBe(0);
  });
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // Round 24 renamed this row: the cause is the change's, not the test's — the
      // parent has `helper.ts` but cannot be given `Mode` — so it is one CANNOT
      // HOLLOW row for the file, which the waiver grammar can clear with one line.
      expect(stdout).toContain("CANNOT-HOLLOW");
      expect(stdout).toContain("`Mode`");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("GREEN ON PARENT: a test that passes on the parent fails the gate", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/green.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("gr", () => {
  test("keeps a positive number", () => {
    expect(guard(1)).toBe(1);
  });
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(stdout).toContain("pins no behaviour the change adds");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("WAIVER MISFILED: a waiver on a test that is already red fails the gate", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/misfiled.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("misfile", () => {
  test("rejects zero", () => {
    expect(() => guard(0)).toThrow("ZERO");
  });
});
// red-on-parent-waive: "misfile rejects zero" — the author thought this was green
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("WAIVER-MISFILED");
      expect(stdout).toContain("delete the waiver");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("GREEN ON PARENT, waived: the escape hatch passes the gate", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/waived.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("pre", () => {
  test("keeps a positive number", () => {
    expect(guard(1)).toBe(1);
  });
});
// red-on-parent-waive: "pre keeps a positive number" — characterizes behaviour the refactor kept
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(stdout).toMatch(/GREEN-ON-PARENT\s+line \d+/u);
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("CANNOT HOLLOW, waived: a file that needs an export the parent cannot be given passes with one line", () => {
    // Round 24 changed this row from one WRONG REASON RED per test to one CANNOT
    // HOLLOW for the file, because the cause is single: the parent cannot be given
    // the export the file imports. One waiver line, naming the file, records
    // exactly that — where the per-test rows demanded one line per test for the
    // same fact, and the file-level rule then refused a pattern broad enough to
    // cover them.
    //
    // Round 25 narrowed which names reach this row: a plain function export is
    // appended as a stand-in now and judged, so the fixture uses an enum, whose
    // members are runtime values an appended declaration cannot carry.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        {
          path: "packages/core/src/helper.ts",
          text: `${HELPER_AFTER}\nexport enum Mode {\n  One,\n}\n`,
        },
        {
          path: "packages/core/src/moved.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { Mode } from "./helper";
describe("moved", () => {
  test("returns the number", () => {
    expect(Mode.One).toBe(0);
  });
});
// red-on-parent-waive: "whole file" — the parent cannot be given the enum the test imports
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("CANNOT-HOLLOW");
      expect(stdout).toMatch(/CANNOT-HOLLOW\s+line \d+/u);
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("an uncommitted test file fails the gate, it does not pass quietly", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/red.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      // The gate reads HEAD, so this file is invisible to it. Naming it was
      // not enough — the run exited 0, so the file that was about to be
      // committed was judged by nothing while the report said PASS.
      writeFiles(fixture.repo, [
        {
          path: "packages/core/src/late.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("late", () => {\n  expect(1).toBe(2);\n});\n`,
        },
      ]);
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("packages/core/src/late.test.ts");
      expect(stdout).toContain("NOT JUDGED");
      expect(stdout).toContain("PROBLEMS");
      // The committed file is judged and passes, so the exit code is the
      // unjudged one that decides this run.
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a staged test file fails the gate too", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/red.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      // Staged is not committed: HEAD does not hold the file, so the gate
      // cannot judge it. A run that printed PASS over it judged nothing.
      writeFiles(fixture.repo, [
        {
          path: "packages/core/src/staged.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("staged", () => {\n  expect(1).toBe(2);\n});\n`,
        },
      ]);
      git(fixture.repo, ["add", "packages/core/src/staged.test.ts"]);
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("packages/core/src/staged.test.ts");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("edited test files are never gated", () => {
    const existing = `import { expect, test } from "bun:test";
test("already here", () => {
  expect(1).toBe(1);
});
`;
    const fixture = createFixture(
      [PKG, HELPER, { path: "packages/core/src/existing.test.ts", text: existing }],
      [
        {
          path: "packages/core/src/existing.test.ts",
          text: existing.replace('expect(1).toBe(1);', 'expect(1).toBe(2);'),
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("no added test files");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a test the change registers and the parent does not is NOT ON PARENT", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        {
          path: "packages/core/src/helper.ts",
          text: `${HELPER_AFTER}
export function brandNew(n: number): number {
  return n;
}
`,
        },
        {
          path: "packages/core/src/conditional.test.ts",
          text: `import { expect, test } from "bun:test";
import * as helper from "./helper";
test("rejects zero", () => {
  expect(() => helper.guard(0)).toThrow("ZERO");
});
if ("brandNew" in helper) {
  test("brandNew returns the number", () => {
    expect(helper.brandNew(2)).toBe(2);
  });
}
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // `rejects zero` is a genuine red on the parent, so on the parent's own
      // test list alone this file passes without the second test ever being
      // judged — the one test the gate exists for.
      expect(stdout).toContain("NOT-ON-PARENT");
      expect(stdout).toContain("brandNew returns the number");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
  test("a non-ASCII file name is gated, not silently skipped", () => {
    // `git diff --name-only` quotes a path holding a non-ASCII byte, and the
    // quoted form fails `isGatedTestPath` at both ends — so without `-z` this
    // file is gated by nobody and the author is never told.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/café.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("café.test.ts");
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("a file whose workspace owns a bunfig.toml", () => {
  // The parent of a React test file has to run the way its workspace runs it.
  // Bun reads the `bunfig.toml` of its working directory, so a gate that runs
  // every file from the repo root never loads this preload, and the fixture
  // below dies at load with `document is not defined`.
  const BUNFIG: File = { path: "apps/web/bunfig.toml", text: `[test]\npreload = ["./preload.ts"]\n` };
  const PRELOAD: File = {
    path: "apps/web/preload.ts",
    text: `(globalThis as { document?: { createElement: (tag: string) => unknown } }).document = {\n  createElement: () => ({}),\n};\n`,
  };
  // The red has to come from the change, not from a line that fails on both
  // sides: a test that is red on the change too is a broken test, and the gate
  // now says so (see "a test that is red on the change as well fails the
  // gate" below).
  const WEB_HELPER_BEFORE: File = {
    path: "apps/web/src/helper.ts",
    text: `export function guard(n: number): number {
  if (n <= 0) throw new Error("zero");
  return n;
}
`,
  };
  const WEB_HELPER_AFTER: File = {
    path: "apps/web/src/helper.ts",
    text: `export function guard(n: number): number {
  if (n <= 0) throw new Error("ZERO");
  return n;
}
`,
  };

  test("runs from that workspace, so the preload's globals exist", () => {
    const fixture = createFixture(
      [PKG, BUNFIG, PRELOAD, WEB_HELPER_BEFORE],
      [
        WEB_HELPER_AFTER,
        {
          path: "apps/web/src/preload.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
const host = (globalThis as { document: { createElement: (tag: string) => unknown } }).document.createElement("div");
test("the preload defined document", () => {
  expect(host).toBeDefined();
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("WRONG-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("--head", () => {
  const taggedFixture = () =>
    createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/red.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("guard", () => {
  test("rejects zero", () => {
    expect(() => guard(0)).toThrow("ZERO");
  });
});
`,
        },
      ],
    );

  const tag = (repo: string, name: string, target: string) =>
    git(repo, [
      "-c",
      "user.email=gate@fixture.invalid",
      "-c",
      "user.name=gate fixture",
      // Same reason as `commitAll`: a contributor with `tag.gpgsign = true` and no
      // usable key cannot create these fixtures, and a command-line `-c` outranks
      // the machine's config and `GIT_CONFIG_*`.
      "-c",
      "tag.gpgsign=false",
      "tag",
      "-a",
      name,
      "-m",
      "annotated on purpose, so its object id is not the commit id",
      target,
    ]);

  test("an annotated tag aimed at the checked-out commit is the same commit", () => {
    const fixture = taggedFixture();
    try {
      tag(fixture.repo, "at-head", "HEAD");
      const { status, stdout } = runGateFixture(fixture, {}, ["--head", "at-head"]);
      // Unpeeled, `rev-parse at-head` is the tag object's id, so the gate sent
      // the author off to check out the commit they were already sitting on.
      expect(stdout).not.toContain("is not the checked-out commit");
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("an annotated tag on another commit is still reported", () => {
    const fixture = taggedFixture();
    try {
      tag(fixture.repo, "at-change", "HEAD");
      writeFiles(fixture.repo, [{ path: "packages/core/README.md", text: "not a test\n" }]);
      commitAll(fixture.repo, "moves HEAD past the tagged commit");
      const { status, stdout } = runGateFixture(fixture, {}, ["--head", "at-change"]);
      expect(stdout).toContain("is not the checked-out commit");
      // A ref problem is not a waiver problem; it used to print under a
      // "WAIVER LINE PROBLEMS" heading, which sends the author to the wrong file.
      expect(stdout).not.toContain("WAIVER LINE PROBLEMS");
      // A `--head` whose tests cannot be enumerated is a problem, and a run with
      // a problem fails closed: the NOT ON PARENT check never ran, so a pass
      // here would be a pass on a check that was skipped.
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("the base worktree lock", () => {
  const redTest: File = {
    path: "packages/core/src/red.test.ts",
    text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
  };

  test("a lock left behind by a dead process does not block the gate", () => {
    const fixture = createFixture([PKG, HELPER], [{ path: "packages/core/src/helper.ts", text: HELPER_AFTER }, redTest]);
    try {
      const lockPath = join(fixture.cache, `wt-${fixture.base}.lock`);
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(join(lockPath, "pid"), "4999999\n");
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a cold cache directory is created before the lock is taken", () => {
    const fixture = createFixture([PKG, HELPER], [{ path: "packages/core/src/helper.ts", text: HELPER_AFTER }, redTest]);
    try {
      // The fixtures normally hand the gate a cache directory that already
      // exists, which is exactly why the first-run crash slipped past them:
      // `mkdirSync(lockPath)` needs its parent, and on a real first run there is
      // none.
      rmSync(fixture.cache, { recursive: true, force: true });
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a lock held by a live run waits, then refuses, and says which lock", () => {
    const fixture = createFixture([PKG, HELPER], [{ path: "packages/core/src/helper.ts", text: HELPER_AFTER }, redTest]);
    try {
      const lockPath = join(fixture.cache, `wt-${fixture.base}.lock`);
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(join(lockPath, "pid"), `${process.pid}\n`);
      // The holder is this test process, which is alive, so the gate must not
      // break the lock and must not pretend to have a verdict: it waits out a
      // budget it was told to keep short, then refuses with exit 2.
      const { status, stdout } = runGateFixture(fixture, { RED_ON_PARENT_LOCK_WAIT_MS: "600" });
      expect(stdout).toContain("another red-on-parent run is using");
      expect(stdout).toContain(lockPath);
      expect(status).toBe(2);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  // A smoke check on the outcome, not the regression detector: without the lock
  // these two may still both succeed if one finishes `git worktree add` before
  // the other looks. The test above is the one that fails deterministically when
  // the lock is removed, because a held lock is observable without a race.
  test("two concurrent runs both reach a verdict", async () => {
    const fixture = createFixture([PKG, HELPER], [{ path: "packages/core/src/helper.ts", text: HELPER_AFTER }, redTest]);
    try {
      const [first, second] = await Promise.all([
        runGateAsync(fixture),
        runGateAsync(fixture),
      ]);
      expect(first.stdout).toContain("RIGHT-REASON-RED");
      expect(second.stdout).toContain("RIGHT-REASON-RED");
      expect([first.status, second.status]).toEqual([0, 0]);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("the hook-throws fixture, where a grep-based gate is wrong", () => {
  test("a beforeEach throw is WRONG-REASON RED even though it prints `(fail)`", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        { path: "packages/core/src/hook.test.ts", text: HOOK_TEST },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // The gate's answer, and the reason for it: the test body never ran, so
      // it never rejected the missing behaviour. Measured on bun 1.4.3 (the
      // pin): a hook throw is `type="Error"`, an assertion red is
      // `type="AssertionError"`, so the type is what decides this.
      //
      // What the gate prints is its verdict and an excerpt of the transcript
      // starting at the first `error:` line, so the reporter's `(fail)` line is
      // deliberately NOT in this output. The trap is asserted against a captured
      // transcript instead — see "the trap a grep-based gate falls into" below.
      expect(stdout).toContain("WRONG-REASON-RED");
      expect(stdout).toContain("before evaluating the test body");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The parsing and classification rules
// ---------------------------------------------------------------------------

describe("the trap a grep-based gate falls into", () => {
  // A transcript as bun prints it for a hook that throws: the reporter writes
  // the same `(fail) <name>` line a real assertion red writes, while junit
  // records `type="Error"` because the body never ran. The gate must not read
  // the reporter. The first test below captures that transcript from a real bun
  // run of the same file the hook fixture commits, so the premise is measured
  // against bun's output and not against a literal written to satisfy the helper.
  const hookJunit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1">
  <testsuite name="hook.test.ts" tests="1">
    <testcase name="never gets to assert" classname="hooky" file="hook.test.ts" line="5" assertions="0">
      <failure type="Error" message="hook boom" />
    </testcase>
  </testsuite>
</testsuites>`;

  test("bun's real transcript for a hook throw carries `(fail)`", () => {
    // The parent-side run is the file copied into the base worktree, so the
    // helper it imports is the pre-change one: `guard(0)` throws "zero", the
    // hook re-throws, and the reporter prints `(fail)`. Leaving helper.ts
    // unchanged here reproduces exactly that run (with the change helper,
    // which throws "ZERO", the hook would not fire and the test would pass).
    const fixture = createFixture([PKG, HELPER], [
      { path: "packages/core/src/hook.test.ts", text: HOOK_TEST },
    ]);
    try {
      const junitPath = join(mkdtempSync(join(tmpdir(), "ronp-hook-junit-")), "out.xml");
      const run = spawnSync(
        process.execPath,
        [
          "test",
          "packages/core/src/hook.test.ts",
          "--reporter=junit",
          `--reporter-outfile=${junitPath}`,
        ],
        { cwd: fixture.repo, encoding: "utf8" },
      );
      const stdout = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      // The premise, from bun itself: the reporter writes the `(fail)` line an
      // assertion red writes, so a grep-based gate would call this a pass.
      expect(stdout).toContain("(fail) hooky > never gets to assert");
      expect(naiveGrepVerdict(stdout)).toBe("RIGHT_REASON_RED");
      // The junit type the gate actually reads is not fooled by it.
      const realJunit = readFileSync(junitPath, "utf8");
      const parsed = parseJunit(realJunit);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.failureType).toBe("Error");
      const classified = classifyFileRun(
        { file: "packages/core/src/hook.test.ts", junit: realJunit, stdout, error: "" },
        [],
      );
      expect(classified.verdicts.map((verdict) => verdict.name)).toEqual(["WRONG_REASON_RED"]);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("the unit fixture carries the same discriminator the real report does", () => {
    const [result] = parseJunit(hookJunit);
    expect(result?.assertions).toBe(0);
    const classified = classifyFileRun(
      {
        file: "hook.test.ts",
        junit: hookJunit,
        stdout: "(fail) hooky > never gets to assert",
        error: "",
      },
      [],
    );
    expect(classified.verdicts.map((verdict) => verdict.name)).toEqual(["WRONG_REASON_RED"]);
  });
});

describe("parseJunit", () => {
  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4">
  <testsuite name="f.test.ts" tests="4">
    <testsuite name="outer" line="2">
      <testsuite name="inner" line="3">
        <testcase name="deep &amp; quotable" classname="inner &gt; outer" file="f.test.ts" line="4" assertions="2">
          <failure type="AssertionError" message="nope">AssertionError: nope</failure>
        </testcase>
      </testsuite>
      <testcase name="passes" classname="outer" file="f.test.ts" line="8" />
      <testcase name="skipped one" classname="outer" file="f.test.ts" line="9">
        <skipped />
      </testcase>
      <testcase name="todos" classname="outer" file="f.test.ts" line="10">
        <skipped message="TODO" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

  test("reads status, failure type and the describe chain", () => {
    const results = parseJunit(sample);
    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({
      name: "deep & quotable",
      classname: "inner > outer",
      status: "failed",
      failureType: "AssertionError",
      assertions: 2,
    });
    expect(results[1]?.status).toBe("passed");
    expect(results[1]?.failureType).toBeNull();
    expect(results[2]?.status).toBe("skipped");
    expect(results[3]?.status).toBe("skipped");
  });

  test("a testcase with no assertions attribute parses it as null", () => {
    expect(parseJunit(sample)[1]?.assertions).toBeNull();
  });

  test("the display name is the chain bun's -t filter matches", () => {
    // Measured: `-t '^outer inner deep$'` selects this test, and the chain is
    // reported innermost-first in `classname`.
    expect(displayName(parseJunit(sample)[0] ?? { name: "", classname: "" })).toBe(
      "outer inner deep & quotable",
    );
  });

  test("a test with no describe has the bare name for both", () => {
    expect(displayName({ name: "loose", classname: "" })).toBe("loose");
  });
});

describe("parseWaivers", () => {
  test("reads the pattern and the reason", () => {
    const { waivers, problems } = parseWaivers(
      `// red-on-parent-waive: "gr keeps a positive number" — behaviour the refactor kept`,
      PROBE_TS,
    );
    expect(problems).toEqual([]);
    expect(waivers).toEqual([
      { pattern: "gr keeps a positive number", reason: "behaviour the refactor kept", line: 1 },
    ]);
  });

  test("accepts single quotes and an ASCII dash", () => {
    const { waivers, problems } = parseWaivers(`// red-on-parent-waive: 'x y' - why`, PROBE_TS);
    expect(problems).toEqual([]);
    expect(waivers[0]?.pattern).toBe("x y");
    expect(waivers[0]?.reason).toBe("why");
  });

  test("a missing reason is a problem, not a waiver", () => {
    const { waivers, problems } = parseWaivers(`// red-on-parent-waive: "x"`, PROBE_TS);
    expect(waivers).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no reason");
  });

  test("a marker with no quoted name is a problem", () => {
    const { problems } = parseWaivers(`// red-on-parent-waive: because I said so`, PROBE_TS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("must read");
  });

  test("an invalid regex is a problem", () => {
    const { problems } = parseWaivers(`// red-on-parent-waive: "(" — broken pattern`, PROBE_TS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not a valid regex");
  });

  test("marks each waiver with its own line", () => {
    const { waivers } = parseWaivers(
      `// a comment\n// red-on-parent-waive: "one" — first\n\n// red-on-parent-waive: "two" — second`,
      PROBE_TS,
    );
    expect(waivers.map((waiver) => waiver.line)).toEqual([2, 4]);
  });

  test("reads a CRLF file, which is what a Windows checkout gives", () => {
    const { waivers, problems } = parseWaivers(
      `// a comment\r\n// red-on-parent-waive: "one" — first\r\n`,
      PROBE_TS,
    );
    expect(problems).toEqual([]);
    expect(waivers).toEqual([{ pattern: "one", reason: "first", line: 2 }]);
  });
});

describe("isGatedTestPath", () => {
  test("gates new unit tests under apps and packages", () => {
    expect(isGatedTestPath("packages/core/src/x.test.ts")).toBe(true);
    expect(isGatedTestPath("apps/web/src/x.test.tsx")).toBe(true);
  });

  test("never gates specs, e2e files, or anything outside apps, packages and scripts", () => {
    expect(isGatedTestPath("tests/e2e/sale.spec.ts")).toBe(false);
    expect(isGatedTestPath("apps/web/tests/e2e/sale.test.ts")).toBe(false);
    expect(isGatedTestPath("packages/core/src/e2e/x.test.ts")).toBe(false);
    expect(isGatedTestPath("tests/outside.test.ts")).toBe(false);
    expect(isGatedTestPath("packages/core/src/helper.ts")).toBe(false);
    // `scripts/` is in scope since round 24: its tests are tests, and the gate
    // judged none of the 26 this repo added under it.
    expect(isGatedTestPath("scripts/red-on-parent.test.ts")).toBe(true);
  });
});

describe("classifyFileRun", () => {
  const noWaiver: Waiver[] = [];
  const waiver: Waiver = { pattern: "gr keeps a positive number", reason: "pre-existing", line: 7 };

  const junitFor = (body: string, attrs = "") =>
    `<testsuites><testsuite name="f.test.ts"><testsuite name="gr"><testcase name="keeps a positive number" classname="gr"${attrs}>${body}</testcase></testsuite></testsuite></testsuites>`;

  const run = (junit: string | null, stdout = ""): FileRun => ({
    file: "packages/core/src/x.test.ts",
    junit,
    stdout,
    error: "",
  });

  test("passed on the parent is GREEN ON PARENT and needs a waiver", () => {
    const { verdicts } = classifyFileRun(run(junitFor("")), noWaiver);
    expect(verdicts[0]?.name).toBe("GREEN_ON_PARENT");
    expect(verdicts[0]?.waiver).toBeNull();
  });

  test("passed on the parent with a waiver passes", () => {
    const { verdicts } = classifyFileRun(run(junitFor("")), [waiver]);
    expect(verdicts[0]?.name).toBe("GREEN_ON_PARENT");
    expect(verdicts[0]?.waiver).toEqual(waiver);
    expect(verdicts.every(verdictPasses)).toBe(true);
  });

  test("an AssertionError is RIGHT REASON RED", () => {
    const { verdicts } = classifyFileRun(
      run(junitFor(`<failure type="AssertionError" message="x">AssertionError: x</failure>`)),
      noWaiver,
    );
    expect(verdicts[0]?.name).toBe("RIGHT_REASON_RED");
    expect(verdicts.every(verdictPasses)).toBe(true);
  });

  test("a non-assertion throw is WRONG REASON RED", () => {
    const { verdicts } = classifyFileRun(
      run(junitFor(`<failure type="Error" message="boom">Error: boom</failure>`)),
      noWaiver,
    );
    expect(verdicts[0]?.name).toBe("WRONG_REASON_RED");
    expect(verdicts.every(verdictPasses)).toBe(false);
  });

  test("a hook throw is WRONG REASON RED on its junit type, not on a counter", () => {
    // Measured on bun 1.4.3: a `beforeEach` throw reports assertions="0" and
    // type="Error". The type decides it; no counter is consulted.
    const { verdicts } = classifyFileRun(
      run(junitFor(`<failure type="Error" message="hook boom" />`, ` assertions="0"`)),
      noWaiver,
    );
    expect(verdicts[0]?.name).toBe("WRONG_REASON_RED");
    expect(verdicts[0]?.detail).toContain("Error");
    expect(verdicts.every(verdictPasses)).toBe(false);
  });

  test("a node:assert red is RIGHT REASON RED, not a counter casualty", () => {
    // Measured on bun 1.4.3: `assert.equal(1, 2)` reports
    // `<failure type="AssertionError" message="1 == 2">` with assertions="0",
    // because node:assert is not an `expect` matcher. A rule that also required
    // assertions !== 0 called a genuine assertion red WRONG REASON RED, so the
    // author had to waive a red the gate exists to accept.
    const { verdicts } = classifyFileRun(
      run(
        junitFor(
          `<failure type="AssertionError" message="1 == 2">AssertionError</failure>`,
          ` assertions="0"`,
        ),
      ),
      noWaiver,
    );
    expect(verdicts[0]?.name).toBe("RIGHT_REASON_RED");
    expect(verdicts.every(verdictPasses)).toBe(true);
  });

  test("a waived AssertionError is WAIVER MISFILED", () => {
    const { verdicts } = classifyFileRun(
      run(junitFor(`<failure type="AssertionError" message="x">AssertionError: x</failure>`)),
      [{ pattern: "keeps a positive number", reason: "thought it was green", line: 9 }],
    );
    expect(verdicts[0]?.name).toBe("WAIVER_MISFILED");
    expect(verdicts.every(verdictPasses)).toBe(false);
  });

  test("a missing junit report is a whole-file WRONG REASON RED", () => {
    const { verdicts } = classifyFileRun(
      run(null, "# Unhandled error between tests\nSyntaxError: Export named 'x' not found"),
      noWaiver,
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.test).toBe("(whole file)");
    expect(verdicts[0]?.name).toBe("WRONG_REASON_RED");
    expect(verdicts[0]?.detail).toContain("could not load");
  });

  test("a waived missing junit report passes (the rename case)", () => {
    // A whole-file waiver cannot be judged against the parent, which produced
    // nothing. The names the change registers are the only list it has.
    const { verdicts, usedWaiverLines } = classifyFileRun(run(null, "SyntaxError: x"), [waiver], [
      { name: "keeps a positive number", classname: "gr", status: "passed", failureType: null, assertions: null },
    ]);
    expect(verdicts[0]?.name).toBe("WRONG_REASON_RED");
    expect(verdicts[0]?.waiver).toEqual(waiver);
    expect(verdicts.every(verdictPasses)).toBe(true);
    expect([...usedWaiverLines]).toEqual([7]);
  });

  test("a waiver naming no test the change registers explains nothing", () => {
    // Before this, `waivers[0]` was attached whatever it named and every waiver
    // was marked used, so this exact input printed PASS with nothing judged.
    const { verdicts, usedWaiverLines } = classifyFileRun(run(null, "SyntaxError: x"), [waiver], [
      { name: "some other test", classname: "", status: "passed", failureType: null, assertions: null },
    ]);
    expect(verdicts[0]?.waiver).toBeNull();
    expect(verdicts[0]?.detail).toContain("no waiver names it");
    expect(verdicts.every(verdictPasses)).toBe(false);
    expect([...usedWaiverLines]).toEqual([]);
  });

  test("a waiver excuses only the test it names", () => {
    // A file that cannot load on the parent has no parent-side test list, so
    // the change-side names are all the gate has. One waiver naming one of
    // them used to excuse the whole file, and the other test was never judged.
    const { verdicts, usedWaiverLines } = classifyFileRun(run(null, "SyntaxError: x"), [waiver], [
      { name: "keeps a positive number", classname: "gr", status: "passed", failureType: null, assertions: null },
      { name: "already worked", classname: "other", status: "passed", failureType: null, assertions: null },
    ]);
    expect(verdicts.map((verdict) => verdict.test)).toEqual([
      "gr keeps a positive number",
      "other already worked",
    ]);
    expect(verdicts[0]?.waiver).toEqual(waiver);
    expect(verdicts[1]?.waiver).toBeNull();
    expect(verdicts.every(verdictPasses)).toBe(false);
    expect([...usedWaiverLines]).toEqual([7]);
  });

  test("a skipped test pins nothing", () => {
    const { verdicts } = classifyFileRun(run(junitFor("<skipped />")), noWaiver);
    expect(verdicts[0]?.name).toBe("GREEN_ON_PARENT");
    expect(verdicts[0]?.detail).toContain("skipped");
  });

  test("a junit report with no testcase is a failure", () => {
    const { verdicts } = classifyFileRun(run("<testsuites></testsuites>"), noWaiver);
    expect(verdicts[0]?.name).toBe("WRONG_REASON_RED");
    expect(verdicts[0]?.detail).toContain("no testcase");
  });

  test("a run that did not finish is RUN INCOMPLETE, and no waiver covers it", () => {
    const { verdicts } = classifyFileRun(
      { ...run(null, ""), error: "bun test did not complete (hit the 120000ms timeout)" },
      [waiver],
    );
    expect(verdicts[0]?.name).toBe("RUN_INCOMPLETE");
    expect(verdicts[0]?.waiver).toBeNull();
    expect(verdicts.every(verdictPasses)).toBe(false);
  });
});

describe("unregisteredVerdicts", () => {
  const parent = parseJunit(
    `<testsuites><testsuite><testcase name="rejects zero" classname="guard" /></testsuite></testsuites>`,
  );
  const change = parseJunit(
    `<testsuites><testsuite><testcase name="rejects zero" classname="guard" /><testcase name="brandNew returns the number" classname="brand" /></testsuite></testsuites>`,
  );

  test("names the test the parent never reported", () => {
    const { verdicts } = unregisteredVerdicts("packages/core/src/x.test.ts", parent, change, []);
    expect(verdicts.map((entry) => entry.test)).toEqual(["brand brandNew returns the number"]);
    expect(verdicts[0]?.name).toBe("NOT_ON_PARENT");
    expect(verdicts.every(verdictPasses)).toBe(false);
  });

  test("a waiver on that test covers it, and is marked used", () => {
    const { verdicts, usedWaiverLines } = unregisteredVerdicts("f", parent, change, [
      { pattern: "brandNew returns the number", reason: "registered only when the export exists", line: 12 },
    ]);
    expect(verdicts.every(verdictPasses)).toBe(true);
    expect([...usedWaiverLines]).toEqual([12]);
  });

  test("a test the parent already reported is not restated", () => {
    expect(unregisteredVerdicts("f", parent, parent, []).verdicts).toEqual([]);
  });

  test("every waiver matching an unregistered test is marked used", () => {
    // Only the first was marked, so the second was then reported as matching no
    // test in the file and failed a correct, properly waived run.
    const broad: Waiver = { pattern: "brand", reason: "broad", line: 12 };
    const narrow: Waiver = { pattern: "brandNew returns the number", reason: "narrow", line: 13 };
    const { verdicts, usedWaiverLines } = unregisteredVerdicts("f", parent, change, [broad, narrow]);
    expect([...usedWaiverLines].sort()).toEqual([12, 13]);
    expect(verdicts.every(verdictPasses)).toBe(true);
    expect(unusedWaiverVerdicts("f", [broad, narrow], usedWaiverLines)).toEqual([]);
  });

  test("a name the parent reported once does not cover a second case on the change", () => {
    const one = parseJunit(
      `<testsuites><testsuite><testcase name="case 1" classname="each" /></testsuite></testsuites>`,
    );
    const two = parseJunit(
      `<testsuites><testsuite><testcase name="case 1" classname="each" /><testcase name="case 1" classname="each" /></testsuite></testsuites>`,
    );
    const { verdicts } = unregisteredVerdicts("f", one, two, []);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.name).toBe("NOT_ON_PARENT");
  });
});

describe("verdictPasses", () => {
  const verdict = (name: Verdict["name"], waiver: Waiver | null): Verdict => ({
    file: "f",
    test: "t",
    name,
    detail: "d",
    waiver,
    // `Verdict.waivers` is required and holds every pattern that matched. The
    // helper takes at most one, so the array is empty or a single element.
    waivers: waiver === null ? [] : [waiver],
  });
  const waiver: Waiver = { pattern: "t", reason: "r", line: 1 };

  test("only a right-reason red passes on its own", () => {
    expect(verdictPasses(verdict("RIGHT_REASON_RED", null))).toBe(true);
    expect(verdictPasses(verdict("WRONG_REASON_RED", null))).toBe(false);
    expect(verdictPasses(verdict("GREEN_ON_PARENT", null))).toBe(false);
    expect(verdictPasses(verdict("WAIVER_MISFILED", waiver))).toBe(false);
  });

  test("a broken or unjudged test fails even with a waiver", () => {
    // These three name a defect in the change, not a fact about the parent, so
    // a waiver has nothing to say about them: a waiver says why a test is
    // green on the parent.
    expect(verdictPasses(verdict("RED_ON_CHANGE", null))).toBe(false);
    expect(verdictPasses(verdict("RED_ON_CHANGE", waiver))).toBe(false);
    expect(verdictPasses(verdict("SKIPPED_ON_CHANGE", null))).toBe(false);
    expect(verdictPasses(verdict("SKIPPED_ON_CHANGE", waiver))).toBe(false);
    expect(verdictPasses(verdict("NOT_ON_CHANGE", null))).toBe(false);
    expect(verdictPasses(verdict("NOT_ON_CHANGE", waiver))).toBe(false);
    expect(verdictPasses(verdict("RUN_INCOMPLETE", null))).toBe(false);
    expect(verdictPasses(verdict("RUN_INCOMPLETE", waiver))).toBe(false);
  });

  test("a waiver carries a wrong-reason red and a green, and nothing else", () => {
    expect(verdictPasses(verdict("WRONG_REASON_RED", waiver))).toBe(true);
    expect(verdictPasses(verdict("GREEN_ON_PARENT", waiver))).toBe(true);
    expect(verdictPasses(verdict("RIGHT_REASON_RED", waiver))).toBe(true);
  });
});

describe("decodeXml", () => {
  test("decodes the entities a test name can carry, amp last", () => {
    expect(decodeXml("a &amp;lt; b &gt; c &quot;d&quot; &amp; &apos;")).toBe(
      'a &lt; b > c "d" & \'',
    );
  });
});

// ---------------------------------------------------------------------------
// Round 5 — the defects no earlier round named. Each one ended in a PASS that
// judged nothing, or in a message that was simply false.
// ---------------------------------------------------------------------------

describe("red-on-parent round 5", () => {
  const suiteFor = (name: string, classname: string, body: string): string =>
    `<testsuites><testsuite name="f.test.ts"><testsuite name="${classname}"><testcase name="${name}" classname="${classname}">${body}</testcase></testsuite></testsuite></testsuites>`;
  const fileRun = (junit: string | null, stdout = ""): FileRun => ({
    file: "packages/core/src/x.test.ts",
    junit,
    stdout,
    error: "",
  });
  const red = `<failure type="AssertionError" message="x">AssertionError: x</failure>`;

  test("a broad waiver does not swallow the narrower one", () => {
    // `firstWaiver` returns the first match, so "case" claimed "case returns the
    // number" and the narrower waiver was reported as matching no test at all.
    const waivers: Waiver[] = [
      { pattern: "case", reason: "broad", line: 5 },
      { pattern: "case returns the number", reason: "narrow", line: 6 },
    ];
    const { usedWaiverLines } = classifyFileRun(
      fileRun(suiteFor("returns the number", "case", red)),
      waivers,
    );
    expect([...usedWaiverLines].sort()).toEqual([5, 6]);
    expect(unusedWaiverVerdicts("packages/core/src/x.test.ts", waivers, usedWaiverLines)).toHaveLength(
      0,
    );
  });

  test("a line that mentions the marker is neither a waiver nor a problem", () => {
    // Every line containing the marker used to be parsed, fail the anchor, and
    // fail the whole run — so documenting the convention broke the gate.
    const { waivers, problems } = parseWaivers(
      [
        "// see red-on-parent-waive for the format this file uses",
        'const note = "red-on-parent-waive: \\"x\\"";',
        '// red-on-parent-waive: "a real one" — because',
        '// red-on-parent-waive "missing colon" — malformed',
      ].join("\n"),
      PROBE_TS,
    );
    expect(waivers.map((parsed) => parsed.pattern)).toEqual(["a real one"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("line 4");
    expect(problems[0]).toContain("must read");
  });

  test("a marker inside a template literal is data, not a waiver", () => {
    // A test that generates test source carries a waiver line of its own inside
    // a template literal. Read as a waiver, the file gets an outer waiver it
    // never declared, that waiver matches nothing, and `unusedWaiverVerdicts`
    // rejects the file — a real red thrown out because of a string.
    const { waivers, problems } = parseWaivers(
      [
        "const generated = `",
        '// red-on-parent-waive: "a generated test" — this line belongs to the data',
        'test("generated", () => {});',
        "`;",
        "/*",
        '// red-on-parent-waive: "commented out" — so is this one',
        "*/",
        '// red-on-parent-waive: "a real one" — because',
      ].join("\n"),
      PROBE_TS,
    );
    expect(waivers.map((parsed) => parsed.pattern)).toEqual(["a real one"]);
    expect(problems).toEqual([]);
  });

  test("the gate refuses to run under node", () => {
    // Node strips TS types and starts this file, then spawns `node test` for
    // every parent-side run, so every file reads as a whole-file load failure —
    // which a waiver could turn into a PASS.
    expect(bunOnlyRefusal({ bun: "1.4.3" })).toBeNull();
    expect(bunOnlyRefusal({})).toContain("run this with bun, not node");
  });

  test("main refuses under node before it reads an argument", () => {
    // The predicate above is only useful if main asks it. Without the wiring the
    // gate starts, spawns `node test <file>` for the parent side, reads every
    // file as a load failure, and a waiver turns that into a PASS.
    // SAFETY: `process.versions` is a plain object; the cast only names the
    // `bun` key the runtime adds to it, which the gate reads as a string.
    const versions = process.versions as { bun?: string };
    const original = versions.bun;
    Object.defineProperty(versions, "bun", { value: undefined, configurable: true, writable: true });
    try {
      expect(main(["--base", "develop"])).toBe(2);
    } finally {
      Object.defineProperty(versions, "bun", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Round 6 — the two findings the deepseek council read found by reproducing
// them, neither of which any earlier lens had named.
// ---------------------------------------------------------------------------

describe("red-on-parent round 6", () => {
  test("a sibling file the substring filter also ran is not judged as this one", () => {
    // `bun test cart.test.ts` is a substring filter over the discovered files, so
    // it also runs `cart.test.tsx`. Judging that file's testcases here fails a
    // correct change with "GREEN ON PARENT: <a test this file does not contain>".
    const xml = [
      "<testsuites>",
      '<testsuite name="packages/core/src/cart.test.tsx" file="packages/core/src/cart.test.tsx" tests="1">',
      '<testcase name="sibling component renders" classname="" />',
      "</testsuite>",
      '<testsuite name="packages/core/src/cart.test.ts" file="packages/core/src/cart.test.ts" tests="1">',
      '<testcase name="cart totals two" classname="cart"><failure type="AssertionError" message="x">AssertionError: x</failure></testcase>',
      "</testsuite>",
      "</testsuites>",
    ].join("\n");
    const judged = parseJunit(xml, "packages/core/src/cart.test.ts");
    expect(judged.map((result) => result.name)).toEqual(["cart totals two"]);
    // Unfiltered is the defect: the sibling's test is read as this file's.
    expect(parseJunit(xml)).toHaveLength(2);
    // bun writes Windows paths with backslashes and reports a path relative to
    // the cwd it ran in, so both forms have to name the same file.
    const backslash = String.fromCharCode(92);
    const windows = xml.split("packages/core/").join(`packages${backslash}core${backslash}`);
    expect(parseJunit(windows, "packages/core/src/cart.test.ts")).toHaveLength(1);
    expect(parseJunit(xml, "apps/api/packages/core/src/cart.test.ts")).toHaveLength(1);
  });

  test("--base that already contains head reports a problem, not a green run", () => {
    // `merge-base(base, head)` is `head` itself when the base contains the change,
    // so the diff is empty and the gate printed PASS having judged nothing.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        {
          path: "packages/core/src/x.test.ts",
          text: `import { expect, test } from "bun:test";
test("n is two", () => {
  expect(2).toBe(1);
});
`,
        },
      ],
    );
    try {
      const run = runGate({ repo: fixture.repo, base: "HEAD", head: "HEAD", fresh: false });
      expect(run.files).toEqual([]);
      expect(run.problems.join(" ")).toContain("there is no change to gate");
      const report = renderReport(run, run.problems);
      expect(report).toContain("PROBLEMS");
      expect(report).toContain("there is no change to gate");
      expect(report).not.toContain("red-on-parent: PASS");
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Round 7 — the P2 Greptile raised on 0eb8708.
// ---------------------------------------------------------------------------

describe("red-on-parent round 7", () => {
  test("two waivers matching one test both reach the report", () => {
    // Keeping only the first match dropped the second pattern from the report and
    // from the unused-waiver check, so a reviewer never saw its reason.
    const broad: Waiver = { pattern: "cart", reason: "broad reason", line: 5 };
    const narrow: Waiver = { pattern: "cart totals two", reason: "narrow reason", line: 6 };
    const xml =
      '<testsuites><testsuite name="packages/core/src/cart.test.ts" file="packages/core/src/cart.test.ts">' +
      '<testcase name="totals two" classname="cart">' +
      '<failure type="AssertionError" message="x">AssertionError: x</failure>' +
      "</testcase></testsuite></testsuites>";
    const synthetic: GateRun = {
      baseSha: "a1b2c3d4e5f6",
      worktree: "(none)",
      worktreeCreated: false,
      installLog: "",
      files: ["packages/core/src/cart.test.ts"],
      verdicts: [],
      stdoutByFile: new Map(),
      problems: [],
      uncommitted: [],
      skipped: [],
      hollowed: [],
      augmented: [],
    };
    const { verdicts, usedWaiverLines } = classifyFileRun(
      { file: "packages/core/src/cart.test.ts", junit: xml, stdout: "", error: "" },
      [broad, narrow],
    );
    expect(verdicts[0]?.waivers.map((waiver) => waiver.line)).toEqual([5, 6]);
    expect([...usedWaiverLines].sort()).toEqual([5, 6]);
    const report = renderReport({ ...synthetic, verdicts }, []);
    expect(report).toContain("line 5, line 6");
    expect(report).toContain("broad reason");
    expect(report).toContain("narrow reason");
  });
});

// ---------------------------------------------------------------------------
// Round 8 — the findings the debate and the test audit filed against the
// gate's fail-closed paths. Every one of them ended in a PASS that judged
// nothing, or in a report that said something the code could not back.
// ---------------------------------------------------------------------------

describe("red-on-parent round 8", () => {
  test("a test that is red on the change as well fails the gate", () => {
    // The change leaves the helper broken and adds a test that is red on the
    // parent AND on the change. The gate read only the parent's status, so it
    // certified the test as RIGHT-REASON RED — a broken test, pinning nothing.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_BEFORE },
        {
          path: "packages/core/src/red.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("guard", () => {
  test("rejects zero", () => {
    expect(() => guard(0)).toThrow("ZERO");
  });
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RED-ON-CHANGE");
      expect(stdout).toContain("fails on the change as well");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a hung test run is RUN INCOMPLETE, and no waiver covers it", () => {
    // The timeout has to be injectable, or this fixture would wait two minutes
    // to prove the same thing. A run that did not finish is not a load error
    // and no waiver excuses it: a waiver says why a test is green on the
    // parent, and a timeout says nothing at all.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/hang.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("hangs", async () => {
  expect(guard(1)).toBe(1);
  await new Promise(() => {});
});
// red-on-parent-waive: "hangs" — a waiver cannot excuse a run that never finished
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(
        fixture,
        { RED_ON_PARENT_TEST_TIMEOUT_MS: "1500" },
        [],
        20_000,
      );
      expect(stdout).toContain("RUN-INCOMPLETE");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("the test timeout is read from the environment", () => {
    const original = process.env.RED_ON_PARENT_TEST_TIMEOUT_MS;
    try {
      process.env.RED_ON_PARENT_TEST_TIMEOUT_MS = "1500";
      expect(gateModule.testTimeoutMs()).toBe(1500);
      process.env.RED_ON_PARENT_TEST_TIMEOUT_MS = "not a number";
      expect(gateModule.testTimeoutMs()).toBe(120_000);
    } finally {
      if (original === undefined) delete process.env.RED_ON_PARENT_TEST_TIMEOUT_MS;
      else process.env.RED_ON_PARENT_TEST_TIMEOUT_MS = original;
    }
  });

  test("a waiver that matches no test fails the gate", () => {
    // The stray waiver excuses nothing, so the run has to fail: the file is
    // red on the parent, and the waiver is a claim about a test that is not
    // there. The unit case below pins the branch; this one pins the wiring.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/stale.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("stale", () => {
  test("rejects zero", () => {
    expect(() => guard(0)).toThrow("ZERO");
  });
});
// red-on-parent-waive: "no such test" — stale: the test was renamed
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("WAIVER-MISFILED");
      expect(stdout).toContain("matches no test");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a waiver that matched nothing is WAIVER MISFILED", () => {
    const waiver: Waiver = { pattern: "no such test", reason: "stale", line: 9 };
    const verdicts = unusedWaiverVerdicts("packages/core/src/x.test.ts", [waiver], new Set());
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.name).toBe("WAIVER_MISFILED");
    expect(verdicts[0]?.detail).toContain("matches no test");
    expect(verdicts.every(verdictPasses)).toBe(false);
  });

  test("a waiver that names one test does not excuse a file the parent cannot load", () => {
    // A file that cannot load on the parent has no parent-side test list. The gate
    // reports that as one CANNOT HOLLOW row for the file, so the waiver an author
    // needs is one that names the file; a pattern naming a single test is misfiled
    // and the run still fails. The per-test rows are still what `classifyFileRun`
    // produces for a load failure it does own (see the unit test of that name).
    //
    // Round 25: the file is stopped by an export whose declaration an appended
    // stand-in cannot carry, so the refusal is still the gate's and the waiver is
    // still judged against `(whole file)`.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        {
          path: "packages/core/src/helper.ts",
          text: `${HELPER_AFTER}
export enum Mode {\n  One,\n}\n`,
        },
        {
          path: "packages/core/src/mixed.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { Mode } from "./helper";
describe("mixed", () => {
  test("pins the new behaviour", () => {
    expect(Mode.One).toBe(0);
  });
});
describe("other", () => {
  test("already worked", () => {
    expect(1).toBe(1);
  });
});
// red-on-parent-waive: "mixed pins the new behaviour" — the author thought this named the cause
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("CANNOT-HOLLOW");
      expect(stdout).toContain("WAIVER-MISFILED");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a test file outside the gate's scope is named, not silently ignored", () => {
    // The report has to say which files it did not gate: "no added test files"
    // reads as "this change adds no tests", which is a different claim. Round 24
    // put `scripts/` in scope, so the example moved to `tests/`, which no gate
    // reads.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "tests/outside.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("outside", () => {\n  expect(1).toBe(1);\n});\n`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("tests/outside.test.ts");
      expect(stdout).toContain("skipped test files");
      // The list is only an inventory of test-like *names*; a test file named
      // any other way is invisible, so the reporting site says which naming
      // conventions it covers rather than implying it saw every test file.
      expect(stdout).toContain("only *.test.* and *.spec.* names are recognised");
      expect(stdout).toContain("added test files: 0");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("the manifest names a copied file as soon as it is copied", () => {
    // The manifest is written on every copy, not after the loop: a run that
    // dies half way has to leave the copied file named, or the next run
    // inherits it — and `bun test <path>` is a substring filter over the
    // discovered files, so an orphan is picked up by a later run.
    const dir = mkdtempSync(join(tmpdir(), "ronp-manifest-"));
    const worktree = join(dir, "wt");
    const manifest = join(dir, "base.copied.json");
    mkdirSync(worktree, { recursive: true });
    const copied: string[] = [];
    try {
      gateModule.copyIntoBaseWorktree(
        manifest,
        worktree,
        "packages/core/src/x.test.ts",
        "content",
        copied,
      );
      expect(gateModule.readManifest(manifest)).toEqual(["packages/core/src/x.test.ts"]);
      expect(existsSync(join(worktree, "packages/core/src/x.test.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a manifest path that escapes the worktree names nothing", () => {
    const worktree = join(tmpdir(), "wt");
    expect(gateModule.manifestTarget(worktree, "packages/core/src/x.test.ts")).toBe(
      join(resolve(worktree), "packages/core/src/x.test.ts"),
    );
    expect(gateModule.manifestTarget(worktree, "../victim.txt")).toBeNull();
    expect(gateModule.manifestTarget(worktree, "packages/../../victim.txt")).toBeNull();
    expect(gateModule.manifestTarget(worktree, "")).toBeNull();
  });

  test("a manifest path that escapes the worktree deletes nothing", () => {
    // The manifest lives in a shared temp directory, so an entry in it is not
    // a path the gate may delete: `join` normalises `..`, and the file it
    // names would be outside the worktree.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/red.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      runGateFixture(fixture);
      const victim = join(fixture.cache, "victim.txt");
      writeFileSync(victim, "keep me");
      writeFileSync(
        join(fixture.cache, `${fixture.base}.copied.json`),
        JSON.stringify(["../victim.txt"]),
      );
      runGateFixture(fixture);
      expect(existsSync(victim)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Round 3 — the facts corrected to the bun CI actually installs, and the
// report saying which bun it ran under.
// ---------------------------------------------------------------------------

describe("red-on-parent round 3", () => {
  test("a node:assert red on the parent passes the gate", () => {
    // Measured on bun 1.4.3: `assert.throws` reports type="AssertionError" with
    // assertions="0", because node:assert is not an `expect` matcher. Requiring
    // assertions !== 0 as well called this WRONG REASON RED, so an honest test
    // written with node:assert had to waive its own red.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/asserted.test.ts",
          text: `import { test } from "bun:test";
import assert from "node:assert";
import { guard } from "./helper";
test("rejects zero", () => {
  assert.throws(() => guard(0), /ZERO/);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("WRONG-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("the report says which bun it ran under", () => {
    // Two lanes on different bun minors emit different junit shapes with no
    // record of which — the ambiguity that produced the 1.3.14 claim this
    // round corrects.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/red.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain(`bun ${process.versions.bun ?? "unknown"}`);
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Round 9 — the CLI, the change-side fail-closed paths, the lock's reclamation
// binding, the per-file promise, the file-level waiver and the exit-code
// contract. Every one is a path the earlier fixtures could not reach.
// ---------------------------------------------------------------------------

describe("red-on-parent round 9 — parseArgs", () => {
  test("reads the documented flags", () => {
    expect(gateModule.parseArgs([])).toEqual({
      base: null,
      head: "HEAD",
      fresh: false,
      help: false,
    });
    expect(
      gateModule.parseArgs(["--base", "origin/develop", "--head", "abc", "--fresh"]),
    ).toEqual({ base: "origin/develop", head: "abc", fresh: true, help: false });
    expect(gateModule.parseArgs(["--base=origin/develop", "--head=abc"])).toEqual({
      base: "origin/develop",
      head: "abc",
      fresh: false,
      help: false,
    });
    expect(gateModule.parseArgs(["--help"]).help).toBe(true);
    expect(gateModule.parseArgs(["-h"]).help).toBe(true);
  });

  test("refuses a flag with no value instead of falling back to origin/develop", () => {
    // `--base` with no value used to leave base === null, which `resolveBase`
    // reads as "use origin/develop": the gate judged a different parent than the
    // caller named and could PASS on a diff nobody asked about.
    expect(() => gateModule.parseArgs(["--base"])).toThrow("--base needs a value");
    expect(() => gateModule.parseArgs(["--base", "--head", "abc"])).toThrow(
      "--base needs a value",
    );
    expect(() => gateModule.parseArgs(["--base="])).toThrow("--base needs a value");
    expect(() => gateModule.parseArgs(["--head"])).toThrow("--head needs a value");
    expect(() => gateModule.parseArgs(["--head="])).toThrow("--head needs a value");
    expect(() => gateModule.parseArgs(["--wat"])).toThrow("unknown argument");
  });

  test("main exits 2 on a valueless --base", () => {
    // The unit above pins parseArgs; this pins the exit code a shell sees.
    expect(main(["--base"])).toBe(2);
  });
});

describe("red-on-parent round 9 — the change-side fail-closed paths", () => {
  test("an added file edited in the working tree is reported, not judged", () => {
    // The change side runs in the checkout, so an edited added file means the
    // gate cannot tell which tests the change registers. It must say so rather
    // than enumerate a version HEAD does not hold.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/dirty.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("x", () => {\n  expect(1).toBe(1);\n});\n`,
        },
      ],
    );
    try {
      writeFileSync(
        join(fixture.repo, "packages/core/src/dirty.test.ts"),
        `import { expect, test } from "bun:test";\ntest("x", () => {\n  expect(2).toBe(2);\n});\n`,
      );
      const problems: string[] = [];
      const out = join(mkdtempSync(join(tmpdir(), "ronp-junit-")), "out.xml");
      changeSideResults(fixture.repo, "packages/core/src/dirty.test.ts", out, problems);
      expect(problems.join(" ")).toContain("has uncommitted changes");
    } finally {
      fixture.cleanup();
    }
  });

  test("a change-side run that wrote no junit report is reported", () => {
    // bun writes the report only when the file loaded and ran; a filter that
    // matches no file leaves none, so the change side must fail closed instead
    // of reading an empty test list as "the change registers nothing".
    const fixture = createFixture([PKG, HELPER], [
      { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
    ]);
    try {
      const problems: string[] = [];
      const out = join(mkdtempSync(join(tmpdir(), "ronp-junit-")), "out.xml");
      changeSideResults(fixture.repo, "packages/core/src/not-there.test.ts", out, problems);
      expect(problems.join(" ")).toContain("wrote no junit report");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("red-on-parent round 9 — the per-file promise", () => {
  test("the gate judges every added gated file, not only the first", () => {
    // Every other fixture adds exactly one gated file, so a gate that judged
    // only the first scored 76 pass / 0 fail. Here the first file is a clean
    // right-reason red and the second is green on the parent with no waiver: a
    // gate that stops after file one prints PASS over a test that pins nothing.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/first.test.ts",
          text: `import { expect, test } from "bun:test";\nimport { guard } from "./helper";\ntest("rejects zero", () => {\n  expect(() => guard(0)).toThrow("ZERO");\n});\n`,
        },
        {
          path: "packages/core/src/second.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("pins nothing", () => {\n  expect(1).toBe(1);\n});\n`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("second.test.ts");
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(stdout).toContain("added test files: 2");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 90_000);
});

describe("red-on-parent round 9 — the file-level waiver", () => {
  test("a waiver that matches every test in the file is a file-level skip", () => {
    // `.*` matches all three tests, so one line drops the whole file out of the
    // "must be red" check — the broad file-level skip the design forbids. The
    // fixture is green on the parent everywhere, so without the refusal it PASSES.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        {
          path: "packages/core/src/char.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("char a", () => {\n  expect(1).toBe(1);\n});\ntest("char b", () => {\n  expect(2).toBe(2);\n});\ntest("char c", () => {\n  expect(3).toBe(3);\n});\n// red-on-parent-waive: ".*" — pre-existing\n`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("file-level skip");
      expect(stdout).toContain("red-on-parent: FAIL");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a waiver may still cover several tests when it does not cover the file", () => {
    // The design allows one line to name more than one test. Refusing every
    // pattern that matches >1 test would punish this, so the refusal is only the
    // every-test shape.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        {
          path: "packages/core/src/partial.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("keeps a", () => {\n  expect(1).toBe(1);\n});\ntest("keeps b", () => {\n  expect(2).toBe(2);\n});\ntest("pins something", () => {\n  expect(3).toBe(3);\n});\n// red-on-parent-waive: "keeps " — behaviour that already worked\n`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).not.toContain("file-level skip");
      // The third test pins nothing and no waiver names it, so the run fails for
      // that reason — not because the shared line covered two tests.
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 9 — the exit-code contract", () => {
  test("a filesystem crash exits 2, not the 1 a gate verdict uses", () => {
    // main used to rethrow anything that was not a GateError, and bun exits 1 on
    // an uncaught throw — the same code as a legitimate gate failure. The
    // contract is 2 for "could not run", so a caller that retries on 1 and gives
    // up on 2 is no longer misled. A cache path that is a file makes mkdirSync
    // throw a plain EEXIST before any verdict is computed.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/x.test.ts",
          text: `import { expect, test } from "bun:test";\nimport { guard } from "./helper";\ntest("rejects zero", () => {\n  expect(() => guard(0)).toThrow("ZERO");\n});\n`,
        },
      ],
    );
    try {
      const cacheFile = join(fixture.repo, "not-a-dir");
      writeFileSync(cacheFile, "x");
      const { status, stdout } = runGateFixture(fixture, {
        RED_ON_PARENT_CACHE: cacheFile,
      });
      expect(stdout).toContain("cannot run");
      expect(status).toBe(2);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 9 — a waiver cannot hide a change-side failure", () => {
  test("a waived NOT ON PARENT does not suppress RED ON CHANGE", () => {
    // The change registers `brand new works` only when the helper has the new
    // export, so the parent never reported it — a waiver legitimately excuses
    // that. The same test fails on the change, though, and a waiver says why the
    // parent could not run it, not that it works. Skipping every NOT ON PARENT
    // test unconditionally printed PASS over a broken test; only an *unexcused*
    // NOT ON PARENT row may make the RED ON CHANGE row redundant.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/conditional.test.ts",
          text: `import { expect, test } from "bun:test";
import * as mod from "./helper";
import { guard } from "./helper";
test("always rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
if ("brandNew" in mod) {
  test("brand new works", () => {
    expect(1).toBe(2);
  });
}
// red-on-parent-waive: "brand new works" — the parent cannot register it
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("NOT-ON-PARENT");
      expect(stdout).toContain("RED-ON-CHANGE");
      expect(stdout).toContain("red-on-parent: FAIL");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 10 — the findings at 5ab9a2c4", () => {
  test("a shared waiver over the parent's tests is not a file-level skip", () => {
    // The change registers `brand new` only when the helper has the new export,
    // so the parent's report holds the two `keeps` tests and not the third. A
    // `keeps ` line is therefore not a file-level skip on the change, and the
    // third test carries its own waiver. Judging the file-level rule against the
    // parent's list called the shared line a whole-file excuse and failed a
    // correct change.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/conditional.test.ts",
          text: `import { expect, test } from "bun:test";
import * as mod from "./helper";
test("keeps a", () => {
  expect(1).toBe(1);
});
test("keeps b", () => {
  expect(2).toBe(2);
});
if ("brandNew" in mod) {
  test("brand new", () => {
    expect(mod.brandNew(1)).toBe(1);
  });
}
// red-on-parent-waive: "keeps " — behaviour that already worked
// red-on-parent-waive: "brand new" — the parent cannot register it
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).not.toContain("file-level skip");
      expect(stdout).toContain("NOT-ON-PARENT");
      expect(stdout).toContain("red-on-parent: PASS");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a sibling whose name extends the added file's is never run", () => {
    // `bun test cart.test.ts` is a substring filter, so it also runs
    // `cart.test.tsx`. That sibling blocks forever here: what is being pinned is
    // that the added file is selected by importing it, not by a filter that
    // cannot tell the two apart.
    const fixture = createFixture(
      [PKG, HELPER, { path: "packages/core/src/cart.test.tsx", text: "for (;;) {}\n" }],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/cart.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero with ZERO", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture, {
        RED_ON_PARENT_TEST_TIMEOUT_MS: "2000",
      });
      expect(stdout).not.toContain("RUN-INCOMPLETE");
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a reused worktree is restored, not judged as the last run left it", () => {
    const fixture = createFixture(
      [
        PKG,
        HELPER,
        { path: ".gitignore", text: "ignored.txt\n" },
        { path: "packages/core/src/data.json", text: `{"v":1}\n` },
        { path: "packages/core/src/other.json", text: `{"kept":true}\n` },
      ],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/cart.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero with ZERO", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    const worktree = join(fixture.cache, `wt-${fixture.base}`);
    const cached = join(worktree, "packages/core/src/data.json");
    const other = join(worktree, "packages/core/src/other.json");
    const leftover = join(worktree, "leftover.txt");
    const ignored = join(worktree, "ignored.txt");
    try {
      expect(runGateFixture(fixture).status).toBe(0);
      // What a test that ran in the cached worktree can leave behind: a tracked
      // file changed and staged, another deleted, an untracked one, and an
      // ignored one. The next run must judge the commit, not any of them.
      // Staged matters: a checkout from the index would restore the change it
      // was meant to discard. Deleted matters: only the reset brings a deleted
      // file back — the clean cannot. Ignored must survive: the dependency
      // tree in the worktree is ignored, and a clean that removed it would
      // reinstall on every run.
      writeFileSync(cached, `{"v":2}\n`);
      execFileSync("git", ["add", "packages/core/src/data.json"], { cwd: worktree });
      rmSync(other);
      writeFileSync(leftover, "leftover\n");
      writeFileSync(ignored, "ignored\n");
      expect(runGateFixture(fixture).status).toBe(0);
      // The order of the assertions is the order of the claims, so each
      // ablation dies on the claim it names and not on an earlier one.
      expect(readFileSync(other, "utf8")).toContain(`"kept"`);
      expect(readFileSync(cached, "utf8")).not.toContain(`"v":2`);
      expect(existsSync(leftover)).toBe(false);
      expect(existsSync(ignored)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  test("a fixture commits with signing configured globally", () => {
    // `commitAll` names the identity but used to leave `commit.gpgsign` to the
    // machine's config, so a contributor with signing on could not run this
    // suite at all. The bogus program makes the failure deterministic instead of
    // depending on whether a key is present.
    const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    process.env.GIT_CONFIG_KEY_1 = "gpg.program";
    process.env.GIT_CONFIG_VALUE_1 = "no-such-gpg-for-this-test";
    try {
      const fixture = createFixture([PKG], []);
      try {
        // The commit is the thing under test: a fixture whose commits silently
        // never landed would make this test green for no reason at all.
        const tree = execFileSync("git", ["ls-tree", "--name-only", "-r", "HEAD"], {
          cwd: fixture.repo,
          encoding: "utf8",
        });
        expect(tree).toContain("package.json");
      } finally {
        fixture.cleanup();
      }
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);
});

describe("red-on-parent round 11 — the findings at 45f42fd7", () => {
  test("a file that imports another test file is named, not judged", () => {
    // Bun names every testcase of a run after the entry file, so a file that
    // imports another test file brings that file's cases into its own report.
    // The gate cannot tell whose test failed, so it says so: the file is named
    // and no verdict is built on a report that mixes two files.
    const fixture = createFixture(
      [
        PKG,
        { path: "packages/core/src/mock.ts", text: "export type Mock = unknown;\n" },
        {
          path: "packages/core/src/helper.test.ts",
          text: `import { expect, test } from "bun:test";
test("the helper's own case", () => {
  expect(1).toBe(1);
});
`,
        },
      ],
      [
        {
          path: "packages/core/src/cart.test.ts",
          text: `import { expect, test } from "bun:test";
import type { Mock } from "./mock.ts";
import "./helper.test.ts";
test("rejects zero with ZERO", () => {
  expect(0).toBe(1);
});
`,
        },
      ],
    );
    try {
      const out = runGateFixture(fixture);
      expect(out.status).toBe(1);
      // The file and the import are named: a message that says only "something
      // is wrong" leaves the contributor guessing.
      expect(out.stdout).toContain("packages/core/src/cart.test.ts");
      expect(out.stdout).toContain("./helper.test.ts");
      expect(out.stdout).toContain("imports another test file");
      // The imported file's case must not be judged against the importing
      // file: that would ask for a waiver for a test the file does not hold.
      // And the importing file's own case must not be judged either — the file
      // was refused, not judged.
      expect(out.stdout).not.toContain("the helper's own case");
      expect(out.stdout).not.toContain("rejects zero with ZERO");
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  test("the import that names another test file is found in the source", () => {
    // The report cannot say whose case it holds, so the source is asked.
    expect(importedTestFiles(`import "./helper.test.ts";\n`, PROBE_TS)).toEqual(["./helper.test.ts"]);
    expect(importedTestFiles(`import { x } from "../shared/other.test";\n`, PROBE_TS)).toEqual([
      "../shared/other.test",
    ]);
    expect(importedTestFiles(`const m = await import("./late.test.ts");\n`, PROBE_TS)).toEqual([
      "./late.test.ts",
    ]);
    expect(importedTestFiles(`const h = require("./req.test.ts");\n`, PROBE_TS)).toEqual(["./req.test.ts"]);
    // A qualified require reaches the same loader in Bun, so it hides the same
    // second test file. The bare-identifier test that replaced the text scan let
    // it through and the gate judged a mixed report as this file's.
    expect(importedTestFiles(`const q = module.require("./qualified.test.ts");\n`, PROBE_TS)).toEqual([
      "./qualified.test.ts",
    ]);
    expect(importedTestFiles(`export * from "./reexport.test.ts";\n`, PROBE_TS)).toEqual([
      "./reexport.test.ts",
    ]);
    // A type-only import is erased before the file runs: it imports nothing.
    // Measured on bun 1.4.2: `import { type X } from` is erased as well.
    expect(importedTestFiles(`import type { Case } from "./cases.test.ts";\n`, PROBE_TS)).toEqual([]);
    expect(importedTestFiles(`import { type Case } from "./cases.test.ts";\n`, PROBE_TS)).toEqual([]);
    expect(importedTestFiles(`export type { Case } from "./cases.test.ts";\n`, PROBE_TS)).toEqual([]);
    expect(
      importedTestFiles(
        `import type { Aaaaaaaaaa, Bbbbbbbbbb, Cccccccccc, Dddddddddd, Eeeeeeeeee, Ffffffffff, Gggggggggg, Hhhhhhhhhh, Iiiiiiiiii } from "./cases.test.ts";\n`,
        PROBE_TS,
      ),
    ).toEqual([]);
    // One runtime name in the clause is enough to make the statement import
    // something, so the file is named.
    expect(importedTestFiles(`import { type A, B } from "./cases.test.ts";\n`, PROBE_TS)).toEqual([
      "./cases.test.ts",
    ]);
    // A commented-out import is not an import, and a comment must not silence
    // a real one.
    expect(importedTestFiles(`// import type { Q } from "./old.test.ts";\n`, PROBE_TS)).toEqual([]);
    expect(
      importedTestFiles(`// import type { Q } from "./old.test.ts";\nimport "./real.test.ts";\n`, PROBE_TS),
    ).toEqual(["./real.test.ts"]);
    // A helper that is not a test file, and a package that is not local.
    expect(importedTestFiles(`import { guard } from "./helper";\n`, PROBE_TS)).toEqual([]);
    expect(importedTestFiles(`import { expect } from "bun:test";\n`, PROBE_TS)).toEqual([]);
    expect(importedTestFiles(`import "./fixtures.test.json";\n`, PROBE_TS)).toEqual([]);
    expect(importedTestFiles(`import "./helper.test-data.ts";\n`, PROBE_TS)).toEqual([]);
    // Known limits, pinned so a change to the scan cannot quietly widen or
    // narrow them: a dynamic import whose specifier is a variable is not seen,
    // and neither is the import of a module that itself imports a test file.
    expect(importedTestFiles(`const m = await import(name);\n`, PROBE_TS)).toEqual([]);
  });
});

describe("red-on-parent round 12 — the findings at 8a618ed9", () => {
  test("a reclaim whose removal is refused is waited out, not spun on", async () => {
    // The reclaim removes the stale lock, and that removal can be refused. Then
    // the lock stays exactly where it was. The waiter saw the same stale lock
    // again, reclaimed it again, and took a `continue` that skipped both the
    // deadline check and the sleep: the run spun at full speed, never read the
    // deadline, and never ended.
    //
    // The removal has to be refused for this test to mean anything, and *how* it
    // is refused is the platform's business. Two refusals, and the fixture asks
    // the filesystem which one it enforces instead of assuming:
    //
    //   a parent with no write bit:  POSIX refuses the unlink. Windows applies a
    //                                directory's mode bits to nothing, so there
    //                                this arm is a no-op.
    //   a directory a live process is working in:  refuses on Windows; a Linux
    //                                kernel removes a directory out from under the
    //                                process sitting in it, so there this arm is
    //                                a no-op.
    //
    // Neither is portable alone, and the cwd one used to be the whole fixture. On
    // Linux the reclaim succeeded, the gate went on to run the fixture, and this
    // test failed on a message the gate had no reason to print. CI is Linux, so
    // the arm it needed was the one arm it never built. The fixture now asks the
    // filesystem which refusal it enforces and keeps that one.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/guard.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    let holder: ReturnType<typeof spawn> | null = null;
    let parentRelaxed = false;
    try {
      const lockPath = join(fixture.cache, `wt-${fixture.base}.lock`);
      const lockPid = `999999 ${randomUUID()}\n`;
      const plantLock = (): void => {
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(join(lockPath, "pid"), lockPid);
      };
      plantLock();
      // Whether this environment lets the reclaim's removal through, asked by
      // performing it: the lock is removed and put back, so a refusal leaves it
      // exactly as the gate must find it.
      const removalAllowed = (): boolean => {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          return false;
        }
        plantLock();
        return true;
      };
      let refusedBy: string | null = null;
      // POSIX: no write bit on the parent, so no entry may be removed from it.
      // Windows applies a directory's mode bits to nothing.
      chmodSync(fixture.cache, 0o555);
      parentRelaxed = true;
      if (!removalAllowed()) {
        refusedBy = "a parent directory with no write bit";
      } else {
        chmodSync(fixture.cache, 0o755);
        parentRelaxed = false;
      }
      if (refusedBy === null) {
        // Windows: a directory a live process is sitting in cannot be removed
        // until the process leaves. The child writing its own cwd is the signal
        // that the directory is held, not the spawn returning.
        holder = spawn(
          process.execPath,
          ["-e", "process.stdout.write(process.cwd()); setTimeout(() => {}, 20000)"],
          { cwd: lockPath, stdio: ["ignore", "pipe", "ignore"] },
        );
        await new Promise<void>((held) => {
          const timer = setTimeout(held, 5_000);
          holder?.stdout?.once("data", () => {
            clearTimeout(timer);
            held();
          });
          holder?.once("exit", () => {
            clearTimeout(timer);
            held();
          });
        });
        if (!removalAllowed()) refusedBy = "a directory a live process is working in";
      }
      if (refusedBy === null) {
        // A root shell bypasses the parent's mode bit and a non-Windows kernel
        // removes a directory out from under its cwd. Either way there is no
        // case to run, and a verdict on the gate would be a verdict on the
        // wrong run.
        throw new Error(
          "the fixture could not make the reclaim's removal fail: neither a 0o555 parent nor a live process's working directory refused it",
        );
      }
      const { status, stdout } = await runGateAsync(
        fixture,
        { RED_ON_PARENT_LOCK_WAIT_MS: "1500" },
        20_000,
      );
      // The gate gives the lock its budget and then says so. A gate that spun
      // on the lock would still be running when the helper killed it.
      expect(stdout).toContain("another red-on-parent run is using");
      expect(stdout).not.toContain("did not exit within");
      // The exit code says the run could not happen, not that the change
      // failed: 2 is the "could not run" code, 1 is a verdict.
      expect(status).toBe(2);
    } finally {
      if (parentRelaxed) chmodSync(fixture.cache, 0o755);
      holder?.kill();
      fixture.cleanup();
    }
  }, 60_000);

  test("a pid file that cannot be read is not evidence of a dead holder", async () => {
    // The pid file is read with one call, and a read that fails for any reason
    // other than "the file is not there" says nothing about the holder. Read as
    // "no pid file", a lock whose pid path is unreadable looked like a lock
    // whose writer died before it wrote anything — and the reclaim took it
    // away from whichever run actually held it.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/guard.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      const lockPath = join(fixture.cache, `wt-${fixture.base}.lock`);
      mkdirSync(lockPath, { recursive: true });
      // A directory where the pid file should be: unreadable, and not ENOENT.
      mkdirSync(join(lockPath, "pid"));
      // Older than the grace, so a lock read as "unclaimed" would be reclaimed.
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockPath, stale, stale);
      const { status, stdout } = await runGateAsync(
        fixture,
        { RED_ON_PARENT_LOCK_WAIT_MS: "1500" },
        20_000,
      );
      expect(stdout).toContain("another red-on-parent run is using");
      expect(stdout).not.toContain("did not exit within");
      // The same code as the other lock case: the run could not happen.
      expect(status).toBe(2);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a test the change skips is not a right-reason red", () => {
    // `test.skipIf(feature)` runs on the parent — where the feature the change
    // adds is absent — and is skipped on the change, where it is present. The
    // parent's red then says nothing about a test the change never executes,
    // and the gate called it a right-reason red and passed.
    const fixture = createFixture(
      [PKG, { path: "packages/core/src/feature.ts", text: "export const feature = false;\n" }],
      [
        { path: "packages/core/src/feature.ts", text: "export const feature = true;\n" },
        {
          path: "packages/core/src/feature.test.ts",
          text: `import { expect, test } from "bun:test";
import { feature } from "./feature";
test.skipIf(feature)("new behaviour", () => {
  expect(1).toBe(2);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).toContain("SKIPPED-ON-CHANGE");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("an uncommitted source cannot hide a test from the change side", () => {
    // The change side runs the added file in the checkout, so it reads the
    // checkout's sources. An uncommitted edit to the source the test guards on
    // stops the file registering a test, and the change side then enumerates a
    // list no commit holds — the test the commit registers is invisible to the
    // gate and the run passes over it. A dirty tree is therefore a problem,
    // not a detail.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/conditional.test.ts",
          text: `import { expect, test } from "bun:test";
import * as mod from "./helper";
test("rejects zero", () => {
  expect(() => mod.guard(0)).toThrow("ZERO");
});
if ("brandNew" in mod) {
  test("brand new works", () => {
    expect(mod.brandNew(1)).toBe(1);
  });
}
`,
        },
      ],
    );
    try {
      // The commit registers `brand new works`; the parent cannot, so the
      // correct verdict is NOT ON PARENT and the run must fail. With the
      // source edited in the working tree the change side stops registering
      // the test, and the gate has nothing left to object to — the one test
      // that still runs is green on the change and red on the parent, so the
      // run passes over a test it never saw.
      writeFileSync(
        join(fixture.repo, "packages/core/src/helper.ts"),
        `export function guard(n: number): number {
  if (n <= 0) throw new Error("ZERO");
  return n;
}
`,
      );
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("the working tree differs from HEAD");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 13 — the debate findings at 8a618ed9", () => {
  test("the report names what the parent was missing", () => {
    // A wrong-reason red says the parent could not load the file. A reviewer
    // reading a waived row has to judge the waiver, and "the parent could not
    // load the file" does not tell them what to fix. The verdict names the
    // missing module, or the missing export, when bun said which one it was.
    expect(loadFailureReason("error: Cannot find module './helper' from 'x.test.ts'")).toContain(
      "the parent has no ./helper",
    );
    expect(
      loadFailureReason("# Unhandled error between tests\nSyntaxError: Export named 'guard' not found"),
    ).toContain("the parent has no export guard");
    // A failure that is neither keeps the old wording.
    expect(loadFailureReason("# Unhandled error between tests\nboom")).toContain(
      "the parent could not load the file",
    );
  });

  test("a file the parent cannot load says which export is missing", () => {
    // The parent's helper cannot be given the export the file imports, so the added
    // test file cannot load there and the report has to say which name was missing
    // rather than only "could not load". An added *module* no longer produces this
    // shape at all: round 24 writes a hollow stand-in for it, so the file loads and
    // the verdict is about the test. A module the parent HAS — extended by the
    // change with an export the gate cannot stand in for — is the case a hollow must
    // not touch, because faking it would erase behaviour the parent really carries;
    // round 25 appends a stand-in when it can, and refuses naming the export when it
    // cannot. It is one CANNOT HOLLOW row that names the export, so one waiver line
    // clears one cause.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: `${HELPER_AFTER}\nexport enum Mode {\n  One,\n}\n` },
        {
          path: "packages/core/src/needs-new.test.ts",
          text: `import { expect, test } from "bun:test";
import { Mode } from "./helper";
test("uses the new export", () => {
  expect(Mode.One).toBe(0);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("CANNOT-HOLLOW");
      expect(stdout).toContain("packages/core/src/helper.ts");
      expect(stdout).toContain("`Mode`");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a pass that rests on a waiver says so in the last line", () => {
    // "PASS" alone, next to a table of waived rows, reads like the gate
    // judged those tests. It did not: the waiver did. The last line is the
    // line a reviewer reads, so it carries the count.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: `${HELPER_AFTER}\nexport enum Mode {\n  One,\n}\n` },
        {
          path: "packages/core/src/needs-new.test.ts",
          text: `import { expect, test } from "bun:test";
import { Mode } from "./helper";
test("uses the new export", () => {
  expect(Mode.One).toBe(0);
});
// red-on-parent-waive: "whole file" — the parent's helper cannot be given the enum the test imports
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(status).toBe(0);
      expect(stdout).toContain("red-on-parent: PASS (1 waived)");
      expect(stdout).toContain("the parent could not run the test, so nothing was judged there");
      // The waiver is still named with its file and line.
      expect(stdout).toContain("WAIVERS (a reviewer reads these in the diff)");
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a pass with no waiver is still a plain PASS", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/red.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(status).toBe(0);
      const lastLine = stdout.trimEnd().split("\n").at(-1);
      expect(lastLine).toBe("red-on-parent: PASS");
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 14 — the test-audit findings at 8a618ed9", () => {
  test("the verdict guide names every verdict, and says what to do about it", () => {
    // The report prints the guide filtered by the verdicts it has, so a typo
    // in a name deletes that verdict's fix text from the report and nothing
    // else notices. A verdict with no guide entry is a verdict a reviewer
    // cannot act on.
    const names = new Set(VERDICT_GUIDE.map((entry) => entry.name));
    expect(names).toEqual(
      new Set<Verdict["name"]>([
        "RIGHT_REASON_RED",
        "RED_ON_CHANGE",
        "SKIPPED_ON_CHANGE",
        "NOT_ON_CHANGE",
        "WRONG_REASON_RED",
        "CANNOT_HOLLOW",
        "NOT_ON_PARENT",
        "GREEN_ON_PARENT",
        "WAIVER_MISFILED",
        "RUN_INCOMPLETE",
      ]),
    );
    for (const entry of VERDICT_GUIDE) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.fixes.length).toBeGreaterThan(0);
    }
    // The WRONG REASON RED advice has already been wrong once: it sent the author
    // to commit the missing module as the change's first commit, which lands it
    // after the merge-base, so the next run fails for the same reason. The
    // instruction a report prints is what an author follows, so it is pinned.
    const wrongReason = VERDICT_GUIDE.find((entry) => entry.name === "WRONG_REASON_RED");
    expect(wrongReason?.fixes[0]).toContain("on the base branch");
    expect(wrongReason?.fixes.join(" ")).not.toContain("first commit");
  });

  test("the change side's verdicts are decided on its own results", () => {
    // `changeSideVerdicts` decides three things the parent's waivers do not
    // reach: a test that fails on the change, a test the change skips, and the
    // pair of those with a NOT ON PARENT row. It had no unit test, so the
    // whole decision surface was reachable only through two end-to-end
    // fixtures.
    const changeResult = (name: string, status: TestStatus): TestResult => ({
      name,
      classname: "",
      status,
      failureType: status === "failed" ? "AssertionError" : null,
      assertions: null,
    });
    const parentVerdict = (name: Verdict["name"], test: string, waiver: Waiver | null): Verdict => ({
      file: "f",
      test,
      name,
      detail: "d",
      waiver,
      waivers: waiver === null ? [] : [waiver],
    });
    const waiver: Waiver = { pattern: "t", reason: "r", line: 1 };

    // A test that fails on the change is broken, and no waiver excuses it.
    expect(changeSideVerdicts("f", [], [changeResult("a", "failed")])[0]?.name).toBe("RED_ON_CHANGE");
    // A test that passes on the change says nothing on its own.
    expect(changeSideVerdicts("f", [], [changeResult("a", "passed")])).toEqual([]);
    // A test the change skips, whose parent red was a right-reason red, pins
    // nothing: the parent's red was about a test the change never runs.
    expect(
      changeSideVerdicts("f", [parentVerdict("RIGHT_REASON_RED", "a", null)], [changeResult("a", "skipped")])[0]
        ?.name,
    ).toBe("SKIPPED_ON_CHANGE");
    // The same skip where the parent never reported the test is a row too: the
    // test runs nowhere, so the file as committed pins nothing. The round-15
    // rule widened this — the earlier shape only fired for a right-reason red,
    // which left a waived load failure plus a skipped test passing.
    expect(changeSideVerdicts("f", [], [changeResult("a", "skipped")])[0]?.name).toBe("SKIPPED_ON_CHANGE");
    // A failing change test whose NOT ON PARENT row already fails the run is
    // not repeated.
    expect(
      changeSideVerdicts("f", [parentVerdict("NOT_ON_PARENT", "a", null)], [changeResult("a", "failed")]),
    ).toEqual([]);
    // A waived NOT ON PARENT row does not suppress it: the waiver explains the
    // parent, and the change's own status is a separate question.
    expect(
      changeSideVerdicts("f", [parentVerdict("NOT_ON_PARENT", "a", waiver)], [changeResult("a", "failed")])[0]
        ?.name,
    ).toBe("RED_ON_CHANGE");
  });

  test("a test the change does not register is named", () => {
    // The parent's run and the change's run read the same file; only the
    // sources differ. A test the parent's run registered and the change's did
    // not is a test the change does not execute.
    const parent = (name: string): TestResult => ({
      name,
      classname: "",
      status: "failed",
      failureType: "AssertionError",
      assertions: 1,
    });
    const change = (name: string): TestResult => ({
      name,
      classname: "",
      status: "passed",
      failureType: null,
      assertions: null,
    });
    const rows = notRegisteredOnChange("f", [parent("a"), parent("b")], [change("a")]);
    expect(rows.map((row) => row.test)).toEqual(["b"]);
    expect(rows[0]?.name).toBe("NOT_ON_CHANGE");
    // A waiver cannot excuse it: the file as committed runs fewer tests than
    // the gate judged.
    expect(verdictPasses(rows[0]!)).toBe(false);
    // The same name on both sides is not a row.
    expect(notRegisteredOnChange("f", [parent("a")], [change("a")])).toEqual([]);
  });

  test("a test the change does not register is not a right-reason red", () => {
    // The gate's worst failure is a PASS over a test it never judged. The
    // parent's run registered two tests; the change's sources took away the
    // export one of them registers on, so the change's run registered one. The
    // parent's red for the other was then about a test the change never
    // executes, and the file as committed pins less than the gate judged —
    // and the gate said RIGHT REASON RED for both.
    const fixture = createFixture(
      [PKG, { path: "packages/core/src/marker.ts", text: "export const marker = true;\n" }],
      [
        // The change removes the export one of the tests registers on, and
        // adds the one the other test needs.
        { path: "packages/core/src/marker.ts", text: "export const other = 1;\n" },
        {
          path: "packages/core/src/marker.test.ts",
          text: `import { expect, test } from "bun:test";
import * as mod from "./marker";
test("always runs", () => {
  expect(mod.other).toBe(1);
});
if ("marker" in mod) {
  test("pins the marker", () => {
    expect(mod.marker).toBe(false);
  });
}
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("NOT-ON-CHANGE");
      expect(stdout).toContain("pins the marker");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a run with nothing to gate still says what it decided", () => {
    // The report ends with a verdict line in every other shape. The shape a
    // misconfigured `--base` produces — a change that adds no test file — used
    // to end with a count and no verdict, so a reader could not tell a decided
    // run from a silent one.
    const fixture = createFixture([PKG, HELPER], [
      { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("nothing to gate");
      expect(stdout.trimEnd().split("\n").at(-1)).toBe("red-on-parent: PASS");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("an assertion that fails inside a hook reads as a right-reason red", () => {
    // The gate's own header states the hole: junit cannot tell an assertion
    // that failed in a `beforeEach` from one that failed in the body — both
    // report `AssertionError`. So when the hook is what fails on the parent,
    // the test body never ran there, and the verdict says nothing about the
    // body's assertions. This test pins the limit, so nobody reads the gate
    // as covering it: a change that closes the hole has to change this test.
    const fixture = createFixture(
      [PKG, { path: "packages/core/src/feature.ts", text: "export const feature = false;\n" }],
      [
        { path: "packages/core/src/feature.ts", text: "export const feature = true;\n" },
        {
          path: "packages/core/src/hook.test.ts",
          text: `import { beforeEach, expect, test } from "bun:test";
import { feature } from "./feature";
beforeEach(() => {
  expect(feature).toBe(true);
});
test("uses the feature", () => {
  expect(1).toBe(1);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a file added under apps/ is judged like one under packages/", () => {
    // Every fixture in this file added its test under packages/core/src, so
    // the workspace-relative path of an apps/ file was never exercised end to
    // end.
    const fixture = createFixture(
      [PKG, { path: "apps/api/src/helper.ts", text: "export const guard = (n: number) => n;\n" }],
      [
        { path: "apps/api/src/helper.ts", text: "export const guard = (n: number) => n + 1;\n" },
        {
          path: "apps/api/src/guard.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(guard(0)).toBe(1);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 15 — the edge-audit findings at 8a618ed9", () => {
  test("a test the change skips and the parent never judged is not a pass", () => {
    // The parent cannot load the file — the module the test imports is new in
    // this change — so the parent's run never judged the test. The waiver
    // excuses the parent side, and the change side registers the test as
    // skipped. The test then runs nowhere: the parent could not load it and
    // the change skips it. The gate said PASS (1 waived) and the file as
    // committed pins nothing.
    const fixture = createFixture(
      [PKG],
      [
        { path: "packages/core/src/fresh.ts", text: "export const fresh = 1;\n" },
        {
          path: "packages/core/src/fresh.test.ts",
          text: `// red-on-parent-waive: "waits for the feature" — the module is new in this change
import { expect, test } from "bun:test";
import { fresh } from "./fresh";
test.skip("waits for the feature", () => {
  expect(fresh).toBe(1);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("SKIPPED-ON-CHANGE");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a waiter waits past its own budget when the holder is judging more", async () => {
    // The end-to-end shape: a live holder that says it is judging three files,
    // and a waiter whose own override is short. The waiter must wait for the
    // holder's work, not for its own guess.
    const fixture = createFixture([PKG, HELPER], [
      { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
      {
        path: "packages/core/src/red.test.ts",
        text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
      },
    ]);
    try {
      const lockPath = join(fixture.cache, `wt-${fixture.base}.lock`);
      mkdirSync(lockPath, { recursive: true });
      // This process is alive, so the lock reads as held by a live run.
      writeFileSync(join(lockPath, "pid"), `${process.pid} ${randomUUID()} 3\n`);
      const started = Date.now();
      const { status, stdout } = runGateFixture(
        fixture,
        {
          RED_ON_PARENT_LOCK_WAIT_MS: "1500",
          RED_ON_PARENT_TEST_TIMEOUT_MS: "1000",
        },
        [],
        40_000,
      );
      const waited = Date.now() - started;
      expect(stdout).toContain("it says it is judging 3 files");
      // Three files at two runs each and a one-second test timeout is six
      // seconds of holder work: the waiter did not give up at its own 1.5s.
      expect(waited).toBeGreaterThan(4_000);
      expect(status).toBe(2);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("the gate refuses to run under node", () => {
    // The ask lived in `main` alone, so a caller that used the exported
    // `runGate` skipped it: every parent-side run then read as a whole-file
    // load failure, and a waiver turned that into a PASS.
    expect(() =>
      runGate({ repo: process.cwd(), base: "HEAD", head: "HEAD", fresh: false }, {}),
    ).toThrow(/bun/);
    // Under bun it does not refuse.
    expect(bunOnlyRefusal({ bun: "1.4.2" })).toBeNull();
    expect(bunOnlyRefusal({})).toContain("run this with bun");
  });

  test("a file whose name is not ASCII is judged like any other", () => {
    // The gate's own file handling goes through git, the filesystem and bun's
    // import, each of which has its own idea of a path. A name outside ASCII
    // exercises all three at once, and the gate used to have no end-to-end case
    // for it: the path was listed, never run.
    const fixture = createFixture(
      [PKG, { path: "packages/core/src/helper.ts", text: "export const guard = (n: number) => n;\n" }],
      [
        { path: "packages/core/src/helper.ts", text: "export const guard = (n: number) => n + 1;\n" },
        {
          path: "packages/core/src/caf\u00e9.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";
test("rejects zero", () => {
  expect(guard(0)).toBe(1);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 16 — the standards-review findings at 8a618ed9", () => {
  test("the gate's refusal to run under node says what to do", () => {
    // The exit code alone does not say why the run stopped, and a reader who
    // only sees "2" cannot tell a wrong runtime from a bad argument.
    expect(bunOnlyRefusal({})).toContain("run this with bun");
    expect(bunOnlyRefusal({ bun: "1.4.3" })).toBeNull();
  });

  test("a commented-out import is not an import", () => {
    // The import scan strips the comments before it reads the file, and the
    // strip had no assertion that could fail without it: the assertions that
    // existed were type-only clauses, which the other half of the fix already
    // skips. A file with a commented-out import was refused, wrongly.
    expect(importedTestFiles('// import "./old.test.ts";\n', PROBE_TS)).toEqual([]);
    expect(importedTestFiles('/* import "./old.test.ts"; */\n', PROBE_TS)).toEqual([]);
    expect(importedTestFiles('// import "./old.test.ts";\nimport "./real.test.ts";\n', PROBE_TS)).toEqual([
      "./real.test.ts",
    ]);
  });

  test("a refused file still has its waiver marker read", () => {
    // The waiver marker of a refused file is read before the refusal, so a
    // malformed marker is still reported. Moving the read below the refusal
    // left every assertion green, because the committed malformed-waiver
    // assertions are unit tests of the parser alone.
    const fixture = createFixture(
      [PKG],
      [
        {
          path: "packages/core/src/other.test.ts",
          text: `import { expect, test } from "bun:test";
test("other", () => {
  expect(1).toBe(1);
});
`,
        },
        {
          path: "packages/core/src/importer.test.ts",
          text: `// red-on-parent-waive: the name is not quoted
import "./other.test.ts";
import { expect, test } from "bun:test";
test("importer", () => {
  expect(1).toBe(1);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("must read");
      expect(stdout).toContain("imports another test file");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 17 — the Greptile findings at ef4c42b1", () => {
  test("a regex literal's quote does not blank the waiver below it", () => {
    // `outsideLiterals` read every `"` as a string delimiter, so
    // `const quote = /"/;` opened a string that ran to the next quote in the
    // file. Everything between — the waiver comment included — became spaces,
    // `parseWaivers` found no waiver, and a characterization test whose red is
    // on the parent was refused as GREEN_ON_PARENT. A regex literal is neither
    // a string nor a comment.
    const source = String.raw`const quote = /"/;
const classSlash = /[//]/;
const escaped = /\/\//;
const half = total / 2;
// red-on-parent-waive: "gr keeps the quote" — characterizes behaviour the refactor kept
test("gr keeps the quote", () => {
  expect(quote.source).toBe('"');
});
`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["gr keeps the quote"]);
    expect(parsed.waivers[0]?.line).toBe(5);
  });

  test("a `//` inside a regex character class is not a comment", () => {
    // The same scan feeds the import check, which keeps literals. A `//` in a
    // character class is not the start of a comment, and reading it as one
    // drops the rest of the line — the line a real import can be on.
    expect(importedTestFiles(String.raw`const slash = /[//]/; import "./real.test.ts";`, PROBE_TS)).toEqual([
      "./real.test.ts",
    ]);
  });

  test("a file that leaves the parent worktree changed cannot redden the next file", () => {
    // The parent worktree used to be restored once, before the file loop. A
    // test that writes a tracked fixture and then fails for its own reason
    // restores nothing, so the next file's parent run saw the mutation. A file
    // that is green on the parent then failed there with an AssertionError, and
    // the gate read that red as RIGHT-REASON RED — a false PASS.
    const shared: File = { path: "packages/core/src/shared.ts", text: 'export const FLAG = "before";\n' };
    const mutator = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("leaves the parent's fixture changed", () => {
  const cache = process.env.RONP_FIXTURE_CACHE ?? "";
  // The change side runs in the checkout, and a dirty checkout is refused
  // before the run for a reason that has nothing to do with this test. The
  // mutation is the parent worktree's, so it is written there and only there.
  if (cache.length > 0 && import.meta.dir.startsWith(cache)) {
    writeFileSync(join(import.meta.dir, "shared.ts"), 'export const FLAG = "after";\\n');
  }
  expect(1).toBe(2);
});
`;
    const reads = `import { expect, test } from "bun:test";
import { FLAG } from "./shared";

test("reads the parent's flag", () => {
  expect(FLAG).toBe("before");
});
`;
    const fixture = createFixture(
      [PKG, shared],
      [
        { path: "packages/core/src/a-leaves.test.ts", text: mutator },
        { path: "packages/core/src/b-reads.test.ts", text: reads },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture, { RONP_FIXTURE_CACHE: fixture.cache });
      expect(stdout).toContain("b-reads.test.ts");
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 90_000);

  test("a change-side run that was killed does not have its report accepted", () => {
    // `changeSideResults` looked only for a junit file, so a process result of
    // `null` — killed by the timeout, interrupted — was read as a completed
    // run whose report enumerated the change's tests. A report bun wrote before
    // it died is not evidence of what the change registers.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/killed.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("x", () => {\n  expect(1).toBe(1);\n});\n`,
        },
      ],
    );
    try {
      const out = join(mkdtempSync(join(tmpdir(), "ronp-junit-")), "out.xml");
      const problems: string[] = [];
      const results = changeSideResults(
        fixture.repo,
        "packages/core/src/killed.test.ts",
        out,
        problems,
        (_repo, _file, junitPath) => {
          // The report bun writes, and then a process that did not finish.
          writeFileSync(
            junitPath,
            `<testsuites><testsuite name="e.test.ts"><testcase name="x" classname="x" /></testsuite></testsuites>`,
          );
          return { status: null, stdout: "", error: "killed after 120000ms" };
        },
      );
      expect(results).toEqual([]);
      expect(problems.join(" ")).toContain("did not finish");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("red-on-parent round 18 — the Greptile findings at 07b7896d", () => {
  test("a division after a closing paren is a division, not a regex", () => {
    // `previousToken` scanned back over `[\w$]` only, so after `)` it found no
    // token at all and `slashStartsRegex` read the empty token as "the start of
    // the file, so a regex". The division was lexed as a regex that ended at the
    // block comment's `*` + `/`, which left `import "./fake.test.ts"` standing
    // as code: the gate then refused a valid test file for importing a test
    // file it never imported.
    const source = `const x = value() / total /* import "./fake.test.ts" */ / 2;\n`;
    expect(importedTestFiles(source, PROBE_TS)).toEqual([]);
  });

  test("a division after a closing bracket is a division, not a regex", () => {
    // The same lie after `]`. Both closers are in the fix's blast radius, and
    // neither is a word character, so both returned the empty token.
    const source = `const x = rows[i] / n /* import "./fake.test.ts" */ / 2;\n`;
    expect(importedTestFiles(source, PROBE_TS)).toEqual([]);
  });

  test("the division fix does not stop a real import being found", () => {
    // The failure mode of an over-correction: a scan that gave up on `/` and
    // reported nothing would pass the two tests above and silently accept a
    // mixed report.
    expect(importedTestFiles(`const x = value() / 2; import "./real.test.ts";\n`, PROBE_TS)).toEqual([
      "./real.test.ts",
    ]);
  });

  test("a division misread as a regex cannot blank the waiver below it", () => {
    // The waiver route and the import route are one scanner, so the same mislex
    // reaches both. Read as a regex, the division ends at the block comment's
    // opening delimiter; the apostrophe in the comment's text then opens a
    // "string" that runs to the next quote in the file — which is below the
    // waiver, and every line of it between became spaces. `parseWaivers` found
    // no waiver, and a characterization test whose red is on the parent was
    // refused as GREEN_ON_PARENT.
    const source = `const x = value() / total /* don't */ / 2;\n// red-on-parent-waive: "gr divides" — characterizes behaviour the refactor kept\ntest("gr divides", () => {\n  expect(x).toBe(1);\n});\n`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["gr divides"]);
  });
});

describe("red-on-parent round 20 — the Greptile findings at e1ea567c", () => {
  const junitOneCase =
    `<testsuites><testsuite name="e.test.ts"><testcase name="x" classname="x" /></testsuite></testsuites>`;

  test("a --fresh run waits for a reclaim another live process holds", () => {
    // `--fresh` has no lock of its own: it deletes the cached worktree from
    // inside `acquireWorktreeLock`, under the name `wt-<sha>`, and never touches
    // `wt-<sha>.lock`. This is the end-to-end proof. A stale lock whose reclaim
    // is already in flight (the claim belongs to a live process) must make the
    // fresh run wait and refuse, and must leave the lock, its claim and the
    // worktree it guards exactly as they were. A fresh path that removed the
    // lock itself would clear the claim, rebuild the worktree and exit 0.
    const redTest: File = {
      path: "packages/core/src/red.test.ts",
      text: `import { expect, test } from "bun:test";\nimport { guard } from "./helper";\ntest("rejects zero", () => {\n  expect(() => guard(0)).toThrow("ZERO");\n});\n`,
    };
    const fixture = createFixture(
      [PKG, HELPER],
      [{ path: "packages/core/src/helper.ts", text: HELPER_AFTER }, redTest],
    );
    try {
      const lockPath = join(fixture.cache, `wt-${fixture.base}.lock`);
      const worktree = join(fixture.cache, `wt-${fixture.base}`);
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, "marker"), "the cached worktree --fresh would rebuild\n");
      mkdirSync(lockPath, { recursive: true });
      // A holder that is gone, and a reclaim of it held by a live process. The
      // count is 0, so the waiter works to its own budget and the test stays
      // short.
      writeFileSync(join(lockPath, "pid"), lockPidFileContent(2_147_483_647, "dead-token", 0));
      writeFileSync(
        join(lockPath, reclaimClaimName(1)),
        lockPidFileContent(process.pid, "first-reclaimer", 0),
      );
      const { status, stdout } = runGateFixture(
        fixture,
        { RED_ON_PARENT_LOCK_WAIT_MS: "600" },
        ["--fresh"],
      );
      expect(stdout).toContain("another red-on-parent run is using");
      expect(status).toBe(2);
      expect(existsSync(join(lockPath, "pid"))).toBe(true);
      expect(existsSync(join(lockPath, reclaimClaimName(1)))).toBe(true);
      expect(existsSync(join(worktree, "marker"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a run that exited non-zero with no error has finished", () => {
    // The change's own run executes the test this change adds, and that test is
    // the one the gate wants red on the parent and green on the change — but a
    // red test on the change exits 1, and the gate reads that red to report
    // RED_ON_CHANGE. So a non-zero exit may not refuse the report. This is the
    // deliberate half of the decision the finding asked for.
    expect(runFinished({ status: 1, error: "" })).toBe(true);
    expect(runFinished({ status: 0, error: "" })).toBe(true);
  });

  test("an errored run has not finished, whatever status it reports", () => {
    // The other half: `spawnSync` sets `error` when the child never ran
    // (ENOENT), was killed for its budget (ETIMEDOUT) or overran the buffer
    // (ENOBUFS). A report on disk from a run that ended that way is not evidence
    // of what the change registers, and the status surviving is not a licence to
    // read it.
    expect(runFinished({ status: 1, error: "spawnSync ETIMEDOUT" })).toBe(false);
    expect(runFinished({ status: 1, error: "ENOBUFS: maxBuffer exceeded" })).toBe(false);
    expect(runFinished({ status: null, error: "" })).toBe(false);
    expect(runFinished({ status: null, error: "killed after 120000ms" })).toBe(false);
  });

  test("a change-side report from a run that exited non-zero is read", () => {
    // The concrete version of the decision above: a report on disk, a process
    // that exited 1 — a red test on the change — and an empty `error`. The
    // report is the evidence, and refusing it would report a broken change as an
    // unreadable run instead.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/red-on-change.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("x", () => {\n  expect(1).toBe(2);\n});\n`,
        },
      ],
    );
    try {
      const out = join(mkdtempSync(join(tmpdir(), "ronp-junit-")), "out.xml");
      const problems: string[] = [];
      const results = changeSideResults(
        fixture.repo,
        "packages/core/src/red-on-change.test.ts",
        out,
        problems,
        (_repo, _file, junitPath) => {
          writeFileSync(junitPath, junitOneCase);
          return { status: 1, stdout: "(fail) x", error: "" };
        },
      );
      expect(problems).toEqual([]);
      expect(results.map((result) => result.name)).toEqual(["x"]);
    } finally {
      fixture.cleanup();
    }
  });

  test("a change-side report from an errored run is refused even when it exited", () => {
    // The finding's exact shape: a report present on disk, from a process that
    // exited non-zero *and* carries a non-empty `error`. Only the status was
    // checked before the report was read, so this report was accepted and the
    // gate enumerated whatever tests happened to reach the file. The report is
    // refused now, and the refusal says which error it was.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/errored.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("x", () => {\n  expect(1).toBe(1);\n});\n`,
        },
      ],
    );
    try {
      const out = join(mkdtempSync(join(tmpdir(), "ronp-junit-")), "out.xml");
      const problems: string[] = [];
      const results = changeSideResults(
        fixture.repo,
        "packages/core/src/errored.test.ts",
        out,
        problems,
        (_repo, _file, junitPath) => {
          writeFileSync(junitPath, junitOneCase);
          return { status: 1, stdout: "", error: "ENOBUFS: maxBuffer exceeded" };
        },
      );
      expect(results).toEqual([]);
      expect(problems.join(" ")).toContain("did not finish");
      expect(problems.join(" ")).toContain("ENOBUFS");
    } finally {
      fixture.cleanup();
    }
  });
});
describe("red-on-parent round 21 — the Greptile findings at 25d60eb9", () => {
  // The quote-in-JSX-prose shape was pinned twice, here and in round 22, from
  // the same source. This copy read it as `.ts`, where the scan only survived
  // the apostrophe because an unterminated string ends at the line break — the
  // pin held for a reason that had nothing to do with JSX, so it would have
  // stayed green if JSX prose went back to being lexed as code. Round 22's copy
  // is the one that names `.tsx`; this one is gone.
  test("an unterminated string does not blank the rest of the file", () => {
    // The failure mode every masking bug shares, and the one that matters more
    // than any single cause: a mask that eats the file turns a declared waiver
    // into a file that declared none, which is GREEN_ON_PARENT. A literal the
    // scan never sees the end of is not a literal — the quote is text, and the
    // scan carries on after it.
    const source = String.raw`const note = 'unterminated
// red-on-parent-waive: "still judged" — the waiver survives the broken literal
test("still judged", () => {
  expect(note).toContain("unterminated");
});
`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["still judged"]);
    expect(parsed.waivers[0]?.line).toBe(2);
  });

  test("the SKIPPED ON CHANGE advice does not offer a fix that cannot work", () => {
    // Skipping the test on the parent as well does not clear the row: the
    // change's own run decides it, and no waiver reaches it. The guide used to
    // send the author there, and a round spent on it came back with the same
    // row. What the guide says has to match what the gate does.
    const skipped = VERDICT_GUIDE.find((entry) => entry.name === "SKIPPED_ON_CHANGE");
    expect(skipped?.fixes.join(" ")).not.toContain("make the parent skip it too");
    const waiver: Waiver = { pattern: "a", reason: "r", line: 1 };
    const parentWaived: Verdict = {
      file: "f",
      test: "a",
      name: "NOT_ON_PARENT",
      detail: "d",
      waiver,
      waivers: [waiver],
    };
    const changeResult: TestResult = {
      name: "a",
      classname: "",
      status: "skipped",
      failureType: null,
      assertions: null,
    };
    // The parent's row passes with its waiver, and the change's row still fails
    // — with both sides skipped. That is the shape the removed advice claimed
    // to fix.
    expect(verdictPasses(parentWaived)).toBe(true);
    const row = changeSideVerdicts("f", [parentWaived], [changeResult])[0];
    expect(row?.name).toBe("SKIPPED_ON_CHANGE");
    expect(row === undefined ? true : verdictPasses(row)).toBe(false);
  });

  test("a `<Foo>` type assertion is not a JSX element", () => {
    // The `<` of an assertion sits where an expression starts, exactly like the
    // `<` of an element. Read as an element, the assertion opens a text region
    // that never closes, and prose keeps a commented-out import that the code
    // scan is supposed to blank — so the file is reported as importing a test
    // file it never imported.
    const source = `const x = <Foo>value;
// import "./fake.test.ts"
const y = x as unknown as number;
`;
    expect(importedTestFiles(source, PROBE_TS)).toEqual([]);
    // An element with a close is text, and the same scan still finds a real
    // import beside it.
    expect(
      importedTestFiles(`const view = <div>it's fine</div>;
import "./real.test.ts";
`, PROBE_TS),
    ).toEqual(["./real.test.ts"]);
  });
});

describe("red-on-parent round 22 — the masker replaced by the TypeScript scanner", () => {
  // The four failures that ended the hand-written mask's life, each pinned by
  // the shape that produced it. Every one of them is a scan reading something
  // that is not code as code: an apostrophe in JSX prose, the inside of a JSX
  // attribute, a `</` inside a string, a string continued over CRLF. The
  // scanner and the parser know all four by construction, which is the whole
  // reason the mask is gone.
  const TSX = "apps/web/src/note.test.tsx";
  const TS = "apps/web/src/note.test.ts";

  test("a quote in JSX text does not blank the waiver below it", () => {
    // Round 21 fixed this one shape and left the mask in place; it is pinned
    // here because dropping the mask has to keep the fix. `<div>Don't …` is
    // prose between two tags, so its `'` is not a string's delimiter.
    const source = [
      'test("renders the note", () => {',
      "  render(<div>Don't delete</div>);",
      "});",
      '// red-on-parent-waive: "renders the note" — characterizes behaviour the refactor kept',
      "",
    ].join("\n");
    const parsed = parseWaivers(source, TSX);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["renders the note"]);
    expect(parsed.waivers[0]?.line).toBe(4);
  });

  test("a comment inside a JSX attribute is not code", () => {
    // `emitTag` copied a whole tag verbatim, comments and strings included. The
    // block comment below holds a specifier, and a mask that keeps it makes the
    // import scan report an import the file does not make — so the gate refuses
    // a valid test file.
    const source = `<div title={1 /* import "./fake.test.ts" */} />;\n`;
    expect(importedTestFiles(source, TSX)).toEqual([]);
  });

  test("a waiver inside a template attribute is not a waiver", () => {
    // The other half of the same copy: a multiline template literal inside an
    // attribute is data, and the marker line inside it used to be handed to the
    // file as a waiver it never declared. `unusedWaiverVerdicts` then rejects
    // the file for a waiver that matches nothing.
    const source = [
      "<div title={`",
      '// red-on-parent-waive: "a generated test" — this line belongs to the data',
      'test("generated", () => {});',
      "`} />;",
      "",
    ].join("\n");
    const parsed = parseWaivers(source, TSX);
    expect(parsed.waivers).toEqual([]);
    expect(parsed.problems).toEqual([]);
  });

  test("a `<Foo>` type assertion in a .ts file is not a JSX element", () => {
    // `hasClosingTagAfter` read any `</` after the assertion as proof of an
    // element, and `"</div>"` on the next line supplied it. The file then read
    // as JSX text from the assertion to that string, prose kept the
    // commented-out import, and the gate refused a file that imports nothing.
    // The extension decides: `<Foo>"ok"` is a type assertion in `.ts`.
    const source = [
      'const x = <Foo>"ok";',
      '// import "./fake.test.ts"',
      'const html = "</div>";',
      "",
    ].join("\n");
    expect(importedTestFiles(source, TS)).toEqual([]);
  });

  test("a backslash-CRLF continuation keeps the rest of the string inside the string", () => {
    // `stringEnd` skipped the backslash and the `\r`, then returned null at the
    // `\n`, so the quote was read as text and the second line of the string was
    // read as code: the marker inside the string became a real waiver, with the
    // string's last two characters glued onto its reason.
    const BACKSLASH = "\\";
    const source = [
      `const s = "a${BACKSLASH}`,
      '// red-on-parent-waive: "not a waiver" — this line is string data";',
      'test("y", () => {});',
      "",
    ].join("\r\n");
    const parsed = parseWaivers(source, TS);
    expect(parsed.waivers).toEqual([]);
    expect(parsed.problems).toEqual([]);
    // A real waiver in the same CRLF file is still read, so the fix is the
    // continuation and not a scan that stopped seeing markers.
    const withWaiver = [
      `const s = "a${BACKSLASH}`,
      '// this line is string data";',
      '// red-on-parent-waive: "a real one" — because',
      "",
    ].join("\r\n");
    expect(parseWaivers(withWaiver, TS).waivers.map((waiver) => waiver.pattern)).toEqual([
      "a real one",
    ]);
  });
});

describe("red-on-parent round 23 — the lens findings at 0f95d7d4", () => {
  // The scanner loop read comments and the parser read imports, and the split
  // was the bug: a hand-driven lexer has to re-derive the state the parser
  // already tracks, and every gap below was one state it did not re-derive.
  // The ranges come from the tree now, so each fix below is a property rather
  // than a case — but each is pinned by the shape that measured it.
  const BACKTICK = "`";

  test("an interpolated template literal does not swallow the waivers below it", () => {
    // `createScanner` was never told to `reScanTemplateToken`, so the closing
    // backtick of an interpolated template was read as the opener of a second
    // template that ran to the end of the file. Every waiver below it was inside
    // that template's data: `parseWaivers` returned no waivers and no problems,
    // and the gate refused a characterization test whose red was legitimately on
    // the parent.
    const source = `const t = ${BACKTICK}x\${1}y${BACKTICK};\n// red-on-parent-waive: "real" - why\n`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["real"]);
  });

  test("a backtick inside a regex literal does not swallow the waiver below it", () => {
    // The same property, one literal kind over: the scanner did not know it was
    // inside a regex, so the backtick in the character class opened a template.
    const source = `const r = /${BACKTICK}/;\n// red-on-parent-waive: "real" - why\n`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["real"]);
  });

  test("a waiver after another comment is still read, and keeps its own reason", () => {
    // The scan took its line slice from a position cached for a previous token,
    // so a block comment before the marker on the same line was matched against
    // the wrong text and the waiver vanished. Another comment is trivia: the line
    // still begins with trivia, so the marker is a declaration.
    const source = `/* note */ // red-on-parent-waive: "real" - why\n`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers).toEqual([{ pattern: "real", reason: "why", line: 1 }]);
  });

  test("a marker that follows code on its line is not a waiver", () => {
    // The other half of the rule the test above relaxes: a line that carries code
    // before the marker declares nothing. `const x = 1; // marker` is a comment
    // about the convention, and reading it as a waiver would excuse a test the
    // author never excused.
    const source = `const x = 1; // red-on-parent-waive: "not a waiver" - why\n`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.waivers).toEqual([]);
    expect(parsed.problems).toEqual([]);
  });

  test("a BOM in front of the file does not lose the first waiver", () => {
    // The byte-order mark is the first character, so a scan that started its
    // comment search at a position it derived by hand never reached the marker on
    // line 1. The parser skips the BOM as trivia, so the tree already knows.
    const source = `\uFEFF// red-on-parent-waive: "real" - why\n`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["real"]);
  });

  test("a CR-only file is a file with lines, and its second waiver is read", () => {
    // A file a Windows tool wrote with CR alone as the line break: the line
    // counter only knew `\n`, so line 2 was never reached and the waiver on it was
    // never seen. A line break is CRLF, CR or LF.
    const source = `const x = 1;\r// red-on-parent-waive: "real" - why\r`;
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers).toEqual([{ pattern: "real", reason: "why", line: 2 }]);
  });

  test("a waiver after the last test in a block is read", () => {
    // The comment is leading trivia of the block's closing brace — a token, not a
    // node. A walk that only visited nodes would drop this shape, and this is the
    // shape a waiver is actually written in: at the end of the file, after the
    // last test. The walk visits tokens for exactly this case.
    const source = [
      'describe("cart", () => {',
      '  test("totals two", () => {',
      "    expect(1).toBe(1);",
      "  });",
      '  // red-on-parent-waive: "totals two" - why',
      "});",
      "",
    ].join("\n");
    const parsed = parseWaivers(source, PROBE_TS);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers).toEqual([{ pattern: "totals two", reason: "why", line: 5 }]);
  });

  test("a lone backtick in JSX prose does not swallow the waiver below it", () => {
    // The shape round 22 needed a JSX-blanking pass for, kept and relabelled: a
    // hand-driven lexer read the backtick as a template opener and the waiver
    // below it as template data. The parser never lexes prose, so the waiver now
    // survives by construction — and what the test pins is the *path*. The same
    // source read as `.ts` is a different file (`<div>` is a type assertion
    // there), and the waiver is lost there, which is exactly why the path is an
    // argument the caller must supply rather than a default that guesses `.ts`.
    const source = [
      'test("renders the note", () => {',
      `  render(<div>a ${BACKTICK} b</div>);`,
      "});",
      '// red-on-parent-waive: "renders the note" - why',
      "",
    ].join("\n");
    const asTsx = parseWaivers(source, PROBE_TSX);
    expect(asTsx.problems).toEqual([]);
    expect(asTsx.waivers.map((waiver) => waiver.pattern)).toEqual(["renders the note"]);
    expect(asTsx.waivers[0]?.line).toBe(4);
    // The other reading, so a test that passed for the wrong reason cannot be
    // the whole pin: `.ts` is the wrong file, and it declares no waiver.
    expect(parseWaivers(source, PROBE_TS).waivers).toEqual([]);
  });

  test("a marker inside JSX prose is prose, not a waiver", () => {
    // The carve-out's real job, and the shape that reddens when it is deleted: a
    // `//` at the start of a line of JSX child text is a comment to any trivia
    // scan that reaches it, and prose is not code. Left in, the marker line
    // declares a waiver the file never wrote, `unusedWaiverVerdicts` then finds
    // it matching no test, and the gate refuses a valid file.
    const source = [
      'test("renders the note", () => {',
      "  render(<div>",
      '    // red-on-parent-waive: "generated" - this line is prose',
      "  </div>);",
      "});",
      "",
    ].join("\n");
    const parsed = parseWaivers(source, PROBE_TSX);
    expect(parsed.waivers).toEqual([]);
    expect(parsed.problems).toEqual([]);
  });

  test("a no-substitution template specifier is as static as a quoted one", () => {
    // A dynamic import whose argument is a backtick literal is one literal with
    // different quotes: the loader resolves it without running anything, so the
    // second file's cases land in this file's report exactly as a quoted import's
    // would.
    expect(importedTestFiles(`await import(${BACKTICK}./a.test.ts${BACKTICK});`, PROBE_TS)).toEqual([
      "./a.test.ts",
    ]);
  });

  test("import attributes after the specifier do not hide the import", () => {
    // The scan required exactly one argument, so an import with attributes was
    // invisible and the mixed report was judged as this file's own. The specifier
    // is the first argument; what follows it is not a reason to stop reading.
    const source = `await import("./a.test.ts", { with: { type: "text" } });`;
    expect(importedTestFiles(source, PROBE_TS)).toEqual(["./a.test.ts"]);
  });

  test("an element-accessed require is a require", () => {
    // `module["require"]` takes the same path in Bun's loader as `require`, and
    // the callee test only knew an identifier and a property access.
    expect(importedTestFiles(`module["require"]("./a.test.ts");`, PROBE_TS)).toEqual([
      "./a.test.ts",
    ]);
  });

  test("a parenthesised require is a require", () => {
    // `(require)(...)` calls the same function; the parentheses were read as an
    // unknown callee, so the import went unseen and the mixed report was judged.
    expect(importedTestFiles(`(require)("./a.test.ts");`, PROBE_TS)).toEqual(["./a.test.ts"]);
  });

  test("a waived NOT ON PARENT row is counted in the pass line", () => {
    // The count covered WRONG REASON RED only, so a run whose only waived row was
    // NOT ON PARENT printed `PASS (1 waived)` with no explanation — while the
    // guide for that very verdict says there is no red to judge. Both verdicts
    // mean "the parent never ran this test", and both are counted now.
    const waiver: Waiver = {
      pattern: "brand new",
      reason: "registered only on the change",
      line: 9,
    };
    const waivedRow: Verdict = {
      file: "packages/core/src/cart.test.ts",
      test: "brand new",
      name: "NOT_ON_PARENT",
      detail: "the change registers this test and the parent's run never reported it",
      waiver,
      waivers: [waiver],
    };
    const run: GateRun = {
      baseSha: "0f95d7d4aaaa",
      worktree: "(none)",
      worktreeCreated: false,
      installLog: "",
      files: ["packages/core/src/cart.test.ts"],
      verdicts: [waivedRow],
      stdoutByFile: new Map(),
      problems: [],
      uncommitted: [],
      skipped: [],
      hollowed: [],
      augmented: [],
    };
    const report = renderReport(run, []);
    expect(verdictPasses(waivedRow)).toBe(true);
    // The printed verdict and the exit code come from one decision now. Before
    // that they were two expressions, which is how a reviewer reads PASS while
    // CI exits 1.
    expect(runPasses(run)).toBe(true);
    expect(report).toMatch(/^red-on-parent: PASS/mu);
    // One problem fails the run even when every verdict passes, and the printed
    // line says so — the same function decides both.
    const withProblem = { ...run, problems: ["cart.test.ts: has uncommitted changes"] };
    expect(runPasses(withProblem)).toBe(false);
    expect(renderReport(withProblem, withProblem.problems)).toMatch(/^red-on-parent: FAIL/mu);
    expect(report).toContain("red-on-parent: PASS (1 waived)");
    expect(report).toContain(
      "1 of them: the parent could not run the test, so nothing was judged there",
    );
  });
});

// ---------------------------------------------------------------------------
// Round 24 — a module the change adds, and a gate that judged none of it.
//
// The test-audit lens on the round-2 diff: `isGatedTestPath` returned false for
// anything outside `apps/` and `packages/`, so both `scripts/*.test.ts` files
// were outside the gate — 26 tests with no red-first enforcement, which is how a
// vacuous assertion landed unchallenged. Widening the scope is not enough on its
// own: on the parent the module those tests import does not exist, the junit
// report is absent, and every case reads WRONG REASON RED, which one waiver line
// turns into a PASS. A real test and a test that asserts `true` are
// indistinguishable in that report.
//
// So the gate writes a HOLLOW stand-in for an added module into the parent at its
// own path: same export names, no behaviour. Then the vacuous test passes on the
// parent (GREEN ON PARENT, rejected) and the real one fails for its own assertion
// reason. What it cannot mirror it refuses, with a verdict that fails closed.
// ---------------------------------------------------------------------------

describe("red-on-parent round 24 — a hollow stand-in for a module the change adds", () => {
  test("a function export becomes an empty function of the same name", () => {
    const hollow = hollowModuleSource(
      `export function twice(n: number): number {\n  return n * 2;\n}\n`,
      "scripts/mod.ts",
    );
    expect(hollow.ok).toBe(true);
    if (!hollow.ok) return;
    expect(hollow.text).toContain("export function twice");
    // No behaviour: the body is empty, so the arithmetic cannot leak through.
    expect(hollow.text).not.toContain("n * 2");
    expect(hollow.text).not.toContain("return n");
  });

  test("a const and a let become undefined", () => {
    const hollow = hollowModuleSource(
      `export const table = { a: 1 };\nexport let counter = 7;\nexport var flag = true;\n`,
      "scripts/mod.ts",
    );
    expect(hollow.ok).toBe(true);
    if (!hollow.ok) return;
    expect(hollow.text).toContain("export const table = undefined;");
    expect(hollow.text).toContain("export let counter;");
    expect(hollow.text).toContain("export var flag;");
    expect(hollow.text).not.toContain("a: 1");
    expect(hollow.text).not.toContain("7");
  });

  test("a class becomes an empty class", () => {
    const hollow = hollowModuleSource(
      `export class Store {\n  read(): number {\n    return 1;\n  }\n}\n`,
      "scripts/mod.ts",
    );
    expect(hollow.ok).toBe(true);
    if (!hollow.ok) return;
    expect(hollow.text).toContain("export class Store");
    expect(hollow.text).not.toContain("read()");
  });

  test("an interface and a type alias are re-emitted, because they emit nothing at runtime", () => {
    const hollow = hollowModuleSource(
      `export interface Shape {\n  a: number;\n}\nexport type Mode = "one" | "two";\n`,
      "scripts/mod.ts",
    );
    expect(hollow.ok).toBe(true);
    if (!hollow.ok) return;
    expect(hollow.text).toContain("export interface Shape");
    expect(hollow.text).toContain("export type Mode");
    expect(hollow.text).not.toContain("a: number");
  });

  // Everything below is a shape a bounded mirror cannot reproduce, and a wrong
  // hollow is worse than a refusal: one that carries behaviour lets a vacuous
  // test pass on the parent, and one that drops an export makes a real test fail
  // for a reason the change did not cause.
  test("an export default is refused", () => {
    for (const source of [
      "export default function twice() {\n  return 2;\n}\n",
      "export default 2;\n",
      "const value = 2;\nexport default value;\n",
    ]) {
      const hollow = hollowModuleSource(source, "scripts/mod.ts");
      expect({ source, ok: hollow.ok }).toEqual({ source, ok: false });
    }
  });

  test("a re-export is refused", () => {
    for (const source of [
      `export { twice } from "./other";\n`,
      `export * from "./other";\n`,
      `export * as other from "./other";\n`,
      `export { type Shape } from "./other";\n`,
    ]) {
      const hollow = hollowModuleSource(source, "scripts/mod.ts");
      expect({ source, ok: hollow.ok }).toEqual({ source, ok: false });
    }
  });

  test("an enum, a namespace and a local export list are refused", () => {
    for (const source of [
      "export enum Mode {\n  One,\n}\n",
      "export namespace util {\n  export const a = 1;\n}\n",
      "function twice() {\n  return 2;\n}\nexport { twice };\n",
      "export = twice;\n",
    ]) {
      const hollow = hollowModuleSource(source, "scripts/mod.ts");
      expect({ source, ok: hollow.ok }).toEqual({ source, ok: false });
    }
  });

  test("a destructuring export is refused, because its names are not one declaration each", () => {
    const hollow = hollowModuleSource("export const { a, b } = { a: 1, b: 2 };\n", "scripts/mod.ts");
    expect(hollow.ok).toBe(false);
  });

  test("a hollow that does not export the same names is refused rather than written", () => {
    // `export declare` is a shape a bounded mirror would silently drop. The
    // self-check compares the export names it re-reads from its own output with
    // the names the real module declares, so a mirror that lost one is refused
    // instead of faked.
    const hollow = hollowModuleSource("export declare const table: number;\n", "scripts/mod.ts");
    expect(hollow.ok).toBe(false);
  });

  test("the refusal names the module and the reason, so a human can act on it", () => {
    const hollow = hollowModuleSource("export enum Mode {\n  One,\n}\n", "scripts/mod.ts");
    expect(hollow.ok).toBe(false);
    if (hollow.ok) return;
    expect(hollow.refusal).toContain("scripts/mod.ts");
    expect(hollow.refusal).toContain("enum");
  });

  test("a hollow keeps no imports, so a chain of added modules cannot put behaviour back", () => {
    // Nested case: the added test imports an added module that itself imports
    // another added module. The hollow drops every import, so the chain can never
    // load — and there is nothing left to hollow. That is stricter than hollowing
    // the chain and needs no second resolution step.
    const hollow = hollowModuleSource(
      `import { helper } from "./other";\nimport "./side-effect";\nexport function twice(n: number): number {\n  return helper(n) * 2;\n}\n`,
      "scripts/mod.ts",
    );
    expect(hollow.ok).toBe(true);
    if (!hollow.ok) return;
    expect(hollow.text).not.toContain("import");
    expect(hollow.text).not.toContain("./other");
    expect(hollow.text).not.toContain("helper");
  });

  test("the stand-in says it is a stand-in, so a reader of the parent worktree knows", () => {
    const hollow = hollowModuleSource(
      "export function twice(): number {\n  return 2;\n}\n",
      "scripts/mod.ts",
    );
    expect(hollow.ok).toBe(true);
    if (!hollow.ok) return;
    expect(hollow.text).toContain("red-on-parent");
  });
});

describe("red-on-parent round 24 — which added module the parent gets hollowed", () => {
  const ADDED = new Set(["scripts/mod.ts", "scripts/other.ts"]);
  const read = (path: string): string | null => {
    if (path === "scripts/mod.ts") {
      return `import { helper } from "./other";\nexport function twice(n: number): number {\n  return helper(n) * 2;\n}\n`;
    }
    if (path === "scripts/other.ts") {
      return `export function helper(n: number): number {\n  return n;\n}\n`;
    }
    return null;
  };

  test("a relative import of a module the same diff adds is hollowed", () => {
    const plan = planHollowModules(
      "scripts/mod.test.ts",
      `import { twice } from "./mod";\ntest("x", () => {\n  expect(twice(2)).toBe(4);\n});\n`,
      ADDED,
      read,
    );
    expect(plan.refusal).toBeNull();
    expect(plan.modules.map((module) => module.path)).toEqual(["scripts/mod.ts"]);
    expect(plan.modules[0]?.importedBy).toBe("scripts/mod.test.ts");
  });

  test("the extensionless specifier and the explicit one land on the same file", () => {
    for (const specifier of ["./mod", "./mod.ts"]) {
      const plan = planHollowModules(
        "scripts/mod.test.ts",
        `import { twice } from "${specifier}";\n`,
        ADDED,
        read,
      );
      expect({ specifier, paths: plan.modules.map((module) => module.path) }).toEqual({
        specifier,
        paths: ["scripts/mod.ts"],
      });
    }
  });

  test("a module the diff does not add is left alone", () => {
    // A module the parent already has is not the change's: it loads there, or it
    // does not, and either answer is about the parent.
    const plan = planHollowModules(
      "scripts/mod.test.ts",
      `import { twice } from "./not-in-this-diff";\n`,
      ADDED,
      read,
    );
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toBeNull();
  });

  test("a type-only import is not hollowed, because it is erased before the file runs", () => {
    for (const source of [
      `import type { Twice } from "./mod";\n`,
      `import { type Twice } from "./mod";\n`,
    ]) {
      expect(planHollowModules("scripts/mod.test.ts", source, ADDED, read).modules).toEqual([]);
    }
  });

  test("an import that pulls a value is hollowed even when it also names a type", () => {
    const plan = planHollowModules(
      "scripts/mod.test.ts",
      `import { type Twice, twice } from "./mod";\n`,
      ADDED,
      read,
    );
    expect(plan.modules.map((module) => module.path)).toEqual(["scripts/mod.ts"]);
  });

  test("a nested added module is not hollowed too, because the hollow keeps no imports", () => {
    const plan = planHollowModules(
      "scripts/mod.test.ts",
      `import { twice } from "./mod";\n`,
      ADDED,
      read,
    );
    expect(plan.modules.map((module) => module.path)).toEqual(["scripts/mod.ts"]);
    expect(plan.modules[0]?.text).not.toContain("./other");
  });

  test("a module that cannot be mirrored refuses instead of being half-faked", () => {
    const plan = planHollowModules(
      "scripts/mod.test.ts",
      `import { twice } from "./mod";\n`,
      ADDED,
      (path) => (path === "scripts/mod.ts" ? "export default 2;\n" : null),
    );
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toContain("scripts/mod.ts");
  });
});

describe("red-on-parent round 24 — the gate's scope includes scripts/", () => {
  test("a new test under scripts/ is gated", () => {
    expect(isGatedTestPath("scripts/test-affected.test.ts")).toBe(true);
    expect(isGatedTestPath("scripts/nested/thing.test.tsx")).toBe(true);
  });

  test("the reasons a file is not gated still hold under scripts/", () => {
    expect(isGatedTestPath("scripts/x.spec.ts")).toBe(false);
    expect(isGatedTestPath("scripts/e2e/x.test.ts")).toBe(false);
    expect(isGatedTestPath("docs/x.test.ts")).toBe(false);
    expect(skipReason("scripts/x.test.ts")).toBeNull();
  });
});

describe("red-on-parent round 24 — CANNOT HOLLOW fails closed", () => {
  const refusal: Verdict = {
    file: "scripts/mod.test.ts",
    test: "(whole file)",
    name: "CANNOT_HOLLOW",
    detail: "scripts/mod.ts: the module exports a default, which a hollow cannot mirror",
    waiver: null,
    waivers: [],
  };
  const waiver: Waiver = {
    pattern: "whole file",
    reason: "the module has no faithful hollow",
    line: 3,
  };

  test("an unwaived CANNOT HOLLOW fails the run", () => {
    expect(verdictPasses(refusal)).toBe(false);
  });

  test("the existing waiver grammar is the only thing that clears it", () => {
    expect(verdictPasses({ ...refusal, waiver, waivers: [waiver] })).toBe(true);
  });

  test("the verdict has a guide entry, so an author knows what to do", () => {
    const entry = VERDICT_GUIDE.find((candidate) => candidate.name === "CANNOT_HOLLOW");
    expect(entry?.title).toContain("hollow");
    expect(entry?.fixes.join(" ")).toContain("red-on-parent-waive");
  });

  test("the report says which module was faked, and for which file", () => {
    // A human reading the transcript has to be able to see that the parent's red
    // was produced against a fake, or a hollow that quietly swallowed an export
    // would look like a real verdict.
    const run: GateRun = {
      baseSha: "a1b2c3d4e5f6",
      worktree: "(none)",
      worktreeCreated: false,
      installLog: "",
      files: ["scripts/mod.test.ts"],
      verdicts: [],
      stdoutByFile: new Map(),
      problems: [],
      uncommitted: [],
      skipped: [],
      hollowed: [{ path: "scripts/mod.ts", importedBy: "scripts/mod.test.ts" }],
      augmented: [],
    };
    expect(renderReport(run, [])).toContain(
      "scripts/mod.ts — hollowed for scripts/mod.test.ts",
    );
  });
});

// ---------------------------------------------------------------------------
// Round 26 — only the documented spelling clears a whole file.
//
// The matcher tested the waiver regex against BOTH `(whole file)` and
// `whole file`, so any pattern matching either cleared the file: `"file"`,
// `"whole"`, `"."`, `".*"`. The documented spelling is `"whole file"`, and the
// docs say a pattern broad enough to cover a whole multi-test file is a failure
// — so a one-character waiver overrode the one rule the verdict is supposed to
// be an exception to.
// ---------------------------------------------------------------------------

describe("red-on-parent round 26 — only the documented spelling waives a whole file", () => {
  const refusal = "scripts/mod.ts: the module exports an enum, which a hollow cannot mirror";
  const waiverFor = (pattern: string): Waiver => ({
    pattern,
    reason: "the parent cannot run this file",
    line: 3,
  });

  test("the documented spelling clears the file", () => {
    const verdict = cannotHollowVerdict("scripts/mod.test.ts", refusal, [waiverFor("whole file")]);
    expect(verdict.waiver?.pattern).toBe("whole file");
  });

  test("a pattern that merely matches the words does not", () => {
    // Each of these matched under the old two-string probe. `.` and `.*` are the
    // broad-file waiver the design forbids; `file` and `whole` are shorter
    // spellings that used to be enough.
    for (const pattern of ["file", "whole", ".", ".*", "hole fi", "^whole", "file$"]) {
      const verdict = cannotHollowVerdict("scripts/mod.test.ts", refusal, [waiverFor(pattern)]);
      expect({ pattern, waived: verdict.waiver !== null }).toEqual({ pattern, waived: false });
    }
  });

  test("the parenthesised spelling is not required, because the docs do not advertise it", () => {
    const verdict = cannotHollowVerdict("scripts/mod.test.ts", refusal, [waiverFor("(whole file)")]);
    expect({ waived: verdict.waiver !== null }).toEqual({ waived: false });
  });
});

// ---------------------------------------------------------------------------
// Round 24, end to end: the plant pair the lens asked for, as fixtures.
//
// A vacuous test and a real one that import a module the same diff adds are
// indistinguishable to the old gate: on the parent the module is missing, so
// both read "the parent could not load the file" and one waiver line clears
// both. The gate now writes a hollow stand-in, so the vacuous test passes on the
// parent (GREEN ON PARENT — rejected) and the real one still fails for its own
// assertion reason.
// ---------------------------------------------------------------------------

describe("red-on-parent round 24 — a module the change adds, end to end", () => {
  const ADDED_MODULE: File = {
    path: "packages/core/src/added.ts",
    text: `export function twice(n: number): number {\n  return n * 2;\n}\n`,
  };
  const VACUOUS: File = {
    path: "packages/core/src/vacuous.test.ts",
    text: `import { expect, test } from "bun:test";
import { twice } from "./added";
test("vacuous", () => {
  expect(twice).toBeDefined();
  expect(true).toBe(true);
});
`,
  };
  const REAL: File = {
    path: "packages/core/src/real.test.ts",
    text: `import { expect, test } from "bun:test";
import { twice } from "./added";
test("real", () => {
  expect(twice(2)).toBe(4);
});
`,
  };

  test("a test that asserts nothing the added module produces is rejected", () => {
    const fixture = createFixture([PKG], [ADDED_MODULE, VACUOUS]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      // Against a hollow module `expect(twice).toBeDefined()` is still true —
      // hollow means "same export names, no behaviour" — so this test is GREEN
      // on the parent and pins nothing. Before the hollow it was WRONG REASON
      // RED with the same shape a genuinely unreachable test has.
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(stdout).not.toContain("WRONG-REASON-RED");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a test that asserts a value the added module produces is accepted", () => {
    const fixture = createFixture([PKG], [ADDED_MODULE, REAL]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a vacuous assertion against a CONST stand-in is accepted — by design, not a defect", () => {
    // ACCEPTED BY DESIGN. The second of the two shapes that pass on a stand-in
    // that asserts nothing. A const stand-in's VALUE is `undefined`, so
    // `expect(NEW_LIMIT).toBeDefined()` is false on the parent and true on the
    // change: an AssertionError, which the gate cannot tell from a real
    // assertion red. `expect(NEW_LIMIT).toBe(7)` would also pass, for the same
    // reason and with the same limitation.
    //
    // The asymmetry this produces is worth writing down, because it looks like a
    // bug and is not one: `expect(brandNew).toBeDefined()` on a FUNCTION export is
    // GREEN on the parent (a hollow function exists) and rejected, while the same
    // shape on a CONST export is accepted. What separates them is not the gate
    // being inconsistent, it is what a hollow can stand in for — a function whose
    // value exists, versus a const whose value cannot.
    const fixture = createFixture([PKG], [
      {
        path: "packages/core/src/limits.ts",
        text: `export const NEW_LIMIT = 7;\nexport function readLimit(): number {\n  return NEW_LIMIT;\n}\n`,
      },
      {
        path: "packages/core/src/limits.test.ts",
        text: `import { expect, test } from "bun:test";
import { NEW_LIMIT } from "./limits";
test("only checks the export exists", () => {
  expect(NEW_LIMIT).toBeDefined();
});
`,
      },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("GREEN-ON-PARENT");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a module a hollow cannot mirror fails the gate instead of being faked", () => {
    const fixture = createFixture([PKG], [
      { path: "packages/core/src/defaulted.ts", text: `const thing = 2;\nexport default thing;\n` },
      {
        path: "packages/core/src/defaulted.test.ts",
        text: `import { expect, test } from "bun:test";
import thing from "./defaulted";
test("real", () => {
  expect(thing).toBe(2);
});
`,
      },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("CANNOT-HOLLOW");
      expect(stdout).toContain("packages/core/src/defaulted.ts");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a waiver on the whole file is the only thing that clears it", () => {
    // The existing grammar, not a second one: the verdict's test name is
    // `(whole file)`, so a waiver that names it is what clears it.
    const fixture = createFixture([PKG], [
      { path: "packages/core/src/defaulted.ts", text: `const thing = 2;\nexport default thing;\n` },
      {
        path: "packages/core/src/defaulted.test.ts",
        text: `import { expect, test } from "bun:test";
import thing from "./defaulted";
// red-on-parent-waive: "whole file" — the module's default export has no faithful stand-in
test("real", () => {
  expect(thing).toBe(2);
});
`,
      },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("CANNOT-HOLLOW");
      expect(stdout).toContain("PASS (1 waived)");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a new test under scripts/ is judged, not skipped as outside the gate", () => {
    const fixture = createFixture([PKG], [
      {
        path: "scripts/mod.ts",
        text: `export function twice(n: number): number {\n  return n * 2;\n}\n`,
      },
      {
        path: "scripts/mod.test.ts",
        text: `import { expect, test } from "bun:test";
import { twice } from "./mod";
test("real", () => {
  expect(twice(2)).toBe(4);
});
`,
      },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("added test files: 1");
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("an added test under apps/ that imports no added module is still judged as before", () => {
    // No false rejection from the hollow path: a file with nothing to hollow runs
    // on the parent exactly as it did before this change.
    const fixture = createFixture([PKG, HELPER], [
      { path: "apps/api/src/hollow-free.test.ts", text: `import { expect, test } from "bun:test";
import { guard } from "../../../packages/core/src/helper";
test("real", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
` },
      { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("hollowed for");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Round 24, second finding: the two shapes that turned the gate red on the
// branch that switched it on.
//
// Turning `scripts/` into gated scope immediately ran the gate over this
// branch's own two added test files, and both failed for reasons that were the
// gate's, not the tests':
//
//   - a hollow function returns `undefined`, so a test that reads a property of
//     what the module produced dies with a TypeError before it can assert. Twelve
//     rows of `scripts/test-affected.test.ts` said WRONG REASON RED for that.
//   - `scripts/e2e-changed.test.ts` imports `specPaths` from a module the parent
//     HAS and the change extends. No mirror can stand in for that module, so the
//     file cannot load on the parent at all — and per-test waiver rows made that
//     one cause into forty lines, which the file-level waiver rule then refused.
// ---------------------------------------------------------------------------

function failureXml(type: string, name = "case"): string {
  return (
    '<testsuites><testsuite name="probe">' +
    `<testcase name="${name}" classname="probe">` +
    `<failure type="${type}" message="boom">${type}: boom</failure>` +
    "</testcase></testsuite></testsuites>"
  );
}

describe("red-on-parent round 24 — a hollowed file's TypeError is the test's own red", () => {
  test("a TypeError against the hollow passes as a right-reason red", () => {
    // `turboArgs(...).args` on a hollow is `undefined.args`. The test reached the
    // module and the red is about what the module does not do yet.
    const { verdicts } = classifyFileRun(
      { file: "scripts/mod.test.ts", junit: failureXml("TypeError"), stdout: "", error: "" },
      [],
      [],
      { hollowed: true },
    );
    expect(verdicts.map((verdict) => verdict.name)).toEqual(["RIGHT_REASON_RED"]);
  });

  test("the same TypeError in a file with no hollow is still a wrong-reason red", () => {
    // The ablation. Without a hollow in play there is nothing that could have
    // turned a property read into `undefined`, so the widening does not apply.
    const { verdicts } = classifyFileRun(
      { file: "apps/api/src/mod.test.ts", junit: failureXml("TypeError"), stdout: "", error: "" },
      [],
    );
    expect(verdicts.map((verdict) => verdict.name)).toEqual(["WRONG_REASON_RED"]);
  });

  test("a thrown Error in a hollowed file is still not the test's own red", () => {
    // The hook-throws discrimination survives: a `beforeEach` that throws reports
    // `Error`, and that shape is unchanged by having hollowed the file.
    const { verdicts } = classifyFileRun(
      { file: "scripts/mod.test.ts", junit: failureXml("Error"), stdout: "", error: "" },
      [],
      [],
      { hollowed: true },
    );
    expect(verdicts.map((verdict) => verdict.name)).toEqual(["WRONG_REASON_RED"]);
  });

  test("the verdict says it was judged against the stand-in", () => {
    const { verdicts } = classifyFileRun(
      { file: "scripts/mod.test.ts", junit: failureXml("TypeError"), stdout: "", error: "" },
      [],
      [],
      { hollowed: true },
    );
    expect(verdicts[0]?.detail).toContain("hollow stand-in");
  });
});

describe("red-on-parent round 24 — an export the parent's copy of an edited module lacks", () => {
  const TRANSCRIPT =
    "# Unhandled error between tests\n" +
    "-------------------------------\n" +
    "SyntaxError: Export named 'specPaths' not found in module " +
    "'C:\\tmp\\wt-abc\\scripts\\e2e-selection.ts'.\n" +
    "-------------------------------\n";

  test("bun's message gives the name and the module, not only the name", () => {
    expect(missingExportDetail(TRANSCRIPT)).toEqual({
      name: "specPaths",
      module: "C:\\tmp\\wt-abc\\scripts\\e2e-selection.ts",
    });
    expect(missingExportDetail("something else")).toBeNull();
  });

  test("a touched module named in the transcript is reported as unmirrorable", () => {
    const refusal = editedModuleExportRefusal(TRANSCRIPT, new Set(["scripts/e2e-selection.ts"]));
    expect(refusal).toContain("scripts/e2e-selection.ts");
    expect(refusal).toContain("`specPaths`");
  });

  test("a module the diff does not touch is left to the existing verdicts", () => {
    // A dependency the parent cannot resolve at all is a different case; the
    // gate must not claim it as its own shape.
    expect(editedModuleExportRefusal(TRANSCRIPT, new Set(["packages/core/src/other.ts"]))).toBeNull();
  });

  test("an added module is not reported this way, because the hollow path owns it", () => {
    // The caller passes `touched`, which is the changed set minus `added`, so an
    // added module never reaches this function. The contract is asserted by
    // CALLING it: a Set built only in the test proves nothing about the gate.
    // `touched` here is empty, which is what the caller's set arithmetic yields
    // for a module the diff adds.
    expect(editedModuleExportRefusal(TRANSCRIPT, new Set<string>())).toBeNull();
    // And the helper really does read the set it is given, so the `null` above is
    // the empty set's answer rather than a function that always returns null.
    expect(editedModuleExportRefusal(TRANSCRIPT, new Set(["scripts/e2e-selection.ts"]))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round 25 — a module the parent HAS, plus the exports the change adds.
//
// Round 24 ended with one waiver on `scripts/e2e-changed.test.ts`: the change
// adds `specPaths` to `scripts/e2e-selection.ts`, a module the parent already
// carries, so the parent cannot load the test file and forty-odd tests went
// unjudged. The hollow path cannot fix that — a stand-in for the whole module
// would erase behaviour the parent really has, and a test of that behaviour
// would then fail on the parent and read as a right-reason red.
//
// So the mirror is narrower. Keep the parent's module exactly as it is, append
// stand-ins for the export names the parent's copy does not have, and refuse
// every shape an appended declaration cannot carry. The distinction is the
// point: a hollow replaces a module the parent has none of, an augmentation
// preserves a module the parent has and adds names to it.
// ---------------------------------------------------------------------------

describe("red-on-parent round 25 — augmenting a module the parent already has", () => {
  const PARENT = `import { readFileSync } from "node:fs";

export function guard(n: number): number {
  if (n <= 0) throw new Error("zero");
  return n;
}
`;
  const CHANGE = `import { readFileSync } from "node:fs";

export function guard(n: number): number {
  if (n <= 0) throw new Error("ZERO");
  return n;
}

export function brandNew(n: number): number {
  return n + 1;
}
`;

  test("the parent's own source is kept, and only the missing name is appended", () => {
    const augmented = augmentModuleSource(PARENT, CHANGE, "scripts/mod.ts", ["brandNew"]);
    expect(augmented.ok).toBe(true);
    if (!augmented.ok) return;
    // Byte for byte: an existing behaviour cannot be faked by accident, which is
    // the whole difference between this and a hollow.
    expect(augmented.text.startsWith(PARENT)).toBe(true);
    expect(augmented.text).toContain("export function brandNew");
    expect(augmented.text).not.toContain("n + 1;");
    expect(augmented.text).not.toContain("ZERO");
  });

  test("the appended stand-in carries no behaviour, and says what it is", () => {
    const augmented = augmentModuleSource(PARENT, CHANGE, "scripts/mod.ts", ["brandNew"]);
    expect(augmented.ok).toBe(true);
    if (!augmented.ok) return;
    const appended = augmented.text.slice(PARENT.length);
    expect(appended).toContain("red-on-parent");
    expect(appended).not.toContain("n + 1");
    // The appended body is the hollow's: a function that returns undefined.
    expect(appended).toContain("return undefined;");
  });

  test("an export the parent already has is not appended again", () => {
    // A second `export function guard` in the same file is a duplicate
    // declaration, so the augmented file would not load at all — the one way an
    // augmentation can do more damage than the refusal it replaced.
    const augmented = augmentModuleSource(PARENT, CHANGE, "scripts/mod.ts", ["brandNew"]);
    expect(augmented.ok).toBe(true);
    if (!augmented.ok) return;
    expect(augmented.text.match(/export function guard/gu)?.length).toBe(1);
    expect(augmented.text).not.toContain('Error("ZERO")');
  });

  test("a parent copy that does not parse is refused, not appended to", () => {
    // Appending to broken text produces broken text that loads nowhere, so the
    // file would read as a load failure the gate never explained.
    const augmented = augmentModuleSource(
      "export function guard(n: number): number {\n  return n;\n",
      "export function guard(n: number): number {\n  return n;\n}\nexport function brandNew(): number {\n  return 1;\n}\n",
      "scripts/mod.ts",
      ["brandNew"],
    );
    expect(augmented.ok).toBe(false);
    if (augmented.ok) return;
    expect(augmented.refusal).toContain("scripts/mod.ts");
    expect(augmented.refusal).toContain("parse");
  });

  test("every shape an appended declaration cannot carry is refused", () => {
    // The refusal set of the hollow writer, for the same reason: a mirror that
    // guesses is worse than a refusal. Each entry is the change's copy of the
    // module, with the export the parent lacks written in that shape.
    const cases: Array<{ name: string; source: string; why: string }> = [
      { name: "Mode", source: "export enum Mode {\n  One,\n}\n", why: "enum" },
      { name: "util", source: "export namespace util {\n  export const a = 1;\n}\n", why: "namespace" },
      { name: "default", source: "const thing = 2;\nexport default thing;\n", why: "default" },
      { name: "brandNew", source: `export { brandNew } from "./other";\n`, why: "re-export" },
      {
        name: "brandNew",
        source: "function brandNew() {\n  return 1;\n}\nexport { brandNew };\n",
        why: "export list",
      },
      { name: "brandNew", source: "export declare const brandNew: number;\n", why: "declare" },
    ];
    for (const entry of cases) {
      const augmented = augmentModuleSource(PARENT, entry.source, "scripts/mod.ts", [entry.name]);
      expect({ name: entry.name, ok: augmented.ok }).toEqual({ name: entry.name, ok: false });
      if (augmented.ok) continue;
      expect({ name: entry.name, refusal: augmented.refusal }).toEqual({
        name: entry.name,
        refusal: expect.stringContaining(entry.why),
      });
    }
  });

  test("the augmented module declares exactly the parent's names plus the appended ones", () => {
    const augmented = augmentModuleSource(PARENT, CHANGE, "scripts/mod.ts", ["brandNew"]);
    expect(augmented.ok).toBe(true);
    if (!augmented.ok) return;
    expect(declaredExportNames("scripts/mod.ts", augmented.text)).toEqual(["brandNew", "guard"]);
  });

  test("a module with nothing missing is left byte-identical", () => {
    const augmented = augmentModuleSource(PARENT, CHANGE, "scripts/mod.ts", []);
    expect(augmented).toEqual({ ok: true, text: PARENT });
  });
});

// ---------------------------------------------------------------------------
// Round 26 — the clash set is every top-level binding, not only the exports.
//
// The check used to ask whether the appended statement redeclares a name the
// parent EXPORTS, which is not the question. A declaration collides with any
// binding in the parent's module scope, exported or not, and the ordinary way a
// module gains an export is to promote a module-local binding to one:
//
//   parent  const specPaths = ["a"];
//   change  export const specPaths = ["a"];
//
// The old check saw no clash (`specPaths` is not exported on the parent), wrote
// `export const specPaths = undefined;` after the parent's own declaration, and
// passed its self-check — which re-parses the text and compares EXPORT names, so
// it saw exactly the names it wanted. `syntaxErrorCount` did not save it either:
// it reads `transpileModule` diagnostics, and a duplicate declaration is not a
// syntax error.
//
// The consequence was worse than one bad row: the augmented module cannot load,
// so every test in the file reads as a load failure, and the remedy the report
// prints is "point the gate at a parent that already has it" or "waive it" —
// both wrong, because the parent does have it.
// ---------------------------------------------------------------------------

describe("red-on-parent round 26 — an appended stand-in clashes with every parent binding", () => {
  // The local binding the change exports. Nothing about `specPaths` changed; the
  // parent simply cannot re-export a name it never exported.
  const PARENT = `const specPaths = ["a"];\nexport function select(): string[] {\n  return specPaths;\n}\n`;
  const CHANGE = `export const specPaths = ["a"];\nexport function select(): string[] {\n  return specPaths;\n}\n`;

  test("a module-local const the change promotes to an export is refused, not appended twice", () => {
    const augmented = augmentModuleSource(PARENT, CHANGE, "scripts/mod.ts", ["specPaths"]);
    // Refused, because the parent's own `const specPaths` is already there and a
    // second declaration of it would not load.
    expect({ ok: augmented.ok }).toEqual({ ok: false });
    if (augmented.ok) return;
    expect(augmented.refusal).toContain("scripts/mod.ts");
    expect(augmented.refusal).toContain("specPaths");
  });

  test("a module-local function, class and type the change exports are refused the same way", () => {
    // One shape per declaration kind, because the clash set is built by kind too:
    // a fix that only widened the variable branch would leave these three open.
    const cases: Array<{ kind: string; parent: string; change: string; name: string }> = [
      {
        kind: "function",
        parent: `function helper(): number {\n  return 1;\n}\nexport const n = helper();\n`,
        change: `export function helper(): number {\n  return 1;\n}\nexport const n = helper();\n`,
        name: "helper",
      },
      {
        kind: "class",
        parent: `class Box {\n  value = 1;\n}\nexport const boxes = [new Box()];\n`,
        change: `export class Box {\n  value = 1;\n}\nexport const boxes = [new Box()];\n`,
        name: "Box",
      },
      {
        kind: "type",
        parent: `type Mode = "a";\nexport function mode(): Mode {\n  return "a";\n}\n`,
        change: `export type Mode = "a";\nexport function mode(): Mode {\n  return "a";\n}\n`,
        name: "Mode",
      },
    ];
    for (const entry of cases) {
      const augmented = augmentModuleSource(entry.parent, entry.change, "scripts/mod.ts", [entry.name]);
      expect({ kind: entry.kind, ok: augmented.ok }).toEqual({ kind: entry.kind, ok: false });
      if (augmented.ok) continue;
      expect({ kind: entry.kind, refusal: augmented.refusal }).toEqual({
        kind: entry.kind,
        refusal: expect.stringContaining(entry.name),
      });
    }
  });

  test("an imported binding the change tries to redeclare is refused too", () => {
    // An import binding is as much a top-level binding as a `const`. Appending a
    // declaration of it is a duplicate declaration, and the parent's import is
    // the one that would win or lose depending on hoisting — which is not a
    // question the gate may leave to chance.
    const parent = `import { readFileSync } from "node:fs";\nexport function read(p: string): string {\n  return readFileSync(p, "utf8");\n}\n`;
    const change = `export function readFileSync(p: string): string {\n  return p;\n}\nexport function read(p: string): string {\n  return p;\n}\n`;
    const augmented = augmentModuleSource(parent, change, "scripts/mod.ts", ["readFileSync"]);
    expect({ ok: augmented.ok }).toEqual({ ok: false });
    if (augmented.ok) return;
    expect(augmented.refusal).toContain("readFileSync");
  });

  test("exportedNameSet and topLevelBindingSet disagree on exactly the local bindings", () => {
    // The two readers, side by side: the fix is only correct if the binding
    // reader is a strict superset of the export reader on the same source. A
    // future edit that narrowed either one breaks this before it breaks the gate.
    const bindings = topLevelBindingNames("scripts/mod.ts", PARENT);
    const exports = declaredExportNames("scripts/mod.ts", PARENT);
    expect(bindings).toContain("specPaths");
    expect(bindings).toContain("select");
    expect(exports).toEqual(["select"]);
    for (const name of exports) expect(bindings).toContain(name);
  });

  test("a parent binding of a different name does not block the stand-in", () => {
    // The fix must not be "refuse everything": a same-named binding is the only
    // thing a declaration collides with, so a module-local name the change did
    // not export leaves the append available.
    const parent = `const internal = 3;\nexport function read(): number {\n  return internal;\n}\n`;
    const change = `const internal = 3;\nexport function read(): number {\n  return internal;\n}\nexport function brandNew(): number {\n  return internal + 1;\n}\n`;
    const augmented = augmentModuleSource(parent, change, "scripts/mod.ts", ["brandNew"]);
    expect({ ok: augmented.ok }).toEqual({ ok: true });
    if (!augmented.ok) return;
    expect(augmented.text.startsWith(parent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 26 — one statement declaring two names is appended once.
//
// `export const b = 2, c = 3;` answers the lookup for both `b` and `c`, so a
// request for both used to append the same statement twice and declare each name
// twice. And when the parent already binds only `c`, a request for `b` alone was
// refused with "`b` is declared beside `c`" — correct refusal, message that reads
// like a gate bug, because `b` is not the problem.
// ---------------------------------------------------------------------------

describe("red-on-parent round 26 — a shared variable statement is appended once, and the refusal names it", () => {
  const PARENT = `export function read(): number {\n  return 1;\n}\n`;
  const CHANGE = `export function read(): number {\n  return 1;\n}\nexport const b = 2, c = 3;\n`;

  test("both names in one statement are appended once, and the module still loads", () => {
    const augmented = augmentModuleSource(PARENT, CHANGE, "scripts/mod.ts", ["b", "c"]);
    expect({ ok: augmented.ok }).toEqual({ ok: true });
    if (!augmented.ok) return;
    // One appended statement, so each name is declared once: two copies would be
    // a duplicate declaration and the file would not load at all.
    expect(augmented.text.match(/export const b/gu)?.length).toBe(1);
    expect(augmented.text.match(/export const c/gu)?.length).toBe(1);
    expect(topLevelBindingNames("scripts/mod.ts", augmented.text)).toEqual(["b", "c", "read"]);
    expect(declaredExportNames("scripts/mod.ts", augmented.text)).toEqual(["b", "c", "read"]);
  });

  test("a clash on a sibling name says the statement is what cannot be appended", () => {
    // The parent binds `c`; the change declares `b` and `c` in one statement. `b`
    // itself is free, so a message about `b` is misleading: the appended text is
    // the whole statement, and that statement cannot go in.
    const parent = `export function read(): number {\n  return 1;\n}\nexport const c = 30;\n`;
    const augmented = augmentModuleSource(parent, CHANGE, "scripts/mod.ts", ["b"]);
    expect({ ok: augmented.ok }).toEqual({ ok: false });
    if (augmented.ok) return;
    // Names the declaration, and the sibling that blocks it, and the consequence.
    expect(augmented.refusal).toContain("export const b = 2, c = 3;");
    expect(augmented.refusal).toContain("`c`");
    expect(augmented.refusal).toContain("no stand-in");
    // And it does not claim `b` is the one the parent already has.
    expect(augmented.refusal).not.toContain("already binds `b`");
  });

  test("a clash on the requested name itself says the parent already binds it", () => {
    const parent = `const b = 20;\nexport function read(): number {\n  return b;\n}\n`;
    const augmented = augmentModuleSource(parent, CHANGE, "scripts/mod.ts", ["b"]);
    expect({ ok: augmented.ok }).toEqual({ ok: false });
    if (augmented.ok) return;
    expect(augmented.refusal).toContain("already binds `b`");
    expect(augmented.refusal).toContain("declaring it twice");
  });

  test("a destructured parent binding is in the clash set too", () => {
    // `const { b } = obj` is a top-level binding of `b` with no simple name node,
    // so a clash reader that only walked identifiers would miss it.
    const parent = `const source = { b: 20 };\nconst { b } = source;\nexport function read(): number {\n  return b;\n}\n`;
    const augmented = augmentModuleSource(parent, CHANGE, "scripts/mod.ts", ["b"]);
    expect({ ok: augmented.ok }).toEqual({ ok: false });
  });
});

describe("red-on-parent round 25 — which module the gate augments, and with which names", () => {
  const TOUCHED = new Set(["scripts/e2e-selection.ts"]);
  const PARENT = `export type Scope = { mode: string };\nexport function select(changed: string[]): Scope {\n  return { mode: "affected" };\n}\n`;
  const CHANGE = `export type Scope = { mode: string };\nexport function select(changed: string[]): Scope {\n  return { mode: "affected" };\n}\nexport function specPaths(scope: Scope): string[] {\n  return [];\n}\n`;
  const readChange = (path: string): string | null =>
    path === "scripts/e2e-selection.ts" ? CHANGE : null;
  const readParent = (path: string): string | null =>
    path === "scripts/e2e-selection.ts" ? PARENT : null;

  const TEST_FILE = `import { select, specPaths, type Scope } from "./e2e-selection";\n`;

  test("the names the test imports but the parent lacks are the ones appended", () => {
    const plan = planAugmentedModules(
      "scripts/e2e-changed.test.ts",
      TEST_FILE,
      TOUCHED,
      readChange,
      readParent,
    );
    expect(plan.refusal).toBeNull();
    expect(plan.modules.map((module) => module.path)).toEqual(["scripts/e2e-selection.ts"]);
    expect(plan.modules[0]?.names).toEqual(["specPaths"]);
    expect(plan.modules[0]?.importedBy).toBe("scripts/e2e-changed.test.ts");
    // The parent's module is carried into the worktree, not replaced.
    expect(plan.modules[0]?.text.startsWith(PARENT)).toBe(true);
  });

  test("a type-only name is never appended, because it is erased before the file runs", () => {
    const plan = planAugmentedModules(
      "scripts/e2e-changed.test.ts",
      `import { type SelectionMap, specPaths } from "./e2e-selection";\n`,
      TOUCHED,
      readChange,
      readParent,
    );
    expect(plan.refusal).toBeNull();
    expect(plan.modules[0]?.names).toEqual(["specPaths"]);
  });

  test("a module the diff does not touch is left alone", () => {
    const plan = planAugmentedModules(
      "scripts/e2e-changed.test.ts",
      `import { anything } from "./untouched";\n`,
      TOUCHED,
      readChange,
      readParent,
    );
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toBeNull();
  });

  test("a module the test imports only names the parent already has is not written", () => {
    const plan = planAugmentedModules(
      "scripts/e2e-changed.test.ts",
      `import { select } from "./e2e-selection";\n`,
      TOUCHED,
      readChange,
      readParent,
    );
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toBeNull();
  });

  test("a parent copy the gate cannot read is a refusal, not a silent skip", () => {
    const plan = planAugmentedModules(
      "scripts/e2e-changed.test.ts",
      TEST_FILE,
      TOUCHED,
      readChange,
      () => null,
    );
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toContain("scripts/e2e-selection.ts");
  });

  test("a change copy the gate cannot read is a refusal too", () => {
    const plan = planAugmentedModules(
      "scripts/e2e-changed.test.ts",
      TEST_FILE,
      TOUCHED,
      () => null,
      readParent,
    );
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toContain("scripts/e2e-selection.ts");
  });
});

describe("red-on-parent round 25 — the report tells an augmentation from a hollow", () => {
  test("the augmented block names the module, the appended exports and the file", () => {
    const run: GateRun = {
      baseSha: "a1b2c3d4e5f6",
      worktree: "(none)",
      worktreeCreated: false,
      installLog: "",
      files: ["scripts/e2e-changed.test.ts"],
      verdicts: [],
      stdoutByFile: new Map(),
      problems: [],
      uncommitted: [],
      skipped: [],
      hollowed: [],
      augmented: [
        {
          path: "scripts/e2e-selection.ts",
          importedBy: "scripts/e2e-changed.test.ts",
          names: ["specPaths"],
        },
      ],
    };
    const report = renderReport(run, []);
    expect(report).toContain("scripts/e2e-selection.ts");
    expect(report).toContain("specPaths");
    expect(report).toContain("for scripts/e2e-changed.test.ts");
    // A reader must not read this as a fake of the whole module.
    expect(report).not.toContain("hollowed for scripts/e2e-changed.test.ts");
  });
});

describe("red-on-parent round 25 — a module the parent has, plus its new export, end to end", () => {
  // `helper.ts` exists on the parent; the change edits it and adds `brandNew`.
  // The appended stand-in is what makes the file load on the parent at all.
  const REAL_TEST = `import { expect, test } from "bun:test";
import { brandNew } from "../../../packages/core/src/helper";
test("real", () => {
  expect(brandNew(2)).toBe(2);
});
`;
  const VACUOUS_TEST = `import { expect, test } from "bun:test";
import { brandNew } from "../../../packages/core/src/helper";
test("vacuous", () => {
  expect(brandNew).toBeDefined();
});
`;
  const EXISTING_TEST = `import { expect, test } from "bun:test";
import { guard } from "../../../packages/core/src/helper";
test("existing behaviour", () => {
  expect(guard(2)).toBe(2);
});
`;

  test("a test that calls the appended export fails on the parent for its own reason", () => {
    const fixture = createFixture([PKG, HELPER], [
      { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
      { path: "apps/api/src/new-export.test.ts", text: REAL_TEST },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("CANNOT-HOLLOW");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a test that asserts nothing the appended export produces is rejected", () => {
    const fixture = createFixture([PKG, HELPER], [
      { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
      { path: "apps/api/src/new-export-vacuous.test.ts", text: VACUOUS_TEST },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(stdout).not.toContain("CANNOT-HOLLOW");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("the parent's own behaviour stays real, so a test of it is not faked into a red", () => {
    // The shape that separates augmentation from hollowing. `guard(2)` is 2 on
    // both sides, so the test is GREEN ON PARENT and must be rejected. A hollow
    // of `helper.ts` would have replaced `guard` with a stand-in, turned this
    // into a TypeError, and accepted it as a right-reason red.
    const fixture = createFixture([PKG, HELPER], [
      { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
      { path: "apps/api/src/existing-behaviour.test.ts", text: EXISTING_TEST },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(stdout).not.toContain("RIGHT-REASON-RED");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a TypeError on an AUGMENTED file is accepted, and that is by design, not a defect", () => {
    // ACCEPTED BY DESIGN. This fixture exists so the next reader does not
    // rediscover it as a bug, and so a change to the behaviour is deliberate.
    //
    // The test dereferences the value the appended stand-in produces. On the
    // parent the stand-in returns `undefined`, so `undefined.mode` is a TypeError
    // before any assertion runs; on the change the real export returns the object
    // and the assertion passes. The gate reads that TypeError as the test's own
    // red, because in a HOLLOWED file nothing but the gate's fake could have
    // produced it.
    //
    // In an AUGMENTED file the parent's real code is still there and still runs,
    // so a TypeError has a second possible cause the gate cannot see: the parent's
    // own code. This is the residual hole, stated rather than hidden. Closing it
    // needs a stronger discrimination than junit's failure type can carry, which
    // is a design change, not a fix.
    const fixture = createFixture([PKG, HELPER], [
      {
        path: "packages/core/src/helper.ts",
        text: `export function guard(n: number): number {\n  if (n <= 0) throw new Error("ZERO");\n  return n;\n}\nexport function brandNew(): { mode: string } {\n  return { mode: "affected" };\n}\n`,
      },
      {
        path: "apps/api/src/dereferences-a-standin.test.ts",
        text: `import { expect, test } from "bun:test";
import { brandNew } from "../../../packages/core/src/helper";
test("dereferences the appended stand-in", () => {
  expect(brandNew().mode).toBe("affected");
});
`,
      },
    ]);
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("WRONG-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Round 27 — the Greptile P1s at b9f9cc4e.
//
// Three findings, none of them about a verdict class: a stand-in that cannot
// load, a stand-in that shadows a name the parent really supplies (a false
// pass), and a waiver that excuses a parent run that never finished.
// ---------------------------------------------------------------------------

describe("red-on-parent round 27 — a JavaScript module's stand-in loads", () => {
  /**
   * Load the hollow in a real bun process.
   *
   * The property under test is "this text parses and runs", and no amount of
   * string inspection answers it: `..._args: unknown[]` looks perfectly
   * reasonable in a template literal and is a syntax error in a `.js` file.
   */
  function loadHollow(name: string, hollowText: string) {
    const dir = mkdtempSync(join(tmpdir(), "ronp-hollow-"));
    try {
      writeFileSync(join(dir, "package.json"), `{ "type": "module" }\n`);
      writeFileSync(join(dir, name), hollowText);
      writeFileSync(
        join(dir, "run.mjs"),
        `import * as mod from "./${name}";\n` +
          `if (typeof mod.twice !== "function") throw new Error("twice is not a function");\n` +
          `if (mod.twice(2) !== undefined) throw new Error("the stand-in carries behaviour");\n` +
          `console.log("LOADED");\n`,
      );
      const result = spawnSync(process.execPath, [join(dir, "run.mjs")], { encoding: "utf8" });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: result.status,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a .js module's stand-in is JavaScript, so the parent can load it", () => {
    const hollow = hollowModuleSource(
      `export function twice(n) {\n  return n * 2;\n}\n`,
      "scripts/mod.js",
    );
    expect(hollow.ok).toBe(true);
    if (!hollow.ok) return;
    // No parameter or return annotation: the file is JavaScript, and bun does
    // not type-check, so an annotation here is a load error rather than a
    // harmless extra.
    expect(hollow.text).not.toContain(": unknown");
    expect(hollow.text).not.toContain("unknown[]");
    const run = loadHollow("mod.js", hollow.text);
    expect({ stdout: run.stdout, status: run.status }).toEqual({ stdout: "LOADED\n", status: 0 });
  });

  test("a .mjs module's stand-in is JavaScript too", () => {
    const hollow = hollowModuleSource(
      `export function twice(n) {\n  return n * 2;\n}\n`,
      "scripts/mod.mjs",
    );
    expect(hollow.ok).toBe(true);
    if (!hollow.ok) return;
    const run = loadHollow("mod.mjs", hollow.text);
    expect({ stdout: run.stdout, status: run.status }).toEqual({ stdout: "LOADED\n", status: 0 });
  });
});

describe("red-on-parent round 27 — a test importing a new .js module, end to end", () => {
  // The fixture Greptile named: an added test imports a `.js` module the same
  // change adds. The stand-in for it is written into the parent worktree, and a
  // TypeScript annotation in that stand-in is a load error rather than a red.
  const TEST_FILE = `import { expect, test } from "bun:test";
import { twice } from "./doubles.js";
test("doubles", () => {
  expect(twice(2)).toBe(4);
});
`;

  test("the parent loads the JavaScript stand-in and judges the test on its assertion", () => {
    const fixture = createFixture(
      [PKG],
      [
        { path: "packages/core/src/doubles.js", text: `export function twice(n) {\n  return n * 2;\n}\n` },
        { path: "packages/core/src/doubles.test.ts", text: TEST_FILE },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("WRONG-REASON-RED");
      expect(stdout).not.toContain("CANNOT-HOLLOW");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 27 — a stand-in never shadows a name the parent supplies", () => {
  const TOUCHED = new Set(["scripts/mod.ts"]);

  test("an export list and a re-export list name their exports", () => {
    // The names are literal, so there is nothing to resolve: `export { a }` and
    // `export { a } from "./y"` both put `a` on the module.
    expect(declaredExportNames("scripts/mod.ts", `const a = 1;\nexport { a };\n`)).toEqual(["a"]);
    expect(
      declaredExportNames("scripts/mod.ts", `export { a, b as c } from "./other";\n`),
    ).toEqual(["a", "c"]);
    expect(declaredExportNames("scripts/mod.ts", `export * as ns from "./other";\n`)).toEqual([
      "ns",
    ]);
  });

  const CHANGE = `export function value(): number {\n  return 1;\n}\n`;
  const TEST_FILE = `import { value } from "./mod";\n`;

  function planFor(parent: string, parentFiles: Record<string, string> = {}) {
    return planAugmentedModules(
      "scripts/mod.test.ts",
      TEST_FILE,
      TOUCHED,
      (path) => (path === "scripts/mod.ts" ? CHANGE : null),
      (path) => (path === "scripts/mod.ts" ? parent : (parentFiles[path] ?? null)),
    );
  }

  test("a name the parent supplies through an export list is not appended", () => {
    const plan = planFor(`const value = (): number => 1;\nexport { value };\n`);
    expect(plan.refusal).toBeNull();
    expect(plan.modules).toEqual([]);
  });

  test("a name the parent supplies by re-export is not appended", () => {
    const plan = planFor(`export { value } from "./base";\n`, {
      "scripts/base.ts": `export function value(): number {\n  return 1;\n}\n`,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.modules).toEqual([]);
  });

  test("an export star is followed through the parent worktree to the name it supplies", () => {
    // Two hops, so a one-level resolution is not enough to pass this.
    const plan = planFor(`export * from "./base";\n`, {
      "scripts/base.ts": `export * from "./deep";\n`,
      "scripts/deep.ts": `export function value(): number {\n  return 1;\n}\n`,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.modules).toEqual([]);
  });

  test("an export star the gate cannot resolve refuses the augmentation", () => {
    // The names such a module supplies are unknowable from this file, and an
    // appended stand-in for one of them would shadow the parent's real export —
    // a test that passes on the parent would be scored a right-reason red. Fail
    // closed instead.
    const plan = planFor(`export * from "./nowhere";\n`);
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toContain("scripts/mod.ts");
    expect(plan.refusal).toContain("./nowhere");
  });

  test("a resolvable star that does not supply the name still gets the stand-in", () => {
    const plan = planFor(`export * from "./base";\n`, {
      "scripts/base.ts": `export function other(): number {\n  return 0;\n}\n`,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.modules.map((module) => module.names)).toEqual([["value"]]);
  });
});

describe("red-on-parent round 27 — a re-exported name the parent supplies, end to end", () => {
  // The false pass Greptile named. On the parent, `helper.ts` supplies `value`
  // through `export *`; the change replaces that with a direct declaration. A
  // test of the parent's own behaviour passes here — so it pins nothing the
  // change adds and must be scored GREEN-ON-PARENT.
  //
  // Appending an empty `value` stand-in to the parent's copy SHADOWS the real
  // re-export: the test then reads `undefined`, and the gate accepts its
  // assertion failure as a right-reason red. A test that pins nothing is scored
  // as a test that pins something.
  const PARENT_HELPER = `export * from "./helper-base";\n`;
  const PARENT_BASE = `export function value(): number {\n  return 1;\n}\n`;
  const CHANGE_HELPER = `export function value(): number {\n  return 1;\n}\n`;
  const SHADOW_TEST = `import { expect, test } from "bun:test";
import { value } from "./helper";
test("the parent's own export", () => {
  expect(value()).toBe(1);
});
`;

  test("a test of the parent's real behaviour is rejected, not accepted on a shadow", () => {
    const fixture = createFixture(
      [
        PKG,
        { path: "packages/core/src/helper.ts", text: PARENT_HELPER },
        { path: "packages/core/src/helper-base.ts", text: PARENT_BASE },
      ],
      [
        { path: "packages/core/src/helper.ts", text: CHANGE_HELPER },
        { path: "packages/core/src/star-shadow.test.ts", text: SHADOW_TEST },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(stdout).not.toContain("RIGHT-REASON-RED");
      // No stand-in is appended, so there is no augmentation to report either.
      expect(stdout).not.toContain("appended stand-in");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 27 — a waiver cannot excuse an unfinished parent run", () => {
  // Two defects in one ordering. A refusal replaces EVERY parent verdict with a
  // waivable CANNOT_HOLLOW row, and the planner can refuse on an import no load
  // takes — a lazy `import()` inside a function body — so the parent's real run
  // is discarded for a claim about a file it did load.
  const MODE = `export enum Mode {\n  One,\n}\n`;

  test("a whole-file waiver does not clear a parent run that never finished", () => {
    // The hang is on the parent only: `PHASE` is "parent" there, so the parent's
    // run times out while the change's run finishes and passes. The added module
    // with the enum is reached only through a lazy import, so the file still
    // loads and the hang is the only thing the parent's run has to say.
    const fixture = createFixture(
      [
        PKG,
        {
          path: "packages/core/src/helper.ts",
          text: `export const PHASE = "parent";\nexport function guard(n: number): number {\n  if (n <= 0) throw new Error("zero");\n  return n;\n}\n`,
        },
      ],
      [
        {
          path: "packages/core/src/helper.ts",
          text: `export const PHASE = "change";\nexport function guard(n: number): number {\n  if (n <= 0) throw new Error("ZERO");\n  return n;\n}\n`,
        },
        { path: "packages/core/src/mode.ts", text: MODE },
        {
          path: "packages/core/src/refused-and-hung.test.ts",
          text: `import { expect, test } from "bun:test";
import { PHASE, guard } from "./helper";

async function later() {
  const { Mode } = await import("./mode.ts");
  return Mode;
}

test("hangs on the parent only", async () => {
  if (PHASE === "parent") await new Promise(() => {});
  expect(() => guard(0)).toThrow("ZERO");
  expect(await later()).toBeDefined();
});
// red-on-parent-waive: "whole file" — the module this file needs has no faithful hollow
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(
        fixture,
        { RED_ON_PARENT_TEST_TIMEOUT_MS: "1500" },
        [],
        20_000,
      );
      expect(stdout).toContain("RUN-INCOMPLETE");
      expect(stdout).toContain("did not complete");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a refusal about a lazily imported module does not replace the parent's own verdicts", () => {
    // `mode.ts` is added and imported only inside `later()`, which the test never
    // calls. The parent loads the file and runs the test, so its verdict is the
    // test's own assertion red — not a whole-file refusal about a module the
    // parent never asked for.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        { path: "packages/core/src/mode.ts", text: MODE },
        {
          path: "packages/core/src/lazy-import.test.ts",
          text: `import { expect, test } from "bun:test";
import { guard } from "./helper";

async function later() {
  const { Mode } = await import("./mode.ts");
  return Mode;
}

test("rejects zero", () => {
  expect(() => guard(0)).toThrow("ZERO");
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("CANNOT-HOLLOW");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Round 28 — the fail-closed refusal that c56ecd73 added fires too eagerly.
//
// Both findings are side effects of closing the star-shadow false pass, and both
// push in the same direction: a file the gate could judge with a stand-in became
// a whole-file waiver instead. That direction degrades a gate into noise, so it
// is fixed by narrowing the question, not by widening the refusal.
// ---------------------------------------------------------------------------

describe("red-on-parent round 28 — a runtime export set excludes the shapes the runtime erases", () => {
  const PATH = "scripts/mod.ts";

  test("a type-only re-export list names nothing the runtime has", () => {
    expect(runtimeExportNames(PATH, `export type { value } from "./types";\n`)).toEqual([]);
  });

  test("a type-only specifier inside an export list is dropped, its sibling kept", () => {
    expect(runtimeExportNames(PATH, `export { type a, b } from "./other";\n`)).toEqual(["b"]);
    expect(runtimeExportNames(PATH, `const a = 1;\nconst b = 2;\nexport { type a, b };\n`)).toEqual([
      "b",
    ]);
  });

  test("a type alias and an interface are erased; a function, a const and an enum are not", () => {
    expect(
      runtimeExportNames(
        PATH,
        `export type Shape = { a: number };\nexport interface Port {\n  b: string;\n}\nexport function run(): void {}\nexport const FLAG = 1;\nexport enum Mode {\n  One,\n}\n`,
      ),
    ).toEqual(["FLAG", "Mode", "run"]);
  });

  test("a type-only star supplies nothing, and `export * as ns` supplies the namespace object", () => {
    expect(
      runtimeExportNames(PATH, `export type * from "./types";\nexport * as ns from "./other";\n`),
    ).toEqual(["ns"]);
  });

  test("an ambient declare export emits no runtime value, so it is not in the set", () => {
    expect(runtimeExportNames(PATH, `export declare const table: number;\n`)).toEqual([]);
  });

  test("declaredExportNames is unchanged: it answers the declared shape, not the runtime one", () => {
    // The reader the type-only fix must NOT rewrite. `hollowModuleSource` compares
    // a module's declared shape against its mirror, and a mirror of an interface
    // is the only honest mirror of an interface. Widening this set to the runtime
    // answer would make a faithful hollow look like an unfaithful one.
    expect(declaredExportNames(PATH, `export type { value } from "./types";\n`)).toEqual(["value"]);
    expect(declaredExportNames(PATH, `export interface Port {}\n`)).toEqual(["Port"]);
  });
});

describe("red-on-parent round 28 — a type-only export does not hide a runtime name", () => {
  // The parent re-exports `value` as a TYPE and the change makes it a runtime
  // export. Counting the type-only name as present appended nothing, so the
  // parent's `import { value }` failed to resolve and a file that could be judged
  // with a stand-in became CANNOT-HOLLOW plus a whole-file waiver.
  const TOUCHED = new Set(["scripts/mod.ts"]);
  const PARENT = `export type { value } from "./types";\nexport function twice(n: number): number {\n  return n * 2;\n}\n`;
  const CHANGE = `export type { value } from "./types";\nexport function twice(n: number): number {\n  return n * 2;\n}\nexport function value(): number {\n  return 7;\n}\n`;
  const TEST_FILE = `import { value } from "./mod";\n`;

  function planFor(parent: string, change: string, testFile = TEST_FILE) {
    return planAugmentedModules(
      "scripts/mod.test.ts",
      testFile,
      TOUCHED,
      (path) => (path === "scripts/mod.ts" ? change : null),
      (path) => (path === "scripts/mod.ts" ? parent : null),
    );
  }

  test("a runtime name the parent only declares as a type still gets its stand-in", () => {
    const plan = planFor(PARENT, CHANGE);
    expect(plan.refusal).toBeNull();
    expect(plan.modules.map((module) => module.names)).toEqual([["value"]]);
  });

  test("the augmented text keeps the parent's type-only export and appends the runtime one", () => {
    const plan = planFor(PARENT, CHANGE);
    const text = plan.modules[0]?.text ?? "";
    expect(text.startsWith(PARENT)).toBe(true);
    expect(runtimeExportNames("scripts/mod.ts", text)).toEqual(["twice", "value"]);
    expect(declaredExportNames("scripts/mod.ts", text)).toEqual(["twice", "value", "value"]);
  });

  test("a type-only name the test imports as a type is still never appended", () => {
    // The sibling case, so the fix cannot be read as "append every type-only name
    // too": an `import { type Shape }` clause is erased and needs no stand-in.
    const plan = planFor(PARENT, CHANGE, `import { type Shape, value } from "./mod";\n`);
    expect(plan.refusal).toBeNull();
    expect(plan.modules.map((module) => module.names)).toEqual([["value"]]);
  });
});

describe("red-on-parent round 28 — an unrelated re-export does not refuse another module", () => {
  // Module A carries `export * from "some-package"` and the test imports only a
  // name A declares itself. Module B is where the change adds a name. Following
  // A's star chain refused the whole plan, so B's stand-in was dropped and the
  // file became a whole-file waiver over a module the test barely uses.
  const PARENT_A = `export * from "some-package";\nexport function existing(): number {\n  return 1;\n}\n`;
  const CHANGE_A = `export * from "some-package";\nexport function existing(): number {\n  return 1;\n}\nexport function alsoNew(): number {\n  return 5;\n}\n`;
  const PARENT_B = `export const other = 1;\n`;
  const CHANGE_B = `export const other = 1;\nexport function brandNew(): number {\n  return 2;\n}\n`;
  const TOUCHED = new Set(["scripts/a.ts", "scripts/b.ts"]);

  const readChange = (path: string): string | null =>
    path === "scripts/a.ts" ? CHANGE_A : path === "scripts/b.ts" ? CHANGE_B : null;
  const readParent = (path: string): string | null =>
    path === "scripts/a.ts" ? PARENT_A : path === "scripts/b.ts" ? PARENT_B : null;

  test("a module whose names the parent declares directly never has its star chain consulted", () => {
    const plan = planAugmentedModules(
      "scripts/two-modules.test.ts",
      `import { existing } from "./a";\nimport { brandNew } from "./b";\n`,
      TOUCHED,
      readChange,
      readParent,
    );
    expect(plan.refusal).toBeNull();
    expect(plan.modules.map((module) => module.path)).toEqual(["scripts/b.ts"]);
    expect(plan.modules[0]?.names).toEqual(["brandNew"]);
    // B's stand-in, not a refusal about A's package specifier.
    expect(plan.modules[0]?.text.startsWith(PARENT_B)).toBe(true);
  });

  test("the same module alone, asked for nothing it lacks, is left alone", () => {
    const plan = planAugmentedModules(
      "scripts/a-only.test.ts",
      `import { existing } from "./a";\n`,
      TOUCHED,
      readChange,
      readParent,
    );
    expect(plan.refusal).toBeNull();
    expect(plan.modules).toEqual([]);
  });

  test("a refusal stays scoped to the module it is about", () => {
    // C genuinely lacks the name and its star cannot be resolved, so C has no
    // stand-in and the file will not load — the refusal is honest. B's stand-in
    // is not C's, and one module's refusal must not delete it.
    const parentC = `export * from "./nowhere";\n`;
    const changeC = `export * from "./nowhere";\nexport function brandNewC(): number {\n  return 3;\n}\n`;
    const plan = planAugmentedModules(
      "scripts/three-modules.test.ts",
      `import { brandNew } from "./b";\nimport { brandNewC } from "./c";\n`,
      new Set(["scripts/b.ts", "scripts/c.ts"]),
      (path) => (path === "scripts/b.ts" ? CHANGE_B : path === "scripts/c.ts" ? changeC : null),
      (path) => (path === "scripts/b.ts" ? PARENT_B : path === "scripts/c.ts" ? parentC : null),
    );
    expect(plan.modules.map((module) => module.path)).toEqual(["scripts/b.ts"]);
    expect(plan.refusal).toContain("scripts/c.ts");
    expect(plan.refusal).toContain("./nowhere");
  });

  test("a star chain is still followed for a module that is missing a name", () => {
    // The regression guard on the narrowing itself: skipping the chain when the
    // direct exports answer every name must not become skipping it always.
    const base = `export function value(): number {\n  return 1;\n}\n`;
    const plan = planAugmentedModules(
      "scripts/star-supplies.test.ts",
      `import { value } from "./b";\n`,
      new Set(["scripts/b.ts"]),
      () => CHANGE_B,
      (path) =>
        path === "scripts/b.ts" ? `export * from "./base";\n` : path === "scripts/base.ts" ? base : null,
    );
    expect(plan.refusal).toBeNull();
    expect(plan.modules).toEqual([]);
  });
});

describe("red-on-parent round 28 — a type-only export, end to end", () => {
  const PARENT = `export type { value } from "./types";\nexport function twice(n: number): number {\n  return n * 2;\n}\n`;
  const CHANGE = `export type { value } from "./types";\nexport function twice(n: number): number {\n  return n * 2;\n}\nexport function value(): number {\n  return 7;\n}\n`;
  const TEST_FILE = `import { expect, test } from "bun:test";
import { value } from "./typed";
test("uses the new runtime export", () => {
  expect(value()).toBe(7);
});
`;

  test("the parent's type-only name does not turn the file into a whole-file waiver", () => {
    const fixture = createFixture(
      [PKG, { path: "packages/core/src/typed.ts", text: PARENT }],
      [
        { path: "packages/core/src/typed.ts", text: CHANGE },
        { path: "packages/core/src/typed-only.test.ts", text: TEST_FILE },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("CANNOT-HOLLOW");
      expect(stdout).not.toContain("WRONG-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 28 — an unrelated re-export, end to end", () => {
  // `some-package` is a real package in the fixture's committed `node_modules`,
  // so the parent LOADS the module that re-exports it — which is what makes this
  // the Greptile shape rather than a load failure. The gate's star reader only
  // resolves relative specifiers, so the chain is unresolvable to it and used to
  // refuse the sibling module's stand-in.
  const PACKAGE_JSON: File = {
    path: "node_modules/some-package/package.json",
    text: `{\n  "name": "some-package",\n  "type": "module",\n  "main": "index.js"\n}\n`,
  };
  const PACKAGE_INDEX: File = {
    path: "node_modules/some-package/index.js",
    text: `export function fromPackage() {\n  return 0;\n}\n`,
  };
  const RE_EXPORTER = `export * from "some-package";\nexport function existing(): number {\n  return 1;\n}\n`;
  const RE_EXPORTER_AFTER = `export * from "some-package";\nexport function existing(): number {\n  return 1;\n}\nexport function alsoNew(): number {\n  return 5;\n}\n`;
  const EXTENDED = `export const other = 1;\n`;
  const EXTENDED_AFTER = `export const other = 1;\nexport function brandNew(): number {\n  return 2;\n}\n`;
  const TEST_FILE = `import { expect, test } from "bun:test";
import { existing } from "./re-exporter";
import { brandNew } from "./extended";
test("uses both modules", () => {
  expect(existing()).toBe(1);
  expect(brandNew()).toBe(2);
});
`;

  test("the re-exporting module does not refuse the module that gained a name", () => {
    const fixture = createFixture(
      [
        PKG,
        PACKAGE_JSON,
        PACKAGE_INDEX,
        { path: "packages/core/src/re-exporter.ts", text: RE_EXPORTER },
        { path: "packages/core/src/extended.ts", text: EXTENDED },
      ],
      [
        { path: "packages/core/src/re-exporter.ts", text: RE_EXPORTER_AFTER },
        { path: "packages/core/src/extended.ts", text: EXTENDED_AFTER },
        { path: "packages/core/src/two-modules.test.ts", text: TEST_FILE },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("RIGHT-REASON-RED");
      expect(stdout).not.toContain("CANNOT-HOLLOW");
      expect(stdout).not.toContain("WRONG-REASON-RED");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Round 29 — the gaps a review lens found in the round 28 fold.
//
// Each case here pins one half of the fold that the round 28 tests reached only
// through the shape it was found in: a type-only export beside a direct one, a
// refusal seen at plan level only, the collapse to `refusals[0]`, and the two
// runtime-name readers nothing asserted directly.
// ---------------------------------------------------------------------------

describe("red-on-parent round 29 — a star target that only type-exports the name", () => {
  // `starExportNames` asks each star target for its RUNTIME export names, and
  // nothing fed it a target whose only mention of the requested name is a
  // `export type`. Counting that name as supplied appends no stand-in, the
  // parent's own `import { value }` fails to resolve, and a file the gate could
  // judge as a right-reason red becomes CANNOT-HOLLOW plus a whole-file waiver.
  const PATH = "scripts/mod.ts";
  const PARENT = `export * from "./types";\nexport function stable(): number {\n  return 3;\n}\n`;
  const CHANGE = `${PARENT}export function value(): number {\n  return 7;\n}\n`;
  const TYPES = `export type { value } from "./real";\n`;
  const REAL = `export function value(): number {\n  return 70;\n}\n`;

  function planFor() {
    return planAugmentedModules(
      "scripts/mod.test.ts",
      `import { value } from "./mod";\n`,
      new Set([PATH]),
      (path) => (path === PATH ? CHANGE : null),
      (path) =>
        path === PATH
          ? PARENT
          : path === "scripts/types.ts"
            ? TYPES
            : path === "scripts/real.ts"
              ? REAL
              : null,
    );
  }

  test("a name the star target only type-exports is still missing from the parent's runtime", () => {
    const plan = planFor();
    expect(plan.refusal).toBeNull();
    expect(plan.modules.map((module) => module.names)).toEqual([["value"]]);
    // The parent's `export *` line survives verbatim and the stand-in is appended
    // beside it, so the parent's own `stable` still works and `value` now binds.
    const text = plan.modules[0]?.text ?? "";
    expect(text.startsWith(PARENT)).toBe(true);
    expect(runtimeExportNames(PATH, text)).toEqual(["stable", "value"]);
  });
});

describe("red-on-parent round 29 — a type-only star target, end to end", () => {
  // Regression guard 1 (a test of the parent's real behaviour is GREEN-ON-PARENT,
  // not accepted on a shadow) reached through an `export *` whose target only
  // type-exports the name. The stand-in has to be written for `value`, and the
  // file still has to be REJECTED for the test that pins what the parent already
  // does — a whole-file refusal for `value` would hide that test behind a waiver
  // instead.
  const TYPES = `export type { value } from "./real";\n`;
  const REAL = `export function value(): number {\n  return 70;\n}\n`;
  const PARENT = `export * from "./types";\nexport function stable(): number {\n  return 3;\n}\n`;
  const CHANGE = `${PARENT}export function value(): number {\n  return 7;\n}\n`;
  const TEST_FILE = `import { expect, test } from "bun:test";
import { stable, value } from "./star-typed";
test("uses the runtime export the change adds", () => {
  expect(value()).toBe(7);
});
test("pins the behaviour the parent already has", () => {
  expect(stable()).toBe(3);
});
`;

  test("the stand-in is written, and the parent-behaviour test is rejected, not waived", () => {
    const fixture = createFixture(
      [
        PKG,
        { path: "packages/core/src/types.ts", text: TYPES },
        { path: "packages/core/src/real.ts", text: REAL },
        { path: "packages/core/src/star-typed.ts", text: PARENT },
      ],
      [
        { path: "packages/core/src/star-typed.ts", text: CHANGE },
        { path: "packages/core/src/star-typed.test.ts", text: TEST_FILE },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // `value` got its stand-in, so the file loads on the parent at all.
      expect(stdout).toContain("packages/core/src/star-typed.ts — appended value");
      expect(stdout).not.toContain("CANNOT-HOLLOW");
      // The test that pins the parent's own `stable` is green there.
      expect(stdout).toContain("GREEN-ON-PARENT");
      expect(stdout).not.toContain("red-on-parent: PASS");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 29 — a refusal beside a sibling's stand-in, end to end", () => {
  // Round 28 proved the pair at plan level. This is the whole gate: one module it
  // must refuse, one it can still stand in for, and the run has to do both — write
  // the sibling's stand-in AND report the refusal — instead of trading one for the
  // other.
  const REFUSER = `export * from "nowhere-pkg";\nexport function existingR(): number {\n  return 1;\n}\n`;
  const REFUSER_AFTER = `${REFUSER}export function gainedR(): number {\n  return 2;\n}\n`;
  const SIBLING = `export const other = 1;\n`;
  const SIBLING_AFTER = `${SIBLING}export function brandNewS(): number {\n  return 4;\n}\n`;
  const TEST_FILE = `import { expect, test } from "bun:test";
import { gainedR } from "./refuser";
import { brandNewS } from "./sibling";
test("uses both modules", () => {
  expect(gainedR()).toBe(2);
  expect(brandNewS()).toBe(4);
});
`;

  test("the refusal is reported and the sibling's stand-in is still written", () => {
    const fixture = createFixture(
      [
        PKG,
        { path: "packages/core/src/refuser.ts", text: REFUSER },
        { path: "packages/core/src/sibling.ts", text: SIBLING },
      ],
      [
        { path: "packages/core/src/refuser.ts", text: REFUSER_AFTER },
        { path: "packages/core/src/sibling.ts", text: SIBLING_AFTER },
        { path: "packages/core/src/refused-sibling.test.ts", text: TEST_FILE },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // The refusal, about the module it is about.
      expect(stdout).toContain("CANNOT-HOLLOW");
      expect(stdout).toContain("packages/core/src/refuser.ts");
      expect(stdout).toContain("nowhere-pkg");
      // The sibling's stand-in, in the report and in what the run actually wrote.
      expect(stdout).toContain("packages/core/src/sibling.ts — appended brandNewS");
      const written = readFileSync(
        join(fixture.cache, `wt-${fixture.base}`, "packages/core/src/sibling.ts"),
        "utf8",
      );
      expect(written.startsWith(SIBLING)).toBe(true);
      expect(written).toContain("Appended stand-in");
      expect(written).toContain("export function brandNewS");
      // And the verdict is not an accept: the file never loaded on the parent.
      expect(stdout).toContain("red-on-parent: FAIL");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe("red-on-parent round 29 — several refusals collapse to the first in import order", () => {
  // The plan returns `refusals[0]`, and the report prints one refusal as one row's
  // detail. Which refusal an author sees is therefore a choice, not an accident:
  // it is the first in the file's own import order. Pinning it means a refactor
  // cannot silently change the module an author is told to fix without failing
  // here, and reversing the imports proves the order is the file's and not the
  // modules' sort order.
  const PARENT_A = `export * from "./nowhere-a";\n`;
  const PARENT_B = `export * from "./nowhere-b";\n`;
  const CHANGE_A = `${PARENT_A}export function nameA(): number {\n  return 1;\n}\n`;
  const CHANGE_B = `${PARENT_B}export function nameB(): number {\n  return 2;\n}\n`;
  const TOUCHED = new Set(["scripts/a.ts", "scripts/b.ts"]);

  const readChange = (path: string): string | null =>
    path === "scripts/a.ts" ? CHANGE_A : path === "scripts/b.ts" ? CHANGE_B : null;
  const readParent = (path: string): string | null =>
    path === "scripts/a.ts" ? PARENT_A : path === "scripts/b.ts" ? PARENT_B : null;

  test("two refusable modules report the first one the file imports", () => {
    const plan = planAugmentedModules(
      "scripts/two-refusals.test.ts",
      `import { nameA } from "./a";\nimport { nameB } from "./b";\n`,
      TOUCHED,
      readChange,
      readParent,
    );
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toContain("scripts/a.ts");
    expect(plan.refusal).toContain("./nowhere-a");
    expect(plan.refusal).not.toContain("scripts/b.ts");
    expect(plan.refusal).not.toContain("./nowhere-b");
  });

  test("the reported refusal follows the file's order, not the modules' sort order", () => {
    const plan = planAugmentedModules(
      "scripts/two-refusals-reversed.test.ts",
      `import { nameB } from "./b";\nimport { nameA } from "./a";\n`,
      TOUCHED,
      readChange,
      readParent,
    );
    expect(plan.modules).toEqual([]);
    expect(plan.refusal).toContain("scripts/b.ts");
    expect(plan.refusal).toContain("./nowhere-b");
    expect(plan.refusal).not.toContain("scripts/a.ts");
    expect(plan.refusal).not.toContain("./nowhere-a");
  });
});

describe("red-on-parent round 29 — a JavaScript module's runtime names", () => {
  // `runtimeExportNames` takes `scriptKindFor(path)`, so the extension decides how
  // the source is parsed: `.js`, `.mjs` and `.cjs` are read as JavaScript. What is
  // pinned here is the export SET a JavaScript module produces through that path.
  // The two parsers do not disagree about an export name in any case found so far
  // (TypeScript's parser recovers from JS-valid input, and a JS reading drops the
  // same type-only shapes), so this is coverage of the JavaScript branch rather
  // than a differential test — said plainly, because a reader should not take it
  // as proof that the script kind changes the answer.
  const JS = `export function twice(n) {\n  return n * 2;\n}\nexport const FLAG = 1;\nexport class Box {}\n`;
  const JS_TYPE_ONLY = `export type { value } from "./types";\nexport interface Port {\n  b: string;\n}\n`;

  test("a .js module's runtime names are read from JavaScript source", () => {
    expect(runtimeExportNames("scripts/mod.js", JS)).toEqual(["Box", "FLAG", "twice"]);
    // A JS file may carry the same type-only shapes a TS one does, and they name
    // nothing the runtime has either way.
    expect(runtimeExportNames("scripts/mod.js", JS_TYPE_ONLY)).toEqual([]);
  });

  test("the same holds for a .mjs module", () => {
    expect(runtimeExportNames("scripts/mod.mjs", JS)).toEqual(["Box", "FLAG", "twice"]);
    expect(runtimeExportNames("scripts/mod.mjs", JS_TYPE_ONLY)).toEqual([]);
  });
});

describe("red-on-parent round 29 — a class and a namespace bind runtime values", () => {
  // Both are in the kept list and neither was asserted directly: the round 28 test
  // pinned a function, a const and an enum, so a change that started dropping
  // classes or namespaces would have passed it.
  test("a class and a namespace count; a type alias and an interface do not", () => {
    expect(
      runtimeExportNames(
        "scripts/mod.ts",
        `export class Box {\n  static empty = true;\n}\nexport namespace Registry {\n  export const size = 0;\n}\nexport type Shape = { a: number };\nexport interface Port {\n  b: string;\n}\n`,
      ),
    ).toEqual(["Box", "Registry"]);
  });
});
