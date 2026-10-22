#!/usr/bin/env bun
/**
 * Heavy-work queue: measured admission control for CPU-heavy commands.
 *
 * Same queue, two front doors: a tool call inside a pi session (`heavy_run`) and this CLI
 * for a plain shell, another harness, or a human. Both use the same loopback port range, and a
 * bound port is a slot - so there is one queue, not two that each admit work and double the load.
 *
 *   bun tools/heavy-slot/heavy-slot.ts status
 *   bun tools/heavy-slot/heavy-slot.ts run "<label>" "<one command string>"
 *
 * Cross-platform: bun's (node's) net, os and child_process. No dependencies, no daemon, no lock
 * file - the port is the lock.
 *
 * Exits with the child's exit code; 75 if it gave up waiting without running anything; 76 when
 * the port range cannot serve work (every candidate reserved, or part of the range refuses to
 * bind even after a re-decide) - refused loudly, never reported as
 * "the queue is full", because waiting will never help. `run` returns that code and the CLI
 * dispatch applies it, so the queue is callable from a library too.
 */

import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir, freemem, totalmem, cpus } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The interface, and everything else. A caller gets the queue (`acquireSlot`,
// `run`), the status readout (`status`, `unusableBanner`), the admission policy and
// its constants (`capacityFor`, `maxSlots`, `BASE_SHIFT_ATTEMPTS`,
// `BASE_PROBE_WINDOW`, `DEFAULT_BASE`, `BASE_STRIDE`), the slot primitives a test
// needs to hold a port from outside (`tryTake`, `release`) and the cancellation pair
// (`killTree`, `treeAlive`), the bind seam tests inject through (`setBinderForTest`,
// `realOpenServer` and its two types), and the base helpers a test uses to point the
// queue at a scenario (`claimBase`, `readPersistedBase`, `chooseFreeBase`,
// `resetBase`). Config getters, measurement, base resolution and the holders scan are
// private on purpose: they are how this module works, not what it is for, and an
// export is a promise to keep them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config. Every value is read lazily from the environment, so a caller (and a
// test) can point env at a scenario even after importing the module.
// ---------------------------------------------------------------------------

export const DEFAULT_BASE = 45700;
export const BASE_STRIDE = 1000; // shift step when the preferred base's range is reserved

/**
 * Two counts, two names, because one name for both was an off-by-one waiting to be
 * written down: this is the number of SHIFTS the walk takes after the preferred
 * base, so a walk visits `BASE_PROBE_WINDOW` bases - the preferred one at shift 0
 * plus shifts 1..8 - and a reader never has to guess whether the preferred base is
 * inside the bound.
 */
export const BASE_SHIFT_ATTEMPTS = 8;
/** Candidates a walk from any `preferred` can visit, preferred base included. */
export const BASE_PROBE_WINDOW = BASE_SHIFT_ATTEMPTS + 1;

function preferredBase(): number {
  return Number(process.env.HEAVY_SLOT_BASE ?? DEFAULT_BASE);
}
export function maxSlots(): number {
  return Math.max(1, Number(process.env.HEAVY_SLOT_MAX ?? 5));
}
function perJobGb(): number {
  return Number(process.env.HEAVY_SLOT_PER_JOB_GB ?? 2.5);
}
function reserveGb(): number {
  return Number(process.env.HEAVY_SLOT_RESERVE_GB ?? 4);
}
function waitMs(): number {
  return Number(process.env.HEAVY_SLOT_WAIT_MS ?? 30 * 60 * 1000);
}
function stateDir(): string {
  return process.env.HEAVY_SLOT_STATE_DIR ?? join(homedir(), ".pi", "heavy-slots");
}

// The base this process has agreed on: the recorded one, the preferred one, or a
// shifted one - see resolveBase. Until a decision, ports come from the preferred
// base. The read here is only this module's starting value: resetBase() re-reads
// the environment, which is what lets a test set env after import.
let activeBase = preferredBase();
let agreedBase: number | null = null;

function portFor(index: number): number {
  return activeBase + index - 1;
}
/** Re-read the environment and forget this process's base decision. Mainly for tests. */
export function resetBase(): void {
  activeBase = preferredBase();
  agreedBase = null;
}

function gb(n: number): number {
  return Math.round((n / 1e9) * 10) / 10;
}

async function cpuLoadPercent(): Promise<number> {
  const snap = () => cpus().map((c) => c.times);
  const a = snap();
  await new Promise((r) => setTimeout(r, 250));
  const b = snap();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const da = a[i];
    const db = b[i];
    if (!da || !db) continue;
    const di = db.idle - da.idle;
    const dt = db.user - da.user + (db.sys - da.sys) + di + (db.nice - da.nice);
    idle += di;
    total += dt;
  }
  return total > 0 ? Math.round(100 - (idle / total) * 100) : 0;
}

