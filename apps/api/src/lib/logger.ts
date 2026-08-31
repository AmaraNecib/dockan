import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ALGERIA_TZ = "Africa/Algiers";

/** "YYYY-MM-DD" in Algeria local time (UTC+1, no DST). */
export function localDate(date: Date = new Date()): string {
  return date.toLocaleString("en-CA", { timeZone: ALGERIA_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
}

/**
 * Normalize the en-CA rendering "YYYY-MM-DD, HH:mm:ss" into the canonical
 * "YYYY-MM-DDTHH:mm:ss" used across Dokan. Exported so tests can drive the
 * hour-24 compensation with a SYNTHETIC string: some Intl runtimes render
 * midnight as hour "24", which must be clamped to "00" BEFORE the ", "
 * delimiter is swapped to "T" (swapping first would leave "T24:00:00" in the
 * log on those runtimes). The clamp is anchored to the hour field (it follows
 * the ", " separator), so a real minute 24 is never rewritten.
 */
export function normalizeLocalDateTime(rendered: string): string {
  return rendered.replace(", 24:", ", 00:").replace(", ", "T");
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
  return normalizeLocalDateTime(d);
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

/**
 * The error identity that picks a stable code: the error's class name plus,
 * when the error framework distinguishes failures with a kind code (oRPC's
 * ORPCError.code — UNAUTHORIZED, BAD_REQUEST, INTERNAL_SERVER_ERROR, ...),
 * that kind. Without the kind, every RPC_ERROR row would collapse to one
 * code and the log could not tell an auth failure from a crash.
 */
function errorKind(error: Error | undefined): string {
  if (error === undefined) return "Error";
  // SAFETY: the optional .code probe is how oRPC's ORPCError exposes its
  // failure kind (UNAUTHORIZED, BAD_REQUEST, ...); plain Errors have none
  const kind = (error as { code?: string }).code;
  return kind === undefined ? error.name : `${error.name}::${kind}`;
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
  storeName?: string;
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
    // one clock read: the ts and the day file must agree even at the exact
    // Algeria-midnight boundary (a split instant could date-stamp a row into
    // the wrong day's file)
    const now = new Date();
    entry.ts = localDateTime(now);
    const line = JSON.stringify(entry);
    fs.appendFileSync(this.fileFor(now), `${line}\n`);
    // mirror non-info events to stdout so `bun run dev:api` shows them live
    if (entry.level !== "info") {
      // eslint-disable-next-line no-console -- dev mirroring
      const prefix = `[${entry.ts}] ${entry.event}${entry.code ? ` (${entry.code})` : ""}`;
      if (entry.level === "error") {
        console.error(`${prefix} \x1b[31m${entry.message}\x1b[0m`);
        if (entry.stack) console.error(`  \x1b[90m${entry.stack.split("\n").slice(1, 4).join("\n  ")}\x1b[0m`);
      } else {
        console.warn(`${prefix} ${entry.message}`);
      }
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
    // stable per site: the event literal + the error's class (and oRPC kind
    // code when present) pick the code; never random. A non-Error payload
    // (e.g. a string) still maps deterministically.
    const code = errorCodeFor(event, errorKind(error));
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
    // SAFETY: slice(-0) is the whole array — a non-positive bound must mean
    // "nothing", not "everything" (the RPC contract clamps to 1..500, but
    // this seam should not betray a direct caller)
    if (lines <= 0) return { file, lines: [] } satisfies LogTail;
    if (!fs.existsSync(file)) return { file, lines: [] } satisfies LogTail;
    const all = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return { file, lines: all.slice(-lines) } satisfies LogTail;
  }
}