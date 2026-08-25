import type { ReportRangePreset } from "@dokan/contracts";

import { localDate, localDateTime } from "./logger";

/**
 * Report-window math in Algeria local time (Africa/Algiers, UTC+1, no DST).
 * Pure and clock-injectable: every function takes an instant and returns the
 * inclusive [from, to] window as local "YYYY-MM-DDTHH:mm:ss" strings.
 *
 * Month/year presets stay in local calendar space (string year/month/date
 * arithmetic) so Algeria edges are exact without tz instants. Rolling windows
 * (24H/7D/28D/30D) subtract span milliseconds from the instant and format
 * both ends via Africa/Algiers — safe here because Algeria has no DST.
 *
 * The fixed-width string format makes lexicographic comparison exact, which
 * is how the report and expense filters slice records (see profit-report.ts).
 */

export interface LocalRange {
  preset: ReportRangePreset;
  from: string;
  to: string;
}

const SPAN_HOURS = { "24H": 24, "7D": 24 * 7, "28D": 24 * 28, "30D": 24 * 30 } as const;

const pad = (value: number): string => String(value).padStart(2, "0");
const localCalendar = (instant: Date) => {
  const [y, m, d] = localDate(instant).split("-").map(Number);
  return { y: y ?? 0, m: m ?? 0, d: d ?? 0 };
};

const firstDay = (y: number, m: number): string => `${y}-${pad(m)}-01T00:00:00`;
const lastDay = (y: number, m: number): string => {
  // day 0 of next month = last day of this month (calendar-only, no tz)
  // SAFETY: Date.UTC reads years 0-99 as 1900+y, so normalize below 100;
  // localCalendar only yields four-digit years — the guard is belt-and-suspenders
  const year = y < 100 ? y + 2000 : y;
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(days)}T23:59:59`;
};

function rollingRange(preset: "24H" | "7D" | "28D" | "30D", now: Date): LocalRange {
  const to = localDateTime(now);
  const from = localDateTime(new Date(now.getTime() - SPAN_HOURS[preset] * 3_600_000));
  return { preset, from, to };
}

/**
 * Resolve one preset to an inclusive Algeria-local window. `custom` is honored
 * only for CUSTOM; the other presets ignore it so a stale form value cannot
 * silently narrow a fixed window. Custom bounds are passed through as-is
 * (the router validates their order).
 */
export function resolveReportRange(
  preset: ReportRangePreset,
  now: Date = new Date(),
  custom: { from?: string; to?: string } = {},
): LocalRange {
  switch (preset) {
    case "24H":
    case "7D":
    case "28D":
    case "30D":
      return rollingRange(preset, now);
    case "CURRENT_MONTH": {
      const { y, m } = localCalendar(now);
      return { preset, from: firstDay(y, m), to: lastDay(y, m) };
    }
    case "3M":
    case "6M": {
      const { y, m } = localCalendar(now);
      const back = preset === "3M" ? 2 : 5;
      const startMonth = m - back;
      const startYear = startMonth <= 0 ? y - 1 : y;
      const start = startMonth <= 0 ? startMonth + 12 : startMonth;
      return { preset, from: firstDay(startYear, start), to: lastDay(y, m) };
    }
    case "CURRENT_YEAR": {
      const { y } = localCalendar(now);
      return { preset, from: `${y}-01-01T00:00:00`, to: `${y}-12-31T23:59:59` };
    }
    case "LAST_YEAR": {
      const { y } = localCalendar(now);
      return { preset, from: `${y - 1}-01-01T00:00:00`, to: `${y - 1}-12-31T23:59:59` };
    }
    case "CUSTOM":
      return { preset, from: custom.from ?? "", to: custom.to ?? "" };
  }
}

/**
 * The default window for expense listings: the current local month (the spec's
 * default range). Editors always send an explicit preset, so this stays a pure
 * helper instead of living in the router.
 */
export function currentMonthRange(now: Date = new Date()): LocalRange {
  return resolveReportRange("CURRENT_MONTH", now);
}

/** True when a customer-supplied custom window is usable (both bounds, ordered). */
export function validCustomRange(from: string | undefined, to: string | undefined): boolean {
  return from !== undefined && to !== undefined && from !== "" && to !== "" && from <= to;
}