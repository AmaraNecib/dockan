import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import {
  acquireSlot,
  BASE_STRIDE,
  capacityFor,
  chooseFreeBase,
  claimBase,
  DEFAULT_BASE,
  EXIT_FULL,
  EXIT_REFUSED,
  killTree,
  maxSlots,
  readPersistedBase,
  realOpenServer,
  release,
  resetBase,
  run,
  setBinderForTest,
  setProcessProbeForTest,
  processState,
  status,
  treeAlive,
  tryTake,
  TASKKILL_TIMEOUT_MS,
  setTaskkillRunnerForTest,
  taskkillTree,
  unusableBanner,
  writeBase,
} from "./heavy-slot";
import { buildGcFixtureScript } from "./gc-fixture";

// Spawned children and the injected-script imports resolve the tool from this
// file's own location, never from the caller's cwd: `bun test heavy-slot.test.ts`
// must work from the repo root and from tools/heavy-slot/ alike.
const TOOL_SCRIPT = fileURLToPath(new URL("./heavy-slot.ts", import.meta.url));
const TOOL_IMPORT = new URL("./heavy-slot.ts", import.meta.url).href;

// The base is picked at runtime with the tool's own probe helper - no hardcoded
// port, no hardcoded C:/ path. The state lives under the system temp dir.
const ROOT = mkdtempSync(join(tmpdir(), "heavy-slot-test-"));

// F10: chooseFreeBase releases every port it probes, so two test runs started
// together can settle on the same "free" base and steal each other's range when
// the real binds begin - separate state dirs do not separate ports. Each run
// starts its walk at a per-run offset (own probed range), and the winner must
// still bind right now (canary); a contended candidate is skipped, not fought over.
const RUN_OFFSET = Math.floor(Math.random() * 8) * BASE_STRIDE;

/** Walk candidate windows downward from `start` until one yields a base that is free twice in a row [T3]: the pick probes AND canary-binds, because an unexpected EADDRINUSE in the RUNNING test is a red, while an unexpected EADDRINUSE in the pick is a re-pick. Two runs together draw overlapping windows (8 offsets, 8-wide windows), so a sibling steal between the probe and the canary is the collision that ends here. */
async function pickWindow(start: number): Promise<number> {
  for (let s = start; s > DEFAULT_BASE - BASE_STRIDE; s -= 4 * BASE_STRIDE) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await chooseFreeBase(s, 3);
      if (candidate === null) break; // this window is exhausted; try the one below
      const canary = await realOpenServer(candidate);
      if ("error" in canary) continue; // a sibling run took it between probe and canary: re-pick, not red
      await new Promise<void>((resolve) => canary.server.close(() => resolve()));
      return candidate;
    }
  }
  throw new Error(`no free base below ${start}`);
}

async function pickTestBase(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const start = DEFAULT_BASE + RUN_OFFSET + attempt * 8 * BASE_STRIDE;
    const candidate = await chooseFreeBase(start, 8);
    if (candidate === null) continue;
    const canary = await realOpenServer(candidate);
    if ("error" in canary) continue; // a sibling run took it between probe and canary
    await new Promise<void>((resolve) => canary.server.close(() => resolve()));
    return candidate;
  }
  throw new Error("no free base found near the default; the probe window is too narrow");
}

const TEST_BASE = await pickTestBase();

// F14: the scenario env is written from a hook, not at module scope, so when it
// applies is visible instead of implied. Two facts make that possible, and both
// are load-bearing: the tool reads every config value lazily (preferredBase(),
// maxSlots(), stateDir() all touch process.env at call time, never at import time),
// and resetBase() re-reads the base into the module's cached decision. Note what
// was never true: a static import is evaluated before any statement in this file,
// so "the env must be set before the module is imported" cannot be arranged here -
// the hook plus the lazy reads are what make the scenario real.
const SCENARIO_ENV = {
  HEAVY_SLOT_MAX: "1",
  HEAVY_SLOT_PER_JOB_GB: "0.1",
  HEAVY_SLOT_RESERVE_GB: "0",
  HEAVY_SLOT_WAIT_MS: "400",
  HEAVY_SLOT_STATE_DIR: ROOT,
  HEAVY_SLOT_BASE: String(TEST_BASE),
} as const;

const previousEnv = new Map<string, string | undefined>();

