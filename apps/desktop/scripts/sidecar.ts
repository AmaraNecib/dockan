/**
 * API sidecar compile (ticket 15). Run via `bun run sidecar` (see
 * package.json). One universal build: no secret is baked into the sidecar.
 * The session-signing secret is generated per install at first run and stored
 * in the database (ADR-0008 §4.2), so `bun build --compile` carries only code.
 */

import path from "node:path";

/**
 * Compile the sidecar. cwd is the package root (apps/desktop) when invoked
 * through `bun run`. Bun appends the platform executable suffix.
 */
export async function compileSidecar(): Promise<void> {
  const outfile = path.resolve("src-tauri/binaries/dokan-api-x86_64-pc-windows-msvc");
  const proc = Bun.spawn(
    ["bun", "build", "--compile", "../api/src/main.ts", "--outfile", outfile],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`sidecar compile failed with exit code ${code}`);
  }
}

async function main(): Promise<void> {
  await compileSidecar();
  console.log("[dokan] sidecar compiled (universal build, no baked secrets)");
}

if (import.meta.main) {
  await main();
}
