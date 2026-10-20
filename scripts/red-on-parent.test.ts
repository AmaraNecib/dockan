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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as gateModule from "./red-on-parent";
import {
  bunOnlyRefusal,
  changeSideResults,
  classifyFileRun,
  decodeXml,
  displayName,
  isGatedTestPath,
  lockHolderIsGone,
  main,
  observeLockHolder,
  parseJunit,
  parseWaivers,
  reclaimStaleLock,
  renderReport,
  runGate,
  unregisteredVerdicts,
  unusedWaiverVerdicts,
  verdictPasses,
  type FileRun,
  type GateRun,
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
  timeoutMs = 120_000,
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
function runGateAsync(fixture: Fixture): Promise<GateOutput> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [GATE, "--base", fixture.base], {
      cwd: fixture.repo,
      env: { ...process.env, RED_ON_PARENT_CACHE: fixture.cache },
    });
    let out = "";
    // A hung child would otherwise leak for the rest of the suite: spawn has no
    // timeout of its own, so this one kills it and says why.
    const timer = setTimeout(() => {
      out += "\n(the gate did not exit within 120s; killed)";
      child.kill();
    }, 120_000);
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
  test("two runs on one base both produce a verdict instead of colliding", async () => {
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

  test("a lock with no pid is reclaimed once it is older than the grace", () => {
    // A crash between taking the lock and writing its pid used to leave a lock
    // nothing could reclaim: "no pid" read as "holder alive", so every later
    // run waited its whole budget (11 minutes) and refused, forever.
    const lockPath = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    try {
      expect(lockHolderIsGone(lockPath)).toBe(false);
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockPath, stale, stale);
      expect(lockHolderIsGone(lockPath)).toBe(true);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  });

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

describe("red-on-parent round 9 — the lock", () => {
  test("a vanished lock is not-gone and does not throw", () => {
    // The pid file's existence and its read are not atomic, and a release can
    // remove the directory in between. `acquireWorktreeLock` only catches
    // EEXIST, so an unguarded read threw ENOENT out of runGate and killed the
    // run with a stack trace instead of retrying.
    const lockPath = join(mkdtempSync(join(tmpdir(), "ronp-lock-")), "gone.lock");
    expect(() => lockHolderIsGone(lockPath)).not.toThrow();
    expect(lockHolderIsGone(lockPath)).toBe(false);
    expect(observeLockHolder(lockPath).kind).toBe("alive");
  });

  test("a stale unclaimed lock is reclaimed", () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), "ronp-lock-")), "wt.lock");
    mkdirSync(lockPath);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    const observed = observeLockHolder(lockPath);
    expect(observed.kind).toBe("unclaimed");
    reclaimStaleLock(lockPath, observed);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reclaiming does not delete a live lock another waiter already took", () => {
    // Two waiters read the same dead pid; the first reclaims and takes the lock
    // (writing its own pid). The second, holding its earlier observation, used
    // to rename and delete the first waiter's live lock, and both runs then
    // shared one worktree. The rename is now verified against the observation.
    const lockPath = join(mkdtempSync(join(tmpdir(), "ronp-lock-")), "wt.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), `${process.pid}\n`);
    reclaimStaleLock(lockPath, { kind: "holder", pid: 999_999 });
    expect(existsSync(join(lockPath, "pid"))).toBe(true);
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
