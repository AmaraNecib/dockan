/**
 * Release pipeline (ticket 15, issue 64; one universal build, ADR-0008).
 * Run via `bun run portable` (default target) or `bun run installer`
 * (see package.json).
 *
 * Flow:
 *   1. compile the api sidecar (no baked secrets — one build for every shop)
 *   2. build the requested target:
 *      - portable (default, `--portable`): `tauri build --no-bundle` (the
 *        nsis installer is NEVER produced on this path), then assemble
 *        `bundle/portable/Dokan-portable/` (folder) + `Dokan-portable.zip`
 *        (portable.mjs). The folder runs in place anywhere: data lives next
 *        to the exe under `data/` (Rust portable marker, issue 64).
 *      - installer (`--installer`): `tauri build --bundles nsis`.
 */

import fs from "node:fs";
import path from "node:path";

import { assemblePortable } from "./portable.mjs";
import { compileSidecar } from "./sidecar";

const FLAG_INSTALLER = "--installer";
const FLAG_PORTABLE = "--portable";

/**
 * Which distribution the pipeline should produce. Portable (folder + zip) is
 * the default; `--installer` opts into the nsis installer. An explicit
 * `--portable` is accepted for symmetry (and wins over `--installer`). Any
 * OTHER flag fails loudly so a typo'd `--instaler` can never silently
 * produce the wrong deliverable.
 */
export function requestedTarget(argv: string[]): "portable" | "installer" {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const unknown = flags.filter((flag) => flag !== FLAG_INSTALLER && flag !== FLAG_PORTABLE);
  if (unknown.length > 0) {
    throw new Error(`[dokan] unknown release flag(s): ${unknown.join(", ")} — use --installer or --portable`);
  }
  if (argv.includes(FLAG_INSTALLER) && !argv.includes(FLAG_PORTABLE)) return "installer";
  return "portable";
}

/** Run a tauri CLI command, inheriting stdio, and propagate failures. */
async function runTauri(args: string[]): Promise<void> {
  const tauri = Bun.spawn(["bunx", "tauri", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await tauri.exited;
  if (code !== 0) {
    console.error(`[dokan] tauri build failed with exit code ${code}`);
    process.exit(code);
  }
}

/** nsis installer target: build the installer artifact. */
async function buildInstaller(): Promise<void> {
  await runTauri(["build", "--bundles", "nsis"]);
}

/**
 * Portable target (issue 64): `--no-bundle` means the nsis installer is
 * never produced; the folder + zip come from portable.mjs. Data lives next
 * to the exe at runtime (portable.marker flips the Rust shell). A stale
 * `bundle/nsis` from an earlier installer run is removed so the portable
 * output can never ship installer leftovers.
 */
async function buildPortable(): Promise<void> {
  // the portable deliverable and its trusted-tar zip are Windows-only; fail
  // BEFORE a multi-minute tauri build instead of after it with a misleading
  // “missing dokan.exe” error on POSIX (where cargo emits `dokan`)
  if (process.platform !== "win32") {
    console.error(
      "[dokan] portable packaging is only supported on Windows hosts — use the installer target elsewhere",
    );
    process.exit(1);
  }

  await runTauri(["build", "--no-bundle"]);

  const nsisDir = path.resolve("src-tauri/target/release/bundle/nsis");
  if (fs.existsSync(nsisDir)) {
    // leftover from a previous `installer` run on this tree — never ship it
    fs.rmSync(nsisDir, { recursive: true, force: true });
    console.log("[dokan] removed stale nsis bundle dir from the portable output path");
  }

  const { portableDir, zipPath } = assemblePortable();
  console.log(`[dokan] portable folder ready at ${portableDir}`);
  console.log(`[dokan] portable zip ready at ${zipPath}`);
}

async function main(): Promise<void> {
  await compileSidecar();
  console.log("[dokan] sidecar compiled (universal build, no baked secrets)");

  if (requestedTarget(Bun.argv) === "installer") {
    await buildInstaller();
  } else {
    await buildPortable();
  }
}

if (import.meta.main) {
  await main();
}
