import { describe, expect, it } from "bun:test";

import { combineBusinessDateTime, formatDate, formatDateTime, nowDateTimeText, parseDateTimeText } from "./dates";

/**
 * Issue #119 — the stored values are naive Algeria-local ISO strings with no
 * timezone: `YYYY-MM-DD` for dates, `YYYY-MM-DDTHH:mm:ss` for moments. The
 * display shape is day-first, 24-hour, Western digits — no `toLocale*`, which
 * would follow the machine's locale and render `10/01/2026 01:18 AM` on the
 * owner's Windows build.
 */
describe("formatDate (issue #119)", () => {
  it("renders a stored date day-first", () => {
    expect(formatDate("2026-10-01")).toBe("01/10/2026");
  });

  it("drops the time-of-day when handed a moment", () => {
    expect(formatDate("2026-10-01T00:34:15")).toBe("01/10/2026");
    // the `T` is handled with or without seconds
    expect(formatDate("2026-10-01T00:34")).toBe("01/10/2026");
    // a space-separated moment is the same shape
    expect(formatDate("2026-10-01 00:34:15")).toBe("01/10/2026");
  });

  it("renders midnight as the day it belongs to, never 24:", () => {
    expect(formatDate("2026-10-01T00:00:00")).toBe("01/10/2026");
  });

  it("keeps every field position: day/month/year, never month-first", () => {
    // 2026-01-10 is 10 January, and must not read as 01/10 (10 Jan US shape)
    expect(formatDate("2026-01-10")).toBe("10/01/2026");
    // the last day of the year
    expect(formatDate("2026-12-31")).toBe("31/12/2026");
  });

  it("returns anything it cannot parse unchanged", () => {
    // a display formatter must never print "Invalid Date" or blank a row
    expect(formatDate("")).toBe("");
    expect(formatDate("not a date")).toBe("not a date");
    expect(formatDate("2026-13-01")).toBe("2026-13-01");
    expect(formatDate("2026-10-32")).toBe("2026-10-32");
    expect(formatDate("2026/10/01")).toBe("2026/10/01");
    expect(formatDate("2026-10-01T25:00:00")).toBe("2026-10-01T25:00:00");
  });

  it("refuses impossible calendar days, leap years included", () => {
    // February 31 is not a day; the raw stored value stays visible instead
    expect(formatDate("2026-02-31")).toBe("2026-02-31");
    // 2026 is not a leap year, so February ends on the 28th
    expect(formatDate("2026-02-29")).toBe("2026-02-29");
    // ...but 2024 is, and 29 February exists there
    expect(formatDate("2024-02-29")).toBe("29/02/2024");
    // century rule: 1900 is not a leap year, 2000 is
    expect(formatDate("1900-02-29")).toBe("1900-02-29");
    expect(formatDate("2000-02-29")).toBe("29/02/2000");
    // 30-day months reject the 31st
    expect(formatDate("2026-04-31")).toBe("2026-04-31");
    expect(formatDate("2026-04-30")).toBe("30/04/2026");
  });

  it("refuses Arabic-Indic digits rather than half-rendering them", () => {
    expect(formatDate("٢٠٢٦-١٠-٠١")).toBe("٢٠٢٦-١٠-٠١");
    expect(formatDateTime("٢٠٢٦-١٠-٠١T٠٠:٣٤:١٥")).toBe("٢٠٢٦-١٠-٠١T٠٠:٣٤:١٥");
  });
});

describe("formatDateTime (issue #119)", () => {
  it("replaces the T with a space and drops the seconds", () => {
    expect(formatDateTime("2026-10-01T00:34:15")).toBe("01/10/2026 00:34");
  });

  it("accepts a moment without seconds", () => {
    expect(formatDateTime("2026-10-01T00:34")).toBe("01/10/2026 00:34");
  });

  it("keeps midnight 24-hour — 00:00, never 12:00 AM", () => {
    expect(formatDateTime("2026-10-01T00:00:00")).toBe("01/10/2026 00:00");
  });

  it("keeps the 24-hour clock past noon", () => {
    expect(formatDateTime("2026-10-01T13:05:59")).toBe("01/10/2026 13:05");
    expect(formatDateTime("2026-10-01T23:59:00")).toBe("01/10/2026 23:59");
  });

  it("returns a date-only value as the day alone", () => {
    // never invent a 00:00 the record does not have
    expect(formatDateTime("2026-10-01")).toBe("01/10/2026");
  });

  it("returns anything it cannot parse unchanged", () => {
    expect(formatDateTime("")).toBe("");
    expect(formatDateTime("2026-10-01T00:34:15Z")).toBe("2026-10-01T00:34:15Z");
    expect(formatDateTime("2026-10-01T00:60:00")).toBe("2026-10-01T00:60:00");
    expect(formatDateTime("اليوم")).toBe("اليوم");
  });

  it("refuses an out-of-range seconds field instead of ignoring it", () => {
    // seconds are trimmed from display, but an impossible value still means
    // the stored string is not a valid moment
    expect(formatDateTime("2026-10-01T00:34:99")).toBe("2026-10-01T00:34:99");
    expect(formatDate("2026-10-01T00:34:99")).toBe("2026-10-01T00:34:99");
  });
});

