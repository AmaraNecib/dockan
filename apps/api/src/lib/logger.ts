import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ALGERIA_TZ = "Africa/Algiers";

/** "YYYY-MM-DD" in Algeria local time (UTC+1, no DST). */
export function localDate(date: Date = new Date()): string {
  return date.toLocaleString("en-CA", { timeZone: ALGERIA_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** "YYYY-MM-DDTHH:mm:ss" in Algeria local time. */
export function localDateTime(date: Date = new Date()): string {
  const d = date.toLocaleString("en-CA", {
    timeZone: ALGERIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // en-CA yields "YYYY-MM-DD, HH:mm:ss" — normalize to ISO-looking local time.
  return d.replace(", ", "T").replace("24:", "00:");
}

/** Stable error identifier for failures, e.g. DKN-1A2B3C4D. */
export function errorCode(prefix = "DKN"): string {
  return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  event: string;
  message: string;
  code?: string;
  stack?: string;
  [key: string]: unknown;
};

/**
 * Developer-facing diagnostics log (the shop owner's Activity log is separate).
 * One JSONL file per day in <dataDir>/logs/, written in Algeria local time —
 * "nice logs ... so I can debug and see what happened where when" (grilled scope).
 */
export class AppLogger {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "logs");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(date: Date): string {
    return path.join(this.dir, `${localDate(date)}.jsonl`);
  }

  private write(entry: LogEntry): void {
    entry.ts = localDateTime();
    const line = JSON.stringify(entry);
    fs.appendFileSync(this.fileFor(new Date()), `${line}\n`);
    // mirror errors to stdout so `pnpm dev:api` shows them live
    if (entry.level !== "info") {
      // eslint-disable-next-line no-console
      console[entry.level](`[${entry.ts}] ${entry.event}${entry.code ? ` (${entry.code})` : ""} ${entry.message}`);
    }
  }

  info(event: string, message: string, extra: Record<string, unknown> = {}): void {
    this.write({ ts: "", level: "info", event, message, ...extra });
  }

  warn(event: string, message: string, extra: Record<string, unknown> = {}): void {
    this.write({ ts: "", level: "warn", event, message, ...extra });
  }

  error(event: string, message: string, error?: unknown, extra: Record<string, unknown> = {}): string {
    const code = errorCode();
    const entry: LogEntry = {
      ts: "",
      level: "error",
      event,
      message,
      code,
      ...extra,
    };
    if (error instanceof Error) {
      entry.stack = error.stack;
      entry.errorName = error.name;
    }
    this.write(entry);
    return code;
  }

  /** Last N lines of today's log file — powers the diagnosticsLogsTail procedure. */
  tail(lines = 100): { file: string; lines: string[] } {
    const file = this.fileFor(new Date());
    if (!fs.existsSync(file)) return { file, lines: [] };
    const all = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return { file, lines: all.slice(-lines) };
  }
}