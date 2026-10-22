import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  changedFilesFromGit,
  decide,
  dirtyTracked,
  main,
  parseArgs,
  playwrightArgs,
  shouldSpawn,
  type GitRunner,
  type Spawn,
} from "./e2e-changed";
import { specPaths, type Scope } from "./e2e-selection";

// The local twin of the CI selector. CI answers "which specs does this PR
// reach" server-side; this answers the same question on the lane that is about
// to push, so the wait is the mapped specs instead of all 35.
//
// Two seams are injected rather than mocked through the module: the git runner
// (what the diff is read from) and the spawn (what the decision becomes). Both
// used to be module imports with no seam, which meant the git argv and the
// Playwright argv were the only part of the driver no test could see — and
// returning 0 unconditionally from `main` left all 26 tests green.
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "scripts", "e2e-changed.ts");

const affected = (specs: string[]): Scope => ({
  mode: "affected",
  specs,
  reason: `${specs.length} spec(s) mapped from 1 file(s)`,
});

const full: Scope = { mode: "full", specs: [], reason: "critical path: package.json" };
const skip: Scope = { mode: "skip", specs: [], reason: "docs only" };

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
    expect(playwrightArgs(full)).toEqual([]);
  });

  test("skip hands Playwright no filters either; the caller is what stops the spawn", () => {
    expect(playwrightArgs(skip)).toEqual([]);
    expect(shouldSpawn(skip)).toBe(false);
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
    expect(shouldSpawn(full)).toBe(true);
    expect(shouldSpawn(affected(["backups.spec.ts"]))).toBe(true);
  });

  test("the argv handed to Playwright is specPaths, for every mode", () => {
    // The prefix used to be built in two files, so a change to one of them left
    // `--dry-run` printing one path set and the spawn passing another. The two
    // are the same function now, and this is the assertion that says so.
    //
    // The concrete list is asserted beside the identity on purpose. Comparing
    // only `playwrightArgs(scope)` with `specPaths(scope)` is two calls into one
    // module, so on a parent carrying neither of them both sides are the gate's
    // undefined stand-ins and the equality holds — a red-on-parent gate reads that
    // as a test that pins nothing. The expected paths are what the spawn is really
    // for, and they cannot both be a stand-in.
    const expected: Array<{ scope: Scope; argv: string[] }> = [
      {
        scope: affected(["backups.spec.ts", "items-flow.spec.ts"]),
        argv: ["tests/e2e/backups.spec.ts", "tests/e2e/items-flow.spec.ts"],
      },
      { scope: affected([]), argv: [] },
      { scope: full, argv: [] },
      { scope: skip, argv: [] },
    ];
    for (const entry of expected) {
      expect({ mode: entry.scope.mode, argv: playwrightArgs(entry.scope) }).toEqual({
        mode: entry.scope.mode,
        argv: entry.argv,
      });
      expect({ mode: entry.scope.mode, argv: playwrightArgs(entry.scope) }).toEqual({
        mode: entry.scope.mode,
        argv: specPaths(entry.scope),
      });
    }
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

  test("a flag may not swallow the flag after it", () => {
    // `--files --dry-run` used to parse as files: ["--dry-run"], dryRun: false,
    // which then decided `full` and SPAWNED the 35-spec suite from an
    // invocation that asked only for a decision.
    for (const argv of [
      ["--files", "--dry-run"],
      ["--base", "--dry-run"],
      ["--files", "-x"],
    ]) {
      const parsed = parseArgs(argv);
      expect({ argv, ok: parsed.ok }).toEqual({ argv, ok: false });
    }
  });

  test("--files may not be given twice: the second would silently win", () => {
    expect(parseArgs(["--files", "a.ts", "--files", "b.ts"]).ok).toBe(false);
    expect(parseArgs(["--files=a.ts", "--files=b.ts"]).ok).toBe(false);
  });

  test("Windows backslash paths are normalised before the map sees them", () => {
    // From Explorer a lane pastes `apps\web\src\pages\backups.tsx`, which
    // matches no row and silently runs the full suite.
    const parsed = parseArgs(["--files", "apps\\web\\src\\pages\\backups.tsx"]);
    expect(parsed.ok && parsed.files).toEqual(["apps/web/src/pages/backups.tsx"]);
  });

  test("any base other than origin/develop is opt-in and reported", () => {
    const parsed = parseArgs(["--base", "origin/main"]);
    expect(parsed.ok && parsed.base).toBe("origin/main");
  });
});

