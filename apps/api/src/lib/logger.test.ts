import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ORPCError } from "@orpc/client";

import { AppLogger, errorCodeFor, localDate, localDateTime, normalizeLocalDateTime } from "./logger";

/** Africa/Algiers date computed independently of the module under test. */
function algiersToday(): string {
  return new Date().toLocaleString("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Per-test tmpdir with a guaranteed cleanup even when the body throws. */
function withTmpLogDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-logger-"));
  try {
    run(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left for the OS temp cleaner */
    }
  }
}

/** Minimal shape of one JSONL row, for assertions in this spec. */
interface LogRowJson {
  ts: string;
  level: string;
  event: string;
  message: string;
  code?: string | undefined;
  errorName?: string | undefined;
  stack?: unknown;
  context?: unknown;
}

/**
 * Ticket 14 unit seams: STABLE error codes (same site → same code across
 * runs, never random), the per-day JSONL file, and the bounded tail the
 * viewer reads.
 */
describe("stable error codes (DKN-XXXXXXXX)", () => {
  it("formats as DKN-XXXXXXXX (8 uppercase hex digits)", () => {
    expect(errorCodeFor("RPC_ERROR", "Error")).toMatch(/^DKN-[0-9A-F]{8}$/);
    expect(errorCodeFor("SERVER_ERROR", "TypeError")).toMatch(/^DKN-[0-9A-F]{8}$/);
  });

  it("is deterministic: same site + same error name → same code, every call", () => {
    expect(errorCodeFor("RPC_ERROR", "Error")).toBe(errorCodeFor("RPC_ERROR", "Error"));
    expect(errorCodeFor("SERVER_ERROR", "TypeError")).toBe(errorCodeFor("SERVER_ERROR", "TypeError"));
  });

  it("differs across error sites (event strings)", () => {
    expect(errorCodeFor("RPC_ERROR", "Error")).not.toBe(errorCodeFor("SERVER_ERROR", "Error"));
  });

  it("differs across error classes at the same site", () => {
    expect(errorCodeFor("RPC_ERROR", "Error")).not.toBe(errorCodeFor("RPC_ERROR", "TypeError"));
  });

  it("defaults an unknown error name to Error", () => {
    expect(errorCodeFor("RPC_ERROR")).toBe(errorCodeFor("RPC_ERROR", "Error"));
  });

  it("keeps oRPC failure kinds apart (UNAUTHORIZED vs INTERNAL_SERVER_ERROR)", () => {
    // the app hashes errorKind = name::code, so two RPC failures of different
    // kinds get different stable codes instead of collapsing into one
    expect(errorCodeFor("RPC_ERROR", "ORPCError::UNAUTHORIZED")).not.toBe(
      errorCodeFor("RPC_ERROR", "ORPCError::INTERNAL_SERVER_ERROR"),
    );
    expect(errorCodeFor("RPC_ERROR", "ORPCError::UNAUTHORIZED")).toBe(
      errorCodeFor("RPC_ERROR", "ORPCError::UNAUTHORIZED"),
    );
  });
});

describe("AppLogger JSONL persistence", () => {
  it("writes today's Algeria-local file under <dir>/logs with the full error shape", () => {
    withTmpLogDir((dir) => {
      const logger = new AppLogger(dir);
      const boom = new Error("kaboom");
      const code = logger.error("RPC_ERROR", "rpc call failed", boom, { url: "/api/rpc/health" });

      const file = path.join(dir, "logs", `${algiersToday()}.jsonl`);
      expect(fs.existsSync(file)).toBe(true);

      // SAFETY: the file is written by AppLogger.write as JSON.stringify(entry),
      // so every non-empty line parses to the LogEntry object shape above
      const row = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n")[0]!) as LogRowJson;
      expect(row.level).toBe("error");
      expect(row.event).toBe("RPC_ERROR");
      expect(row.message).toBe("rpc call failed");
      expect(row.code).toBe(code);
      expect(row.code).toMatch(/^DKN-[0-9A-F]{8}$/);
      expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(row.errorName).toBe("Error");
      expect(String(row.stack)).toContain("kaboom");
      expect(row.context).toEqual({ url: "/api/rpc/health" });
    });
  });

  it("derives distinct stable codes for oRPC failure kinds through the full shape", () => {
    withTmpLogDir((dir) => {
      const logger = new AppLogger(dir);
      const auth = new ORPCError("UNAUTHORIZED", { message: "AUTH_REQUIRED" });
      const crash = new ORPCError("INTERNAL_SERVER_ERROR", { message: "boom" });
      const authCode = logger.error("RPC_ERROR", "rpc call failed", auth);
      const crashCode = logger.error("RPC_ERROR", "rpc call failed", crash);

      // different failure kinds → different codes, both stable
      expect(authCode).not.toBe(crashCode);
      const file = path.join(dir, "logs", `${algiersToday()}.jsonl`);
      // SAFETY: same invariant as elsewhere — AppLogger writes its own
      // JSON.stringify(entry), so each line parses to the LogEntry shape
      const two = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as LogRowJson);
      expect(new Set(two.map((row) => `${row.event}::${row.code}`))).toEqual(
        new Set([`RPC_ERROR::${authCode}`, `RPC_ERROR::${crashCode}`]),
      );

      const again = new AppLogger(dir).error("RPC_ERROR", "rpc call failed", auth);
      expect(again).toBe(authCode); // restart stability with kinds included
    });
  });

  it("keeps codes stable across restarts: a fresh instance derives the same code", () => {
    withTmpLogDir((dir) => {
      const first = new AppLogger(dir);
      const boom = new Error("kaboom");
      const codeRun1 = first.error("RPC_ERROR", "rpc call failed", boom);

      const second = new AppLogger(dir); // simulates a process restart
      const codeRun2 = second.error("RPC_ERROR", "rpc call failed", boom);

      expect(codeRun2).toBe(codeRun1);
      expect(codeRun2).toMatch(/^DKN-[0-9A-F]{8}$/);
    });
  });

  it("writes info and warn entries too; only errors carry a code", () => {
    withTmpLogDir((dir) => {
      const logger = new AppLogger(dir);
      logger.info("SERVER_BOOT_DONE", "database ready", { driver: "sqlite" });
      logger.warn("LOW_DISK", "disk nearly full");

      // SAFETY: same invariant as above — the file content is AppLogger's own
      // JSON.stringify output (LogEntry shape), so the cast is a shape promise
      const rows = fs
        .readFileSync(path.join(dir, "logs", `${algiersToday()}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as LogRowJson);
      expect(rows).toHaveLength(2);
      expect(rows[0]!).toMatchObject({ level: "info", event: "SERVER_BOOT_DONE" });
      expect(rows[1]!).toMatchObject({ level: "warn", event: "LOW_DISK" });
      expect(rows[0]!.code).toBeUndefined();
      expect(rows[1]!.code).toBeUndefined();
    });
  });
});

describe("AppLogger.tail (viewer input)", () => {
  it("returns the newest-last bounded tail of today's file", () => {
    withTmpLogDir((dir) => {
      const logger = new AppLogger(dir);
      for (let i = 1; i <= 10; i++) logger.info("PROBE", `entry ${i}`);

      const tail = logger.tail(3);
      expect(tail.lines).toHaveLength(3);
      expect(tail.lines[2]).toContain("entry 10"); // newest last
      expect(tail.lines[0]).toContain("entry 8");
      expect(tail.file).toBe(path.join(dir, "logs", `${algiersToday()}.jsonl`));
    });
  });

  it("returns all lines when the file is smaller than the limit", () => {
    withTmpLogDir((dir) => {
      const logger = new AppLogger(dir);
      logger.info("PROBE", "only one");
      expect(logger.tail(100).lines).toHaveLength(1);
    });
  });

  it("returns an empty list when today's file does not exist yet", () => {
    withTmpLogDir((dir) => {
      const logger = new AppLogger(dir);
      const tail = logger.tail(10);
      expect(tail.lines).toEqual([]);
      expect(tail.file).toContain("logs");
    });
  });

  it("returns an empty list for a non-positive bound instead of the whole file", () => {
    withTmpLogDir((dir) => {
      const logger = new AppLogger(dir);
      logger.info("PROBE", "must not leak");
      expect(logger.tail(0).lines).toEqual([]);
      expect(logger.tail(-3).lines).toEqual([]);
    });
  });
});

describe("Algeria-local timestamps", () => {
  it("formats dates as YYYY-MM-DD and moments as YYYY-MM-DDTHH:mm:ss", () => {
    expect(localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(localDateTime()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("clamps hour-24 midnight BEFORE the delimiter swap (synthetic, runtime-conditional)", () => {
    // Some Intl runtimes render midnight as hour "24". The clamp must run
    // while the ", " delimiter is still present: swapping first would leave
    // the non-canonical "T24:00:00" in the log on those runtimes. These
    // strings exercise that branch deterministically on ANY runtime.
    expect(normalizeLocalDateTime("2026-08-25, 24:00:00")).toBe("2026-08-25T00:00:00");
    expect(normalizeLocalDateTime("2026-08-25, 24:24:05")).toBe("2026-08-25T00:24:05"); // a 24-minute survives
    expect(normalizeLocalDateTime("2026-08-25, 24:59:59")).toBe("2026-08-25T00:59:59");
  });

  it("never rewrites a real minute 24 through the anchored clamp", () => {
    // the clamp pattern ", 24:" only anchors on the HOUR (the sole ", " in the
    // rendering precedes the time), so a real minute-24 is untouched
    expect(normalizeLocalDateTime("2026-08-25, 12:24:05")).toBe("2026-08-25T12:24:05");
    expect(normalizeLocalDateTime("2026-08-25, 00:24:00")).toBe("2026-08-25T00:24:00");
    expect(normalizeLocalDateTime("2026-08-25, 00:00:00")).toBe("2026-08-25T00:00:00");
    expect(normalizeLocalDateTime("2026-08-25, 23:59:59")).toBe("2026-08-25T23:59:59");
  });

  it("never rewrites a real minute 24 through the runtime path either", () => {
    // 11:24:05 UTC = 12:24:05 Africa/Algiers; the old bare s/24:/00:/ turned
    // it into 12:00:05, corrupting roughly every :24 minute of the day
    expect(localDateTime(new Date("2026-08-25T11:24:05Z"))).toBe("2026-08-25T12:24:05");
    expect(localDateTime(new Date("2026-08-24T23:24:00Z"))).toBe("2026-08-25T00:24:00");
  });

  it("renders midnight canonically on this runtime", () => {
    expect(localDateTime(new Date("2026-08-24T23:00:00Z"))).toBe("2026-08-25T00:00:00");
  });

  it("maps instants near midnight to the Algeria calendar day (UTC+1, no DST)", () => {
    expect(localDate(new Date("2026-08-24T23:00:00Z"))).toBe("2026-08-25"); // 00:00 local
    expect(localDate(new Date("2026-08-24T22:59:59Z"))).toBe("2026-08-24"); // 23:59 local
  });

  it("agrees on the day within ONE instant (no midnight-crossing flake)", () => {
    const now = new Date();
    expect(localDateTime(now).slice(0, 10)).toBe(localDate(now));
  });
});