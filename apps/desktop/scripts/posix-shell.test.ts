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

    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") throw new Error(resolved.reason);
    expect(resolved.path).toBe(GIT_BASH);
    // the refused launcher is still recorded, so a future reader can see it was
    // considered and not merely missed
    expect(resolved.searched).toContain(SYSTEM32_BASH);
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

    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") throw new Error(resolved.reason);
    expect(resolved.path).toBe(GIT_BASH);
  });

  it("takes the first bash on a POSIX PATH, where there is no launcher to skip", () => {
    const resolved = resolvePosixShell(
      fabricated({
        platform: "linux",
        pathEnv: ["/usr/local/bin", "/usr/bin"].join(":"),
        present: ["/usr/local/bin/bash", "/usr/bin/bash"],
      }),
    );

    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") throw new Error(resolved.reason);
    expect(resolved.path).toBe("/usr/local/bin/bash");
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

    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") throw new Error(resolved.reason);
    // the one that runs, not merely the first one that exists
    expect(resolved.path).toBe("/usr/bin/bash");
    // and the unusable candidate is recorded as examined, not silently unseen
    expect(resolved.searched).toContain("/usr/local/bin/bash");
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
    // reason has to tell them apart instead of reporting a bare absence.
    expect(resolved.kind).toBe("absent");
    if (resolved.kind !== "absent") throw new Error("expected no usable shell");
    expect(resolved.reason).toContain("/usr/local/bin/bash");
    expect(resolved.reason).toContain("not executable");
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

    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") throw new Error(resolved.reason);
    expect(path.posix.isAbsolute(resolved.path)).toBe(true);
    // the entry survived the conversion instead of being replaced by a guess
    expect(resolved.path.endsWith("/tools/git-bin/bash")).toBe(true);
  });

  it("names what it looked for and where when no POSIX shell exists", () => {
    const resolved = resolvePosixShell(
      fabricated({ platform: "win32", pathEnv: SYSTEM32_DIR, present: [SYSTEM32_BASH] }),
    );

    // never a silent absence: the reason is what a skip or a failure reports
    expect(resolved.kind).toBe("absent");
    if (resolved.kind !== "absent") throw new Error("expected no resolvable shell");
    // what it wanted...
    expect(resolved.reason).toContain("bash.exe");
    // ...where it looked, including the directory it walked, the launcher it
    // refused, and the environment variables naming the install roots
    expect(resolved.reason).toContain(SYSTEM32_DIR);
    expect(resolved.reason).toContain("WSL");
    expect(resolved.reason).toContain("ProgramFiles");
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

    expect(resolved.kind).toBe("absent");
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

    if (resolved.kind === "resolved") {
      expect(path.isAbsolute(resolved.path)).toBe(true);
      if (process.platform === "win32") {
        expect(resolved.path.toLowerCase()).not.toBe(SYSTEM32_BASH.toLowerCase());
      }
    } else {
      expect(resolved.reason).toContain("bash");
    }
  });
});
