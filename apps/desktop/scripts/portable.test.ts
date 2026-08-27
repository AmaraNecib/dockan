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
  LOCK_RETRY_ATTEMPTS,
  assemblePortableFolder,
  outputNames,
  portableLayout,
  tryRemoveOutputFolder,
  zipPathFor,
  zipPortable,
} from "./portable.mjs";
import { requestedTarget } from "./release";
import {
  copyValidatedTree,
  resolveTrustedTarPath,
  validateReleaseArtifacts,
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
 * Fake a complete `tauri build --no-bundle` output (issue 64) the way this
 * repo's tauri-build actually lays it out: the app exe, the sidecar and the
 * ui tree FLAT in `target/release/` (no resources/ subdir — verified by a
 * real build on 2026-08-26). All output lives under a fresh scoped temp dir
 * and is removed even when the assertion body throws.
 */
function fakeReleaseBuild() {
  const root = mkdtempSync(path.join(tmpdir(), "dokan-portable-test-"));
  const release = path.join(root, "release");
  mkdirSync(path.join(release, UI_RESOURCE_NAME, "assets"), { recursive: true });
  writeFileSync(path.join(release, RELEASE_EXE_NAME), "fake-app-exe");
  writeFileSync(path.join(release, SIDECAR_RESOURCE_NAME), "fake-sidecar");
  writeFileSync(path.join(release, UI_RESOURCE_NAME, "index.html"), "<html />");
  writeFileSync(path.join(release, UI_RESOURCE_NAME, "assets", "app.js"), "console.log(1);");
  return { root, release };
}

/**
 * Run an assertion body against a scratch fake build and GUARANTEE the
 * scratch root is removed afterwards (even when the body throws).
 */
function withScopedRelease(body) {
  const { root, release } = fakeReleaseBuild();
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
      expect(
        existsSync(path.join(path.dirname(portableDir), `.tmp-${PORTABLE_BASENAME}-${process.pid}`)),
      ).toBe(false);

      // assembly COPIES the app exe — the source in target/release must
      // survive, and the renamed portable exe must be byte-identical to it
      // (a renameSync regression would consume the source here)
      expect(existsSync(path.join(release, RELEASE_EXE_NAME))).toBe(true);
      expect(readFileSync(path.join(portableDir, PORTABLE_EXE_NAME))).toEqual(
        readFileSync(path.join(release, RELEASE_EXE_NAME)),
      );
    });
  });

  it("ignores unrelated release-root build outputs (deps/, build/, .pdb, lockfiles)", () => {
    withScopedRelease(({ release }) => {
      // cargo/tauri leave plenty of non-shippable output in target/release;
      // the portable folder must only ever take the three real artifacts
      mkdirSync(path.join(release, "deps"), { recursive: true });
      mkdirSync(path.join(release, ".fingerprint"), { recursive: true });
      writeFileSync(path.join(release, "dokan.pdb"), "symbols");
      writeFileSync(path.join(release, ".cargo-lock"), "lock");
      const { portableDir } = assemblePortableFolder({ releaseRootPath: release });
      const folder = portableFolderEntries(portableDir);
      expect(folder.has("dokan.pdb")).toBe(false);
      expect(folder.has(".cargo-lock")).toBe(false);
      expect(folder.has("deps")).toBe(false);
    });
  });

  it("fails loudly on a missing sidecar in the release tree", () => {
    withScopedRelease(({ release }) => {
      // strip the sidecar, leaving only ui/ (as if the compile step broke)
      rmSync(path.join(release, SIDECAR_RESOURCE_NAME), { force: true });
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
        /Release artifact missing: dokan-api\.exe/,
      );
    });
  });

  it("refuses a zero-byte sidecar or app exe (would boot into a dead api)", () => {
    withScopedRelease(({ release }) => {
      writeFileSync(path.join(release, SIDECAR_RESOURCE_NAME), "");
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(/empty \(0 bytes\)/);
    });
    withScopedRelease(({ release }) => {
      writeFileSync(path.join(release, RELEASE_EXE_NAME), "");
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(/empty \(0 bytes\)/);
    });
  });

  it("refuses a sidecar that is a directory instead of a file", () => {
    withScopedRelease(({ release }) => {
      rmSync(path.join(release, SIDECAR_RESOURCE_NAME), { force: true });
      mkdirSync(path.join(release, SIDECAR_RESOURCE_NAME));
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
        /Release artifact "dokan-api\.exe" is not a file/,
      );
    });
  });

  it("fails loudly when the release app exe is missing", () => {
    withScopedRelease(({ release }) => {
      rmSync(path.join(release, RELEASE_EXE_NAME), { force: true });
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
        /Release artifact missing: dokan\.exe/,
      );
    });
  });

  it("refuses an empty ui/ directory (would ship a dead UI)", () => {
    withScopedRelease(({ release }) => {
      rmSync(path.join(release, UI_RESOURCE_NAME), { recursive: true, force: true });
      mkdirSync(path.join(release, UI_RESOURCE_NAME));
      expect(() => assemblePortableFolder({ releaseRootPath: release })).toThrow(
        /Release artifact "ui" is an empty directory/,
      );
    });
  });

  it("produces the documented portable layout paths", () => {
    const layout = portableLayout("C:\\build\\release");
    expect(layout.portableDir).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable");
    expect(layout.zipPath).toBe("C:\\build\\release\\bundle\\portable\\Dokan-portable.zip");
    expect(layout.appExePath).toBe("C:\\build\\release\\dokan.exe");
    expect(layout.sidecarSourcePath).toBe("C:\\build\\release\\dokan-api.exe");
    expect(layout.uiSourcePath).toBe("C:\\build\\release\\ui");
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

/**
 * Inject a removal strategy into [`assemblePortableFolder`]: the given paths
 * act as if held open by another process (removal throws); everything else
 * uses the real fs. Retries run instantly (zero delay, no real sleep) so the
 * regression tests are deterministic without relying on Windows handle
 * semantics (Bun's rmSync ignores open-handle locks).
 */
function lockedRemoveWrapper(lockedPaths) {
  const locked = new Set(lockedPaths.map((p) => path.resolve(p)));
  const remove = (p) => {
    if (locked.has(path.resolve(p))) {
      throw new Error("EBUSY: portable output folder is locked");
    }
    rmSync(p, { recursive: true, force: true });
  };
  return (dir) =>
    tryRemoveOutputFolder(dir, { remove, sleep: () => {}, attempts: LOCK_RETRY_ATTEMPTS, delayMs: 0 });
}

describe("portable output lock handling (issue 64 / PR #65)", () => {
  it("tryRemoveOutputFolder retries exactly the bounded attempts and reports a persistent lock", () => {
    const dir = path.join(tmpdir(), "dokan-lock-bounded");
    let calls = 0;
    let sleeps = 0;
    const ok = tryRemoveOutputFolder(dir, {
      attempts: 3,
      delayMs: 0,
      remove: () => {
        calls += 1;
        throw new Error("EBUSY");
      },
      sleep: () => {
        sleeps += 1;
      },
    });
    expect(ok).toBe(false);
    expect(calls).toBe(3);
    // a bounded retry sleeps between attempts, never after the last one
    expect(sleeps).toBe(2);
  });

  it("tryRemoveOutputFolder re-checks existence when a remove does not throw yet leaves the dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-lock-persist-"));
    // a remove that succeeds WITHOUT deleting (e.g. a silent no-op) must not
    // be mistaken for success — the existsSync re-check drives a retry and
    // eventually reports the folder as still busy
    const ok = tryRemoveOutputFolder(dir, {
      attempts: 2,
      delayMs: 0,
      remove: () => {},
      sleep: () => {},
    });
    expect(ok).toBe(false);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tryRemoveOutputFolder succeeds once a transient lock clears", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-lock-transient-"));
    let calls = 0;
    const ok = tryRemoveOutputFolder(dir, {
      attempts: 3,
      delayMs: 0,
      remove: () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("EBUSY");
        }
        rmSync(dir, { recursive: true, force: true });
      },
      sleep: () => {},
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(existsSync(dir)).toBe(false);
  });

  it("tryRemoveOutputFolder treats an absent folder as removable", () => {
    const dir = path.join(tmpdir(), "dokan-lock-absent");
    rmSync(dir, { recursive: true, force: true });
    expect(tryRemoveOutputFolder(dir, { attempts: 3, delayMs: 0, sleep: () => {} })).toBe(true);
  });

  it("fails loudly when BOTH output folders are locked: actionable error, no partial output, scoped cleanup", () => {
    withScopedRelease(({ release }) => {
      const layout = portableLayout(release);
      // both candidate outputs already exist and are “locked”
      mkdirSync(layout.portableDir, { recursive: true });
      writeFileSync(path.join(layout.portableDir, "canonical.txt"), "busy");
      const newDir = path.join(layout.portableRoot, `${PORTABLE_BASENAME}-new`);
      mkdirSync(newDir, { recursive: true });
      writeFileSync(path.join(newDir, "new.txt"), "busy");
      // a sentinel OUTSIDE the scoped bundle/portable output dir must survive
      const sentinelOutsidePortable = path.join(layout.portableRoot, "..", "portable-sentinel.txt");
      writeFileSync(sentinelOutsidePortable, "keep-me");

      const removeOutputFolder = lockedRemoveWrapper([layout.portableDir, newDir]);
      let error;
      try {
        assemblePortableFolder({ releaseRootPath: release, removeOutputFolder });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/locked by another process/);
      expect(String(error.message)).toMatch(/close the running app/i);
      expect(String(error.message)).toMatch(/Dokan-portable\*/);

      // nothing outside the scoped portable output dir was deleted
      expect(readFileSync(sentinelOutsidePortable, "utf8")).toBe("keep-me");
      // no partial assembly happened: no renamed exe, no staging leftover
      expect(existsSync(path.join(layout.portableDir, PORTABLE_EXE_NAME))).toBe(false);
      expect(
        existsSync(path.join(layout.portableRoot, `.tmp-${PORTABLE_BASENAME}-${process.pid}`)),
      ).toBe(false);
      // the locked folders were untouched
      expect(readFileSync(path.join(layout.portableDir, "canonical.txt"), "utf8")).toBe("busy");
      expect(readFileSync(path.join(newDir, "new.txt"), "utf8")).toBe("busy");
    });
  });

  it("keeps the -new fallback when ONLY the canonical folder is locked", () => {
    withScopedRelease(({ release }) => {
      const layout = portableLayout(release);
      mkdirSync(layout.portableDir, { recursive: true });
      writeFileSync(path.join(layout.portableDir, "canonical.txt"), "busy");

      const removeOutputFolder = lockedRemoveWrapper([layout.portableDir]);
      const { portableDir } = assemblePortableFolder({ releaseRootPath: release, removeOutputFolder });
      expect(portableDir).toBe(path.join(layout.portableRoot, `${PORTABLE_BASENAME}-new`));
      expect(zipPathFor(portableDir)).toBe(
        path.join(layout.portableRoot, `${PORTABLE_BASENAME}-new.zip`),
      );
      // the locked canonical folder is left untouched; the -new one is complete
      expect(readFileSync(path.join(layout.portableDir, "canonical.txt"), "utf8")).toBe("busy");
      expect(existsSync(path.join(portableDir, PORTABLE_EXE_NAME))).toBe(true);
      expect(statSync(path.join(portableDir, PORTABLE_MARKER)).size).toBe(0);
    });
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
  it("validates the release artifacts: present, correctly typed, non-empty", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dokan-entries-"));
    try {
      mkdirSync(path.join(dir, "ui", "assets"), { recursive: true });
      writeFileSync(path.join(dir, "ui", "index.html"), "x");
      writeFileSync(path.join(dir, "dokan.exe"), "x");
      writeFileSync(path.join(dir, "dokan-api.exe"), "x");
      expect(() => validateReleaseArtifacts(dir)).not.toThrow();
      // a missing artifact is reported by name
      rmSync(path.join(dir, "dokan-api.exe"), { force: true });
      expect(() => validateReleaseArtifacts(dir)).toThrow(/Release artifact missing: dokan-api\.exe/);
      // a zero-byte artifact is refused
      writeFileSync(path.join(dir, "dokan-api.exe"), "");
      expect(() => validateReleaseArtifacts(dir)).toThrow(/empty \(0 bytes\)/);
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