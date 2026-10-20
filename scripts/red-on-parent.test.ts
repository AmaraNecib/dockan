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
  bunOnlyRefusal,
  changeSideResults,
  changeSideVerdicts,
  classifyFileRun,
  decodeXml,
  displayName,
  importedTestFiles,
  isGatedTestPath,
  loadFailureReason,
  lockPidFileContent,
  main,
  notRegisteredOnChange,
  parseJunit,
  parseWaivers,
  RECLAIM_CLAIM_FILE,
  renderReport,
  runFinished,
  runGate,
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

  test("WRONG-REASON RED: a file that cannot load on the parent fails the gate", () => {
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
          path: "packages/core/src/load.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { brandNew } from "./helper";
describe("brand", () => {
  test("returns the number", () => {
    expect(brandNew(2)).toBe(2);
  });
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("WRONG-REASON-RED");
      expect(stdout).toContain("# Unhandled error between tests");
      // The parent is the merge-base, so a commit inside this change is still
      // after it: the fix has to say so, or an author follows it and meets the
      // same missing import on the next run.
      expect(stdout).toContain("--base <rev>");
      expect(stdout).not.toContain("first commit");
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

  test("WRONG-REASON RED, waived: a rename whose import only resolves on the change passes", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/moved.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { brandNew } from "./helper";
describe("moved", () => {
  test("returns the number", () => {
    expect(brandNew(2)).toBe(2);
  });
});
// red-on-parent-waive: "moved returns the number" — rename: the test moved with the file
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("WRONG-REASON-RED");
      expect(stdout).toMatch(/WRONG-REASON-RED\s+line \d+/u);
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
    );
    expect(problems).toEqual([]);
    expect(waivers).toEqual([
      { pattern: "gr keeps a positive number", reason: "behaviour the refactor kept", line: 1 },
    ]);
  });

  test("accepts single quotes and an ASCII dash", () => {
    const { waivers, problems } = parseWaivers(`// red-on-parent-waive: 'x y' - why`);
    expect(problems).toEqual([]);
    expect(waivers[0]?.pattern).toBe("x y");
    expect(waivers[0]?.reason).toBe("why");
  });

  test("a missing reason is a problem, not a waiver", () => {
    const { waivers, problems } = parseWaivers(`// red-on-parent-waive: "x"`);
    expect(waivers).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no reason");
  });

  test("a marker with no quoted name is a problem", () => {
    const { problems } = parseWaivers(`// red-on-parent-waive: because I said so`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("must read");
  });

  test("an invalid regex is a problem", () => {
    const { problems } = parseWaivers(`// red-on-parent-waive: "(" — broken pattern`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not a valid regex");
  });

  test("marks each waiver with its own line", () => {
    const { waivers } = parseWaivers(
      `// a comment\n// red-on-parent-waive: "one" — first\n\n// red-on-parent-waive: "two" — second`,
    );
    expect(waivers.map((waiver) => waiver.line)).toEqual([2, 4]);
  });

  test("reads a CRLF file, which is what a Windows checkout gives", () => {
    const { waivers, problems } = parseWaivers(
      `// a comment\r\n// red-on-parent-waive: "one" — first\r\n`,
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

  test("never gates specs, e2e files, or anything outside apps and packages", () => {
    expect(isGatedTestPath("tests/e2e/sale.spec.ts")).toBe(false);
    expect(isGatedTestPath("apps/web/tests/e2e/sale.test.ts")).toBe(false);
    expect(isGatedTestPath("packages/core/src/e2e/x.test.ts")).toBe(false);
    expect(isGatedTestPath("scripts/red-on-parent.test.ts")).toBe(false);
    expect(isGatedTestPath("packages/core/src/helper.ts")).toBe(false);
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

  test("a waiver excuses only the test it names", () => {
    // The file cannot load on the parent, so the gate has no parent-side test
    // list; the names the change registers are all it has. A waiver naming one
    // of them used to excuse the whole file, and the other test was never
    // judged and never named.
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
          path: "packages/core/src/mixed.test.ts",
          text: `import { describe, expect, test } from "bun:test";
import { brandNew } from "./helper";
describe("mixed", () => {
  test("pins the new behaviour", () => {
    expect(brandNew(1)).toBe(1);
  });
});
describe("other", () => {
  test("already worked", () => {
    expect(1).toBe(1);
  });
});
// red-on-parent-waive: "mixed pins the new behaviour" — rename: the test moved with the file
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("WRONG-REASON-RED");
      // The unjudged sibling has to be named: a waiver that names one test says
      // nothing about the next one.
      expect(stdout).toContain("other already worked");
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 60_000);

  test("a test file outside the gate's scope is named, not silently ignored", () => {
    // The gate on its own pull request adds `scripts/red-on-parent.test.ts` and
    // gates nothing. The report has to say which files it did not gate: "no
    // added test files" reads as "this change adds no tests", which is a
    // different claim.
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "scripts/outside.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("outside", () => {\n  expect(1).toBe(1);\n});\n`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("scripts/outside.test.ts");
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
    expect(importedTestFiles(`import "./helper.test.ts";\n`)).toEqual(["./helper.test.ts"]);
    expect(importedTestFiles(`import { x } from "../shared/other.test";\n`)).toEqual([
      "../shared/other.test",
    ]);
    expect(importedTestFiles(`const m = await import("./late.test.ts");\n`)).toEqual([
      "./late.test.ts",
    ]);
    expect(importedTestFiles(`const h = require("./req.test.ts");\n`)).toEqual(["./req.test.ts"]);
    expect(importedTestFiles(`export * from "./reexport.test.ts";\n`)).toEqual([
      "./reexport.test.ts",
    ]);
    // A type-only import is erased before the file runs: it imports nothing.
    // Measured on bun 1.4.2: `import { type X } from` is erased as well.
    expect(importedTestFiles(`import type { Case } from "./cases.test.ts";\n`)).toEqual([]);
    expect(importedTestFiles(`import { type Case } from "./cases.test.ts";\n`)).toEqual([]);
    expect(importedTestFiles(`export type { Case } from "./cases.test.ts";\n`)).toEqual([]);
    expect(
      importedTestFiles(
        `import type { Aaaaaaaaaa, Bbbbbbbbbb, Cccccccccc, Dddddddddd, Eeeeeeeeee, Ffffffffff, Gggggggggg, Hhhhhhhhhh, Iiiiiiiiii } from "./cases.test.ts";\n`,
      ),
    ).toEqual([]);
    // One runtime name in the clause is enough to make the statement import
    // something, so the file is named.
    expect(importedTestFiles(`import { type A, B } from "./cases.test.ts";\n`)).toEqual([
      "./cases.test.ts",
    ]);
    // A commented-out import is not an import, and a comment must not silence
    // a real one.
    expect(importedTestFiles(`// import type { Q } from "./old.test.ts";\n`)).toEqual([]);
    expect(
      importedTestFiles(`// import type { Q } from "./old.test.ts";\nimport "./real.test.ts";\n`),
    ).toEqual(["./real.test.ts"]);
    // A helper that is not a test file, and a package that is not local.
    expect(importedTestFiles(`import { guard } from "./helper";\n`)).toEqual([]);
    expect(importedTestFiles(`import { expect } from "bun:test";\n`)).toEqual([]);
    expect(importedTestFiles(`import "./fixtures.test.json";\n`)).toEqual([]);
    expect(importedTestFiles(`import "./helper.test-data.ts";\n`)).toEqual([]);
    // Known limits, pinned so a change to the scan cannot quietly widen or
    // narrow them: a dynamic import whose specifier is a variable is not seen,
    // and neither is the import of a module that itself imports a test file.
    expect(importedTestFiles(`const m = await import(name);\n`)).toEqual([]);
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

  test("a file the parent cannot load says which module is missing", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        { path: "packages/core/src/new-helper.ts", text: "export const answer = 42;\n" },
        {
          path: "packages/core/src/needs-new.test.ts",
          text: `import { expect, test } from "bun:test";
import { answer } from "./new-helper";
test("uses the new module", () => {
  expect(answer).toBe(42);
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // The parent has no new-helper.ts, so the file cannot load there, and
      // the report has to say that rather than only "could not load".
      expect(stdout).toContain("the parent has no ./new-helper");
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
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        { path: "packages/core/src/new-helper.ts", text: "export const answer = 42;\n" },
        {
          path: "packages/core/src/needs-new.test.ts",
          text: `import { expect, test } from "bun:test";
import { answer } from "./new-helper";
test("uses the new module", () => {
  expect(answer).toBe(42);
});
// red-on-parent-waive: "uses the new module" — the parent has no new-helper yet
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
    expect(importedTestFiles('// import "./old.test.ts";\n')).toEqual([]);
    expect(importedTestFiles('/* import "./old.test.ts"; */\n')).toEqual([]);
    expect(importedTestFiles('// import "./old.test.ts";\nimport "./real.test.ts";\n')).toEqual([
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
    const parsed = parseWaivers(source);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["gr keeps the quote"]);
    expect(parsed.waivers[0]?.line).toBe(5);
  });

  test("a `//` inside a regex character class is not a comment", () => {
    // The same scan feeds the import check, which keeps literals. A `//` in a
    // character class is not the start of a comment, and reading it as one
    // drops the rest of the line — the line a real import can be on.
    expect(importedTestFiles(String.raw`const slash = /[//]/; import "./real.test.ts";`)).toEqual([
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
    expect(importedTestFiles(source)).toEqual([]);
  });

  test("a division after a closing bracket is a division, not a regex", () => {
    // The same lie after `]`. Both closers are in the fix's blast radius, and
    // neither is a word character, so both returned the empty token.
    const source = `const x = rows[i] / n /* import "./fake.test.ts" */ / 2;\n`;
    expect(importedTestFiles(source)).toEqual([]);
  });

  test("the division fix does not stop a real import being found", () => {
    // The failure mode of an over-correction: a scan that gave up on `/` and
    // reported nothing would pass the two tests above and silently accept a
    // mixed report.
    expect(importedTestFiles(`const x = value() / 2; import "./real.test.ts";\n`)).toEqual([
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
    const parsed = parseWaivers(source);
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
        join(lockPath, RECLAIM_CLAIM_FILE),
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
      expect(existsSync(join(lockPath, RECLAIM_CLAIM_FILE))).toBe(true);
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
  test("a quote in JSX text does not blank the waiver below it", () => {
    // The mask read every `'` as the start of a string. In `.tsx` a quote
    // between an element's `>` and its close is prose, so `<div>Don't delete</div>`
    // opened a literal that ran to EOF and blanked the waiver below it:
    // `parseWaivers` returned no waivers and no problems, and a test whose red
    // was legitimately on the parent was refused as GREEN_ON_PARENT.
    const source = String.raw`test("renders the note", () => {
  render(<div>Don't delete</div>);
});
// red-on-parent-waive: "renders the note" — characterizes behaviour the refactor kept
`;
    const parsed = parseWaivers(source);
    expect(parsed.problems).toEqual([]);
    expect(parsed.waivers.map((waiver) => waiver.pattern)).toEqual(["renders the note"]);
    expect(parsed.waivers[0]?.line).toBe(4);
  });

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
    const parsed = parseWaivers(source);
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
    expect(importedTestFiles(source)).toEqual([]);
    // An element with a close is text, and the same scan still finds a real
    // import beside it.
    expect(
      importedTestFiles(`const view = <div>it's fine</div>;
import "./real.test.ts";
`),
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
