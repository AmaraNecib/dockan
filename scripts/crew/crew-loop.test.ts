import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { loopSelftest, parsePickupOutcome } from "./crew-loop";

describe("crew-loop", () => {
  test("--selftest cases all pass", () => {
    const failed = loopSelftest().filter((item) => !item.ok);
    expect(failed).toEqual([]);
  });

  // The loop is the only parser of pickup's `started=` line, and the two shells around it
  // (`crew-loop.sh`, `crew-autopilot.ts`) each match it differently. Both shapes pinned.
  test("the started= line is read the way both callers write it", () => {
    expect(parsePickupOutcome("[pickup] started=0").started).toBe(0);
    expect(parsePickupOutcome("[pickup] started=2\n").started).toBe(2);
    expect(parsePickupOutcome("noise\n[pickup] started=11\nmore noise").started).toBe(11);
    expect(parsePickupOutcome("[pickup] started=oops").started).toBe(0);
  });

  // Read-only, so it is safe against the live loop: `status` only reads the pidfile.
  test("status runs through the shim and reports the live pidfile", () => {
    const shim = join(import.meta.dir, "..", "..", ".scratch", "scripts", "crew-loop.sh");
    const out = execFileSync("bash", [shim, "status"], { encoding: "utf8", windowsHide: true });
    expect(/^(running pid \d+ — log .+|not running)\n$/u.test(out)).toBe(true);
  });
});
