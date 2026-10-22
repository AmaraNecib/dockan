import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSlot,
  BASE_STRIDE,
  capacityFor,
  chooseFreeBase,
  claimBase,
  DEFAULT_BASE,
  maxSlots,
  readPersistedBase,
  realOpenServer,
  release,
  resetBase,
  setBinderForTest,
  status,
  tryTake,
  unusableBanner,
} from "./heavy-slot";

// The base is picked at runtime with the tool's own probe helper - no hardcoded
// port, no hardcoded C:/ path. The state lives under the system temp dir.
const ROOT = mkdtempSync(join(tmpdir(), "heavy-slot-test-"));
process.env.HEAVY_SLOT_MAX = "1";
process.env.HEAVY_SLOT_PER_JOB_GB = "0.1";
process.env.HEAVY_SLOT_RESERVE_GB = "0";
process.env.HEAVY_SLOT_WAIT_MS = "400";
process.env.HEAVY_SLOT_STATE_DIR = ROOT;

const TEST_BASE = await chooseFreeBase(DEFAULT_BASE);
if (TEST_BASE === null) throw new Error("no free base found near the default; the probe window is too narrow");
process.env.HEAVY_SLOT_BASE = String(TEST_BASE);

console.log(`[heavy-slot-test] chosen base: ${TEST_BASE} (probed free at runtime), state root: ${ROOT}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freshDir(): string {
  return mkdtempSync(join(ROOT, "state-"));
}

function childEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HEAVY_SLOT_STATE_DIR: dir, ...extra };
}

type ChildOutput = { code: number; out: string };

function childOutput(child: ReturnType<typeof spawn>): Promise<ChildOutput> {
  return new Promise((resolve) => {
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("close", (c) => resolve({ code: c ?? 1, out }));
  });
}

/** Inject bind failures at the module's bind seam: EACCES is how Windows says "reserved range". */
function stubUnusable(matches: (port: number) => boolean): void {
  setBinderForTest(async (port) => (matches(port) ? { error: "unusable", code: "EACCES" } : await realOpenServer(port)));
}

describe("heavy-slot", () => {
  test("capacity never exceeds the ceiling", () => {
    expect(capacityFor(1000, 10, false)).toBeLessThanOrEqual(maxSlots());
    expect(capacityFor(1000, 10, true)).toBeLessThanOrEqual(maxSlots());
  });

  test("a busy port reads as busy and an injected EACCES reads as unusable, never the other way round", async () => {
    resetBase();
    const a = await tryTake(1, "holder-a");
    expect(a.ok).toBe(true);
    const b = await tryTake(1, "holder-b");
    expect(b).toEqual({ ok: false, reason: "busy", port: TEST_BASE, code: "EADDRINUSE" });
    if (a.ok) release(a.slot);

    setBinderForTest(async () => ({ error: "unusable", code: "EACCES" }));
    try {
      const c = await tryTake(1, "victim");
      expect(c).toEqual({ ok: false, reason: "unusable", port: TEST_BASE, code: "EACCES" });
    } finally {
      setBinderForTest(null);
    }
  });

  test("status says the range is unusable and never calls it an empty or full queue", async () => {
    resetBase();
    setBinderForTest(async () => ({ error: "unusable", code: "EACCES" }));
    try {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        await status();
      } finally {
        console.log = log;
      }
      const out = lines.join("\n");
      expect(out).toContain(unusableBanner());
      expect(out).toContain(String(TEST_BASE));
      expect(out).toContain("netsh int ipv4 show excludedportrange protocol=tcp");
      expect(out).not.toContain("the queue is empty");
      // "full" appears only inside the refusal that denies it, never as the reason.
      expect(out).toContain('not "the queue is full"');
    } finally {
      setBinderForTest(null);
    }
  });

  test("run refuses loudly non-zero (76, not 75) and fast when every candidate range is reserved", async () => {
    resetBase();
    const dir = freshDir();
    // The stub must live inside the child process: a bind seam set here cannot cross it.
    const script = [
      "const mod = await import('./tools/heavy-slot/heavy-slot.ts');",
      "mod.setBinderForTest(() => Promise.resolve({ error: 'unusable', code: 'EACCES' }));",
      'await mod.run("extra", "echo hi");',
    ].join("\n");
    const t0 = Date.now();
    const r = await childOutput(spawn("bun", ["-e", script], { cwd: process.cwd(), env: childEnv(dir), stdio: ["ignore", "pipe", "pipe"] }));
    expect(r.code).toBe(76);
    expect(r.out).toContain(unusableBanner());
    expect(r.out).toContain(`HEAVY_SLOT_BASE=${TEST_BASE}`);
    expect(r.out).toContain("netsh int ipv4 show excludedportrange protocol=tcp");
    expect(r.out).toContain('not "the queue is full"');
    expect(r.out).not.toContain("gave up");
    // Refuses immediately instead of burning the wait budget.
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15000);

  test("an EACCES on the range's first slot shifts the base by the stride and records it", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    process.env.HEAVY_SLOT_STATE_DIR = dir; // the record goes to stateDir(); point it at the scenario
    stubUnusable((port) => port === TEST_BASE);
    try {
      const r = await acquireSlot("shifter");
      expect(r).not.toBeNull();
      expect(r && "slot" in r ? r.slot.port : null).toBe(TEST_BASE + BASE_STRIDE);
      if (r && "slot" in r) release(r.slot);
      // "wx" record: the first process to find a working base writes it once.
      expect(readPersistedBase(dir)).toBe(TEST_BASE + BASE_STRIDE);
      expect(readFileSync(join(dir, "base"), "utf8")).toBe(`${TEST_BASE + BASE_STRIDE}\n`);
    } finally {
      setBinderForTest(null);
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
    }
  }, 20000);

  test("a second process reads the recorded base instead of picking a different one", async () => {
    resetBase();
    const dir = freshDir();
    const shared = await chooseFreeBase(TEST_BASE + 2 * BASE_STRIDE);
    if (shared === null) throw new Error("no free base for the shared-base scenario");
    expect(claimBase(shared, dir)).toBe(true);
    const r = await childOutput(
      spawn("bun", ["tools/heavy-slot/heavy-slot.ts", "run", "probe", "echo hi"], {
        cwd: process.cwd(),
        env: childEnv(dir),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    // The child ran on the recorded base even though its env points elsewhere.
    expect(r.code).toBe(0);
    expect(r.out).toContain(`port ${shared}`);
    // And it did not overwrite the recorded decision ("wx" first-writer wins).
    expect(readPersistedBase(dir)).toBe(shared);
  }, 15000);

  test("N+1 concurrent acquires: the extra exits 75 because slots are held", async () => {
    resetBase();
    const held = await tryTake(1, "blocker");
    expect(held.ok).toBe(true);
    const r = await childOutput(
      spawn("bun", ["tools/heavy-slot/heavy-slot.ts", "run", "extra", "echo hi"], {
        cwd: process.cwd(),
        env: childEnv(freshDir(), { HEAVY_SLOT_WAIT_MS: "400" }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(r.code).toBe(75);
    expect(r.out).toContain("gave up");
    // The refusal banner is reserved for a reserved range - never for a full queue.
    expect(r.out).not.toContain("no usable port range");
    if (held.ok) release(held.slot);
  }, 15000);

  test("slot is released when its holder dies", async () => {
    resetBase();
    const holder = spawn(
      "bun",
      [
        "-e",
        "const m=await import('./tools/heavy-slot/heavy-slot.ts'); const s=await m.tryTake(1,'holder'); console.log('bound', s.ok); await new Promise(r=>setTimeout(r,60000));",
      ],
      { cwd: process.cwd(), env: childEnv(freshDir()), stdio: "ignore" },
    );
    await sleep(1500);
    const busy = await tryTake(1, "probe");
    expect(busy).toEqual({ ok: false, reason: "busy", port: TEST_BASE, code: "EADDRINUSE" });
    holder.kill("SIGKILL");
    await sleep(2000);
    const slot = await tryTake(1, "after-death");
    expect(slot.ok).toBe(true);
    if (slot.ok) release(slot.slot);
  }, 15000);
});