export function capacityFor(freeGb: number, cpuLoad: number, urgent: boolean): number {
  const byRam = Math.floor((freeGb - reserveGb()) / perJobGb());
  // The floor of 1 is policy, not the measurement ("never starve the caller"):
  // a measured capacity of 0 still admits one job instead of refusing forever.
  let capacity = Math.max(1, Math.min(maxSlots(), byRam < 1 ? 1 : byRam));
  if (cpuLoad > 85) capacity = Math.max(1, capacity - 2);
  else if (cpuLoad > 70) capacity = Math.max(1, capacity - 1);
  else if (cpuLoad < 35 && freeGb > reserveGb()) capacity = Math.min(maxSlots(), capacity + 1);
  // urgent takes the ceiling, but the RAM measurement still gates it: MAX_SLOTS
  // heavy jobs must actually fit above the reserve, or urgent waits like everyone.
  if (urgent && freeGb >= reserveGb() + maxSlots() * perJobGb() && cpuLoad < 80) capacity = maxSlots();
  return capacity;
}

// ---------------------------------------------------------------------------
// Binding a port. Only EADDRINUSE means "the slot is held by someone, so wait".
// EACCES, EADDRNOTAVAIL and EPERM mean "this port is not ours to use at all" -
// on Windows, TCP port ranges the OS has reserved (they move across reboots and
// Hyper-V changes). Waiting never fixes those, so they are the "unusable" family.
// Every other error (EMFILE, a transient refusal, resource exhaustion) is
// retryable: it reads as busy and keeps its code in every message so it is not
// silently misread as "this whole range is reserved".
// ---------------------------------------------------------------------------

export type OpenResult = { server: net.Server } | { error: "busy" | "unusable"; code: string };
export type OpenServer = (port: number) => Promise<OpenResult>;

const UNUSABLE_BIND_CODES: ReadonlySet<string> = new Set(["EACCES", "EADDRNOTAVAIL", "EPERM"]);

export function realOpenServer(port: number): Promise<OpenResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException | undefined) => {
      const code = err?.code ?? "UNKNOWN";
      resolve({ error: code !== "EADDRINUSE" && UNUSABLE_BIND_CODES.has(code) ? "unusable" : "busy", code });
      try {
        server.removeAllListeners();
        server.close();
      } catch {
        /* never started listening */
      }
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve({ server }));
  });
}

// Test seam: heavy-slot.test.ts injects bind failures here instead of editing
// the OS exclusion list. setBinderForTest(null) restores the real bind.
let openServerImpl: OpenServer = realOpenServer;
export function setBinderForTest(impl: OpenServer | null): void {
  openServerImpl = impl ?? realOpenServer;
}

type PortProbe = "free" | "busy" | "unusable";

