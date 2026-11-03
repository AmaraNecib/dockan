/**
 * Resolution order for the POSIX shell the workflow tests shell out with
 * (issue 349). The suite used to run `execFileSync("bash", ...)` and trust the
 * PATH lookup; on a Windows box whose PATH finds `C:\Windows\System32\bash.exe`
 * first, that launches the WSL launcher, which sees a different filesystem and
 * fails the two tests that execute a `run:` block (`sed: can't read scope.txt`,
 * then `EBUSY` when the temp dir is removed under it).
 *
 * The order has to be pinned with a fabricated PATH: a test that only runs
 * against this machine's real PATH passes or fails for reasons outside the
 * repo, and cannot assert that the System32 launcher is refused.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";

import { type PosixShellSearch, resolvePosixShell } from "./posix-shell";

const SYSTEM32_DIR = "C:\\Windows\\System32";
const SYSTEM32_BASH = "C:\\Windows\\System32\\bash.exe";
const GIT_ROOT = "C:\\Program Files\\Git";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PROGRAM_FILES = "C:\\Program Files";

/**
 * A search over a fabricated filesystem: `present` is every path that exists,
 * `pathEnv` is the PATH the resolver walks. Nothing here touches the host's
 * real PATH or disk, which is the point — the System32-first ordering is
 * simulated rather than borrowed from whichever machine runs the suite.
 *
 * `platform` has no default on purpose. A default of `win32` once let a test
 * written for a POSIX PATH look for `bash.exe` while its fixture held
 * `/usr/bin/bash`, so the only candidate was rejected and the assertion below it
 * never ran. A test that says which platform it simulates cannot make that
 * mistake.
 *
 * `executable` defaults to `present`: unless a test says otherwise, a file in the
 * fixture can run.
 */
function fabricated(options: {
  readonly platform: "win32" | "linux" | "darwin";
  readonly pathEnv?: string;
  readonly env?: Record<string, string | undefined>;
  readonly present: readonly string[];
  readonly executable?: readonly string[];
}): PosixShellSearch {
  const executable = options.executable ?? options.present;
  return {
    platform: options.platform,
    pathEnv: options.pathEnv ?? "",
    env: options.env ?? {},
    isFile: (candidate) => options.present.includes(candidate),
    isExecutable: (candidate) => executable.includes(candidate),
  };
}

