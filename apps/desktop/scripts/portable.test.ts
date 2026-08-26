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
  PORTABLE_BASENAME,
  PORTABLE_MARKER,
  PORTABLE_EXE_NAME,
  RELEASE_EXE_NAME,
  SIDECAR_RESOURCE_NAME,
  UI_RESOURCE_NAME,
  assemblePortableFolder,
  outputNames,
  portableLayout,
  zipPathFor,
  zipPortable,
} from "./portable.mjs";
import { requestedTarget } from "./release";
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
 * scoped temp dir and is removed even when the assertion body throws.
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

/**
 * Run an assertion body against a scratch fake build and GUARANTEE the
 * scratch root is removed afterwards (even when the body throws).
 */
function withScopedRelease(body, extraResourceEntries = []) {
  const { root, release } = fakeReleaseBuild(extraResourceEntries);
  try {
    return body({ root, release });
  } finally {
    cleanupScopedRoot(root);
  }
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
    withScopedRelease(({ release }) => {
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

      // nothing staged under a temp name survives
      expect(existsSync(path.join(path.dirname(portableDir), `.tmp-${PORTABLE_BASENAME}`))).toBe(false);
    });
  });

  it("fails loudly on an unexpected release resources entry", () => {
    withScopedRelease(
      ({ release }) => {
        expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
          /Release resources failed validation \(unexpected: stray\.dll\)/,
        );
      },
      ["stray.dll"],
    );
  });

  it("fails loudly on a missing sidecar in the release resources", () => {
    withScopedRelease(({ release }) => {
      // strip the sidecar, leaving only ui/ (as if the compile step broke)
      rmSync(path.join(release, "resources", SIDECAR_RESOURCE_NAME), { force: true });
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
        /Release resources failed validation \(missing: dokan-api\.exe\)/,
      );
    });
  });

  it("refuses a zero-byte sidecar or app exe (would boot into a dead api)", () => {
    withScopedRelease(({ release }) => {
      writeFileSync(path.join(release, "resources", SIDECAR_RESOURCE_NAME), "");
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(/empty \(0 bytes\)/);
    });
    withScopedRelease(({ release }) => {
      writeFileSync(path.join(release, RELEASE_EXE_NAME), "");
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(/empty \(0 bytes\)/);
    });
  });

  it("refuses a sidecar that is a directory instead of a file", () => {
    withScopedRelease(({ release }) => {
      rmSync(path.join(release, "resources", SIDECAR_RESOURCE_NAME), { force: true });
      mkdirSync(path.join(release, "resources", SIDECAR_RESOURCE_NAME));
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
        /Release resource "dokan-api\.exe" is not a file/,
      );
    });
  });

  it("fails loudly when the release exe is missing", () => {
    withScopedRelease(({ release }) => {
      rmSync(path.join(release, RELEASE_EXE_NAME), { force: true });
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(/Missing release app exe/);
    });
  });

  it("produces the documented portable layout paths", () => {
    const layout = portableLayout("C:\\build\\release");
    expect(layout.portableDir).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable");
    expect(layout.zipPath).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable.zip");
    expect(layout.appExePath).toBe("C:\\build\\release\\dokan.exe");
    expect(layout.resourcesDir).toBe("C:\\build\\release\\resources");
    // the zip is always named after its folder, including the `-new` fallback
    expect(zipPathFor("C:\\build\\release\\bundle\\portable\\Dokan-portable-new")).toBe(
      "C:\\build\\release\\bundle\\portable\\Dokan-portable-new.zip",
    );
  });

  it("falls back to a -new folder (and -new zip name) when the canonical folder cannot be replaced", () => {
    const portableRoot = portableLayout("C:\\build\\release").portableRoot;
    const canonical = outputNames(portableRoot);
    expect(canonical.portableDir).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable");
    expect(canonical.zipPath).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable.zip");
    // a locked canonical folder (a running app holds it open on Windows)
    // must fall back to a -new sibling AND name its zip after that folder
    const fallback = outputNames(portableRoot, { canReplaceCanonical: false });
    expect(fallback.portableDir).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable-new");
    expect(fallback.zipPath).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable-new.zip");
    expect(zipPathFor(fallback.portableDir)).toBe(fallback.zipPath);
  });
});

describe("release.ts target dispatch (issue 64)", () => {
  it("defaults to the portable folder+zip build", () => {
    expect(requestedTarget([])).toBe("portable");
    expect(requestedTarget(["scripts/release.ts"])).toBe("portable");
  });

  it("--installer selects the nsis installer and --portable is explicit", () => {
    expect(requestedTarget(["--installer"])).toBe("installer");
    expect(requestedTarget(["--portable"])).toBe("portable");
  });

  it("an explicit --portable wins over --installer (symmetry, not a surprise)", () => {
    expect(requestedTarget(["--portable", "--installer"])).toBe("portable");
  });

  it("rejects unknown flags loudly instead of silently building the wrong target", () => {
    expect(() => requestedTarget(["--instaler"])).toThrow(/unknown release flag/);
    expect(() => requestedTarget(["--installer", "--nope"])).toThrow(/unknown release flag/);
  });
});

describe("portable zip (issue 64)", () => {
  it.skipIf(process.platform !== "win32")(
    "zips the folder with the trusted tar.exe into Dokan-portable.zip",
    () => {
      withScopedRelease(({ release }) => {
        const { portableDir } = assemblePortableFolder({ releaseRootPath: release });
        const zipPath = zipPortable({ portableDir });
        expect(zipPath).toBe(portableLayout(release).zipPath);
        expect(existsSync(zipPath)).toBe(true);
        expect(statSync(zipPath).size).toBeGreaterThan(0);
      });
    },
  );
});

describe("script-security-utils (issue 64)", () => {
  it("validates the exact expected resource entries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-entries-"));
    try {
      mkdirSync(path.join(dir, "ui"), { recursive: true });
      writeFileSync(path.join(dir, "dokan-api.exe"), "x");
      expect(() => validateReleaseResourceEntries(dir)).not.toThrow();
      writeFileSync(path.join(dir, "surprise.bin"), "x");
      expect(() => validateReleaseResourceEntries(dir)).toThrow(/unexpected: surprise\.bin/);
    } finally {
      cleanupScopedRoot(dir);
    }
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
      cleanupScopedRoot(sourceDir);
      cleanupScopedRoot(destDir);
      cleanupScopedRoot(junctionTarget);
    }
  });
});