describe("e2e-changed spawn", () => {
  const spawnDecision = (status: number | null) => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: Spawn = (command, args) => {
      calls.push({ command, args });
      return { status };
    };
    return { calls, run };
  };

  test("the spawn is `bun run test:e2e <spec paths>` under this bun", () => {
    const { calls, run } = spawnDecision(0);
    main(["--files", "apps/web/src/pages/backups.tsx"], ROOT, run);
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: ["run", "test:e2e", "tests/e2e/backups.spec.ts"],
      },
    ]);
  });

  test("a full decision spawns the same command with no filters", () => {
    const { calls, run } = spawnDecision(0);
    main(["--files", "package.json"], ROOT, run);
    expect(calls).toEqual([{ command: process.execPath, args: ["run", "test:e2e"] }]);
  });

  test("the suite's exit code is this script's exit code", () => {
    // The whole point of the front door: a red suite must read as a red exit.
    // Returning 0 unconditionally left every other test in this file green.
    const { run } = spawnDecision(3);
    expect(main(["--files", "apps/web/src/pages/backups.tsx"], ROOT, run)).toBe(3);
  });

  test("zero stays zero, and no status at all is a failure", () => {
    // A signal leaves `status` null; that is not a pass.
    expect(main(["--files", "package.json"], ROOT, spawnDecision(0).run)).toBe(0);
    expect(main(["--files", "package.json"], ROOT, spawnDecision(null).run)).toBe(1);
  });

  test("a spawn error is 1 and says what could not start", () => {
    const run: Spawn = () => ({ error: { message: "ENOENT" }, status: null });
    expect(main(["--files", "package.json"], ROOT, run)).toBe(1);
  });

  test("a skip decision never spawns", () => {
    const { calls, run } = spawnDecision(0);
    expect(main(["--files", "docs/ci.md"], ROOT, run)).toBe(0);
    expect(calls).toEqual([]);
  });

  test("--dry-run never spawns either", () => {
    const { calls, run } = spawnDecision(0);
    expect(main(["--dry-run", "--files", "package.json"], ROOT, run)).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("e2e-changed git", () => {
  const recorder = (responses: string[]) => {
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      const stdout = responses[calls.length - 1] ?? "";
      return { status: 0, stdout, stderr: "" };
    };
    return { calls, run };
  };

  test("the diff is --no-renames --name-only, from the merge base", () => {
    // `--no-renames` is the whole reason a file moved OUT of a mapped path is
    // seen: a detected rename reports only its destination. Removing the flag
    // is invisible without this assertion.
    const { calls, run } = recorder(["abc123\n", "apps/web/src/pages/backups.tsx\n"]);
    expect(changedFilesFromGit("origin/develop", ROOT, run)).toEqual({
      ok: true,
      files: ["apps/web/src/pages/backups.tsx"],
    });
    expect(calls).toEqual([
      ["merge-base", "origin/develop", "HEAD"],
      ["diff", "--no-renames", "--name-only", "abc123", "HEAD"],
    ]);
  });

  test("a git that will not run reports its own message, not a crash", () => {
    const run: GitRunner = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository\n" });
    const diff = changedFilesFromGit("origin/develop", ROOT, run);
    expect(diff).toEqual({ ok: false, reason: "fatal: not a git repository" });
  });

  test("a silent non-zero git exit still names the command", () => {
    const run: GitRunner = () => ({ status: 2, stdout: "", stderr: "" });
    const diff = changedFilesFromGit("origin/develop", ROOT, run);
    expect(diff).toEqual({ ok: false, reason: "git merge-base origin/develop HEAD exited 2" });
  });

  test("a merge base that resolves to nothing is a refusal, not an empty diff", () => {
    // An empty diff would select `full` for the wrong reason and say so as if
    // it knew; this names the real cause.
    const { run } = recorder(["   \n"]);
    expect(changedFilesFromGit("origin/develop", ROOT, run)).toEqual({
      ok: false,
      reason: "git merge-base origin/develop HEAD produced no commit",
    });
  });

  test("a real rename lists both sides, so the path that stopped being covered is seen", () => {
    // Cheap enough to be real: a throwaway repo proves the behaviour of git
    // itself, which a recorded argv cannot. This is the case the flag exists
    // for — a file moved OUT of a mapped tree.
    const dir = mkdtempSync(join(tmpdir(), "e2e-changed-rename-"));
    const git = (args: string[]) => {
      const run = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(`${args.join(" ")}: ${run.stderr.toString()}`);
      return run.stdout.toString();
    };
    try {
      git(["init", "--quiet"]);
      git(["config", "user.email", "lane@example.invalid"]);
      git(["config", "user.name", "lane"]);
      // Long enough that git calls the move a rename rather than an add+delete.
      writeFileSync(join(dir, "moved.ts"), "// a line long enough for git to call this a rename\n".repeat(8));
      git(["add", "."]);
      git(["commit", "--quiet", "-m", "base"]);
      git(["mv", "moved.ts", "renamed.ts"]);
      git(["commit", "--quiet", "-m", "move it out of its mapped path"]);

      const diff = changedFilesFromGit("HEAD~1", dir);
      // SAFETY: `HEAD~1` resolves and every call above exits non-zero otherwise.
      if (!diff.ok) throw new Error(`expected a diff, got ${diff.reason}`);
      expect(diff.files).toEqual(["moved.ts", "renamed.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dirty working tree is reported as such, so a stale answer is not silent", () => {
    // turbo's `[ref]` filter diffs the working tree; this driver diffs
    // merge-base..HEAD. A lane that edits, runs tier 0 (which sees the edit),
    // then tier 1 gets a narrowed or skip answer for the stale committed set —
    // and `skip` exits 0, indistinguishable from a real decision.
    const decision = decide({ base: "origin/develop", files: null }, ROOT, {
      diff: () => ({ ok: true, files: ["apps/web/src/pages/backups.tsx"] }),
      dirty: () => ["apps/web/src/pages/backups.tsx"],
    });
    expect(decision.source).toBe("dirty");
    expect(decision.scope.mode).toBe("affected");
    expect(decision.scope.reason).toContain("uncommitted");
  });

  test("a clean tree is a git decision with no caveat", () => {
    const decision = decide({ base: "origin/develop", files: null }, ROOT, {
      diff: () => ({ ok: true, files: ["apps/web/src/pages/backups.tsx"] }),
      dirty: () => [],
    });
    expect(decision).toEqual({ scope: affected(["backups.spec.ts"]), source: "git" });
  });

  test("--files is its own provenance: it never claims to be the branch", () => {
    // `--files apps/web/src/pages/backups.tsx` prints a contract byte-shaped
    // exactly like a real decision, and silently overrides an always_full
    // verdict. `source=files` is what makes a pasted contract say what it is.
    const decision = decide({ base: "origin/develop", files: ["apps/web/src/pages/backups.tsx"] }, ROOT, {
      diff: () => {
        throw new Error("--files must not read git");
      },
      dirty: () => [],
    });
    expect(decision.source).toBe("files");
    expect(decision.scope.mode).toBe("affected");
  });

  test("an unreadable diff is a git failure that widens, with a dirty caveat if there is one", () => {
    const decision = decide({ base: "origin/develop", files: null }, ROOT, {
      diff: () => ({ ok: false, reason: "fatal: bad revision" }),
      dirty: () => ["docs/ci.md"],
    });
    expect(decision.scope.mode).toBe("full");
    expect(decision.scope.reason).toContain("cannot diff against origin/develop");
    expect(decision.scope.reason).toContain("uncommitted");
  });

  test("git status is read with untracked files excluded", () => {
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      return { status: 0, stdout: " M package.json\n", stderr: "" };
    };
    expect(dirtyTracked(ROOT, run)).toEqual(["package.json"]);
    expect(calls).toEqual([["status", "--porcelain", "--untracked-files=no"]]);
  });

  test("a git that cannot answer leaves the dirty check unknown rather than clean", () => {
    const run: GitRunner = () => ({ status: 128, stdout: "", stderr: "fatal\n" });
    expect(dirtyTracked(ROOT, run)).toBeNull();
  });
});

describe("e2e-changed CLI", () => {
  test("--dry-run prints the CI selector's contract lines", () => {
    // Two front ends, one map. Comparing the outputs is what keeps the local
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
      // The driver adds one line the selector has no opinion about: where the
      // decision came from. Everything else is byte-identical.
      const [mode, specs, reason, source, ...rest] = local.trimEnd().split("\n");
      expect([mode, specs, `${reason}\n`].join("\n")).toBe(ci);
      expect(source).toBe("source=files");
      expect(rest).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mapped list stays short instead of widening to the suite", () => {
    // `not.toContain("mode=full")` passed on empty stdout; the mode line is
    // asserted positively instead.
    const out = execFileSync(process.execPath, [CLI, "--dry-run", "--files", "apps/web/src/pages/backups.tsx"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out.split("\n")[0]).toBe("mode=affected");
    expect(out).toContain("specs=tests/e2e/backups.spec.ts\n");
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
    // Four lines, nothing on stderr: a dry run that had quietly spawned the
    // suite would leave Playwright's own output behind.
    const run = Bun.spawnSync({
      cmd: [process.execPath, CLI, "--dry-run", "--files", "apps/web/src/pages/backups.tsx"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trimEnd().split("\n")).toHaveLength(4);
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
    expect(run.stdout.toString()).toContain("cannot diff against origin/does-not-exist");
    // `git` or `dirty`: a lane's own worktree usually has uncommitted edits, so
    // pinning one of the two here would fail on the machine it runs on. The
    // provenance values themselves are pinned in the `decide` tests, where the
    // sources are injected.
    expect(run.stdout.toString()).toMatch(/^source=(git|dirty)$/mu);
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

  test("--help prints usage on stdout and exits 0", () => {
    const run = Bun.spawnSync({
      cmd: [process.execPath, CLI, "--help"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("usage:");
    expect(run.stderr.toString()).toBe("");
  });

  test("the git path is taken, not bypassed: --base HEAD is an empty diff", () => {
    // `HEAD..HEAD` is empty on every commit, so this asserts the real merge-base
    // and the real diff actually ran and returned a diff-shaped nothing — not
    // that this checkout happens to be editing package.json today. A test that
    // pinned this branch's own file list would fail on every later branch.
    const run = Bun.spawnSync({
      cmd: [process.execPath, CLI, "--dry-run", "--base", "HEAD"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.toString().trimEnd().split("\n");
    expect(lines[0]).toBe("mode=full");
    expect(lines[1]).toBe("specs=");
    expect(lines[2]).toContain("empty diff");
    expect(lines[3]).toMatch(/^source=(git|dirty)$/u);
  });

  test("a decision always carries its four keys, in the order the tests read them", () => {
    const run = Bun.spawnSync({
      cmd: [process.execPath, CLI, "--dry-run", "--base", "HEAD"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const keys = run.stdout
      .toString()
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")));
    // `mode=`/`specs=`/`reason=` are ci.yml's contract; `source=` is this
    // driver's, and it is last so a reader that stops after three lines still
    // has the shape CI parses.
    expect(keys).toEqual(["mode", "specs", "reason", "source"]);
  });
});
