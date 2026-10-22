/**
 * Which POSIX shell the workflow tests execute a `run:` block with (issue 349).
 *
 * These tests shell out because the point of several of them is that the YAML
 * step really works: `runDecide` executes the `changes`/`Decide the scope`
 * script, and the summary test executes `Report the scope decision`. They used
 * to call `execFileSync("bash", ...)` and let the OS resolve `bash` from PATH.
 *
 * On Windows that is a coin flip. `C:\Windows\System32\bash.exe` is the WSL
 * launcher: it runs a different distribution with a different view of the
 * filesystem, so a script that writes `scope.txt` into the current directory and
 * reads it back with `sed` can fail to see its own file, and the temp directory
 * stays busy after the child exits (`EBUSY` on cleanup). Whichever of
 * System32 and Git bash comes first on PATH decided whether the suite was green.
 *
 * So the shell is resolved explicitly, in a fixed order, to an absolute path:
 *
 *   1. the first `bash.exe` on PATH that is not the Windows system launcher;
 *   2. `<root>/bin/bash.exe` then `<root>/usr/bin/bash.exe` for the Git for
 *      Windows install roots named by `ProgramFiles`, `ProgramW6432`,
 *      `ProgramFiles(x86)` and `LOCALAPPDATA\Programs\Git`.
 *
 * The launcher is refused by location, not by guessing from behaviour: it is the
 * one file named `bash.exe` that ships inside the Windows system directory.
 *
 * A candidate has to be able to run, not merely to exist. On POSIX that means the
 * execute bit: a non-executable `bash` earlier on PATH used to be selected over a
 * usable one behind it, and every workflow test that shelled out died with
 * `EACCES`. Such a candidate is refused and the search falls through.
 *
 * When nothing is found the resolution says so with the list of paths it
 * checked. Callers skip with that reason rather than passing silently, because a
 * green suite that verified nothing is worse than a red one.
 */

import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export type PosixShellResolution =
  | {
      readonly kind: "resolved";
      /** Absolute path to the shell, so nothing can re-enter a PATH lookup. */
      readonly path: string;
      /** Every candidate examined, in order — including the ones refused. */
      readonly searched: readonly string[];
    }
  | {
      readonly kind: "absent";
      /** What was looked for, where, and why the launcher was refused. */
      readonly reason: string;
      readonly searched: readonly string[];
    };

/**
 * Everything the resolution reads from the host. Each field is injectable so the
 * order can be pinned against a fabricated PATH and a fabricated filesystem:
 * a test that borrows this machine's PATH only proves something about this
 * machine.
 */
export interface PosixShellSearch {
  readonly platform?: string;
  readonly pathEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isFile?: (candidate: string) => boolean;
  /**
   * True when the candidate carries the execute bit. Consulted on POSIX only:
   * Windows has no such bit, so presence as a regular file is the whole rule
   * there.
   */
  readonly isExecutable?: (candidate: string) => boolean;
}

/** Environment variables that point at a Git for Windows install root. */
const GIT_ROOT_VARIABLES = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] as const;
const GIT_PER_USER_ROOT = "Programs\\Git";

/**
 * True when `candidate` is an existing regular file. A directory named `bash.exe`
 * must not resolve, and a probe that throws (no such file, EACCES, ELOOP) means
 * nothing usable is there.
 */
function existsAsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * True when this process may execute `candidate`. A file that exists but is not
 * executable (`chmod -x`, a package manager's stray copy, an extracted archive)
 * is not a shell: selecting it turns every workflow test into `EACCES`, so it
 * must fall through to the next candidate instead of being accepted because it
 * is present.
 */
function hasExecuteAccess(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One directory compared the way Windows compares them: case-insensitively. */
function sameDirectory(flavour: path.PlatformPath, a: string, b: string): boolean {
  const trim = (value: string): string =>
    value.replace(/[\\/]+$/u, "").toLowerCase();
  return trim(flavour.resolve(a)) === trim(flavour.resolve(b));
}

/**
 * `C:\Windows\System32`, derived from the environment rather than hardcoded past
 * the Windows default. This is the WSL launcher's home, and the one PATH entry
 * this resolution refuses.
 */
function windowsSystemDirectory(
  env: Readonly<Record<string, string | undefined>>,
  flavour: path.PlatformPath,
): string {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return flavour.join(root, "System32");
}

/** The Git for Windows install roots the environment names, in a fixed order. */
function gitInstallRoots(
  env: Readonly<Record<string, string | undefined>>,
  flavour: path.PlatformPath,
): string[] {
  const roots: string[] = [];
  for (const variable of GIT_ROOT_VARIABLES) {
    const value = env[variable];
    if (value !== undefined && value.trim() !== "") roots.push(flavour.join(value, "Git"));
  }
  const localAppData = env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.trim() !== "") {
    roots.push(flavour.join(localAppData, GIT_PER_USER_ROOT));
  }
  return roots;
}

/**
 * A PATH entry as an absolute directory. Windows PATH entries are sometimes
 * quoted, and a relative entry is resolved against the working directory so the
 * returned shell path is always absolute.
 */
function absoluteDirectory(
  flavour: path.PlatformPath,
  segment: string,
): string {
  const unquoted = segment.replace(/^"(.*)"$/u, "$1");
  return flavour.isAbsolute(unquoted) ? unquoted : flavour.resolve(unquoted);
}

function absenceReason(
  platform: string,
  shellFile: string,
  searched: readonly string[],
  refusedLauncher: string | undefined,
  notExecutable: readonly string[],
): string {
  const refused =
    refusedLauncher === undefined
      ? ""
      : ` Refused the WSL launcher ${refusedLauncher}: it runs a different filesystem view, so it cannot be trusted to see the script's own files.`;
  const unexecutable =
    notExecutable.length === 0
      ? ""
      : ` Refused ${notExecutable.join(", ")}: present but not executable, so running it would fail with EACCES.`;
  const looked =
    platform === "win32"
      ? `on PATH and under the Git for Windows install roots named by ${GIT_ROOT_VARIABLES.join(", ")} and LOCALAPPDATA.`
      : "on PATH.";
  return (
    `platform ${platform}: no POSIX-capable ${shellFile} found.${refused}${unexecutable}` +
    ` Looked ${looked} Checked: ${searched.join(", ")}.`
  );
}

/** Resolve the POSIX shell to an absolute path, or report what was looked for. */
export function resolvePosixShell(search: PosixShellSearch = {}): PosixShellResolution {
  const platform = search.platform ?? process.platform;
  const flavour: path.PlatformPath = platform === "win32" ? path.win32 : path.posix;
  const env = search.env ?? process.env;
  const isFile = search.isFile ?? existsAsFile;
  const isExecutable = search.isExecutable ?? hasExecuteAccess;
  const shellFile = platform === "win32" ? "bash.exe" : "bash";
  const pathEnv = search.pathEnv ?? env.PATH ?? "";
  const delimiter = platform === "win32" ? ";" : ":";

  const onPath = pathEnv
    .split(delimiter)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .map((segment) => flavour.join(absoluteDirectory(flavour, segment), shellFile));

  // PATH order first: the shell the developer's own terminal uses. The install
  // roots are the fallback for a bash that is installed but not exported.
  const installRoots =
    platform === "win32"
      ? gitInstallRoots(env, flavour).flatMap((root) => [
          flavour.join(root, "bin", shellFile),
          flavour.join(root, "usr", "bin", shellFile),
        ])
      : [];

  const systemDirectory = platform === "win32" ? windowsSystemDirectory(env, flavour) : undefined;
  const searched: string[] = [];
  const notExecutable: string[] = [];
  let refusedLauncher: string | undefined;

  for (const candidate of [...onPath, ...installRoots]) {
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
    if (systemDirectory !== undefined && sameDirectory(flavour, flavour.dirname(candidate), systemDirectory)) {
      refusedLauncher = candidate;
      continue;
    }
    if (!isFile(candidate)) continue;
    // A candidate has to run, not merely exist: on POSIX that means the execute
    // bit, while on Windows there is no such bit and a regular file is the whole
    // rule. An unusable candidate falls through to the next one rather than being
    // selected because it happens to be there.
    if (platform !== "win32" && !isExecutable(candidate)) {
      notExecutable.push(candidate);
      continue;
    }
    return { kind: "resolved", path: candidate, searched };
  }

  return {
    kind: "absent",
    reason: absenceReason(platform, shellFile, searched, refusedLauncher, notExecutable),
    searched,
  };
}

/**
 * A `bun:test` title suffix that carries the absent shell's reason, or `""` when
 * one was found. A skip whose name does not say why is the silent pass this
 * module exists to prevent.
 */
export function absentShellTitleSuffix(resolution: PosixShellResolution): string {
  return resolution.kind === "absent" ? ` [skipped: ${resolution.reason}]` : "";
}
