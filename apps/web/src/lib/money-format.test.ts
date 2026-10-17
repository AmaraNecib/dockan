import { describe, expect, it } from "bun:test";

import { formatMoney } from "./money-format";

/**
 * #254 — a money amount is grouped Western digits on the screen and on paper
 * alike. One formatter for both surfaces, pinned here.
 */
describe("formatMoney (Western grouped digits)", () => {
  it("groups thousands with ASCII separators", () => {
    expect(formatMoney(1000)).toBe("1,000");
    expect(formatMoney(92500)).toBe("92,500");
    expect(formatMoney(170000)).toBe("170,000");
    expect(formatMoney(1234567)).toBe("1,234,567");
  });

  it("handles zero, small values and negatives", () => {
    expect(formatMoney(0)).toBe("0");
    expect(formatMoney(900)).toBe("900");
    expect(formatMoney(-28800)).toBe("-28,800");
  });

  it("prints a negative zero as 0, never -0", () => {
    // reports.tsx shows COGS as a negation, so -0 is reachable
    expect(formatMoney(-0)).toBe("0");
    expect(formatMoney(-0 * 1)).toBe("0");
  });

  it("keeps the top of the safe-integer range exact", () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toBe("9,007,199,254,740,991");
    expect(formatMoney(1_700_000_000_000)).toBe("1,700,000,000,000");
  });

  it("does not invent a rounding rule for a fractional value (whole DZD by contract)", () => {
    expect(formatMoney(92500.5)).toBe("92,500.5");
    expect(formatMoney(1234.5678)).toBe("1,234.568");
  });
});
