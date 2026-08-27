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

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  copyValidatedTree,
  resolveTrustedTarPath,
  validateReleaseArtifacts,
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
    // the release root is FLAT: tauri-build copies the resources map and the
    // external sidecar straight into target/release (no resources/ subdir)
    uiSourcePath: path.join(releaseRootPath, UI_RESOURCE_NAME),
    sidecarSourcePath: path.join(releaseRootPath, SIDECAR_RESOURCE_NAME),
    appExePath: path.join(releaseRootPath, RELEASE_EXE_NAME),
  };
}

/** The zip keeps the FOLDER's basename (Dokan-portable.zip or, when the
 * folder fell back to `-new` because the canonical one was locked,
 * Dokan-portable-new.zip) so the archive never names a different folder
 * than it contains. */
export function zipPathFor(portableDir) {
  return path.join(path.dirname(portableDir), `${path.basename(portableDir)}.zip`);
}

/**
 * Decide the final folder + zip names for a release root. When the canonical
 * folder cannot be replaced (locked/running app — the Windows case where
 * rmSync throws), the assembly falls back to a `-new` sibling. Both names
 * derive from the same base so the zip always names the folder it contains.
 */
export function outputNames(
  portableRoot,
  { baseName = PORTABLE_BASENAME, canReplaceCanonical = true } = {},
) {
  const folderName = canReplaceCanonical ? baseName : `${baseName}-new`;
  const portableDir = path.join(portableRoot, folderName);
  return { portableDir, zipPath: path.join(portableRoot, `${folderName}.zip`) };
}

/** How many removal attempts for a locked portable output folder. */
export const LOCK_RETRY_ATTEMPTS = 3;
/** Sleep between removal attempts (ms) — transient locks (antivirus scans,
 * brief handles) usually clear within a few hundred ms. */
export const LOCK_RETRY_DELAY_MS = 150;

/** Synchronous bounded sleep (the assembly is synchronous; 150ms in a CLI
 * packaging script is fine). Injected in tests so retries run instantly. */
export function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/**
 * Remove a portable output folder (`rmSync -r --force`) with a bounded
 * retry. Returns TRUE when the folder is gone (or never existed) and FALSE
 * when it is still held by another process after all attempts. It only ever
 * touches exactly `folderPath` — never a parent or sibling. `remove` and
 * `sleep` are injectable so tests can simulate a locked folder
 * deterministically (Bun's rmSync ignores Windows open-handle locks, so an
 * OS-level lock is not reliably simulatable).
 */
export function tryRemoveOutputFolder(
  folderPath,
  {
    attempts = LOCK_RETRY_ATTEMPTS,
    delayMs = LOCK_RETRY_DELAY_MS,
    remove = (p) => rmSync(p, { recursive: true, force: true }),
    sleep = sleepSync,
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(folderPath);
      if (!existsSync(folderPath)) {
        return true;
      }
    } catch {
      // fall through to the next attempt
    }
    if (attempt < attempts) {
      sleep(delayMs);
    }
  }
  return false;
}

/**
 * Assemble the portable FOLDER from a finished release build (no zip). All
 * inputs are injectable so tests can fake a complete build in scratch dirs.
 * `removeOutputFolder` is the removal-until-free strategy; tests inject a
 * wrapper over [`tryRemoveOutputFolder`] with fake remove/sleep fns.
 */
