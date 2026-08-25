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

/**
 * Stable error identifier for failures, e.g. DKN-1A2B3C4D.
 *
 * The code is DERIVED, never random: the same error site (the caller's `event`
 * literal) plus the same error class (`error.name`) maps to the same code on
 * every run and every machine. That is what makes a code an identifier — the
 * viewer and the docs can point at "DKN-XXXX happens at RPC_ERROR". Different
 * error classes at one site get different codes; occurrences of the same
 * failure are told apart by `ts` in the JSONL, not by the code.
 *
 * 8 hex chars of sha256 = 32 bits; collisions across distinct sites are an
 * event-name clash (a programming error), not a realistic accident.
 */
export function errorCodeFor(event: string, errorName = "Error"): string {
  const digest = crypto.createHash("sha256").update(`${event}::${errorName}`).digest("hex");
  return `DKN-${digest.slice(0, 8).toUpperCase()}`;
}

export type LogLevel = "info" | "warn" | "error";

/**
 * Named context contract. Extend it (never loosen to a free dictionary) when
 * a caller needs to log new structured fields; the diagnostics viewer reads
 * exactly these keys.
 */
export type LogContext = {
  url?: string;
  version?: string;
  invoiceNumber?: string;
  itemName?: string;
  driver?: string;
};

export type LogEntry = {
  ts: string;
  level: LogLevel;
  event: string;
  message: string;
  code?: string;
  stack?: string;
  errorName?: string;
  context?: LogContext;
};

export type LogTail = {
  file: string;
  lines: string[];
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
    // mirror non-info events to stdout so `bun run dev:api` shows them live
    if (entry.level !== "info") {
      // eslint-disable-next-line no-console -- dev mirroring
      console[entry.level](`[${entry.ts}] ${entry.event}${entry.code ? ` (${entry.code})` : ""} ${entry.message}`);
    }
  }

  info(event: string, message: string, context: LogContext = {}): void {
    const entry: LogEntry = { ts: "", level: "info", event, message };
    if (Object.keys(context).length > 0) entry.context = context;
    this.write(entry);
  }

  warn(event: string, message: string, context: LogContext = {}): void {
    const entry: LogEntry = { ts: "", level: "warn", event, message };
    if (Object.keys(context).length > 0) entry.context = context;
    this.write(entry);
  }

  error(event: string, message: string, error?: Error, context: LogContext = {}): string {
    // stable per site: the event literal + the error's class pick the code;
    // a non-Error payload (e.g. a string) still maps deterministically
    const code = errorCodeFor(event, error?.name);
    const entry: LogEntry = { ts: "", level: "error", event, message, code };
    if (error !== undefined) {
      entry.stack = error.stack;
      entry.errorName = error.name;
    }
    if (Object.keys(context).length > 0) entry.context = context;
    this.write(entry);
    return code;
  }

  /** Last N lines of today's log file, for the diagnosticsLogsTail procedure. */
  tail(lines = 100): LogTail {
    const file = this.fileFor(new Date());
    if (!fs.existsSync(file)) return { file, lines: [] } satisfies LogTail;
    const all = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return { file, lines: all.slice(-lines) } satisfies LogTail;
  }
}