async function probePort(port: number): Promise<PortProbe> {
  const opened = await openServerImpl(port);
  if ("error" in opened) return opened.error;
  await closeServer(opened.server);
  return "free";
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// The base: picking it, recording it, agreeing on it.
// ---------------------------------------------------------------------------

const BASE_FILE_NAME = "base";

function baseFilePath(dir: string = stateDir()): string {
  return join(dir, BASE_FILE_NAME);
}

export function readPersistedBase(dir: string = stateDir()): number | null {
  try {
    const n = Number(readFileSync(baseFilePath(dir), "utf8").trim());
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

/** Record a chosen base. First writer wins: when the file already exists the loser returns false and re-reads the winner instead of overwriting it. */
export function claimBase(base: number, dir: string = stateDir()): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(baseFilePath(dir), `${base}\n`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function portOf(base: number, index: number): number {
  return base + index - 1;
}

function activate(base: number): number {
  activeBase = base;
  agreedBase = base;
  return base;
}

/**
 * Try to record `base` as the shared base through the state dir, exactly like every
 * other candidate - the preferred base includes itself, so two processes with
 * different environments never each activate a private choice. Losing the
 * first-writer race never ends in a private choice either: follow the winner. A
 * winner whose range no longer binds is a stale record: replace it and retry the
 * claim once, so a working range can still be written; if that claim also loses,
 * follow the winner anyway and let the acquisition loop's re-decide speak (refusal
 * with exit 76) - two queues disagreeing is worse than one queue refusing loudly.
 */
async function claimOrFollow(base: number): Promise<number> {
  if (claimBase(base)) return base;
  let winner = readPersistedBase();
  if (winner !== null && (await probePort(winner)) === "unusable") {
    try {
      rmSync(baseFilePath(), { force: true });
    } catch {
      /* fall through with the record still visible */
    }
    if (readPersistedBase() === null && claimBase(base)) return base;
    winner = readPersistedBase();
  }
  // No record anywhere and one failed claim means this process is the only one
  // that picked a range at all - own it; otherwise the winner owns the decision.
  return winner ?? base;
}

/**
 * Decide the base for this process, once. Order of authority:
 * 1. a base a previous process recorded, while it still binds (every process agrees with it);
 * 2. the preferred base (HEAVY_SLOT_BASE or the default), while it binds - but it is
 *    claimed through the shared state dir like any candidate, never activated privately;
 * 3. the preferred base shifted by BASE_STRIDE at a time, bounded; the first process to find
 *    a working candidate records it, a concurrent one reads the winner.
 *
 * A recorded base that no longer binds (a reboot re-reserved its range) is removed
 * before the walk, so a working range can be claimed again instead of the stale
 * record freezing every later process into re-probing it forever.
 *
 * Returns null when every candidate is excluded - the caller must refuse loudly, never
 * report the queue as full.
 */
async function resolveBase(): Promise<number | null> {
  if (agreedBase !== null) return agreedBase;
  const preferred = preferredBase();
  const persisted = readPersistedBase();
  if (persisted !== null) {
    if ((await probePort(persisted)) !== "unusable") return activate(persisted);
    // Stale record: rm it before walking candidates, so a working range can be
    // claimed again - a persisted base that only ever reads as unusable would
    // otherwise keep every claim failing forever.
    try {
      rmSync(baseFilePath(), { force: true });
    } catch {
      /* another process is replacing it right now; the claims below decide */
    }
  }
  // The preferred base is candidate 0 of the walk (BASE_PROBE_WINDOW counts it);
  // the loop takes the shifts 1..BASE_SHIFT_ATTEMPTS, so the two counts meet
  // exactly and nothing is skipped or probed twice.
  if ((await probePort(portOf(preferred, 1))) !== "unusable") {
    return activate(await claimOrFollow(preferred));
  }
  for (let shift = 1; shift <= BASE_SHIFT_ATTEMPTS; shift++) {
    const candidate = preferred + shift * BASE_STRIDE;
    if (candidate >= 65536) continue;
    if ((await probePort(portOf(candidate, 1))) === "unusable") continue;
    return activate(await claimOrFollow(candidate));
  }
  return null;
}

/** Helper for callers that need an actually free port region (tests pick their base with this): probe candidate slot-1 ports until one binds cleanly. */
export async function chooseFreeBase(
  preferred: number = preferredBase(),
  attempts: number = BASE_PROBE_WINDOW,
): Promise<number | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = preferred + attempt * BASE_STRIDE;
    if (candidate >= 65536) break;
    if ((await probePort(candidate)) === "free") return candidate;
  }
  return null;
}

/** The largest base the walk can reach, named once so the banner and the walk cannot disagree. */
const LAST_PROBED_BASE_SPAN = BASE_SHIFT_ATTEMPTS * BASE_STRIDE;

export function unusableBanner(): string {
  return (
    `[heavy-slot] no usable port range on this machine: candidates ${preferredBase()}..` +
    `${preferredBase() + LAST_PROBED_BASE_SPAN} (stride ${BASE_STRIDE}, ${BASE_PROBE_WINDOW} probes) all fail to bind with EACCES. ` +
    `HEAVY_SLOT_BASE=${preferredBase()} points into a range this machine has reserved. ` +
    `List the excluded ranges with: netsh int ipv4 show excludedportrange protocol=tcp - then set HEAVY_SLOT_BASE outside every range. ` +
    `Refusing loudly: this is not "the queue is full", and waiting will never help (exit 76).`
  );
}

// ---------------------------------------------------------------------------
// Slots: a bound port is a slot.
// ---------------------------------------------------------------------------

export type Slot = { index: number; port: number; server: net.Server };

export type TakeResult =
  | { ok: true; slot: Slot }
  | { ok: false; reason: "busy" | "unusable"; port: number; code: string };

export async function tryTake(index: number, label: string): Promise<TakeResult> {
  const port = portFor(index);
  const opened = await openServerImpl(port);
  if ("error" in opened) return { ok: false, reason: opened.error, port, code: opened.code };
  const server = opened.server;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      join(stateDir(), `slot-${index}.json`),
      JSON.stringify({ slot: index, port, pid: process.pid, label, startedAt: new Date().toISOString() }),
    );
  } catch {
    /* metadata is a hint, the bound port is the truth */
  }
  return { ok: true, slot: { index, port, server } };
}

