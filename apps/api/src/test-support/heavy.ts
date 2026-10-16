import { it, setDefaultTimeout } from "bun:test";

/**
 * Real work — opening a connection, running `store.setup()`'s DDL and forward
 * migrations, copying/rebuilding a database file, a full Argon2 KDF pass, or a
 * whole-repo source scan — is fast warm but can pass Bun's 5s default on a
 * contended run (#89, #91). A test that exceeds the default is then reported as
 * a failure even though nothing is wrong, and the lane cannot tell it from a
 * real regression.
 *
 * Two ways to opt in:
 * - `itHeavy` for a file that mixes heavy tests with trivial ones, so only the
 *   heavy tests get the budget;
 * - `setHeavyDefaultTimeout()` for a file where every test does the same heavy
 *   work, where wrapping each test would be noise.
 *
 * `beforeAll` hooks that open and migrate a database also take the budget: a
 * hook timeout fails every test in the file. Everything else keeps the strict
 * default, so a genuine hang in a light test still fails fast.
 *
 * 120s, not 60s: under a full `bun run test` (turbo runs the api and web suites
 * together) with sibling worktrees active, one legacy-migration test with four
 * `setup()` calls was measured at 96s. The budget still bounds a real hang.
 */
export const HEAVY_TEST_TIMEOUT_MS = 120_000;

/** `it` with the budget that heavy real work needs. */
export function itHeavy(name: string, fn: () => void | Promise<void>): void {
  it(name, fn, HEAVY_TEST_TIMEOUT_MS);
}

/**
 * Raise the whole file's default for a file where every test does the same
 * heavy work; call it once, at module top level.
 */
export function setHeavyDefaultTimeout(): void {
  setDefaultTimeout(HEAVY_TEST_TIMEOUT_MS);
}
