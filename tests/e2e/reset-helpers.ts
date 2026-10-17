import { execFileSync } from "node:child_process";
import path from "node:path";

/** The reset scripts a spec may run. A union, not `string`, so a typo fails typecheck. */
export type E2eResetScript = "reset-e2e-records.mjs" | "reset-e2e-preferences.mjs";

/**
 * Run one of the shared reset scripts against the e2e database.
 *
 * Every spec here shares ONE sqlite database and runs with `workers: 1` in path
 * order, so two kinds of spec must call this:
 *
 * - a spec whose assertions read GLOBAL state (an exact total or count over the
 *   whole shop) resets BEFORE it runs, so it owns its starting state rather than
 *   borrowing the previous spec's tidiness;
 * - a spec whose writes join that global state resets AFTER it runs, so it does
 *   not change state for the specs that follow.
 *
 * The data-dir default lives here once. `playwright.config.ts` computes the same
 * `E2E_DATA_DIR ?? <repo>/.e2e-data`, so a harness that overrides the variable
 * must move the server and every reset together — four copies of that line would
 * drift the day the default moves.
 *
 * `afterAll` is the right hook for the second kind: it also runs when a test
 * fails, which is the case where a leaked row would otherwise sit in the
 * database for the rest of the run. It is not a guarantee on a killed worker.
 */
export function runE2eReset(script: E2eResetScript): void {
  execFileSync("bun", [`scripts/${script}`], {
    cwd: process.cwd(),
    // respect a harness-supplied data dir; only default when none is set
    env: { ...process.env, E2E_DATA_DIR: process.env.E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data") },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
