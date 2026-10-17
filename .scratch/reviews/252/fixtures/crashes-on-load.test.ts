/**
 * Drill fixture for mutation-proof.ts — NOT a test of the product.
 *
 * `bun test` on this file exits non-zero because the import cannot be resolved:
 * there is no "(fail)" line, only an unhandled load error, so
 * `outcome.failures` stays empty while `outcome.exit` is 1. That is exactly the
 * shape Greptile findings #252-1 and #252-2 describe: a run that never executed
 * an assertion must not count as a caught mutation.
 */
import { missingDependency } from "./missing-dependency";

test("this body never runs", () => {
  expect(missingDependency).toBe(1);
});
