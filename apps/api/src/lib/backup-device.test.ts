import { describe, expect, it } from "bun:test";
import { comparePhysicalDevice, compareWindowsDiskNumbers } from "./backup-device";

describe("physical-device comparison", () => {
  for (const platform of ["linux", "darwin", "freebsd"] as const) {
    it(`does not claim a physical-disk match from stat.dev on ${platform}`, async () => {
      expect(await comparePhysicalDevice(process.cwd(), process.cwd(), platform)).toBe("unknown");
    });
  }

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
