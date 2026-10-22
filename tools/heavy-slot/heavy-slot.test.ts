import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  status,
  treeAlive,
  tryTake,
  unusableBanner,
  writeBase,
} from "./heavy-slot";

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
afterAll(() => leaveScenario());

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
      expect(slot?.port).toBe(TEST_BASE + BASE_STRIDE);
      if (slot) release(slot);
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
      expect(r.status).toBe("acquired");
      const slot = r.status === "acquired" ? r.slot : null;
      expect(slot?.port).toBe(TEST_BASE + BASE_STRIDE);
      expect(readPersistedBase(dir)).toBe(TEST_BASE + BASE_STRIDE);
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
        'process.exit(await mod.run("racer", "echo hi"));',
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
