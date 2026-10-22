import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireSlot,
  BASE_STRIDE,
  capacityFor,
  chooseFreeBase,
  claimBase,
  closeServer,
  DEFAULT_BASE,
  killTree,
  maxSlots,
  readPersistedBase,
  realOpenServer,
  release,
  resetBase,
  setBinderForTest,
  status,
  treeAlive,
  tryTake,
  unusableBanner,
} from "./heavy-slot";

// Spawned children and the injected-script imports resolve the tool from this
// file's own location, never from the caller's cwd: `bun test heavy-slot.test.ts`
// must work from the repo root and from tools/heavy-slot/ alike.
const TOOL_SCRIPT = fileURLToPath(new URL("./heavy-slot.ts", import.meta.url));
const TOOL_IMPORT = new URL("./heavy-slot.ts", import.meta.url).href;

// The base is picked at runtime with the tool's own probe helper - no hardcoded
// port, no hardcoded C:/ path. The state lives under the system temp dir.
const ROOT = mkdtempSync(join(tmpdir(), "heavy-slot-test-"));
process.env.HEAVY_SLOT_MAX = "1";
process.env.HEAVY_SLOT_PER_JOB_GB = "0.1";
process.env.HEAVY_SLOT_RESERVE_GB = "0";
process.env.HEAVY_SLOT_WAIT_MS = "400";
process.env.HEAVY_SLOT_STATE_DIR = ROOT;

// F10: chooseFreeBase releases every port it probes, so two test runs started
// together can settle on the same "free" base and steal each other's range when
// the real binds begin - separate state dirs do not separate ports. Each run
// starts its walk at a per-run offset (own probed range), and the winner must
// still bind right now (canary); a contended candidate is skipped, not fought over.
const RUN_OFFSET = Math.floor(Math.random() * 8) * BASE_STRIDE;

/** Walk candidate windows downward from `start` until one yields a free base; chooseFreeBase only walks up, and a high run offset can push a start past the top of the port range. */
async function pickWindow(start: number): Promise<number> {
  for (let s = start; s > DEFAULT_BASE - BASE_STRIDE; s -= 4 * BASE_STRIDE) {
    const candidate = await chooseFreeBase(s, 3);
    if (candidate !== null) return candidate;
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
    await closeServer(canary.server);
    return candidate;
  }
  throw new Error("no free base found near the default; the probe window is too narrow");
}

const TEST_BASE = await pickTestBase();
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
      `const mod = await import(${JSON.stringify(TOOL_IMPORT)});`,
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
      // keeping every later process frozen on it.
      expect(r && "slot" in r ? r.slot.port : null).toBe(TEST_BASE + BASE_STRIDE);
      expect(readPersistedBase(dir)).toBe(TEST_BASE + BASE_STRIDE);
      if (r && "slot" in r) release(r.slot);
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

  test("two processes racing on an absent record agree on one base, and the file records that one once", async () => {
    resetBase();
    const dir = freshDir();
    // A stale record stands in the shared dir: its range refuses to bind inside
    // both children, so neither can follow it and both must go claim a working
    // candidate - the two children prefer DIFFERENT bases (two lanes, different
    // env, one machine). The three windows are far enough apart that each child's
    // first walk candidate is its own; what the test demands is agreement and a
    // replaced record, not a particular winner.
    const stale = await pickWindow(TEST_BASE + 5 * BASE_STRIDE);
    if (stale === null) throw new Error("no free base for the stale record");
    const a = await pickWindow(stale + 3 * BASE_STRIDE);
    if (a === null) throw new Error("no free base for racing child A");
    const b = await pickWindow(stale + 6 * BASE_STRIDE);
    if (b === null) throw new Error("no free base for racing child B");
    expect(claimBase(stale, dir)).toBe(true);
    // The stub must live inside each child: a bind seam set in this process cannot
    // cross it. Each child marks its own preferred first port and the stale base
    // unusable; everything else binds for real.
    const racerScript = (preferred: number) =>
      [
        `const mod = await import(${JSON.stringify(TOOL_IMPORT)});`,
        `mod.setBinderForTest(async (port) => port === ${preferred} || port === ${stale}`,
        "  ? { error: 'unusable', code: 'EACCES' }",
        "  : await mod.realOpenServer(port));",
        'await mod.run("racer", "echo hi");',
      ].join("\n");
    // Both children start at the same moment on the same state dir. The raised
    // wait budget keeps a child patient while the other briefly holds the agreed
    // port, so the assertions prove agreement, not a lost race to the exit.
    const [ra, rb] = await Promise.all([
      childOutput(
        spawn("bun", ["-e", racerScript(a)], {
          cwd: process.cwd(),
          env: childEnv(dir, { HEAVY_SLOT_BASE: String(a), HEAVY_SLOT_WAIT_MS: "15000" }),
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
      childOutput(
        spawn("bun", ["-e", racerScript(b)], {
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
        `const m=await import(${JSON.stringify(TOOL_IMPORT)}); const s=await m.tryTake(1,'holder'); console.log('bound', s.ok); await new Promise(r=>setTimeout(r,60000));`,
      ],
      { cwd: process.cwd(), env: childEnv(freshDir()), stdio: "ignore" },
    );
    await sleep(1500);
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
});
