import { describe, expect, it } from "bun:test";

import { formatPrintAmount, formatPrintDateTime } from "./print-format";

/**
 * Printed documents must not carry the raw timestamp `T` nor the browser's
 * locale digits. These are the two formats the paper depends on.
 */
describe("formatPrintDateTime (app-wide date/time shape)", () => {
  it("formats a local datetime as day/month/year + 24-hour time", () => {
    expect(formatPrintDateTime("2026-10-01T00:34:15")).toBe("01/10/2026 00:34");
    expect(formatPrintDateTime("2026-10-01T14:32:00")).toBe("01/10/2026 14:32");
    // midnight is 00:34, never 24:34 or 12:34 AM
    expect(formatPrintDateTime("2026-01-05T00:00:00")).toBe("05/01/2026 00:00");
  });

  it("keeps a date-only value date-only", () => {
    expect(formatPrintDateTime("2026-08-25")).toBe("25/08/2026");
  });

  it("never emits a raw T", () => {
    expect(formatPrintDateTime("2026-08-25T10:01:00")).not.toContain("T");
  });

  it("passes a non-ISO value through instead of printing NaN", () => {
    expect(formatPrintDateTime("—")).toBe("—");
    expect(formatPrintDateTime("")).toBe("");
  });
});

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
