import { describe, expect, it } from "bun:test";

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PORTABLE_MARKER,
  PORTABLE_EXE_NAME,
  RELEASE_EXE_NAME,
  SIDECAR_RESOURCE_NAME,
  UI_RESOURCE_NAME,
  assemblePortableFolder,
  portableLayout,
  zipPortable,
} from "./portable.mjs";
import {
  copyValidatedTree,
  resolveTrustedTarPath,
  validateReleaseResourceEntries,
} from "./script-security-utils.mjs";

const TEMP_ROOT = path.resolve(tmpdir());

/**
 * Scoped cleanup for a test scratch dir: ASSERT the dir is a DIRECT child of
 * the os tmpdir() before deleting it, so a mis-constructed path can never
 * climb to the temp root (or anywhere above it) and `rmSync -r` a folder it
 * must not touch. Verifies the deletion actually happened.
 */
function cleanupScopedRoot(root) {
  const scoped = path.resolve(root);
  expect(path.dirname(scoped)).toBe(TEMP_ROOT);
  expect(scoped.startsWith(TEMP_ROOT)).toBe(true);
  expect(scoped).not.toBe(TEMP_ROOT);
  rmSync(scoped, { recursive: true, force: true });
  expect(existsSync(scoped)).toBe(false);
}

/**
 * Fake a complete `tauri build --no-bundle` output (issue 64): the app exe
 * next to a resources folder holding the sidecar and the built ui tree, the
 * way tauri-build lays out `target/release/`. All output lives under a fresh
 * scoped temp dir; callers must clean up with `cleanupScopedRoot(root)`.
 */
function fakeReleaseBuild(extraResourceEntries = []) {
  const root = mkdtempSync(path.join(tmpdir(), "dokan-portable-test-"));
  const release = path.join(root, "release");
  const resources = path.join(release, "resources");
  mkdirSync(path.join(resources, UI_RESOURCE_NAME, "assets"), { recursive: true });
  writeFileSync(path.join(release, RELEASE_EXE_NAME), "fake-app-exe");
  writeFileSync(path.join(resources, SIDECAR_RESOURCE_NAME), "fake-sidecar");
  writeFileSync(path.join(resources, UI_RESOURCE_NAME, "index.html"), "<html />");
  writeFileSync(path.join(resources, UI_RESOURCE_NAME, "assets", "app.js"), "console.log(1);");
  for (const entry of extraResourceEntries) {
    writeFileSync(path.join(resources, entry), "extra");
  }
  return { root, release };
}

function portableFolderEntries(portableDir) {
  const entries = readdirSync(portableDir, { withFileTypes: true }).map((e) => e.name).sort();
  return {
    has: (name) => entries.includes(name),
    names: entries,
  };
}

/** Recursively collect every filename under a dir (used to prove no nsis
 * artifact sneaks into the portable output). */
function walkNames(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkNames(full));
    } else {
      out.push(entry.name);
    }
  }
  return out;
}

describe("portable assembly (issue 64)", () => {
  it("assembles a folder with the renamed exe, sidecar, ui tree and the portable marker", () => {
    const { root, release } = fakeReleaseBuild();
    const { portableDir } = assemblePortableFolder({ releaseRootPath: release });

    const folder = portableFolderEntries(portableDir);
    expect(folder.has(PORTABLE_EXE_NAME)).toBe(true);
    expect(folder.has(SIDECAR_RESOURCE_NAME)).toBe(true);
    expect(folder.has(UI_RESOURCE_NAME)).toBe(true);
    expect(folder.has(PORTABLE_MARKER)).toBe(true);
    // the source exe must NOT be copied under its build name
    expect(folder.has(RELEASE_EXE_NAME)).toBe(false);
    // the ui tree is deep-copied, not linked or truncated
    expect(existsSync(path.join(portableDir, UI_RESOURCE_NAME, "assets", "app.js"))).toBe(true);
    expect(readFileSync(path.join(portableDir, UI_RESOURCE_NAME, "index.html"), "utf8")).toBe("<html />");
    // the marker is present but EMPTY
    expect(statSync(path.join(portableDir, PORTABLE_MARKER)).size).toBe(0);

    // the portable output contains NO nsis/installer artifact
    const allNames = walkNames(path.dirname(portableDir));
    expect(allNames.some((name) => /setup\.exe$/i.test(name))).toBe(false);

    cleanupScopedRoot(root);
  });

  it("fails loudly on an unexpected release resources entry", () => {
    const { root, release } = fakeReleaseBuild(["stray.dll"]);
    expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
      /Release resources failed validation \(unexpected: stray\.dll\)/,
    );
    cleanupScopedRoot(root);
  });

  it("fails loudly on a missing sidecar in the release resources", () => {
    const { root, release } = fakeReleaseBuild();
    // strip the sidecar, leaving only ui/ (as if the compile step broke)
    rmSync(path.join(release, "resources", SIDECAR_RESOURCE_NAME), { force: true });
    expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
      /Release resources failed validation \(missing: dokan-api\.exe\)/,
    );
    cleanupScopedRoot(root);
  });

  it("fails loudly when the release exe is missing", () => {
    const { root, release } = fakeReleaseBuild();
    rmSync(path.join(release, RELEASE_EXE_NAME), { force: true });
    expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(/Missing release app exe/);
    cleanupScopedRoot(root);
  });

  it("produces the documented portable layout paths", () => {
    const layout = portableLayout("C:\\build\\release");
    expect(layout.portableDir).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable");
    expect(layout.zipPath).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable.zip");
    expect(layout.appExePath).toBe("C:\\build\\release\\dokan.exe");
    expect(layout.resourcesDir).toBe("C:\\build\\release\\resources");
  });
});

