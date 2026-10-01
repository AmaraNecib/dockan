import { describe, expect, it } from "bun:test";

import { formatPrintAmount } from "./print-format";

/**
 * Printed documents must keep Western, grouped digits — the app-wide date
 * shape lives in lib/dates.ts (covered by dates.test.ts), so only the amount
 * formatter is pinned here.
 */
describe("formatPrintAmount (Western grouped digits)", () => {
  it("groups thousands with ASCII separators", () => {
    expect(formatPrintAmount(1000)).toBe("1,000");
    expect(formatPrintAmount(170000)).toBe("170,000");
    expect(formatPrintAmount(1234567)).toBe("1,234,567");
  });

  it("handles zero, small values and negatives", () => {
    expect(formatPrintAmount(0)).toBe("0");
    expect(formatPrintAmount(900)).toBe("900");
    expect(formatPrintAmount(-28800)).toBe("-28,800");
  });
});
