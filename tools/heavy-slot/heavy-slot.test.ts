import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

process.env.HEAVY_SLOT_BASE = "59123";
process.env.HEAVY_SLOT_MAX = "1";
process.env.HEAVY_SLOT_PER_JOB_GB = "0.1";
process.env.HEAVY_SLOT_RESERVE_GB = "0";
process.env.HEAVY_SLOT_WAIT_MS = "400";
process.env.HEAVY_SLOT_STATE_DIR = "C:/tmp/heavy-slot-test-state";

const mod = await import("./heavy-slot");
const { tryTake, release, capacityFor, MAX_SLOTS } = mod;

describe("heavy-slot", () => {
  test("capacity never exceeds the ceiling", () => {
    expect(capacityFor(1000, 10, false)).toBeLessThanOrEqual(MAX_SLOTS);
    expect(capacityFor(1000, 10, true)).toBeLessThanOrEqual(MAX_SLOTS);
  });

  test("bound is respected: a busy slot cannot be taken", async () => {
    const a = await tryTake(1, "holder-a");
    expect(a).not.toBeNull();
    const b = await tryTake(1, "holder-b");
    expect(b).toBeNull();
    if (a) release(a);
  });

  test("N+1 concurrent acquires: the extra exits 75", async () => {
    const held = await tryTake(1, "blocker");
    expect(held).not.toBeNull();
    const child = spawn(
      "bun",
      ["tools/heavy-slot/heavy-slot.ts", "run", "extra", "echo hi"],
      {
        cwd: process.cwd(),
        env: { ...process.env, HEAVY_SLOT_BASE: "59123", HEAVY_SLOT_MAX: "1", HEAVY_SLOT_WAIT_MS: "400" },
        stdio: "ignore",
      },
    );
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
    expect(code).toBe(75);
    if (held) release(held);
  }, 10000);

  test("slot is released when its holder dies", async () => {
    const holder = spawn(
      "bun",
      ["-e", "const m=await import('./tools/heavy-slot/heavy-slot.ts'); const s=await m.tryTake(1,'holder'); await new Promise(r=>setTimeout(r,60000));"],
      {
        cwd: process.cwd(),
        env: { ...process.env, HEAVY_SLOT_BASE: "59123", HEAVY_SLOT_MAX: "1" },
        stdio: "ignore",
      },
    );
    await new Promise((r) => setTimeout(r, 1500));
    const busy = await tryTake(1, "probe");
    expect(busy).toBeNull();
    holder.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 2000));
    const slot = await tryTake(1, "after-death");
    expect(slot).not.toBeNull();
    if (slot) release(slot);
  }, 10000);
});
