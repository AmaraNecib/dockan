import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppLogger, errorCodeFor, localDate, localDateTime } from "./logger";

/** Africa/Algiers date computed independently of the module under test. */
function algiersToday(): string {
  return new Date().toLocaleString("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dokan-logger-"));
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
});

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

describe("AppLogger JSONL persistence", () => {
  it("writes today's Algeria-local file under <dir>/logs with the full error shape", () => {
    const dir = tmpDir();
    try {
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps codes stable across restarts: a fresh instance derives the same code", () => {
    const dir = tmpDir();
    try {
      const first = new AppLogger(dir);
      const boom = new Error("kaboom");
      const codeRun1 = first.error("RPC_ERROR", "rpc call failed", boom);

      const second = new AppLogger(dir); // simulates a process restart
      const codeRun2 = second.error("RPC_ERROR", "rpc call failed", boom);

      expect(codeRun2).toBe(codeRun1);
      expect(codeRun2).toMatch(/^DKN-[0-9A-F]{8}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes info entries too, without a code", () => {
    const dir = tmpDir();
    try {
      const logger = new AppLogger(dir);
      logger.info("SERVER_BOOT_DONE", "database ready", { driver: "sqlite" });

      const file = path.join(dir, "logs", `${algiersToday()}.jsonl`);
      // SAFETY: same invariant as above — the file content is AppLogger's own
      // JSON.stringify output (LogEntry shape), so the cast is a shape promise
      const row = JSON.parse(fs.readFileSync(file, "utf8").trim()) as LogRowJson;
      expect(row.level).toBe("info");
      expect(row.event).toBe("SERVER_BOOT_DONE");
      // stable codes exist for technical ERRORS; info rows have no code
      expect(row.code).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AppLogger.tail (viewer input)", () => {
  it("returns the newest-last bounded tail of today's file", () => {
    const dir = tmpDir();
    try {
      const logger = new AppLogger(dir);
      for (let i = 1; i <= 10; i++) logger.info("PROBE", `entry ${i}`);

      const tail = logger.tail(3);
      expect(tail.lines).toHaveLength(3);
      expect(tail.lines[2]).toContain("entry 10"); // newest last
      expect(tail.lines[0]).toContain("entry 8");
      expect(tail.file).toBe(path.join(dir, "logs", `${algiersToday()}.jsonl`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns all lines when the file is smaller than the limit", () => {
    const dir = tmpDir();
    try {
      const logger = new AppLogger(dir);
      logger.info("PROBE", "only one");
      expect(logger.tail(100).lines).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when today's file does not exist yet", () => {
    const dir = tmpDir();
    try {
      const logger = new AppLogger(dir);
      const tail = logger.tail(10);
      expect(tail.lines).toEqual([]);
      expect(tail.file).toContain("logs");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Algeria-local timestamps", () => {
  it("formats dates as YYYY-MM-DD and moments as YYYY-MM-DDTHH:mm:ss", () => {
    expect(localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(localDateTime()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    // the date part of the moment agrees with localDate() — one calendar day
    expect(localDateTime().slice(0, 10)).toBe(localDate());
  });
});