export function assemblePortableFolder({
  releaseRootPath = releaseRoot,
  markerName = PORTABLE_MARKER,
  portableExeName = PORTABLE_EXE_NAME,
  removeOutputFolder = tryRemoveOutputFolder,
} = {}) {
  const layout = portableLayout(releaseRootPath);
  const { sidecarSourcePath: sidecarSource, uiSourcePath: uiSource, appExePath } = layout;

  // every artifact the folder is built from must be present, correctly
  // typed and non-empty — the app exe, the api sidecar and the ui tree
  validateReleaseArtifacts(releaseRootPath);

  // assemble in a per-process temp dir and rename into place, so a failed
  // run never leaves a half-built Dokan-portable/ behind and two concurrent
  // builds never clobber each other's staging copy
  const tempDir = path.join(layout.portableRoot, `.tmp-${PORTABLE_BASENAME}-${process.pid}`);
  rmSync(tempDir, { recursive: true, force: true });

  // remove the existing canonical output with a bounded retry; when it
  // stays locked (a running app holds it open on Windows), fall back to a
  // `-new` sibling — the zip follows the folder name via `outputNames`
  const canonical = layout.portableDir;
  const canReplaceCanonical = removeOutputFolder(canonical);
  const finalPortableDir = outputNames(layout.portableRoot, { canReplaceCanonical }).portableDir;

  // the selected output folder must be free — a `-new` that is ALSO locked
  // is a real conflict: fail loudly with an actionable message instead of
  // silently skipping or packing into a partial/stale layout
  if (finalPortableDir !== canonical && !removeOutputFolder(finalPortableDir)) {
    throw new Error(
      `Portable output folders are locked by another process: both ${canonical} ` +
        `and ${layout.portableRoot}/${PORTABLE_BASENAME}-new could not be removed. ` +
        `Close the running app (or remove ${layout.portableRoot}/${PORTABLE_BASENAME}*) and retry.`,
    );
  }

  try {
    mkdirSync(tempDir, { recursive: true });

    // the app exe, renamed so portable mode is obvious on a USB key
    copyFileSync(appExePath, path.join(tempDir, portableExeName));

    // sidecar + ui shipped flat next to the exe (Windows resource_dir ==
    // exe dir, so the Rust shell finds them with zero configuration)
    copyFileSync(sidecarSource, path.join(tempDir, SIDECAR_RESOURCE_NAME));
    copyValidatedTree(uiSource, path.join(tempDir, UI_RESOURCE_NAME));

    // the marker that flips the Rust shell into portable mode
    writeFileSync(path.join(tempDir, markerName), "");

    renameSync(tempDir, finalPortableDir);
  } catch (error) {
    // a failed assembly must not leave the staging dir behind
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return { portableDir: finalPortableDir };
}

/**
 * Zip a finished portable folder with the trusted System32 tar.exe
 * (`-a -c -f <zip> -C <dir> .` — the same deterministic-ish style as the
 * sibling project). Returns the zip path. The archive must exist and be
 * non-empty afterwards — an empty folder would "zip successfully" into a
 * useless empty archive, so that is refused loudly too.
 */
export function zipPortable({
  portableDir,
  zipPath = zipPathFor(portableDir),
  tarPath = resolveTrustedTarPath(),
} = {}) {
  const zipResult = spawnSync(tarPath, ["-a", "-c", "-f", zipPath, "-C", portableDir, "."], {
    stdio: "inherit",
    shell: false,
  });
  if (zipResult.status !== 0) {
    throw new Error("Failed to create portable zip archive.");
  }
  if (!existsSync(zipPath) || statSync(zipPath).size === 0) {
    throw new Error(`Portable zip is missing or empty: ${zipPath}`);
  }
  return zipPath;
}

/** Assemble the folder, zip it (naming the archive after the folder), and
 * report both paths. */
export function assemblePortable(options = {}) {
  const { portableDir } = assemblePortableFolder(options);
  const zipPath = zipPortable({ ...options, portableDir });
  return { portableDir, zipPath };
}

if (import.meta.main) {
  // same preflight as release.ts buildPortable: the portable deliverable is
  // Windows-only — fail clearly instead of “missing dokan.exe” on POSIX
  if (process.platform !== "win32") {
    console.error("[dokan] portable packaging is only supported on Windows hosts.");
    process.exit(1);
  }
  const { portableDir, zipPath } = assemblePortable();
  console.log(`[dokan] portable folder ready at ${portableDir}`);
  console.log(`[dokan] portable zip ready at ${zipPath}`);
}