/**
 * True portable distribution (issue 64): assemble a copy-anywhere folder +
 * zip from the tauri release build. The app exe is renamed to
 * Dokan-portable.exe and shipped FLAT next to the api sidecar (`dokan-api.exe`)
 * and the built ui (`ui/`) — on Windows `resource_dir` IS the exe's folder,
 * so the Rust shell finds both with zero configuration. An empty
 * `portable.marker` file beside the exe flips the shell into portable mode:
 * all data then lives under `<folder>/data` and the whole thing runs in
 * place off a USB key. Mirrors the sibling project's build-portable.mjs.
 *
 * Run via `bun run --filter @dokan/desktop portable` (release.ts default
 * target, after `tauri build --no-bundle`). The nsis installer is never
 * produced on this path.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  copyValidatedTree,
  resolveTrustedTarPath,
  validateReleaseResourceEntries,
} from "./script-security-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const releaseRoot = path.resolve(desktopRoot, "src-tauri", "target", "release");

/** Marker file that switches the app into portable mode (see desktop.rs). */
export const PORTABLE_MARKER = "portable.marker";
/** The tauri-built binary inside target/release (crate name `dokan`). */
export const RELEASE_EXE_NAME = "dokan.exe";
/** The name customers see for the portable exe. */
export const PORTABLE_EXE_NAME = "Dokan-portable.exe";
/** Basename of the emitted portable folder and zip. */
export const PORTABLE_BASENAME = "Dokan-portable";
/** Sidecar file as bundled into the resources folder by tauri. */
export const SIDECAR_RESOURCE_NAME = "dokan-api.exe";
/** The built web UI resource folder name. */
export const UI_RESOURCE_NAME = "ui";

/** Resolve every path the assembly touches for a given release root. */
export function portableLayout(releaseRootPath = releaseRoot) {
  const portableRoot = path.join(releaseRootPath, "bundle", "portable");
  return {
    portableRoot,
    portableDir: path.join(portableRoot, PORTABLE_BASENAME),
    zipPath: path.join(portableRoot, `${PORTABLE_BASENAME}.zip`),
    resourcesDir: path.join(releaseRootPath, "resources"),
    appExePath: path.join(releaseRootPath, RELEASE_EXE_NAME),
  };
}

/**
 * Assemble the portable FOLDER from a finished release build (no zip). All
 * inputs are injectable so tests can fake a complete build in scratch dirs.
 */
export function assemblePortableFolder({
  releaseRootPath = releaseRoot,
  markerName = PORTABLE_MARKER,
  portableExeName = PORTABLE_EXE_NAME,
} = {}) {
  const layout = portableLayout(releaseRootPath);
  const { resourcesDir, appExePath, portableDir } = layout;

  if (!existsSync(appExePath)) {
    throw new Error(`Missing release app exe: ${appExePath}. Run tauri build first.`);
  }
  if (!existsSync(resourcesDir)) {
    throw new Error(`Missing release resources dir: ${resourcesDir}. Run tauri build first.`);
  }

  // assemble in a temp dir and rename into place, so a failed run never
  // leaves a half-built Dokan-portable/ behind
  const tempDir = path.join(layout.portableRoot, `.tmp-${PORTABLE_BASENAME}`);
  rmSync(tempDir, { recursive: true, force: true });

  let finalPortableDir = portableDir;
  try {
    rmSync(portableDir, { recursive: true, force: true });
  } catch {
    // another process holds the folder (e.g. the app running from it): fall
    // back to a `-new` sibling instead of aborting the whole build
    finalPortableDir = path.join(layout.portableRoot, `${PORTABLE_BASENAME}-new`);
    rmSync(finalPortableDir, { recursive: true, force: true });
  }

  mkdirSync(tempDir, { recursive: true });

  // the app exe, renamed so portable mode is obvious on a USB key
  copyFileSync(appExePath, path.join(tempDir, portableExeName));

  // sidecar + ui flat next to the exe; validate the resources folder first
  // so a stray or missing file can never ship silently
  validateReleaseResourceEntries(resourcesDir);
  copyFileSync(
    path.join(resourcesDir, SIDECAR_RESOURCE_NAME),
    path.join(tempDir, SIDECAR_RESOURCE_NAME),
  );
  copyValidatedTree(path.join(resourcesDir, UI_RESOURCE_NAME), path.join(tempDir, UI_RESOURCE_NAME));

  // the marker that flips the Rust shell into portable mode
  writeFileSync(path.join(tempDir, markerName), "");

  renameSync(tempDir, finalPortableDir);
  return { portableDir: finalPortableDir };
}

/**
 * Zip a finished portable folder with the trusted System32 tar.exe
 * (`-a -c -f <zip> -C <dir> .` — the same deterministic-ish style as the
 * sibling project). Returns the zip path.
 */
export function zipPortable({
  portableDir,
  zipPath,
  tarPath = resolveTrustedTarPath(),
} = {}) {
  const zipResult = spawnSync(tarPath, ["-a", "-c", "-f", zipPath, "-C", portableDir, "."], {
    stdio: "inherit",
    shell: false,
  });
  if (zipResult.status !== 0) {
    throw new Error("Failed to create portable zip archive.");
  }
  return zipPath;
}

/** Assemble the folder, zip it, and report both paths. */
export function assemblePortable(options = {}) {
  const { portableDir } = assemblePortableFolder(options);
  const zipPath = zipPortable({ ...options, portableDir });
  return { portableDir, zipPath };
}

if (import.meta.main) {
  const { portableDir, zipPath } = assemblePortable();
  console.log(`[dokan] portable folder ready at ${portableDir}`);
  console.log(`[dokan] portable zip ready at ${zipPath}`);
}