describe("POSIX shell resolution", () => {
  it("skips the Windows System32 launcher and takes the Git bash later on PATH", () => {
    // The reported condition, exactly: System32 comes first, Git bash second.
    const resolved = resolvePosixShell(
      fabricated({
        platform: "win32",
        pathEnv: [SYSTEM32_DIR, `${GIT_ROOT}\\bin`].join(";"),
        present: [SYSTEM32_BASH, GIT_BASH],
      }),
    );

    // #369: the whole value — including `searched` — is pinned, so the refused
    // launcher is still recorded (considered, not merely missed) and the hollow
    // stand-in reds as an AssertionError instead of a TypeError.
    expect(resolved).toEqual({
      kind: "resolved",
      path: GIT_BASH,
      searched: [SYSTEM32_BASH, GIT_BASH],
    });
  });

  it("falls back to a Git for Windows install root when PATH has only the launcher", () => {
    const resolved = resolvePosixShell(
      fabricated({
        platform: "win32",
        pathEnv: SYSTEM32_DIR,
        env: { ProgramFiles: PROGRAM_FILES },
        present: [SYSTEM32_BASH, GIT_BASH],
      }),
    );

    expect(resolved).toEqual({
      kind: "resolved",
      path: GIT_BASH,
      searched: [SYSTEM32_BASH, GIT_BASH],
    });
  });

  it("takes the first bash on a POSIX PATH, where there is no launcher to skip", () => {
    const resolved = resolvePosixShell(
      fabricated({
        platform: "linux",
        pathEnv: ["/usr/local/bin", "/usr/bin"].join(":"),
        present: ["/usr/local/bin/bash", "/usr/bin/bash"],
      }),
    );

    expect(resolved).toEqual({
      kind: "resolved",
      path: "/usr/local/bin/bash",
      searched: ["/usr/local/bin/bash"],
    });
  });

  it("skips a bash it cannot execute and takes the one it can", () => {
    // The reported condition: an unusable `bash` earlier on PATH. Selecting it
    // fails the workflow tests with EACCES even though a usable shell sits right
    // behind it, so the check has to be "can this run", not "is this a file".
    const resolved = resolvePosixShell(
      fabricated({
        platform: "linux",
        pathEnv: ["/usr/local/bin", "/usr/bin"].join(":"),
        present: ["/usr/local/bin/bash", "/usr/bin/bash"],
        executable: ["/usr/bin/bash"],
      }),
    );

    // the one that runs, not merely the first one that exists — and the unusable
    // candidate stays in `searched`: examined and refused, not silently unseen
    expect(resolved).toEqual({
      kind: "resolved",
      path: "/usr/bin/bash",
      searched: ["/usr/local/bin/bash", "/usr/bin/bash"],
    });
  });

  it("names the shell it refused for being non-executable, rather than calling it absent", () => {
    const resolved = resolvePosixShell(
      fabricated({
        platform: "linux",
        pathEnv: "/usr/local/bin",
        present: ["/usr/local/bin/bash"],
        executable: [],
      }),
    );

    // "not found" and "found but unrunnable" call for different fixes, so the
    // reason has to tell them apart instead of reporting a bare absence. #369
    // pins the whole value with the reason included: none of it is volatile.
    expect(resolved).toEqual({
      kind: "absent",
      reason:
        "platform linux: no POSIX-capable bash found. Refused /usr/local/bin/bash: present but not executable, so running it would fail with EACCES. Looked on PATH. Checked: /usr/local/bin/bash.",
      searched: ["/usr/local/bin/bash"],
    });
  });

  it("resolves a relative PATH entry against the working directory", () => {
    // A relative entry must come back absolute: a bare `bash`, or a bare
    // directory, hands the choice back to the OS, which is the bug #349 is about.
    const resolved = resolvePosixShell({
      platform: "linux",
      pathEnv: "tools/git-bin",
      isFile: (candidate) => candidate.endsWith("/bash"),
      isExecutable: () => true,
    });

    // #369: the whole value is pinned to `path.posix.resolve`, the same
    // platform-flavour primitive the resolver applies — the pre-existing
    // tradeoff, unchanged — while the `isFile`/`isExecutable` pair is what gives
    // the row its teeth both here and against the gateway hollow.
    const entry = path.posix.resolve("tools/git-bin");
    expect(resolved).toEqual({
      kind: "resolved",
      path: `${entry}/bash`,
      searched: [`${entry}/bash`],
    });
  });

  it("names what it looked for and where when no POSIX shell exists", () => {
    const resolved = resolvePosixShell(
      fabricated({ platform: "win32", pathEnv: SYSTEM32_DIR, present: [SYSTEM32_BASH] }),
    );

    // never a silent absence: what it wanted, where it looked, the launcher it
    // refused and the install-root environment it consulted. #369 pins the whole
    // reason — the module owns the wording, so nothing in it is volatile.
    expect(resolved).toEqual({
      kind: "absent",
      reason: `platform win32: no POSIX-capable bash.exe found. Refused the WSL launcher ${SYSTEM32_BASH}: it runs a different filesystem view, so it cannot be trusted to see the script's own files. Looked on PATH and under the Git for Windows install roots named by ProgramFiles, ProgramW6432, ProgramFiles(x86) and LOCALAPPDATA. Checked: ${SYSTEM32_BASH}.`,
      searched: [SYSTEM32_BASH],
    });
  });

  it("does not treat an unrelated file named bash as a POSIX shell on POSIX", () => {
    // guards the `bash.exe`/`bash` suffix rule: Windows resolution must look for
    // the executable with its extension, POSIX without
    const resolved = resolvePosixShell(
      fabricated({
        platform: "darwin",
        pathEnv: "/opt/homebrew/bin",
        present: ["/opt/homebrew/bin/bash.exe"],
      }),
    );

    expect(resolved).toEqual({
      kind: "absent",
      reason: "platform darwin: no POSIX-capable bash found. Looked on PATH. Checked: /opt/homebrew/bin/bash.",
      searched: ["/opt/homebrew/bin/bash"],
    });
  });

  it("reports a well-formed resolution on this host, and never the System32 launcher", () => {
    // The live check: the fabricated tests pin the rule, this one proves the end
    // result on the machine running the suite. It asserts the *shape* rather than
    // a particular result, because a host with no POSIX shell has nothing to
    // prove here — `ci-workflow.test.ts` carries that absence as a named skip on
    // the two tests that need the shell.
    //
    // Called here, not at module scope: a module-scope call stops this file from
    // loading at all on a tree that lacks the module, which hides every test in
    // it from the red-on-parent gate instead of failing each one for itself.
    const resolved = resolvePosixShell();

    // #369: the shape is asserted whole and either arm of the union satisfies it,
    // so the hollow stand-in reds as `expect(undefined).toEqual(...)`
    // (AssertionError) instead of a `TypeError` off `resolved.kind`. The
    // conditional arms below never dereference on the parent, and `resolved.kind`
    // stays reachable there only after the expect above has already spoken.
    expect(resolved).toEqual(
      expect.objectContaining({
        kind: expect.stringMatching(/^(resolved|absent)$/u),
        searched: expect.any(Array),
      }),
    );

    if (resolved?.kind === "resolved") {
      // A relative PATH entry must not become the command handed to the runner.
      // This stays an assertion after the whole-value guard so the parent hollow
      // fails with AssertionError before this arm can dereference `path`.
      expect(path.isAbsolute(resolved.path)).toBe(true);
    }

    if (process.platform === "win32" && resolved?.kind === "resolved") {
      // this host must never be handed the WSL launcher
      expect(resolved.path.toLowerCase()).not.toBe(SYSTEM32_BASH.toLowerCase());
    } else if (resolved?.kind === "absent") {
      // an absence still says what was wanted, in words
      expect(resolved.reason).toContain("bash");
    }
  });
});
