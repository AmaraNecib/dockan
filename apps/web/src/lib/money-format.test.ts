import { describe, expect, it } from "bun:test";

import { formatMoney } from "./money-format";

/**
 * #254 — a money amount is grouped Western digits on the screen and on paper
 * alike. The app-wide date shape lives in lib/dates.ts (covered by
 * dates.test.ts), so only the amount formatter is pinned here.
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
});