function enterScenario(): void {
  for (const [key, value] of Object.entries(SCENARIO_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  resetBase(); // the base decided at import time came from the caller's env, not this one
}

function leaveScenario(): void {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
}

beforeAll(() => enterScenario());
afterAll(() => {
  leaveScenario();
  rmSync(ROOT, { recursive: true, force: true });
});

console.log(`[heavy-slot-test] chosen base: ${TEST_BASE} (probed free at runtime), state root: ${ROOT}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fixtureResponds(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (matches: boolean) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      resolve(matches);
    };
    timer = setTimeout(() => finish(false), 250);
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.length >= token.length) finish(response === token);
    });
    socket.on("end", () => finish(response === token));
    socket.on("error", () => finish(false));
  });
}

async function waitForFixtureGone(port: number, token: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fixtureResponds(port, token))) return true;
    await sleep(50);
  }
  return !(await fixtureResponds(port, token));
}

type BoundedWait<T> = { settled: true; value: T } | { settled: false };

async function waitForPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedWait<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitOrCleanup<T>(
  promise: Promise<T>,
  timeoutMs: number,
  cleanup: () => Promise<void>,
): Promise<BoundedWait<T>> {
  const result = await waitForPromise(promise, timeoutMs);
  if (!result.settled) await cleanup();
  return result;
}

type CapturedFixture = {
  isAlive: () => Promise<boolean>;
  kill: () => "signalled" | "found" | "not-found" | "unknown";
  waitForExit: (timeoutMs: number) => Promise<boolean>;
};

async function cleanupCapturedFixture(runDone: boolean, fixture: CapturedFixture, timeoutMs = 2000): Promise<void> {
  if (!(await fixture.isAlive())) return;
  const outcome = fixture.kill();
  if (!(await fixture.waitForExit(timeoutMs))) {
    const runnerState = runDone ? "already settled" : "still active";
    throw new Error(`test-owned fixture did not exit within ${timeoutMs}ms; kill outcome=${outcome}, runner ${runnerState}`);
  }
}

function throwTestFailures(primaryFailure: Error | undefined, cleanupFailure: Error | undefined): void {
  if (primaryFailure && cleanupFailure) {
    throw new AggregateError([primaryFailure, cleanupFailure], "test body and fixture cleanup both failed");
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
}

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
  test("taskkill subprocess receives the fixed timeout budget", () => {
    const calls: Array<{ pid: number; timeout?: number }> = [];
    setTaskkillRunnerForTest((pid, options) => {
      calls.push({ pid, timeout: options.timeout });
      return { status: 0 };
    });
    try {
      expect(taskkillTree(43210)).toBe("found");
      expect(calls).toEqual([{ pid: 43210, timeout: TASKKILL_TIMEOUT_MS }]);
    } finally {
      setTaskkillRunnerForTest(null);
    }
  });

  test("taskkill nonzero with a live PID is unknown, not absent", () => {
    setTaskkillRunnerForTest(() => ({ status: 1 }));
    setProcessProbeForTest(() => "present");
    try {
      expect(taskkillTree(43209)).toBe("unknown");
    } finally {
      setTaskkillRunnerForTest(null);
      setProcessProbeForTest(null);
    }
  });

  test("taskkill nonzero only confirms absence when the OS probe reports ESRCH", () => {
    setTaskkillRunnerForTest(() => ({ status: 128 }));
    setProcessProbeForTest(() => "absent");
    try {
      expect(taskkillTree(43208)).toBe("not-found");
      setProcessProbeForTest(() => "unknown");
      expect(taskkillTree(43208)).toBe("unknown");
    } finally {
      setTaskkillRunnerForTest(null);
      setProcessProbeForTest(null);
    }
  });

  test("taskkill timeout reports an unknown tree state instead of success or absence", () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...messages: unknown[]) => errors.push(messages.map(String).join(" "));
    setTaskkillRunnerForTest(() => ({
      status: null,
      error: Object.assign(new Error("simulated taskkill timeout"), { code: "ETIMEDOUT" }),
    }));
    try {
      expect(taskkillTree(43211)).toBe("unknown");
      expect(errors.join("\n")).toContain(`${TASKKILL_TIMEOUT_MS}ms`);
      expect(errors.join("\n")).toContain("state is unknown");
    } finally {
      setTaskkillRunnerForTest(null);
      console.error = originalError;
    }
  });

  test("taskkill spawn errors leave the process-tree state unknown", () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...messages: unknown[]) => errors.push(messages.map(String).join(" "));
    setTaskkillRunnerForTest(() => ({
      status: null,
      error: Object.assign(new Error("simulated missing taskkill"), { code: "ENOENT" }),
    }));
    try {
      expect(taskkillTree(43212)).toBe("unknown");
      expect(errors.join("\n")).toContain("ENOENT");
      expect(errors.join("\n")).toContain("state is unknown");
    } finally {
      setTaskkillRunnerForTest(null);
      console.error = originalError;
    }
  });

  test.skipIf(process.platform !== "win32")("treeAlive treats a taskkill timeout as potentially alive", () => {
    setTaskkillRunnerForTest(() => ({
      status: null,
      error: Object.assign(new Error("simulated taskkill timeout"), { code: "ETIMEDOUT" }),
    }));
    setProcessProbeForTest(() => "unknown");
    try {
      // SAFETY: this Windows-only branch reads only pid; other platforms skip the test.
      expect(treeAlive({ pid: 43213 } as Parameters<typeof treeAlive>[0])).toBe(true);
    } finally {
      setTaskkillRunnerForTest(null);
      setProcessProbeForTest(null);
    }
  });

  test("fixture ownership probe errors are visible and never trigger a PID kill", async () => {
    let killCalled = false;
    await expect(cleanupCapturedFixture(true, {
      isAlive: async () => { throw new Error("probe unavailable"); },
      kill: () => { killCalled = true; return "signalled"; },
      waitForExit: async () => true,
    })).rejects.toThrow("probe unavailable");
    expect(killCalled).toBe(false);
  });

  test("test body and cleanup failures remain visible together", () => {
    const primary = new Error("assertion failed");
    const cleanup = new Error("fixture did not stop");
    try {
      throwTestFailures(primary, cleanup);
      throw new Error("expected combined failure");
    } catch (error) {
      if (!(error instanceof AggregateError)) throw error;
      expect(error.errors).toEqual([primary, cleanup]);
    }
  });

  test("fixture finalizer kills and reaps a live child after the runner settled", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const runner = await waitForPromise(Promise.resolve(0), 100);
    expect(runner.settled).toBe(true);
    expect(child.exitCode).toBeNull();

    try {
      await cleanupCapturedFixture(runner.settled, {
        isAlive: async () => child.exitCode === null && child.signalCode === null,
        kill: () => (child.kill("SIGKILL") ? "signalled" : "not-found"),
        waitForExit: async (timeoutMs) => (await waitForPromise(childClosed, timeoutMs)).settled,
      });
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect((await waitForPromise(childClosed, 2000)).settled).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForPromise(childClosed, 2000);
    }
  });

  test("bounded cancellation cleanup stops its owned child and restores scenario state", async () => {
    const stateDir = freshDir();
    const previousStateDir = process.env.HEAVY_SLOT_STATE_DIR;
    process.env.HEAVY_SLOT_STATE_DIR = stateDir;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    try {
      const result = await waitOrCleanup(new Promise<never>(() => {}), 25, async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        const stopped = await waitForPromise(childClosed, 2000);
        if (!stopped.settled) throw new Error("test-owned cleanup child did not exit");
        if (previousStateDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
        else process.env.HEAVY_SLOT_STATE_DIR = previousStateDir;
        rmSync(stateDir, { recursive: true, force: true });
      });

      expect(result.settled).toBe(false);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(process.env.HEAVY_SLOT_STATE_DIR === previousStateDir).toBe(true);
      expect(existsSync(stateDir)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (previousStateDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("the F18 premise holds on this machine: renameSync over an existing file replaces it", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "record"), "1\n");
    writeFileSync(join(dir, "next.tmp"), "2\n");
    // The atomic-replace story rests on this: the rename must REPLACE the live
    // file, not fail or leave both behind (Windows would refuse without
    // MOVEFILE_REPLACE_EXISTING). Verified with a real rename, not a comment.
    renameSync(join(dir, "next.tmp"), join(dir, "record"));
    expect(existsSync(join(dir, "record"))).toBe(true);
    expect(readFileSync(join(dir, "record"), "utf8")).toBe("2\n");
    expect(existsSync(join(dir, "next.tmp"))).toBe(false);
  });

  test("writeBase replaces a live record and answers with the file's own re-read", () => {
    const dir = freshDir();
    expect(claimBase(47001, dir)).toBe(true);
    const after = writeBase(48001, dir);
    expect(after).toBe(48001);
    expect(readFileSync(join(dir, "base"), "utf8")).toBe("48001\n");
    // no temp litter: the temp file lands exactly once as the record
    expect(readdirSync(dir).filter((f) => f.startsWith(".base-"))).toEqual([]);
  });

  test("the exit-code contract is exported for library callers (F23)", () => {
    expect(EXIT_FULL).toBe(75);
    expect(EXIT_REFUSED).toBe(76);
  });

  test("the policy is measured even for urgent callers: RAM gates capacity, the ceiling only caps it (T4)", () => {
    // The scenario env holds HEAVY_SLOT_MAX=1, under which every input answers 1
    // and the assertion would prove nothing about the policy - so the max is
    // raised for this test alone and restored.
    const prevMax = process.env.HEAVY_SLOT_MAX;
    process.env.HEAVY_SLOT_MAX = "5";
    try {
      const scenarioPerJobGb = Number(process.env.HEAVY_SLOT_PER_JOB_GB ?? "0.1"); // per-test env, mirrored here so the pick cannot drift
      const scenarioReserveGb = Number(process.env.HEAVY_SLOT_RESERVE_GB ?? "0");
      const lowFreeRam = 0.05; // GB: below one scenario job (0.1 GB/job), so the measurement, not the ceiling, answers 1
      const ampleRam = 1000; // GB, above any job count

      expect(capacityFor(lowFreeRam, 50, true)).toBeLessThan(maxSlots());
      expect(capacityFor(lowFreeRam, 50, true)).toBe(1);
      expect(capacityFor(lowFreeRam, 50, false)).toBe(1);
      // ample RAM, low CPU: urgent (and non-urgent) take the ceiling
      expect(capacityFor(ampleRam, 10, true)).toBe(maxSlots());
      expect(capacityFor(1000, 10, false)).toBe(maxSlots());
      expect(scenarioPerJobGb).toBeGreaterThan(0);
      expect(scenarioReserveGb).toBeGreaterThanOrEqual(0);
    } finally {
      if (prevMax === undefined) delete process.env.HEAVY_SLOT_MAX;
      else process.env.HEAVY_SLOT_MAX = prevMax;
    }
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
      `const mod = await import(${JSON.stringify(TOOL_IMPORT)});`,
      "mod.setBinderForTest(() => Promise.resolve({ error: 'unusable', code: 'EACCES' }));",
      'process.exit(await mod.run("extra", "echo hi"));',
    ].join("\n");
    const t0 = Date.now();
    const r = await childOutput(spawn("bun", ["-e", script], { cwd: process.cwd(), env: childEnv(dir), stdio: ["ignore", "pipe", "pipe"] }));
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.out).toContain(unusableBanner());
    expect(r.out).toContain(`HEAVY_SLOT_BASE=${TEST_BASE}`);
    expect(r.out).toContain("netsh int ipv4 show excludedportrange protocol=tcp");
    expect(r.out).toContain('not "the queue is full"');
    expect(r.out).not.toContain("gave up");
    // Refuses immediately instead of burning the wait budget.
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15000);

  test("run hands its outcome back as a code instead of exiting", async () => {
    resetBase();
    setBinderForTest(async () => ({ error: "unusable", code: "EACCES" }));
    try {
      // The same refusal the CLI turns into exit 76 - but here it is a return
      // value, and this test process is still alive to read it. That is what makes
      // the queue callable from a library, and it is the property the old
      // process.exit(76) inside run() could not have.
      expect(await run("library-caller", "echo hi")).toBe(EXIT_REFUSED);
    } finally {
      setBinderForTest(null);
    }

    // The other half of "safe to call from a library": a run that does reach the
    // command leaves no SIGINT/SIGTERM listener behind for the next call to collide
    // with. Counted around the call, not assumed.
    resetBase();
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    expect(await run("library-caller", "echo library-run-ok")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
  }, 20000);

  test("F18: a record claimed under this process's stale probe is followed, never replaced - two queues stay impossible", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    process.env.HEAVY_SLOT_STATE_DIR = dir;
    // Free ports are picked while the real binder is still active.
    const c1 = await chooseFreeBase(TEST_BASE + 2 * BASE_STRIDE, 4);
    if (c1 === null) throw new Error("no free base for P1's claim C1");
    const stale = await chooseFreeBase(c1 + BASE_STRIDE, 4);
    if (stale === null) throw new Error("no free base for the stale record S");
    // The F18 interleaving, enumerated in order at the two seams instead of
    // raced with two children (the F7 race test could pass by luck):
    //   1. P2 reads the record -> S.
    //   2. P1's whole stale-path lands BEFORE P2's stale verdict is acted on:
    //      the record is atomically replaced with a working claim C1.
    //   3. P2 probes S (still the value it read) -> unusable. OLD P2 rm'ed the
    //      file here and took C1 with it; the fix's pre-write re-read sees C1.
    //   4. P2 must end ON C1, and the record must still say C1.
    expect(claimBase(stale, dir)).toBe(true);
    let p1Claimed = false;
    setBinderForTest(async (port) => {
      if (port === stale && !p1Claimed) {
        p1Claimed = true;
        writeBase(c1, dir); // P1's completed replace-and-claim
        return { error: "unusable", code: "EACCES" };
      }
      return realOpenServer(port);
    });
    try {
      const r = await acquireSlot("p2");
      expect(p1Claimed).toBe(true); // the interleaving actually ran
      expect(r.status).toBe("acquired");
      const slot = r.status === "acquired" ? r.slot : null;
      // P2 ends on C1 - a record it never read at decision time is followed.
      expect(slot?.port).toBe(c1);
      // And the record survived untouched: the file is still C1, byte for byte.
      expect(readPersistedBase(dir)).toBe(c1);
      expect(readFileSync(join(dir, "base"), "utf8")).toBe(`${c1}\n`);
      if (slot) release(slot);
    } finally {
      setBinderForTest(null);
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
    }
  }, 20000);

  test("an EACCES on the range's first slot shifts the base by the stride and records it", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    process.env.HEAVY_SLOT_STATE_DIR = dir; // the record goes to stateDir(); point it at the scenario
    stubUnusable((port) => port === TEST_BASE);
    try {
      const r = await acquireSlot("shifter");
      expect(r.status).toBe("acquired");
      const slot = r.status === "acquired" ? r.slot : null;
      // [T5] No literal: pickWindow and the machine's own reserved bands do not
      // know which STRIDE landed this run, so the assertion is the record the
      // walk published, wherever it moved to off the stubbed unusable preferred.
      const recorded = readPersistedBase(dir);
      expect(recorded).not.toBeNull();
      if (recorded === null) throw new Error("the walk published no record");
      expect(recorded).toBeGreaterThan(TEST_BASE); // shifted UP off the unusable preferred
      if (slot) expect(slot.port).toBe(recorded);
      // "wx" record: the first process to find a working base writes it once.
      expect(readFileSync(join(dir, "base"), "utf8")).toBe(`${recorded}\n`);
      if (slot) release(slot);
    } finally {
      setBinderForTest(null);
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
    }
  }, 20000);

  test("a stale recorded base is replaced so a working range can be recorded again", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    process.env.HEAVY_SLOT_STATE_DIR = dir; // the record goes to stateDir(); point it at the scenario
    const stale = await pickWindow(TEST_BASE + 5 * BASE_STRIDE);
    if (stale === null) throw new Error("no free base for the stale record");
    claimBase(stale, dir); // planted: the recorded range now refuses to bind (e.g. re-reserved after a reboot)
    stubUnusable((port) => port === TEST_BASE || port === stale);
    try {
      const r = await acquireSlot("stale-replace");
      // The walk replaced the stale record with the shifted candidate instead of
      // keeping every later process frozen on it. [T5] The assertion is the
      // record's own published value, wherever the walk landed, not a stride
      // literal that a sibling window or a reserved band can invalidate.
      expect(r.status).toBe("acquired");
      const slot = r.status === "acquired" ? r.slot : null;
      const recorded = readPersistedBase(dir);
      expect(recorded).not.toBeNull();
      if (recorded === null) throw new Error("the walk published no record");
      expect(recorded).not.toBe(stale); // the planted stale base is gone
      expect(recorded).not.toBe(TEST_BASE); // and not on the stubbed unusable preferred either
      expect(recorded).toBeGreaterThan(TEST_BASE); // the walk only shifts up
      if (slot) expect(slot.port).toBe(recorded);
      if (slot) release(slot);
    } finally {
      setBinderForTest(null);
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
    }
  }, 20000);

  test("F19: a torn or empty record never becomes a private activation - the record the process ends on is the one on disk", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    process.env.HEAVY_SLOT_STATE_DIR = dir;
    // A torn write: the record file exists and reads as nothing (the old
    // `winner ?? base` fallback said "I picked a range, I own it" and activated
    // a private base while the file stayed empty - no record, no warning, a
    // split queue). The fixed rule: publish or adopt - the file must name the
    // base the process ends on.
    writeFileSync(join(dir, "base"), "");
    try {
      const r = await acquireSlot("torn-record");
      expect(r.status).toBe("acquired");
      const slot = r.status === "acquired" ? r.slot : null;
      expect(slot?.port).toBe(TEST_BASE);
      const record = readPersistedBase(dir); // not null: a record was published
      expect(record).not.toBeNull();
      if (slot) expect(record).toBe(slot.port);
      expect(readFileSync(join(dir, "base"), "utf8")).toBe(`${TEST_BASE}\n`);
      if (slot) release(slot);
    } finally {
      setBinderForTest(null);
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
    }
  }, 20000);

  test("F20: a refused partly-reserved range does not keep the record, and the next resolve walks shifted", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    const prevMax = process.env.HEAVY_SLOT_MAX;
    process.env.HEAVY_SLOT_STATE_DIR = dir;
    process.env.HEAVY_SLOT_MAX = "4"; // capacity >= 2 even when the CPU meter subtracts its 2
    // Unit-level, not an integration demo: every port the assertion depends on
    // is canary-probed free while the binder is honest, and the walk windows
    // before the shifted candidate are marked reserved by the stub - the
    // assertion no more depends on the machine's capacity than a record check.
    const shifted = await chooseFreeBase(TEST_BASE + 4 * BASE_STRIDE, 4);
    if (shifted === null) throw new Error("no free base above the partly reserved range");
    // Phase B's reserved set: the walk windows between the (re-reserved)
    // preferred base and the shifted candidate - slot-1 ports of the walk.
    const windowPorts = new Set<number>();
    for (let shift = 1; TEST_BASE + shift * BASE_STRIDE < shifted; shift++) {
      windowPorts.add(TEST_BASE + shift * BASE_STRIDE);
    }
    // Phase A's reserved set: slots 2..4 of the base itself. Slots are
    // CONSECUTIVE ports (base+0..base+max-1), not stride windows - the EACCES
    // that pre-empts waiting lands on the capacity loop, not on the walk.
    const slotPorts = new Set<number>();
    for (let slot = 2; slot <= 4; slot++) slotPorts.add(TEST_BASE + slot - 1);
    // Phase A - the F20 shape: slot 1 binds but is HELD (a working queue), the
    // deeper slots refuse (EACCES). The run must refuse loudly AND clear the
    // record it proved broken, instead of handing the frozen base to everyone.
    expect(claimBase(TEST_BASE, dir)).toBe(true);
    const blocker = await tryTake(1, "blocker");
    expect(blocker.ok).toBe(true);
    setBinderForTest(async (port) =>
      slotPorts.has(port) ? { error: "unusable", code: "EACCES" } : await realOpenServer(port),
    );
    try {
      const refused = await acquireSlot("victim");
      expect(refused.status).toBe("refused");
      // THE F20 assertion: the proven-broken base is not recorded any more.
      expect(readPersistedBase(dir)).toBeNull();
      // Phase B - the record must not be re-frozen either: plant the same
      // broken base again, but now the whole first window is genuinely
      // reserved (the reboot case). The next resolve must walk to the shifted,
      // working range and record THAT, replacing the stale base atomically.
      expect(claimBase(TEST_BASE, dir)).toBe(true);
      const allReserved = new Set<number>([TEST_BASE]);
      for (const p of windowPorts) allReserved.add(p);
      setBinderForTest(async (port) =>
        allReserved.has(port) ? { error: "unusable", code: "EACCES" } : await realOpenServer(port),
      );
      const r = await acquireSlot("walker");
      expect(r.status).toBe("acquired");
      const slot = r.status === "acquired" ? r.slot : null;
      expect(slot?.port).toBe(shifted); // shifted, not the frozen TEST_BASE
      expect(readPersistedBase(dir)).toBe(shifted); // the record follows the decision
      if (slot) release(slot);
    } finally {
      setBinderForTest(null);
      if (blocker.ok) release(blocker.slot);
      if (prevMax === undefined) delete process.env.HEAVY_SLOT_MAX;
      else process.env.HEAVY_SLOT_MAX = prevMax;
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
    }
  }, 30000);

  test("F22: two bases holding slot 1 at the same time do not share slot metadata", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    const prevBase = process.env.HEAVY_SLOT_BASE;
    process.env.HEAVY_SLOT_STATE_DIR = dir;
    // Same slot INDEX, two different bases: the metadata file must key on the
    // port - an index key would let the second holder overwrite the first's
    // file and release() of one would delete the other holder's metadata.
    const portA = await chooseFreeBase(TEST_BASE + 2 * BASE_STRIDE, 4);
    if (portA === null) throw new Error("no free base A");
    const portB = await chooseFreeBase(portA + BASE_STRIDE, 4);
    if (portB === null) throw new Error("no free base B");
    process.env.HEAVY_SLOT_BASE = String(portA);
    resetBase();
    const a = await tryTake(1, "holder-a"); // slot 1 on base A: port A
    expect(a.ok).toBe(true);
    process.env.HEAVY_SLOT_BASE = String(portB);
    resetBase();
    const b = await tryTake(1, "holder-b"); // slot 1 on base B: port B
    expect(b.ok).toBe(true);
    // Each holder owns slot-<port>.json; the index key's file exists nowhere.
    if (a.ok && b.ok) {
      expect(existsSync(join(dir, `slot-${portA}.json`))).toBe(true);
      expect(existsSync(join(dir, `slot-${portB}.json`))).toBe(true);
      expect(existsSync(join(dir, "slot-1.json"))).toBe(false);
      release(a.slot); // A's release touches only A's file - B's holder intact
      expect(existsSync(join(dir, `slot-${portA}.json`))).toBe(false);
      expect(existsSync(join(dir, `slot-${portB}.json`))).toBe(true);
      release(b.slot);
    }
    if (prevBase === undefined) delete process.env.HEAVY_SLOT_BASE;
    else process.env.HEAVY_SLOT_BASE = prevBase;
    if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
    else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
    resetBase(); // forget the second base decision; the caller's env governs again
  }, 20000);

  test("a second process reads the recorded base instead of picking a different one", async () => {
    resetBase();
    const dir = freshDir();
    const shared = await chooseFreeBase(TEST_BASE + 2 * BASE_STRIDE);
    if (shared === null) throw new Error("no free base for the shared-base scenario");
    expect(claimBase(shared, dir)).toBe(true);
    const r = await childOutput(
      spawn("bun", [TOOL_SCRIPT, "run", "probe", "echo hi"], {
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

  // #365 - un-quarantined. Two things were wrong, and only one of them was the
  // protocol. The test's premise was impossible: each child declared ITS OWN
  // preferred base unusable, i.e. a machine where one process sees EACCES on a
  // port another binds happily, and no protocol can agree with two contradictory
  // observations. Both children now mark the same stale range, which is what
  // EACCES actually is - machine-global.
  //
  // The protocol change is `confirmBase()`: a process re-reads the record
  // immediately before its first bind and adopts what the file says, so a writer
  // that replaced the record after this process resolved cannot leave two live
  // ranges. 20-run tally after both changes: 20 pass, 0 fail.
  test("two processes racing on an absent record agree on one base, and the file records that one once", async () => {
    resetBase();
    const dir = freshDir();
    // A stale record stands in the shared dir and its range is reserved for the
    // WHOLE machine, so neither child can follow it and both walk to a working
    // candidate. The children prefer DIFFERENT bases (two lanes, different env,
    // one machine) - the situation F1 exists for. What the test demands is
    // agreement and a replaced record, not a particular winner.
    const stale = await pickWindow(TEST_BASE + 5 * BASE_STRIDE);
    if (stale === null) throw new Error("no free base for the stale record");
    const a = await pickWindow(stale + 3 * BASE_STRIDE);
    if (a === null) throw new Error("no free base for racing child A");
    const b = await pickWindow(stale + 6 * BASE_STRIDE);
    if (b === null) throw new Error("no free base for racing child B");
    expect(claimBase(stale, dir)).toBe(true);
    // The stub must live inside each child: a bind seam set in this process cannot
    // cross it. Both children mark the SAME stale base unusable, because EACCES is
    // a MACHINE-GLOBAL condition - a range this machine reserves is reserved for
    // every process on it. An earlier version of this test had each child mark its
    // OWN preferred base unusable instead, which models a machine that cannot
    // exist: one process seeing EACCES on a port another binds happily. The
    // protocol was then asked to satisfy two contradictory observations, and it
    // split - correctly, because no protocol can agree with both.
    const racerScript = () =>
      [
        `const mod = await import(${JSON.stringify(TOOL_IMPORT)});`,
        `mod.setBinderForTest(async (port) => port === ${stale}`,
        "  ? { error: 'unusable', code: 'EACCES' }",
        "  : await mod.realOpenServer(port));",
        'process.exit(await mod.run("racer", "echo hi"));',
      ].join("\n");
    // Both children start at the same moment on the same state dir. The raised
    // wait budget keeps a child patient while the other briefly holds the agreed
    // port, so the assertions prove agreement, not a lost race to the exit.
    const [ra, rb] = await Promise.all([
      childOutput(
        spawn("bun", ["-e", racerScript()], {
          cwd: process.cwd(),
          env: childEnv(dir, { HEAVY_SLOT_BASE: String(a), HEAVY_SLOT_WAIT_MS: "15000" }),
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
      childOutput(
        spawn("bun", ["-e", racerScript()], {
          cwd: process.cwd(),
          env: childEnv(dir, { HEAVY_SLOT_BASE: String(b), HEAVY_SLOT_WAIT_MS: "15000" }),
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    ]);
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    // One shared decision: both children ran the SAME base, which replaced the
    // stale record - and it is the only thing the file records.
    const winner = readPersistedBase(dir);
    expect(winner).not.toBeNull();
    expect(winner).not.toBe(stale);
    expect(ra.out).toContain(`port ${winner}`);
    expect(rb.out).toContain(`port ${winner}`);
    // Written once, byte for byte: the first claim's line, unchanged by the loser.
    expect(readFileSync(join(dir, "base"), "utf8")).toBe(`${winner}\n`);
    // The replacement runs under `base.lock` (mutual exclusion, not ordering), so
    // this also proves the lock was RELEASED: one left behind would wedge the next
    // process for the whole stale-lock window.
    expect(existsSync(join(dir, "base.lock"))).toBe(false);
  }, 30000);

  test("N+1 concurrent acquires: the extra exits 75 because slots are held", async () => {
    resetBase();
    const held = await tryTake(1, "blocker");
    expect(held.ok).toBe(true);
    const r = await childOutput(
      spawn("bun", [TOOL_SCRIPT, "run", "extra", "echo hi"], {
        cwd: process.cwd(),
        env: childEnv(freshDir(), { HEAVY_SLOT_WAIT_MS: "400" }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(r.code).toBe(EXIT_FULL);
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
        `const m=await import(${JSON.stringify(TOOL_IMPORT)}); const s=await m.tryTake(1,'holder'); console.log('bound', s.ok); await new Promise(r=>setTimeout(r,60000));`,
      ],
      { cwd: process.cwd(), env: childEnv(freshDir()), stdio: "ignore" },
    );
    // [T6] The holder's reach to tryTake is not a constant (a cold bun start can
    // pass 1.5s), so the busy assertion POLLS on a wall-clock budget - the same
    // flake class F8 removed. Each free probe is released so the holder can win
    // the bind the moment its launcher lets go of it.
    let holderUp = false;
    for (const deadline = Date.now() + 5000; Date.now() < deadline && !holderUp; ) {
      const pre = await tryTake(1, "pre-kill-probe");
      if (pre.ok) {
        release(pre.slot); // the holder has not bound yet; give it the port back
        await sleep(100);
      } else {
        holderUp = true; // held: the holder is up
      }
    }
    expect(holderUp).toBe(true);
    const busy = await tryTake(1, "probe");
    expect(busy).toEqual({ ok: false, reason: "busy", port: TEST_BASE, code: "EADDRINUSE" });
    holder.kill("SIGKILL");
    // Poll for the freed port instead of trusting one fixed sleep: how long the
    // OS takes to release a killed process's bind is not a constant, and a single
    // probe is a coincidence - not the property "a dead holder does not strand
    // its slot".
    let freed = false;
    for (let waited = 0; waited < 5000 && !freed; waited += 100) {
      const probe = await tryTake(1, "after-death");
      freed = probe.ok;
      if (probe.ok) release(probe.slot);
      else await sleep(100);
    }
    expect(freed).toBe(true);
  }, 15000);

  test("a cancelled run's tree is confirmed dead before the slot could release", async () => {
    // The same spawn shape run() uses: a wrapper shell whose pid is the group
    // leader (POSIX, detached), and a real descendant beneath it that a plain
    // shell-signal would never reach.
    let exited = false;
    const sleeper =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "ping -n 30 127.0.0.1 > nul"], { stdio: "ignore" })
        : spawn("sleep", ["200"], { stdio: "ignore", detached: true });
    sleeper.on("exit", () => (exited = true));
    await sleep(300);
    expect(sleeper.pid).toBeDefined();
    // What the SIGINT/SIGTERM hook hands to a cancelled run.
    killTree(sleeper, "SIGTERM");
    // run()'s grace loop: re-probe until the tree is unreachable, then release.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !exited && treeAlive(sleeper)) await sleep(100);
    // Two pieces of evidence, never in dispute: the tree confirm itself (what
    // run() waits on before release), and the wrapper shell's own exit.
    expect(exited || !treeAlive(sleeper)).toBe(true);
    if (exited) expect(treeAlive(sleeper)).toBe(false);
  }, 15000);

  // [L342] The grandchild fixture the cancel test launches must be impossible to
  // strand. run()'s cancel path is not the only way a test ends: an assertion
  // failure between the launch and the cancel, bun's per-test timeout, or the
  // runner itself being killed leaves the fixture running - and it used to live
  // forever (issue #342: two bun.exe children from this very test were still
  // serving their sockets ~20 hours later, gripping a port and a cwd whose tree
  // the parent had already stripped). A bounded lifetime plus a pid file the
  // launcher can delete close both ends: the fixture dies by itself at its TTL
  // even when nothing ever cleans up, and dies within a poll interval when the
  // launcher removes the pid file.
  test("the grandchild fixture dies by itself at its time-to-live", async () => {
    const port = (await chooseFreeBase(TEST_BASE + 5 * BASE_STRIDE, 4)) ?? TEST_BASE;
    const script = join(ROOT, `gc-ttl-${process.pid}-${Date.now()}.mjs`);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      writeFileSync(script, buildGcFixtureScript(port, { ttlMs: 1500 }));
      child = spawn(process.execPath, [script], { stdio: "ignore" });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && child.exitCode === null) await sleep(100);
      expect(child.exitCode).toBe(0);
    } finally {
      rmSync(script, { force: true });
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10000);

  test("the grandchild fixture still holds its socket until the TTL arrives", async () => {
    const port = (await chooseFreeBase(TEST_BASE + 6 * BASE_STRIDE, 4)) ?? TEST_BASE;
    const script = join(ROOT, `gc-pin-${process.pid}-${Date.now()}.mjs`);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      writeFileSync(script, buildGcFixtureScript(port, { ttlMs: 2500 }));
      child = spawn(process.execPath, [script], { stdio: "ignore" });
      // The cancel test's own observable: "port bound" is "grandchild alive". The
      // pin must survive well past run()'s whole cancellation budget, so the
      // production TTL has to be the only thing that ends it.
      await sleep(500);
      expect(await isPortBound(port)).toBe(true);
    } finally {
      rmSync(script, { force: true });
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10000);

  test("the fixture exits after its cooperative shutdown file appears", async () => {
    const port = (await chooseFreeBase(TEST_BASE + 7 * BASE_STRIDE, 4)) ?? TEST_BASE;
    const dir = freshDir();
    const pidFile = join(dir, "gc.pid");
    const shutdownFile = join(dir, "gc.shutdown");
    const script = join(ROOT, `gc-pid-${process.pid}-${Date.now()}.mjs`);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      writeFileSync(script, buildGcFixtureScript(port, { ttlMs: 60000, pidFile, shutdownFile }));
      child = spawn(process.execPath, [script], { stdio: "ignore" });
      // The fixture writes its own pid on boot; wait until it has actually done so
      // before deleting, so the signal cannot race the write.
      let wrote = false;
      for (const deadline = Date.now() + 3000; Date.now() < deadline && !wrote; ) {
        wrote = existsSync(pidFile);
        if (!wrote) await sleep(50);
      }
      expect(wrote).toBe(true);
      expect(readFileSync(pidFile, "utf8").trim()).toBe(String(child.pid));
      // The launcher's cooperative signal file ends the fixture without a PID signal.
      writeFileSync(shutdownFile, "stop");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && child.exitCode === null) await sleep(100);
      expect(child.exitCode).toBe(0);
    } finally {
      rmSync(pidFile, { force: true });
      rmSync(shutdownFile, { force: true });
      rmSync(script, { force: true });
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10000);

  // [T2] run()'s cancel loop needs a grandchild the test can observe INDEPENDENTLY
  // of treeAlive, because treeAlive probes the (dead) wrapper's pid and that is
  // exactly the blind spot under audit: on Windows a taskkill without /T leaves
  // the grandchild alive while the probe reads "tree dead". The observable is
  // chosen per platform - Windows: the grandchild binds a port of its own, so
  // "port bound" is "grandchild alive"; POSIX: the grandchild writes its pid to a
  // file (the sh groups it into run()'s detached process group, so a bypass means
  // treeAlive missed a live member). [F21] is respected: any release under a live
  // grandchild outside the disclosed give-up is a violation.
  const isPortBound = async (port: number): Promise<boolean> => {
    const opened = await realOpenServer(port);
    if ("error" in opened) return true; // busy: something holds it
    await new Promise<void>((resolve) => opened.server.close(() => resolve()));
    return false;
  };

  test("a cancelled run keeps its slot until the grandchild is gone (T2)", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    process.env.HEAVY_SLOT_STATE_DIR = dir;
    const gcPort = await chooseFreeBase(TEST_BASE + 3 * BASE_STRIDE, 4);
    if (gcPort === null) throw new Error("no free port for the grandchild");
    const pidFile = join(dir, "gc.pid");
    const shutdownFile = join(dir, `shutdown-${randomUUID()}`);
    const fixtureToken = randomUUID();
    const gcScript = join(ROOT, `heavy-gc-${process.pid}-${Date.now()}.mjs`);
    let wrapper: string | undefined;
    writeFileSync(
      gcScript,
      buildGcFixtureScript(gcPort, { ttlMs: 90_000, pidFile, shutdownFile, ownershipToken: fixtureToken }),
    );
    const gcAlive = (): Promise<boolean> => fixtureResponds(gcPort, fixtureToken);
    let command: string;
    if (process.platform === "win32") {
      // The wrapper is what run() sees; the grandchild outlives any early close.
      // The 90-second TTL remains a fallback if the test runner itself is killed.
      wrapper = join(ROOT, `heavy-wrapper-${process.pid}.cmd`);
      writeFileSync(
        wrapper,
        `@echo off\r\nstart /b "" "${process.execPath}" "${gcScript}"\r\nping -n 8 127.0.0.1 > nul\r\n`,
      );
      command = `"${wrapper}"`;
    } else {
      // The fixture joins run()'s detached group; its private token endpoint proves
      // that a captured PID still names this disposable fixture before cleanup.
      command = `"${process.execPath}" "${gcScript}" & sleep 6`;
    }

    let violation: string | null = null;
    let cleanupFailure: Error | undefined;
    let primaryFailure: Error | undefined;
    let runDone = false;
    let cancelSent = false;
    const runPromise = run("cancel-me", command).finally(() => {
      runDone = true;
    });
    let listenerBaseline = 0;
    try {
      listenerBaseline = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
      // [T2] Cancels only once the slot is held AND the grandchild is observable: the
      // poll replaces both a fixed sleep and a race on child startup.
      let slotBusy = false;
      let gcUp = false;
      for (const deadline = Date.now() + 10000; Date.now() < deadline && !(slotBusy && gcUp); ) {
        const probe = await tryTake(1, "pre-cancel");
        slotBusy = !probe.ok;
        if (probe.ok) release(probe.slot);
        if (slotBusy) gcUp = await gcAlive();
        if (!slotBusy || !gcUp) await sleep(200);
      }
      expect(slotBusy).toBe(true);
      expect(gcUp).toBe(true);

      // Cancel: the script holds slot 1 already; its terminal writes into stderr
      // of the test are the tool's own progress lines (inherit), harmless here.
      cancelSent = true;
      process.emit("SIGINT");

      // The invariant: while a grandchild is observable, the slot stays bound.
      // The audit's failure mode (probe-only, no traversal) reads: wrapper dies,
      // run releases immediately, grandchild runs on - visible HERE whichever
      // way the sampling interleaves, for as long as the grandchild lives.
      while (!runDone) {
        const probe = await tryTake(1, "monitor");
        const slotBound = !probe.ok;
        if (probe.ok) release(probe.slot);
        if (!runDone && !slotBound && (await gcAlive())) violation = `slot freed while the grandchild is still alive`;
        await sleep(200);
      }
      const code = await runPromise;
      // answered a CODE (0..255), not a throw: the contract run() must keep
      expect(code).toBeInteger();
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThanOrEqual(255);
      expect(violation).toBeNull();

      // The fixture is gone only when its private token endpoint stops answering.
      let gcGone = false;
      for (const deadline = Date.now() + 10000; Date.now() < deadline && !gcGone; ) {
        if (!(await gcAlive())) gcGone = true;
        else await sleep(200);
      }
      expect(gcGone).toBe(true);
      // Listener hygiene on the cancel path too: run() removed its pair.
      expect(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM")).toBe(listenerBaseline);
    } catch (error) {
      primaryFailure = error instanceof Error ? error : new Error(String(error));
    } finally {
      try {
        // Keep a failed assertion from leaving run() and its child tree alive.
        let fixturePid: number | undefined;
        try {
          const recordedPid = Number(readFileSync(pidFile, "utf8").trim());
          if (Number.isInteger(recordedPid) && recordedPid > 0) fixturePid = recordedPid;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            cleanupFailure = new Error(`could not read fixture ownership record: ${String(error)}`);
          }
        }
        if (!cancelSent && !runDone) {
          cancelSent = true;
          process.emit("SIGINT");
        }
        if (!runDone) {
          const outcome = await waitOrCleanup(runPromise, 5000, async () => {
            process.emit("SIGTERM");
          });
          if (!outcome.settled) {
            const finalWait = await waitForPromise(runPromise, 12_000);
            if (!finalWait.settled) cleanupFailure = new Error("cancelled run did not settle after forced fixture cleanup");
          }
        }
        if (fixturePid !== undefined) {
          const capturedPid = fixturePid;
          await cleanupCapturedFixture(runDone, {
            isAlive: async () => {
              let recordedPid: number;
              try {
                recordedPid = Number(readFileSync(pidFile, "utf8").trim());
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT" &&
                  !(await fixtureResponds(gcPort, fixtureToken)) && processState(capturedPid) === "absent") return false;
                throw error;
              }
              if (recordedPid !== capturedPid) throw new Error("fixture PID ownership changed during cleanup");
              if (await fixtureResponds(gcPort, fixtureToken)) return true;
              if (processState(capturedPid) === "absent") return false;
              throw new Error("fixture ownership probe failed; process state is unknown");
            },
            kill: () => {
              writeFileSync(shutdownFile, "stop");
              return "signalled";
            },
            waitForExit: (timeoutMs) => waitForFixtureGone(gcPort, fixtureToken, timeoutMs),
          });
        } else {
          // The unique signal path is safe even if startup raced PID publication.
          writeFileSync(shutdownFile, "stop");
          if (!(await waitForFixtureGone(gcPort, fixtureToken, 2000))) {
            cleanupFailure = new Error("fixture did not acknowledge cooperative shutdown within 2000ms");
          }
        }
      } catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error(String(error));
      } finally {
        if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
        else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
        // The shutdown file is a cooperative signal; remove both records after
        // the fixture acknowledged exit or reported a cleanup failure.
        rmSync(pidFile, { force: true });
        rmSync(shutdownFile, { force: true });
        rmSync(gcScript, { force: true });
        if (wrapper) rmSync(wrapper, { force: true });
        resetBase();
      }
    }
    throwTestFailures(primaryFailure, cleanupFailure);
  }, 30000);

  test("a launch that never starts returns a code, not a throw, and frees its slot (G1)", async () => {
    if (process.platform !== "win32") return; // POSIX resolves shell:true to the absolute /bin/sh, which a test cannot make unspawnable; the Windows branch carries the pin
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    process.env.HEAVY_SLOT_STATE_DIR = dir;
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    const prevComSpec = process.env.ComSpec;
    process.env.ComSpec = "definitely-not-a-shell-6b3f7c.exe"; // spawn cannot start the shell: 'error' fires, 'close' never
    try {
      // Pre-run(): the old shape threw here, unhandled - the crash the fix names.
      const code = await run("launch-failure", "echo hi");
      expect(code).toBe(1);
      // Listener removal ran on this path too - a library caller can keep calling.
      expect(process.listenerCount("SIGINT")).toBe(sigint);
      expect(process.listenerCount("SIGTERM")).toBe(sigterm);
      // The slot is free afterwards: a failed launch releases in finally.
      const t = await tryTake(1, "after-launch-failure");
      expect(t.ok).toBe(true);
      if (t.ok) release(t.slot);
    } finally {
      if (prevComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = prevComSpec;
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
      resetBase();
    }
  }, 20000);

  test("EMFILE is a machine refusal: a retry, a named code, never a holder nor a refusal (G2)", async () => {
    resetBase();
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    const prevWait = process.env.HEAVY_SLOT_WAIT_MS;
    process.env.HEAVY_SLOT_STATE_DIR = dir;
    process.env.HEAVY_SLOT_WAIT_MS = "400";
    const errors: string[] = [];
    const logs: string[] = [];
    const err = console.error;
    const log = console.log;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    // The bind seam says EMFILE - the machine could not serve the bind. Nothing
    // holds the port; nothing reserves the range; the answer may be neither.
    setBinderForTest(async () => ({ error: "retryable", code: "EMFILE" }));
    try {
      resetBase();
      const r = await acquireSlot("emfile-caller");
      expect(r.status).toBe("full"); // NOT "refused": the range is not broken
      await status();
      const out = [...errors, ...logs].join("\n");
      // The code reached the diagnostic - [T7] carried into the progress line...
      expect(out).toContain("EMFILE");
      // ...and the port never reads as a held job: the holder line's shape is
      // "slot N: '<label>' ... running <age>" and is absent, because a machine
      // refusal has no holder to name.
      expect(out).not.toContain("running");
      expect(out).not.toMatch(/slot \d+: '/);
      // ...and never as the refusal the reserved range gets.
      expect(out).not.toContain("netsh int ipv4 show excludedportrange");
    } finally {
      console.error = err;
      console.log = log;
      setBinderForTest(null);
      if (prevWait === undefined) delete process.env.HEAVY_SLOT_WAIT_MS;
      else process.env.HEAVY_SLOT_WAIT_MS = prevWait;
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
      resetBase();
    }
  }, 15000);

  test("a base whose range leaves the port space is named as the configuration it is (G3)", async () => {
    const dir = freshDir();
    const prevDir = process.env.HEAVY_SLOT_STATE_DIR;
    const prevMax = process.env.HEAVY_SLOT_MAX;
    const prevBase = process.env.HEAVY_SLOT_BASE;
    process.env.HEAVY_SLOT_STATE_DIR = dir;
    process.env.HEAVY_SLOT_MAX = "4";
    process.env.HEAVY_SLOT_BASE = "65535"; // itself a valid port; its RANGE is not
    resetBase();
    let bindCalls = 0;
    setBinderForTest(() => {
      bindCalls++;
      return Promise.resolve({ error: "unusable", code: "EACCES" });
    });
    const err = console.error;
    const log = console.log;
    const errors: string[] = [];
    const logs: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      // recorded: the seam refuses to publish a range that cannot exist
      expect(claimBase(65535, dir)).toBe(false);
      expect(writeBase(65535, dir)).toBeNull();
      expect(existsSync(join(dir, "base"))).toBe(false);
      // read: a record an older install planted under a smaller max reads as
      // stale, not adoptable, and without one binding attempt
      writeFileSync(join(dir, "base"), "65535\n");
      expect(readPersistedBase(dir)).toBeNull();
      // used: acquireSlot refuses BEFORE any bind, naming base, max, limit
      const r = await acquireSlot("stillborn");
      expect(r).toEqual({ status: "refused", reason: "config" });
      expect(bindCalls).toBe(0);
      // status shows the same message - never the reserved-range banner
      await status();
      const out = [...errors, ...logs].join("\n");
      expect(out).toContain("HEAVY_SLOT_BASE=65535");
      expect(out).toContain("HEAVY_SLOT_MAX=4");
      expect(out).toContain("limit of 65535");
      expect(out).not.toContain("netsh int ipv4 show excludedportrange");
      // and run() answers the library caller with the CLI's code
      expect(await run("stillborn-cli", "echo hi")).toBe(EXIT_REFUSED);
      expect(bindCalls).toBe(0);
    } finally {
      console.error = err;
      console.log = log;
      setBinderForTest(null);
      if (prevMax === undefined) delete process.env.HEAVY_SLOT_MAX;
      else process.env.HEAVY_SLOT_MAX = prevMax;
      if (prevBase === undefined) delete process.env.HEAVY_SLOT_BASE;
      else process.env.HEAVY_SLOT_BASE = prevBase;
      if (prevDir === undefined) delete process.env.HEAVY_SLOT_STATE_DIR;
      else process.env.HEAVY_SLOT_STATE_DIR = prevDir;
      resetBase();
    }
  }, 15000);
});