export function release(slot: Slot): void {
  try {
    rmSync(join(stateDir(), `slot-${slot.index}.json`), { force: true });
  } catch {
    /* ignore */
  }
  try {
    slot.server.close();
  } catch {
    /* ignore */
  }
}

type Holder = { slot: number; port: number; label: string; pid?: number; startedAt?: string; stale: boolean };

async function holders(): Promise<Holder[]> {
  return (await scanSlots()).list;
}

/** holders() plus the ports that fail to bind (EACCES) - status needs both so a broken range is never reported as an empty queue. */
async function scanSlots(): Promise<{ list: Holder[]; unusablePorts: number[] }> {
  const list: Holder[] = [];
  const unusablePorts: number[] = [];
  for (let i = 1; i <= maxSlots(); i++) {
    const port = portFor(i);
    const probe = await probePort(port);
    if (probe === "unusable") {
      unusablePorts.push(port);
      continue;
    }
    let label = "(unknown)";
    let pid: number | undefined;
    let startedAt: string | undefined;
    try {
      const raw = readFileSync(join(stateDir(), `slot-${i}.json`), "utf8");
      // SAFETY: shape matches what tryTake writes.
      const j = JSON.parse(raw) as { label?: string; pid?: number; startedAt?: string };
      label = j.label ?? label;
      pid = j.pid;
      startedAt = j.startedAt;
    } catch {
      /* no metadata */
    }
    if (probe === "busy") list.push({ slot: i, port, label, pid, startedAt, stale: false });
    else if (existsSync(join(stateDir(), `slot-${i}.json`)))
      list.push({ slot: i, port, label, pid, startedAt, stale: true });
  }
  return { list, unusablePorts };
}

async function printHolders(): Promise<void> {
  const { list, unusablePorts } = await scanSlots();
  if (unusablePorts.length > 0) {
    console.log(
      `[heavy-slot] warning: slot ports ${unusablePorts.join(", ")} do not bind with EACCES (reserved on this machine?): check "netsh int ipv4 show excludedportrange protocol=tcp"`,
    );
  }
  if (list.length === 0) {
    if (unusablePorts.length === 0) console.log("the queue is empty");
    return;
  }
  for (const h of list) {
    const age = h.startedAt ? `${Math.round((Date.now() - Date.parse(h.startedAt)) / 1000)}s` : "?";
    console.log(
      `slot ${h.slot}: '${h.label}' pid ${h.pid ?? "?"} running ${age}${h.stale ? "  [port free - stale metadata]" : ""}`,
    );
  }
}

export async function status(): Promise<void> {
  const freeGb = gb(freemem());
  const cpuLoad = await cpuLoadPercent();
  console.log(
    `free ${freeGb} GB of ${gb(totalmem())} GB, cpu ${cpuLoad}%  ->  capacity ${capacityFor(freeGb, cpuLoad, false)} of max ${maxSlots()}`,
  );
  const base = await resolveBase();
  if (base === null) {
    console.log(unusableBanner());
    return;
  }
  const preferred = preferredBase();
  const note = base === preferred ? "" : `  [shifted from ${preferred}; recorded in ${baseFilePath()}]`;
  console.log(`slots on base ${base}, ports ${portFor(1)}-${portFor(maxSlots())}${note}`);
  await printHolders();
}

