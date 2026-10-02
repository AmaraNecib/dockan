import { describe, expect, it } from "bun:test";

import { classifyPlaintextCleanup } from "./cleanup-status";

/**
 * Round-4 finding: the sweep has three outcomes, and a failure must never
 * masquerade as a confirmed-clean empty result.
 */
describe("classifyPlaintextCleanup", () => {
  it("reports a confirmed clean sweep", async () => {
    const outcome = await classifyPlaintextCleanup(async () => ({ plaintextRemaining: [] }), () => {});
    expect(outcome).toEqual({ status: "clean", remaining: [] });
  });

  it("reports the paths a sweep confirmed it could not remove", async () => {
    const outcome = await classifyPlaintextCleanup(
      async () => ({ plaintextRemaining: ["C:/data/dokan.db", "D:/backups/dokan-2020-01-01.db"] }),
      () => {},
    );
    expect(outcome).toEqual({
      status: "remaining",
      remaining: ["C:/data/dokan.db", "D:/backups/dokan-2020-01-01.db"],
    });
  });

  it("reports UNKNOWN when the sweep throws, never a clean empty result", async () => {
    const errors: Error[] = [];
    const outcome = await classifyPlaintextCleanup(
      async () => {
        throw new Error("cleanup exploded");
      },
      (error) => errors.push(error),
    );
    expect(outcome).toEqual({ status: "unknown", remaining: [] });
    expect(errors[0]?.message).toBe("cleanup exploded");
  });

  it("reports UNKNOWN for a non-Error throw as well", async () => {
    const errors: Error[] = [];
    const outcome = await classifyPlaintextCleanup(
      async () => {
        throw "string failure";
      },
      (error) => errors.push(error),
    );
    expect(outcome).toEqual({ status: "unknown", remaining: [] });
    expect(errors[0]?.message).toBe("string failure");
  });
});
