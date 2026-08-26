/**
 * Security-sensitive helpers for the portable packaging pipeline (issue 64).
 * Mirrors the sibling project's script-security-utils.mjs approach: copies
 * that refuse symlinks/junctions and unexpected build outputs, plus a
 * trusted-tool resolver so packaging never executes arbitrary PATH binaries.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const normalizePath = (value) => path.normalize(path.resolve(value));

/**
 * Resolve the trusted Windows tar.exe from System32/Sysnative — never from
 * PATH, where a tampered copy could rewrite the archive or its contents.
 * Portable packaging is a Windows deliverable, so non-Windows hosts fail
 * loudly instead of producing an archive a different way.
 */
export function resolveTrustedTarPath({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (platform !== "win32") {
    throw new Error("Portable packaging is only supported on Windows hosts.");
  }
  const windowsRoots = [
    ...new Set([env.SystemRoot, env.windir].filter(Boolean).map(normalizePath)),
  ];
  for (const root of windowsRoots) {
    for (const candidate of [
      path.join(root, "System32", "tar.exe"),
      path.join(root, "Sysnative", "tar.exe"),
    ]) {
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error("Unable to locate trusted tar.exe under System32 or Sysnative.");
}

/**
 * Validate the release-tree artifacts the portable folder is assembled from.
 * The target/release root legitimately contains OTHER build outputs (deps/,
 * build/, .pdb, .cargo-lock …), so validation is per artifact: each expected
 * FILE must exist as a non-empty file (a zero-byte sidecar or app exe would
 * ship a build that boots into a dead api and a 20s startup timeout), and
 * each expected DIRECTORY must exist as a directory. A missing, wrong-typed
 * or empty artifact aborts packaging instead of silently shipping a broken
 * bundle.
 */
export function validateReleaseArtifacts(
  releaseRoot,
  expectedFiles = ["dokan.exe", "dokan-api.exe"],
  expectedDirs = ["ui"],
) {
  for (const entry of expectedFiles) {
    const full = path.join(releaseRoot, entry);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      throw new Error(`Release artifact missing: ${entry}. Run tauri build first.`);
    }
    if (!stats.isFile()) {
      throw new Error(`Release artifact "${entry}" is not a file.`);
    }
    if (stats.size === 0) {
      throw new Error(`Release artifact "${entry}" is empty (0 bytes).`);
    }
  }
  for (const entry of expectedDirs) {
    const full = path.join(releaseRoot, entry);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      throw new Error(`Release artifact missing: ${entry}. Run tauri build first.`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Release artifact "${entry}" is not a directory.`);
    }
  }
}

/**
 * Copy a directory tree with explicit safety checks: the root and every
 * entry must be a real file or directory — symlinks and junctions are
 * refused so a developer-machine link (e.g. a junctioned dist) can never
 * leak outside the portable folder or ship as a dangling path.
 */
export function copyValidatedTree(sourceDir, destinationDir) {
  const sourceStats = lstatSync(sourceDir);
  if (sourceStats.isSymbolicLink()) {
    throw new Error(`Refusing to package symbolic link root: ${sourceDir}`);
  }
  if (!sourceStats.isDirectory()) {
    throw new Error(`Expected directory to copy: ${sourceDir}`);
  }
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to package symbolic link: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      copyValidatedTree(sourcePath, destinationPath);
      continue;
    }
    if (entry.isFile()) {
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
      continue;
    }
    throw new Error(`Refusing to package unsupported entry type: ${sourcePath}`);
  }
}