describe("parseDateTimeText (issue #119)", () => {
  it("parses the field shape into the api's naive ISO with seconds", () => {
    expect(parseDateTimeText("01/10/2026 00:34")).toBe("2026-10-01T00:34:00");
  });

  it("accepts a single-digit day, month or hour", () => {
    expect(parseDateTimeText("1/10/2026 0:34")).toBe("2026-10-01T00:34:00");
    expect(parseDateTimeText("1/2/2026 9:05")).toBe("2026-02-01T09:05:00");
  });

  it("treats a bare date as midnight and keeps typed seconds", () => {
    expect(parseDateTimeText("01/10/2026")).toBe("2026-10-01T00:00:00");
    expect(parseDateTimeText("01/10/2026 00:34:15")).toBe("2026-10-01T00:34:15");
  });

  it("trims surrounding whitespace and accepts a run of spaces before the time", () => {
    expect(parseDateTimeText("  01/10/2026   00:34  ")).toBe("2026-10-01T00:34:00");
    expect(parseDateTimeText("\t1/10/2026\t0:34")).toBe("2026-10-01T00:34:00");
  });

  it("refuses impossible calendar days instead of rolling them over", () => {
    // 2026 is not a leap year; the api must never receive 2026-02-29
    expect(parseDateTimeText("29/02/2026")).toBeNull();
    // 2024 is a leap year
    expect(parseDateTimeText("29/02/2024")).toBe("2024-02-29T00:00:00");
    // 31 April does not exist
    expect(parseDateTimeText("31/04/2026")).toBeNull();
    expect(parseDateTimeText("30/04/2026 08:00")).toBe("2026-04-30T08:00:00");
    expect(parseDateTimeText("31/12/2026")).toBe("2026-12-31T00:00:00");
  });

  it("round-trips what the formatters produce", () => {
    expect(parseDateTimeText(formatDateTime("2026-10-01T00:34:15"))).toBe("2026-10-01T00:34:00");
    expect(parseDateTimeText(formatDate("2026-10-01"))).toBe("2026-10-01T00:00:00");
  });

  it("refuses anything that is not a real day-first date/time", () => {
    expect(parseDateTimeText("")).toBeNull();
    expect(parseDateTimeText("   ")).toBeNull();
    // the raw stored shape is not what the field teaches
    expect(parseDateTimeText("2026-10-01T00:34:15")).toBeNull();
    // month/day swapped by a US habit must not silently parse
    expect(parseDateTimeText("10/13/2026 00:34")).toBeNull();
    expect(parseDateTimeText("01/10/2026 25:00")).toBeNull();
    expect(parseDateTimeText("01/10/2026 00:60")).toBeNull();
    expect(parseDateTimeText("01/10/2026 00:34:99")).toBeNull();
    expect(parseDateTimeText("01/10/26 00:34")).toBeNull();
    expect(parseDateTimeText("01/10/2026 00")).toBeNull();
    expect(parseDateTimeText("hello")).toBeNull();
  });

  it("rejects Arabic-Indic digits: the api's shape is ASCII, so half-parse is worse than none", () => {
    expect(parseDateTimeText("٠١/١٠/٢٠٢٦ ٠٠:٣٤")).toBeNull();
    expect(parseDateTimeText("٠١/١٠/٢٠٢٦")).toBeNull();
  });
});

describe("combineBusinessDateTime (issue #121)", () => {
  it("keeps the business day and takes the recorded clock time", () => {
    // a backdated invoice recorded two days later: the paper shows the
    // business date with the recording time
    expect(combineBusinessDateTime("2026-10-01", "2026-10-03T14:32:00")).toBe("2026-10-01T14:32:00");
    expect(formatDateTime(combineBusinessDateTime("2026-10-01", "2026-10-03T14:32:00"))).toBe("01/10/2026 14:32");
  });

  it("falls back to the business date when the moment carries no time", () => {
    expect(combineBusinessDateTime("2026-10-01", "2026-10-01")).toBe("2026-10-01");
    expect(formatDateTime(combineBusinessDateTime("2026-10-01", "2026-10-01"))).toBe("01/10/2026");
  });
});

describe("nowDateTimeText (issue #119)", () => {
  it("renders the device-local moment in the field shape", () => {
    // SAFETY: a fixed local instant keeps the test independent of the wall clock
    expect(nowDateTimeText(new Date(2026, 9, 1, 0, 34, 15))).toBe("01/10/2026 00:34");
  });

  it("pads a single-digit day, month, hour and minute", () => {
    expect(nowDateTimeText(new Date(2026, 0, 5, 9, 4, 0))).toBe("05/01/2026 09:04");
  });
});