describe("portable zip (issue 64)", () => {
  it.skipIf(process.platform !== "win32")(
    "zips the folder with the trusted tar.exe into Dokan-portable.zip",
    () => {
      const { root, release } = fakeReleaseBuild();
      const { portableDir } = assemblePortableFolder({ releaseRootPath: release });
      const layout = portableLayout(release);
      const zipPath = zipPortable({ portableDir, zipPath: layout.zipPath });
      expect(zipPath).toBe(layout.zipPath);
      expect(existsSync(zipPath)).toBe(true);
      expect(statSync(zipPath).size).toBeGreaterThan(0);
      cleanupScopedRoot(root);
    },
  );
});

describe("script-security-utils (issue 64)", () => {
  it("validates the exact expected resource entries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-entries-"));
    mkdirSync(path.join(dir, "ui"), { recursive: true });
    writeFileSync(path.join(dir, "dokan-api.exe"), "x");
    expect(() => validateReleaseResourceEntries(dir)).not.toThrow();
    writeFileSync(path.join(dir, "surprise.bin"), "x");
    expect(() => validateReleaseResourceEntries(dir)).toThrow(/unexpected: surprise\.bin/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the trusted tar.exe only from System32/Sysnative", () => {
    const tarPath = resolveTrustedTarPath({
      platform: "win32",
      env: { SystemRoot: "C:/Windows" },
      exists: (candidate) => candidate === path.join(path.resolve("C:/Windows"), "System32", "tar.exe"),
    });
    expect(tarPath).toBe(path.join(path.resolve("C:/Windows"), "System32", "tar.exe"));
    expect(() =>
      resolveTrustedTarPath({
        platform: "win32",
        env: { SystemRoot: "C:/Windows" },
        exists: () => false,
      }),
    ).toThrow(/Unable to locate trusted tar\.exe/);
    expect(() =>
      resolveTrustedTarPath({
        platform: "linux",
        env: {},
      }),
    ).toThrow(/Windows hosts/);
  });

  it("copyValidatedTree deep-copies files and refuses a junction root", () => {
    const sourceDir = mkdtempSync(path.join(tmpdir(), "dokan-copy-src-"));
    const destDir = mkdtempSync(path.join(tmpdir(), "dokan-copy-dst-"));
    const junctionTarget = mkdtempSync(path.join(tmpdir(), "dokan-copy-target-"));
    try {
      mkdirSync(path.join(sourceDir, "nested"), { recursive: true });
      writeFileSync(path.join(sourceDir, "nested", "file.txt"), "hello");
      copyValidatedTree(sourceDir, path.join(destDir, "copied"));
      expect(readFileSync(path.join(destDir, "copied", "nested", "file.txt"), "utf8")).toBe("hello");

      try {
        symlinkSync(junctionTarget, path.join(sourceDir, "linked-dir"), "junction");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EPERM") {
          console.warn(
            "[portable.test] junction creation is not permitted here — the symlink-refusal branch was not exercised",
          );
          return;
        }
        throw error;
      }
      expect(() => copyValidatedTree(sourceDir, path.join(destDir, "copied-2"))).toThrow(
        /Refusing to package symbolic link/,
      );
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(destDir, { recursive: true, force: true });
      rmSync(junctionTarget, { recursive: true, force: true });
    }
  });
});