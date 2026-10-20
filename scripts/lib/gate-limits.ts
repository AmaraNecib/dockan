/**
 * How long the gate's runs may take, and how much slack a waiting run gets.
 *
 * These are the numbers the lock's wait budget is built from, so they live
 * outside both the gate and the lock: the gate owns the timeouts, the lock owns
 * the budget, and neither has to import the other.
 */

const DEFAULT_TEST_TIMEOUT_MS = 120_000;

/** The cold `bun install` in the base worktree. Inside the lock, so the lock
 * wait budget has to cover it. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The slack a waiting run gets past the work it knows can be inside the lock. */
export const LOCK_WAIT_SLACK_MS = 60_000;

/**
 * How long a `bun test` run may take before the gate calls it unfinished.
 *
 * `RED_ON_PARENT_TEST_TIMEOUT_MS` overrides it. A hard-coded two minutes
 * cannot be tested: a fixture whose test hangs would have to wait that long
 * to prove that a run that did not finish is RUN INCOMPLETE and that no
 * waiver covers it.
 */
export function testTimeoutMs(): number {
  const override = Number.parseInt(process.env.RED_ON_PARENT_TEST_TIMEOUT_MS ?? "", 10);
  if (Number.isInteger(override) && override > 0) return override;
  return DEFAULT_TEST_TIMEOUT_MS;
}