// ---------------------------------------------------------------------------
// Acquiring and running.
// ---------------------------------------------------------------------------

/**
 * The queue's answer, as a value: `acquired` carries the slot, `full` means the
 * wait budget ran out while slots were genuinely held (waiting would still be the
 * right call, later), `refused` means the port range itself is broken - every
 * candidate excluded, or part of the current range refuses to bind and a re-decide
 * of the base lands back on it. A bare null used to stand for "full", which read as
 * "no slot at all" next to the object forms; every caller now names the outcome it
 * got. Exit codes are the CLI dispatch's business, not the queue's.
 */
export type AcquireResult =
  | { status: "acquired"; slot: Slot }
  | { status: "full" }
  | { status: "refused"; reason: "unusable" };

/** Wait for a slot until the queue admits one, the range is refused, or the wait budget runs out. */
export async function acquireSlot(label: string): Promise<AcquireResult> {
  const started = Date.now();
  const urgent = process.env.HEAVY_PRIORITY === "high";

  if ((await resolveBase()) === null) return { status: "refused", reason: "unusable" };
  let redecided = false;

  while (true) {
    const freeGb = freemem() / 1e9;
    const cpuLoad = await cpuLoadPercent();
    const capacity = capacityFor(freeGb, cpuLoad, urgent);
    const unusablePorts: number[] = [];
    let unusableCode: string | null = null;
    for (let i = 1; i <= capacity; i++) {
      const taken = await tryTake(i, label);
      if (taken.ok) return { status: "acquired", slot: taken.slot };
      if (taken.reason !== "busy") { // busy = a slot is held; not a reason to re-decide or refuse
        unusablePorts.push(taken.port);
        unusableCode ??= taken.code;
      }
    }
    if (unusableCode !== null) {
      // Some slot ports refuse to bind outright: part of the range is reserved or
      // broken. Name the ports and the code - a partly reserved range must be
      // visible, never silent. Note a held slot does not excuse this: waiting for
      // the usable slot is fine, hiding the failure is not.
      console.error(
        `[heavy-slot] slot ports ${unusablePorts.join(", ")} refuse to bind (${unusableCode}) - the range is partly reserved; re-deciding the base because waiting will not fix it`,
      );
      const before = agreedBase;
      if (redecided) return { status: "refused", reason: "unusable" };
      redecided = true;
      agreedBase = null;
      const next = await resolveBase();
      // The walk is deterministic, so landing on the same base means the range is
      // genuinely unusable for everyone: refuse 76 now instead of burning the
      // whole wait budget on a machine that is broken and reporting exit 75 -
      // "the queue is full" - afterwards.
      if (next === null || next === before) return { status: "refused", reason: "unusable" };
      continue;
    }
    if (Date.now() - started > waitMs()) return { status: "full" };
    const busy = (await holders()).map((h) => `${h.label}(${h.slot})`);
    console.error(
      `[heavy-slot] queued ${Math.round((Date.now() - started) / 1000)}s - free ${gb(freeGb * 1e9)} GB, cpu ${cpuLoad}%, capacity ${capacity}, busy [${busy.join(", ")}]`,
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------
// Ending a run. `shell: true` makes child.pid the wrapper shell, so "did the
// command stop" and "did the machine get freed" are different questions - a
// cancelled run must answer the second one before its slot is released.
// ---------------------------------------------------------------------------

const STOP_GRACE_MS = 10_000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * End the whole tree behind the wrapper shell, not only the shell. OS-specific
 * branch: Windows has no signalable process group, so `taskkill /T /F` walks the
 * descendants (a signal to the shell alone can leave the build or the full suite
 * running while the slot is already released - exactly the double load the queue
 * exists to prevent); on POSIX the child was spawned detached, so the negative pid
 * signals the group the shell and its children share. Exported for the cancellation
 * test - it pins the kill-then-confirm promise the SIGINT/SIGTERM hook makes.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, signal);
    } catch {
      /* the tree is already gone */
    }
  }
}

/**
 * True while any member of the child's tree can still be reached. The same final
 * crash counts on both platforms: POSIX probes the group with a 0-signal, which
 * throws when nobody is left; on Windows `taskkill` exits non-zero once the pid
 * and its tree no longer exist (so the same call doubles as a re-kill).
 */
