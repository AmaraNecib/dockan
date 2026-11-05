import { describe, expect, it } from "bun:test";
import { comparePhysicalDevice, compareWindowsDiskNumbers } from "./backup-device";

describe("physical-device comparison", () => {
  it.skipIf(process.platform !== "win32")("queries the running Windows host and recognizes one physical disk", async () => {
    expect(await comparePhysicalDevice(process.cwd(), process.cwd())).toBe("same");
  });

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
