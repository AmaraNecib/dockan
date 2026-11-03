import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const EXPECTED_CONTRACT_SOURCES = [
  "packages/contracts/src/app-contract.ts",
  "packages/contracts/src/app-host.ts",
  "packages/contracts/src/arabic-search.ts",
  "packages/contracts/src/core.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/phone.ts",
  "packages/contracts/src/return-refund.ts",
] as const;

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const GUARD = fileURLToPath(new URL("./contracts-source-guard.ts", import.meta.url));
const HOOK = join(REPO_ROOT, ".husky", "pre-commit");

function huskyShell(): string {
  if (process.platform !== "win32") return "sh";

  const gitExecPath = execFileSync("git", ["--exec-path"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const candidates = [
    resolve(gitExecPath, "..", "..", "..", "bin", "sh.exe"),
    resolve(gitExecPath, "..", "..", "..", "usr", "bin", "sh.exe"),
  ];
  const shell = candidates.find(existsSync);
  if (!shell) throw new Error(`Git's Husky shell was not found from exec path ${gitExecPath}`);
  return shell;
}

function makeFixture(omitted?: string): string {
  const root = mkdtempSync(join(tmpdir(), "contracts-source-guard-"));
  for (const source of EXPECTED_CONTRACT_SOURCES) {
    if (source === omitted) continue;
    const file = join(root, ...source.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export {};\n");
  }
  const present = EXPECTED_CONTRACT_SOURCES.filter((source) => existsSync(join(root, ...source.split("/"))));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["add", "--", ...present], { cwd: root });
  return root;
}

function fileSymlinkSupported(): boolean {
  const root = mkdtempSync(join(tmpdir(), "contracts-source-guard-symlink-capability-"));
  const target = join(root, "target.txt");
  const link = join(root, "link.txt");
  try {
    writeFileSync(target, "fixture target\n");
    symlinkSync(target, link, process.platform === "win32" ? "file" : undefined);
    return lstatSync(link).isSymbolicLink();
  } catch (error) {
    // SAFETY: symlinkSync reports Windows privilege and capability failures as system error codes.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "ENOSYS") return false;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FILE_SYMLINK_SUPPORTED = fileSymlinkSupported();

function runGuard(root: string) {
  return spawnSync(process.execPath, [GUARD, root], {
    cwd: root,
    encoding: "utf8",
  });
}

function initGitFixture(root: string): void {
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "--", ...EXPECTED_CONTRACT_SOURCES], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
}

describe("contracts source pre-commit guard", () => {
  test("the hook runs the guard before the other checks", () => {
    const hook = readFileSync(HOOK, "utf8");
    const guardAt = hook.indexOf("bun scripts/contracts-source-guard.ts");
    const lintAt = hook.indexOf("bun run lint");

    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(lintAt);
  });

  test("the required set matches contract sources in the Git index", () => {
    const actual = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--", "packages/contracts/src"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean)
      .sort();

    expect(actual).toEqual([...EXPECTED_CONTRACT_SOURCES].sort());
  });

  test("refuses a disposable fixture with a missing expected source", () => {
    const missing = EXPECTED_CONTRACT_SOURCES[0];
    if (!missing) throw new Error("the expected source list is empty");
    const root = makeFixture(missing);

    try {
      const result = runGuard(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(missing);
      expect(result.stderr).toContain("Restore them from Git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts a disposable fixture with every expected source", () => {
    const root = makeFixture();

    try {
      const result = runGuard(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows an unstaged deletion to be restored in the working tree during development", () => {
    const root = makeFixture();
    const source = EXPECTED_CONTRACT_SOURCES[0];
    if (!source) throw new Error("the expected source list is empty");

    try {
      const file = join(root, ...source.split("/"));
      unlinkSync(file);
      writeFileSync(file, "export {}; // ordinary in-progress edit\\n");

      expect(existsSync(file)).toBe(true);
      expect(
        execFileSync("git", ["ls-files", "--error-unmatch", "--", source], { cwd: root, encoding: "utf8" }).trim(),
      ).toBe(source);
      const result = runGuard(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a staged deletion even when an untracked replacement exists", () => {
    const root = makeFixture();
    const missing = EXPECTED_CONTRACT_SOURCES[0];
    if (!missing) throw new Error("the expected source list is empty");

    try {
      initGitFixture(root);
      const replacement = join(root, ...missing.split("/"));
      unlinkSync(replacement);
      execFileSync("git", ["add", "-u", "--", missing], { cwd: root });
      writeFileSync(replacement, "export {}; // untracked replacement\n");

      expect(existsSync(replacement)).toBe(true);
      expect(
        () => execFileSync("git", ["ls-files", "--error-unmatch", "--", missing], { cwd: root, stdio: "ignore" }),
      ).toThrow();

      const result = runGuard(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(missing);
      expect(result.stderr).toContain("Git index");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a symlink index mode even when its worktree path is a local regular file", () => {
    const root = makeFixture();
    const source = EXPECTED_CONTRACT_SOURCES[0];
    if (!source) throw new Error("the expected source list is empty");

    try {
      const localFile = join(root, ...source.split("/"));
      expect(lstatSync(localFile).isFile()).toBe(true);
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        input: "local untracked target\n",
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["update-index", "--add", "--cacheinfo", "120000", blob, source], { cwd: root });

      const indexEntry = execFileSync("git", ["ls-files", "--stage", "--", source], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      expect(indexEntry.startsWith(`120000 ${blob} 0\t`)).toBe(true);
      expect(lstatSync(localFile).isFile()).toBe(true);

      const result = runGuard(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(source);
      expect(result.stderr).toContain("Git index");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts an indexed executable regular contract source", () => {
    const root = makeFixture();
    const source = EXPECTED_CONTRACT_SOURCES[0];
    if (!source) throw new Error("the expected source list is empty");

    try {
      execFileSync("git", ["update-index", "--chmod=+x", "--", source], { cwd: root });
      const indexEntry = execFileSync("git", ["ls-files", "--stage", "--", source], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      expect(indexEntry.startsWith("100755 ")).toBe(true);
      const result = runGuard(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!FILE_SYMLINK_SUPPORTED)("refuses a worktree symlink with a regular index mode", () => {
    const root = makeFixture();
    const source = EXPECTED_CONTRACT_SOURCES[0];
    const target = EXPECTED_CONTRACT_SOURCES[1];
    if (!source || !target) throw new Error("the expected source list needs at least two entries");

    try {
      const linkPath = join(root, ...source.split("/"));
      const targetPath = join(root, ...target.split("/"));
      unlinkSync(linkPath);
      symlinkSync(targetPath, linkPath, process.platform === "win32" ? "file" : undefined);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(
        execFileSync("git", ["ls-files", "--stage", "--", source], { cwd: root, encoding: "utf8" }).startsWith("100644 "),
      ).toBe(true);

      const result = runGuard(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(source);
      expect(result.stderr).toContain("worktree");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the Husky pre-commit stops after the guard command fails", () => {
    const fixture = mkdtempSync(join(tmpdir(), "contracts-hook-failure-"));
    const bin = join(fixture, "bin");
    const calls = join(fixture, "calls.txt");
    mkdirSync(bin);
    const stub = join(bin, "bun");
    writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$HOOK_CALLS"\nexit 37\n');
    chmodSync(stub, 0o755);

    try {
      const result = spawnSync(huskyShell(), ["-e", HOOK], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HOOK_CALLS: calls,
          PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(37);
      expect(readFileSync(calls, "utf8").trim()).toBe("scripts/contracts-source-guard.ts");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
