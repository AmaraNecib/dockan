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
 * assertion. (On 1.4.2 junit's `type` is `Error` and not `AssertionError`; on
 * 1.3.14, the repo's pin, bun types every failure `AssertionError`, so the
 * `assertions="0"` counter is the signal that holds on CI.)
 *
 * These fixtures are the gate's own tests, so they live where `bun run test`
 * already looks (`bun test ./scripts/`).
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  classifyFileRun,
  decodeXml,
  displayName,
  isGatedTestPath,
  parseJunit,
  parseWaivers,
  verdictPasses,
  type FileRun,
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

function runGateFixture(fixture: Fixture): GateOutput {
  const result = spawnSync(process.execPath, [GATE, "--base", fixture.base], {
    cwd: fixture.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, RED_ON_PARENT_CACHE: fixture.cache },
  });
  return { status: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
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
`;

const PKG: File = { path: "package.json", text: `{ "name": "fixture", "type": "module" }\n` };
const HELPER: File = { path: "packages/core/src/helper.ts", text: HELPER_BEFORE };

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
  });

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
      expect(status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

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
  });

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
  });

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
  });

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
  });

  test("an uncommitted test file is reported, not silently skipped", () => {
    const fixture = createFixture([PKG, HELPER], []);
    try {
      // The gate reads HEAD, so this file is invisible to it. Saying nothing
      // would be a silent pass on the exact file the author is about to commit.
      writeFiles(fixture.repo, [
        {
          path: "packages/core/src/late.test.ts",
          text: `import { expect, test } from "bun:test";\ntest("late", () => {\n  expect(1).toBe(2);\n});\n`,
        },
      ]);
      const { status, stdout } = runGateFixture(fixture);
      expect(stdout).toContain("WARNING");
      expect(stdout).toContain("packages/core/src/late.test.ts");
      expect(status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

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
  });
});

describe("the hook-throws fixture, where a grep-based gate is wrong", () => {
  test("a beforeEach throw is WRONG-REASON RED even though it prints `(fail)`", () => {
    const fixture = createFixture(
      [PKG, HELPER],
      [
        { path: "packages/core/src/helper.ts", text: HELPER_AFTER },
        {
          path: "packages/core/src/hook.test.ts",
          text: `import { beforeEach, describe, expect, test } from "bun:test";
import { guard } from "./helper";
describe("hooky", () => {
  beforeEach(() => {
    throw new Error("hook boom");
  });
  test("never gets to assert", () => {
    expect(guard(1)).toBe(2);
  });
});
`,
        },
      ],
    );
    try {
      const { status, stdout } = runGateFixture(fixture);
      // The gate's answer, and the reason for it: the test body never ran, so
      // it never rejected the missing behaviour. Wording on purpose that does
      // not move between bun versions: on 1.3.14 (the repo pin) junit types a
      // hook throw `AssertionError` exactly like a real red, and only the
      // `assertions="0"` counter gives it away; on 1.4.2 the type says `Error`.
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
  });
});

// ---------------------------------------------------------------------------
// The parsing and classification rules
// ---------------------------------------------------------------------------

describe("the trap a grep-based gate falls into", () => {
  // A transcript as bun 1.3.14 (the repo pin) prints it for the hook-throws
  // fixture: the reporter writes the same `(fail) <name>` line a real assertion
  // red writes, while junit records `assertions="0"` because the body never ran.
  // The gate must not read the reporter. A grep-based gate does, and passes a
  // fixture that proves nothing.
  const hookTranscript = [
    "(fail) hooky > never gets to assert [0.42ms]",
    "error: hook boom",
    "      at <anonymous> (/tmp/wt/packages/core/src/hook.test.ts:5:32)",
  ].join("\n");
  const hookJunit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1">
  <testsuite name="hook.test.ts" tests="1">
    <testcase name="never gets to assert" classname="hooky" file="hook.test.ts" line="5" assertions="0">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>`;

  test("a grep-based gate calls the hook fixture RIGHT-REASON RED", () => {
    expect(naiveGrepVerdict(hookTranscript)).toBe("RIGHT_REASON_RED");
  });

  test("the gate calls it WRONG-REASON RED on the assertion counter, not the reporter", () => {
    const [result] = parseJunit(hookJunit);
    expect(result?.assertions).toBe(0);
    const classified = classifyFileRun(
      { file: "hook.test.ts", junit: hookJunit, stdout: hookTranscript, error: "" },
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

  test("a bare AssertionError with no assertion evaluated is WRONG REASON RED (a bun 1.3.14 hook throw)", () => {
    const { verdicts } = classifyFileRun(
      run(junitFor(`<failure type="AssertionError" />`, ` assertions="0"`)),
      noWaiver,
    );
    expect(verdicts[0]?.name).toBe("WRONG_REASON_RED");
    expect(verdicts[0]?.detail).toContain("no assertion was evaluated");
    expect(verdicts.every(verdictPasses)).toBe(false);
  });

  test("a bare AssertionError with an assertion evaluated is RIGHT REASON RED (a bun 1.3.14 real red)", () => {
    const { verdicts } = classifyFileRun(
      run(junitFor(`<failure type="AssertionError" />`, ` assertions="1"`)),
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
    const { verdicts, usedWaiverLines } = classifyFileRun(run(null, "SyntaxError: x"), [waiver]);
    expect(verdicts[0]?.name).toBe("WRONG_REASON_RED");
    expect(verdicts[0]?.waiver).toEqual(waiver);
    expect(verdicts.every(verdictPasses)).toBe(true);
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
});

describe("verdictPasses", () => {
  const verdict = (name: Verdict["name"], waiver: Waiver | null): Verdict => ({
    file: "f",
    test: "t",
    name,
    detail: "d",
    waiver,
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
