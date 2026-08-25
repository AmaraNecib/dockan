import { describe, expect, it } from "bun:test";

import { localDate, localDateTime } from "./logger";
import { resolveReportRange } from "./report-ranges";

/**
 * Date-boundary tests in Algeria local time (Africa/Algiers, UTC+1, no DST).
 * Fixed instants choose values that flip to a different local calendar day or
 * month than their UTC representation, so a UTC-lurking bug fails loudly.
 */
describe("report ranges (Algeria local time)", () => {
  it("CURRENT_MONTH spans the whole local month, starting at 00:00:00", () => {
    // 2026-01-31T23:30:00Z is 2026-02-01T00:30:00 +01 locally — February.
    const now = new Date("2026-01-31T23:30:00Z");
    const range = resolveReportRange("CURRENT_MONTH", now);
    expect(range.from).toBe("2026-02-01T00:00:00");
    expect(range.to).toBe("2026-02-28T23:59:59");
  });

  it("CURRENT_MONTH respects leap February (29 days in 2024)", () => {
    const now = new Date("2024-02-15T12:00:00Z");
    const range = resolveReportRange("CURRENT_MONTH", now);
    expect(range.from).toBe("2024-02-01T00:00:00");
    expect(range.to).toBe("2024-02-29T23:59:59");
  });

  it("CURRENT_MONTH ends the month with 31 days when applicable", () => {
    const now = new Date("2026-03-10T08:00:00Z");
    const range = resolveReportRange("CURRENT_MONTH", now);
    expect(range.to).toBe("2026-03-31T23:59:59");
  });

  it("monotonic strings: every moment of the month lies inside [from, to]", () => {
    const now = new Date("2026-07-10T12:00:00Z"); // local 13:00
    const { from, to } = resolveReportRange("CURRENT_MONTH", now);
    expect(localDate(now)).toBe("2026-07-10");
    expect(localDateTime(now)).toBe("2026-07-10T13:00:00");
    expect("2026-07-01T00:00:00" >= from).toBe(true);
    expect("2026-07-31T23:59:59" <= to).toBe(true);
  });

  it("CURRENT_YEAR spans Jan 1 .. Dec 31 of the local year", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const range = resolveReportRange("CURRENT_YEAR", now);
    expect(range.from).toBe("2026-01-01T00:00:00");
    expect(range.to).toBe("2026-12-31T23:59:59");
  });

  it("LAST_YEAR is the previous local year, even on January 1st", () => {
    // 2026-01-01T00:30:00Z is 2026-01-01T01:30:00 locally — a new-year moment.
    const now = new Date("2026-01-01T00:30:00Z");
    const range = resolveReportRange("LAST_YEAR", now);
    expect(range.from).toBe("2025-01-01T00:00:00");
    expect(range.to).toBe("2025-12-31T23:59:59");
  });

  it("3M starts two months back and crosses the year boundary", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const range = resolveReportRange("3M", now);
    expect(range.from).toBe("2025-11-01T00:00:00");
    expect(range.to).toBe("2026-01-31T23:59:59");
  });

  it("6M starts five months back and crosses the year boundary", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const range = resolveReportRange("6M", now);
    expect(range.from).toBe("2025-08-01T00:00:00");
    expect(range.to).toBe("2026-01-31T23:59:59");
  });

  it("3M and 6M share the current month's end", () => {
    const now = new Date("2026-04-20T10:00:00Z");
    expect(resolveReportRange("3M", now).to).toBe("2026-04-30T23:59:59");
    expect(resolveReportRange("6M", now).to).toBe("2026-04-30T23:59:59");
    expect(resolveReportRange("3M", now).from).toBe("2026-02-01T00:00:00");
    expect(resolveReportRange("6M", now).from).toBe("2025-11-01T00:00:00");
  });

  it("rolling windows subtract their span from the instant (24H/7D/28D/30D)", () => {
    const now = new Date("2026-03-15T02:30:00Z");
    const localNow = localDateTime(now);
    expect(localNow).toBe("2026-03-15T03:30:00");
    const expectedFrom = (hours: number) => {
      const instant = new Date(now.getTime() - hours * 3_600_000);
      return localDateTime(instant);
    };
    expect(resolveReportRange("24H", now)).toEqual({ preset: "24H", from: expectedFrom(24), to: localNow });
    expect(resolveReportRange("7D", now)).toEqual({ preset: "7D", from: expectedFrom(24 * 7), to: localNow });
    expect(resolveReportRange("28D", now)).toEqual({ preset: "28D", from: expectedFrom(24 * 28), to: localNow });
    expect(resolveReportRange("30D", now)).toEqual({ preset: "30D", from: expectedFrom(24 * 30), to: localNow });
  });

  it("28D and 30D are two days apart and distinct", () => {
    const now = new Date("2026-03-15T02:30:00Z");
    const r28 = resolveReportRange("28D", now);
    const r30 = resolveReportRange("30D", now);
    expect(r30.from).not.toBe(r28.from);
    expect(r28.to).toBe(r30.to);
  });

  it("a rolling window crosses the month boundary into the previous month", () => {
    const now = new Date("2026-03-03T09:00:00Z"); // local 10:00
    const range = resolveReportRange("7D", now);
    expect(range.to).toBe("2026-03-03T10:00:00");
    expect(range.from).toBe("2026-02-24T10:00:00");
  });

  it("CUSTOM passes the caller's bounds through unchanged", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const range = resolveReportRange("CUSTOM", now, { from: "2026-01-10T08:00:00", to: "2026-01-20T18:30:00" });
    expect(range.from).toBe("2026-01-10T08:00:00");
    expect(range.to).toBe("2026-01-20T18:30:00");
    expect(range.preset).toBe("CUSTOM");
  });

  it("non-CUSTOM presets ignore any supplied custom bounds", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const range = resolveReportRange("CURRENT_MONTH", now, { from: "2020-01-01T00:00:00", to: "2020-02-01T00:00:00" });
    expect(range.from).toBe("2026-01-01T00:00:00");
    expect(range.to).toBe("2026-01-31T23:59:59");
  });
});