import { describe, expect, it } from "bun:test";

import { readyHandlerFor } from "./boot-loss";

/**
 * The boot-theft decision (ADR-0012 clause 3) is pure so a boot that stopped
 * asking cannot stay green: installing the live app after the folder was taken
 * re-executes a refused mutation against the real owner's app.
 */
describe("vault boot handler decision", () => {
  it("installs the live app only while the folder is ours", () => {
    expect(readyHandlerFor(false)).toBe("live");
    expect(readyHandlerFor(true)).toBe("refused");
  });
});