export function treeAlive(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (process.platform === "win32") {
    return spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).status === 0;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exit codes this tool answers a CLI caller with, kept in one place because they
 * are a contract: 75 = the queue stayed full for the whole wait budget (nothing
 * ran), 76 = the port range is unusable (waiting cannot help), 2 = usage.
 */
const EXIT_FULL = 75;
const EXIT_REFUSED = 76;
const EXIT_USAGE = 2;

/**
 * Run `command` behind a slot, returning the exit code the caller should use: the
 * child's own code, or the queue's 75 (gave up waiting, nothing was run) / 76
 * (port range unusable). This function never exits - the CLI dispatch below is the
 * single place that maps a code to `process.exit`, so the queue stays callable as a
 * library function from a script or a test.
 */
export async function run(label: string, command: string): Promise<number> {
  const started = Date.now();
  const acquired = await acquireSlot(label);

  if (acquired.status === "full") {
    console.error(
      `[heavy-slot] gave up after ${Math.round((Date.now() - started) / 1000)}s waiting for a slot. Nothing was run.`,
    );
    return EXIT_FULL;
  }
  if (acquired.status === "refused") {
    console.error(unusableBanner());
    return EXIT_REFUSED;
  }
  const slot = acquired.slot;

  const waited = Math.round((Date.now() - started) / 1000);
  console.error(
    `[heavy-slot] ${waited >= 5 ? `got slot ${slot.index} after ${waited}s` : `got slot ${slot.index}`} (port ${slot.port}), running: ${command}`,
  );

  let child: ChildProcess | undefined;
  let cancelled = false;
  // Hoisted out of the promise so the handlers can be removed once the child is
  // gone: a library caller running several commands through run() would otherwise
  // accumulate one SIGINT/SIGTERM listener per call.
  const stop = (): void => {
    cancelled = true;
    if (child) killTree(child, "SIGTERM");
  };
  const code = await new Promise<number>((resolve) => {
    // detached on POSIX: the command leads its own process group, so the kill below
    // reaches every descendant and not only the wrapper shell that `shell: true`
    // makes child.pid point at. Windows has no signalable group - taskkill walks
    // the tree instead.
    child = spawn(command, {
      shell: true,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (child) child.on("close", (c) => resolve(c ?? 1));
  });
  // SAFETY: process is an EventEmitter at runtime; bun's NodeJS.Process augmentation
  // declares off() only for its own "memoryPressure" event, which is what narrows the
  // call away from the EventEmitter signature. The cast names the interface in use.
  const emitter = process as NodeJS.EventEmitter;
  emitter.off("SIGINT", stop);
  emitter.off("SIGTERM", stop);

  if (cancelled && child) {
    // The close event fires as soon as the wrapper shell dies, and the rest of the
    // tree can outlive it - on Windows a tree can survive a SIGTERM to the shell
    // outright. The slot is released only once the tree is really gone: re-kill
    // and re-probe on a bounded budget, so a wedged machine cannot hold a slot
    // hostage forever. A descendant that made its own process group is out of
    // reach of both the signal and the probe; the same bound releases the slot
    // when that happens too.
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && treeAlive(child)) {
      killTree(child, "SIGKILL");
      await wait(100);
    }
  }

  release(slot);
  console.error(`[heavy-slot] slot ${slot.index} released, exit ${code}`);
  return code;
}

// ---------------------------------------------------------------------------
// CLI dispatch. The only layer that turns an outcome into an exit code.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "status" || (!cmd && process.stdin.isTTY)) {
    await status();
    process.exit(0);
  }
  if (cmd === "run") {
    if (rest.length < 2) {
      console.error('usage: bun tools/heavy-slot/heavy-slot.ts run "<label>" "<command>"');
      process.exit(EXIT_USAGE);
    }
    const label = rest[0];
    if (!label) {
      console.error('usage: bun tools/heavy-slot/heavy-slot.ts status | run "<label>" "<command>"');
      process.exit(EXIT_USAGE);
    }
    process.exit(await run(label, rest.slice(1).join(" ")));
  }
  console.error('usage: bun tools/heavy-slot/heavy-slot.ts status | run "<label>" "<command>"');
  process.exit(EXIT_USAGE);
}
