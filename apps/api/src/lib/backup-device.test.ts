import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { comparePhysicalDevice, compareWindowsDiskNumbers, resolvePhysicalDevicePaths, windowsDiskQueryForPaths } from "./backup-device";

describe("physical-device comparison", () => {
  for (const platform of ["linux", "darwin", "freebsd"] as const) {
    it(`does not claim a physical-disk match from stat.dev on ${platform}`, async () => {
      expect(await comparePhysicalDevice(process.cwd(), process.cwd(), platform)).toBe("unknown");
    });
  }

  it("resolves a redirected destination before comparing physical devices", async () => {
    const paths = await resolvePhysicalDevicePaths("D:/vault", "E:/backup", async (value) => value === "E:/backup" ? "C:/backup-target" : value);
    expect(paths).toEqual(["D:/vault", "C:/backup-target"]);
  });

  it("keeps event-loop work moving while canonical path I/O is delayed", async () => {
    let release!: (value: string) => void;
    const delayedPath = new Promise<string>((resolve) => { release = resolve; });
    let apiWorkCompleted = false;
    const resolution = resolvePhysicalDevicePaths("D:/vault", "E:/backup", (value) =>
      value === "E:/backup" ? delayedPath : Promise.resolve(value));
    await Promise.resolve().then(() => { apiWorkCompleted = true; });
    expect(apiWorkCompleted).toBe(true);
    release("E:/resolved-backup");
    expect(await resolution).toEqual(["D:/vault", "E:/resolved-backup"]);
  });

  it("resolves a junction to its target path before device lookup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-device-junction-"));
    try {
      const target = path.join(root, "target");
      const junction = path.join(root, "junction");
      fs.mkdirSync(target);
      fs.symlinkSync(target, junction, process.platform === "win32" ? "junction" : "dir");
      expect(await resolvePhysicalDevicePaths(root, junction)).toEqual([
        await fs.promises.realpath(root),
        await fs.promises.realpath(target),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("inserts path text literally into the PowerShell source", () => {
    const script = windowsDiskQueryForPaths("C:/vault/$'__DESTINATION_PATH__", "D:/backup/$'__SOURCE_PATH__");
    expect(script).toEqual(expect.stringContaining("'C:/vault/$''__DESTINATION_PATH__'"));
    expect(script).toEqual(expect.stringContaining("'D:/backup/$''__SOURCE_PATH__'"));
  });

  it("queries the running host without guessing physical disk identity", async () => {
    const expected = process.platform === "win32" ? "same" : "unknown";
    expect(await comparePhysicalDevice(process.cwd(), process.cwd())).toBe(expected);
  }, 15_000);

  it("warns for paths mapped to the same Windows disk even when letters differ", () => {
    expect(compareWindowsDiskNumbers(["3", "3"])).toBe("same");
  });

  it("distinguishes Windows disk identities, not drive letters", () => {
    expect(compareWindowsDiskNumbers(["2", "7"])).toBe("different");
  });

  it("reports unknown when the bounded system query cannot prove an identity", () => {
    expect(compareWindowsDiskNumbers(["3", null])).toBe("unknown");
    expect(compareWindowsDiskNumbers(["3"])).toBe("unknown");
  });
});
