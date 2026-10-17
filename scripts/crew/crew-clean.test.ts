import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

import { cleanSelftest } from "./crew-clean";

describe("crew-clean", () => {
  test("--selftest cases all pass (pure guards + real git worktrees)", () => {
    const failed = cleanSelftest().filter((item) => !item.ok);
    expect(failed).toEqual([]);
  }, 60_000);

  // `--selftest` is the operator's proof, so it has to be runnable as a command and
  // exit non-zero when a guard breaks.
  test("--selftest runs from the CLI and exits 0", () => {
    const out = execFileSync(process.execPath, [join(import.meta.dir, "crew-clean.ts"), "--selftest"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    expect(out).toContain("uncommitted source refuses the burn");
    expect(out.trimEnd().endsWith("pass / 0 fail")).toBe(true);
  }, 60_000);

  test("an unknown flag is a usage error, and nothing is burned", () => {
    const done = spawnSync(process.execPath, [join(import.meta.dir, "crew-clean.ts"), "--nope"], { encoding: "utf8", windowsHide: true });
    expect(done.status).toBe(2);
  });
});
