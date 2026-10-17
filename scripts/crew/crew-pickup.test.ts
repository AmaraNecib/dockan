import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

import { pickupSelftest } from "./crew-pickup";

describe("crew-pickup", () => {
  test("--selftest cases all pass", async () => {
    const failed = (await pickupSelftest()).filter((item) => !item.ok);
    expect(failed).toEqual([]);
  });

  // `crew-loop.sh` and `crew-autopilot.ts` both parse `started=N` out of this stdout, so
  // the last line is a contract. This asserts the SHAPE on a dry run, which is the only
  // way to see the line without starting a lane.
  test("--selftest runs from the CLI and exits 0", () => {
    const out = execFileSync(process.execPath, [join(import.meta.dir, "crew-pickup.ts"), "--selftest"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(out).toContain("the last line is the loop's contract: [pickup] started=N");
    expect(out.trimEnd().endsWith("pass / 0 fail")).toBe(true);
  });

  test("an unknown flag is a usage error", () => {
    const done = spawnSync(process.execPath, [join(import.meta.dir, "crew-pickup.ts"), "--wat"], { encoding: "utf8", windowsHide: true });
    expect(done.status).toBe(2);
  });
});
