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
 * Validate the tauri release resources folder. The portable folder is built
 * FLAT (on Windows `resource_dir` == the exe's folder, so the sidecar and ui
 * must sit next to the exe), and the resources folder must contain EXACTLY
 * the expected entries — the api sidecar and the ui tree. An unexpected or
 * missing entry aborts packaging instead of silently shipping a broken or
 * bloated bundle.
 */
export function validateReleaseResourceEntries(
  resourceDir,
  expectedEntries = ["dokan-api.exe", "ui"],
) {
  const actualEntries = readdirSync(resourceDir).sort();
  const expected = [...expectedEntries].sort();
  const unexpected = actualEntries.filter((entry) => !expected.includes(entry));
  const missing = expected.filter((entry) => !actualEntries.includes(entry));
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [
      unexpected.length > 0 ? `unexpected: ${unexpected.join(", ")}` : null,
      missing.length > 0 ? `missing: ${missing.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    throw new Error(`Release resources failed validation (${details}).`);
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