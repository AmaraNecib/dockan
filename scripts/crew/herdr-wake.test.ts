import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { wakeSelftest } from "./herdr-wake";

describe("herdr-wake", () => {
  test("--selftest cases all pass", async () => {
    const failed = (await wakeSelftest()).filter((item) => !item.ok);
    expect(failed).toEqual([]);
  });

  // The whole point of this script: a wake that was never delivered must never look
  // like one that was. `herdr` missing from PATH is the cheapest case to reproduce.
  test("a PATH without herdr is exit 3, never a false zero", () => {
    const done = spawnSync(process.execPath, [join(import.meta.dir, "herdr-wake.ts"), "w48:p1", "hello", "1", "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "", HERDR_BIN: "herdr" },
      windowsHide: true,
    });
    expect(done.status).toBe(3);
    expect((done.stderr ?? "").trim()).toBe("herdr-wake: herdr not on PATH");
  });

  test("a missing message is a usage error, and usage never exits 0", () => {
    const done = spawnSync(process.execPath, [join(import.meta.dir, "herdr-wake.ts"), "w48:p1"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(done.status).toBe(1);
  });
});
