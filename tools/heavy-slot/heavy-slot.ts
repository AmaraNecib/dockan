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
 * bind even after a re-decide, or the configured base's range leaves the TCP port space [G3])
 * - refused loudly, never reported as
 * "the queue is full", because waiting will never help. `run` returns that code and the CLI
 * dispatch applies it, so the queue is callable from a library too.
 */

import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir, freemem, totalmem, cpus } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The interface, and everything else. A caller gets the queue (`acquireSlot`,
// `run`), the status readout (`status`, `unusableBanner`), the admission policy and
// its constants (`capacityFor`, `maxSlots`, `BASE_SHIFT_ATTEMPTS`,
// `BASE_PROBE_WINDOW`, `DEFAULT_BASE`, `BASE_STRIDE`), the slot primitives a test
// needs to hold a port from outside (`tryTake`, `release`) and the cancellation pair
// (`killTree`, `treeAlive`), the bind seam tests inject through (`setBinderForTest`,
// `realOpenServer` and its two types), the base helpers a test uses to point the
// queue at a scenario (`claimBase`, `writeBase`, `readPersistedBase`,
// `chooseFreeBase`, `resetBase`), and the exit-code contract (`EXIT_FULL`,
// `EXIT_REFUSED`, `EXIT_USAGE`). Config getters, measurement, base resolution and the holders scan are
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

/**
 * [G3] A base is usable only when its WHOLE slot range lives inside the TCP port
 * space (1..65535): `base + maxSlots() - 1 <= 65535`. `HEAVY_SLOT_BASE=65535`
 * used to pass the single-port check on every read and then send the queue's
 * probes at ports 65536+ - a configuration error surfacing as bind failures.
 * Checked at the seam of every base source: read (readPersistedBase), walked
 * (resolveBase, chooseFreeBase), recorded (claimBase, writeBase) and used
 * (acquireSlot, status) - so the refusal names the base, the max and the limit
 * before a single port is touched, and waiting is never presented as the cure.
 * Returns null when the range fits, the message a caller must print as its own
 * refusal when not.
 */
function baseRangeFault(base: number = preferredBase(), slots: number = maxSlots()): string | null {
  if (!Number.isInteger(base) || base < 1 || base > 65535) {
    return `HEAVY_SLOT_BASE=${base} is not a TCP port number (ports run 1..65535) - the queue cannot use it at all, and waiting will never fix it`;
  }
  if (base + slots - 1 > 65535) {
    return (
      `HEAVY_SLOT_BASE=${base} with HEAVY_SLOT_MAX=${slots} runs to port ${base + slots - 1}, past the TCP limit of 65535 - ` +
      `lower HEAVY_SLOT_BASE or HEAVY_SLOT_MAX so the whole slot range fits; waiting will never fix a range that cannot exist`
    );
  }
  return null;
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
// Every other error (EMFILE and friends) is a machine-side refusal of its own:
// no queue holds the port and the port is not reserved - the machine could not
// serve the bind at all. Folding those into "busy" made status() report a
// caller out of file descriptors as a queue of running jobs [G2], so the three
// stay separate at every seam and the code travels with the answer.
// ---------------------------------------------------------------------------

export type OpenResult =
  | { server: net.Server }
  | { error: "busy" | "unusable" | "retryable"; code: string };
export type OpenServer = (port: number) => Promise<OpenResult>;

const UNUSABLE_BIND_CODES: ReadonlySet<string> = new Set(["EACCES", "EADDRNOTAVAIL", "EPERM"]);

export function realOpenServer(port: number): Promise<OpenResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException | undefined) => {
      const code = err?.code ?? "UNKNOWN";
      const error = code === "EADDRINUSE" ? "busy" : UNUSABLE_BIND_CODES.has(code) ? "unusable" : "retryable";
      resolve({ error, code });
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

type PortProbe = "free" | "busy" | "unusable" | "retryable";
type ProbedPort = { status: PortProbe; code: string | null };

async function probePort(port: number): Promise<ProbedPort> {
  const opened = await openServerImpl(port);
  if ("error" in opened) return { status: opened.error, code: opened.code };
  await closeServer(opened.server);
  return { status: "free", code: null };
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// The record: a shared file, the single truth about the base.
// ---------------------------------------------------------------------------

const BASE_FILE_NAME = "base";

function baseFilePath(dir: string = stateDir()): string {
  return join(dir, BASE_FILE_NAME);
}

export function readPersistedBase(dir: string = stateDir()): number | null {
  try {
    const n = Number(readFileSync(baseFilePath(dir), "utf8").trim());
    // [G3] a record only reads as a base when its RANGE fits the current max:
    // a record written under a smaller HEAVY_SLOT_MAX may point past the limit
    // after the max is raised, and a null here (not a probed bind failure) is
    // how that claim walks aside.
    return Number.isInteger(n) && n > 0 && n < 65536 && baseRangeFault(n) === null ? n : null;
  } catch {
    return null;
  }
}

/** First-writer-wins claim, used only where the record must not be overwritten: an absent-record race. When it succeeds this process created the file; when it fails another process wrote between this one's read and claim. [G3] refuses to record a base whose range leaves the port space. */
export function claimBase(base: number, dir: string = stateDir()): boolean {
  if (baseRangeFault(base) !== null) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(baseFilePath(dir), `${base}\n`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The atomic record write, and the rule it carries: [F18] a replace of a stale
 * record goes temp-file-in-the-same-directory first, then `renameSync` over the
 * record. Node's rename replaces the destination everywhere (Windows:
 * MoveFileEx with MOVEFILE_REPLACE_EXISTING), so a concurrent reader sees
 * either the old record or the new one - never an absent or torn file - and an
 * unconditional `rmSync` at the read-then-delete site is GONE: a process that
 * probes a record as stale may have read a value another process already
 * replaced with a working claim, and deleting the file could take that claim
 * with it. Only a record still holding the exact value this process probed
 * (checked right before the write) is replaced.
 *
 * Returns the record's content AFTER the write, re-read from the file: the
 * caller activates that value, not the one this process chose, so a process
 * that wrote and re-read converges with one that wrote a moment later
 * ("last atomic write wins, everybody re-reads"). An absent/torn record reads
 * back null and the caller decides - see claimOrFollow.
 * Exported for tests: staging a record or a loser's claim at the write seam.
 */
export function writeBase(base: number, dir: string = stateDir()): number | null {
  // [G3] The record is the shared truth; a range that cannot exist must not be
  // published into it. The current content is the answer, exactly as a failed
  // write would answer.
  if (baseRangeFault(base) !== null) return readPersistedBase(dir);
  let tmp = "";
  try {
    mkdirSync(dir, { recursive: true });
    tmp = join(dir, `.base-${process.pid}-write.tmp`);
    writeFileSync(tmp, `${base}\n`);
    renameSync(tmp, baseFilePath(dir));
    return readPersistedBase(dir);
  } catch {
    try {
      if (tmp) rmSync(tmp, { force: true });
    } catch {
      /* the temp file is inert */
    }
    return readPersistedBase(dir);
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
 * Establish `base` as the shared base - or follow the record that beat this
 * process to the decision. The record is the truth, and it is read fresh every
 * time before anything is written to it:
 *
 * - a record whose CURRENT content binds (free or busy - a held port is a
 *   working queue) is followed, never overwritten: it was left by a process
 *   that picked its range after this one read the stale value, and replacing it
 *   would kill that claim - [F18] two queues are exactly that;
 * - a record that still holds the value this process just probed as unusable is
 *   replaced atomically (writeBase), and the re-read decides;
 * - no record: this process may claim the file with "wx" where the record must
 *   not be overwritten - creating it is not overwriting; a FAILED claim means
 *   the file appeared under the read and the claim, and the winner's content is
 *   re-read and followed;
 * - a write that cannot land at all (the state dir unwritable is the usual
 *   way) is retried once inside the loop, then disclosed ONCE per failed
 *   decision with one console.error naming the split-queue risk, every run,
 *   instead of splitting silently: [F19] - the old `winner ?? base` fallback
 *   activated a private base with no record and no warning.
 *
 * The loop is bounded at two attempts - no probe storm - and every return after
 * a write is the record's own re-read, not this process's choice.
 */
async function claimOrFollow(base: number): Promise<number> {
  const dir = stateDir();
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = readPersistedBase(dir);
    if (current !== null) {
      if ((await probePort(current)).status !== "unusable") return current; // follow the live winner
      // Current content is exactly the record this process probed as stale:
      // replace the FILE, not the record that may have appeared under the walk.
      const afterWrite = writeBase(base, dir);
      if (afterWrite !== null) return afterWrite;
      continue; // the write could not land; one retry, then disclose
    }
    if (claimBase(base, dir)) {
      // Created it. The re-read is still authority: a concurrent writer's
      // rename can land between the wx-claim and this read.
      const mine = readPersistedBase(dir);
      if (mine !== null) return mine;
    } else if (readPersistedBase(dir) === null) {
      // The "wx" claim lost AND the file still does not read: the record
      // exists but is torn or empty, nobody can claim it and nobody can adopt
      // it. This is the one overwrite whose target was never a readable
      // decision - replace it with a probed candidate by atomic rename.
      const afterRename = writeBase(base, dir);
      if (afterRename !== null) return afterRename;
    }
    // Otherwise the wx race was lost to a REAL claim: go around, read and
    // probe whatever the file holds now - its winner's content decides.
  }
  console.error(
    `[heavy-slot] no shared record could be adopted in ${dir} - every record write failed; ` +
      `this process runs a PRIVATE base and the queue may split (a portable state dir makes this repeat on every run)`,
  );
  return base;
}

/**
 * Decide the base for the process, once. Order of authority:
 * 1. the record, while its port binds (free or busy - every process agrees with it);
 * 2. the preferred base (HEAVY_SLOT_BASE or the default), while it binds, claimed
 *    through the record like any candidate - never activated privately;
 * 3. the preferred base shifted by BASE_STRIDE at a time, bounded; the first
 *    process to find a working candidate writes the record, concurrent ones
 *    follow it (claimOrFollow re-reads before replacing anything).
 *
 * A stale record is NOT deleted here: deleting a file this process may not own
 * any more (another process replaced it under the walk) is how two queues are
 * made, and the record is the truth until a working candidate replaces it
 * atomically in claimOrFollow. A refusal with the range proven unusable clears
 * the record in acquireSlot instead - [F20].
 *
 * [F20, comment only] Each candidate probes ONLY its slot-1 port. Probing
 * every slot of every candidate costs `BASE_PROBE_WINDOW * maxSlots` binds per
 * decision and can hold ports a claimer is then denied, for a case (slot-1
 * binds, deeper slots reserved) that surfaces at acquire time anyway - and when
 * it does, the refusal path clears the record so the walk is not frozen by it.
 * The cheap probe plus the honest clear is worth more than a wide probe.
 *
 * Returns null when every candidate is unusable - the caller must refuse
 * loudly, never report the queue as full.
 */
async function resolveBase(): Promise<number | null> {
  if (agreedBase !== null) return agreedBase;
  const preferred = preferredBase();
  const preferredFault = baseRangeFault(preferred);
  if (preferredFault !== null) return null; // acquireSlot and status named this as the configuration it is
  const persisted = readPersistedBase();
  if (persisted !== null && (await probePort(persisted)).status !== "unusable") return activate(persisted);
  // The preferred base is candidate 0 of the walk (BASE_PROBE_WINDOW counts it);
  // the loop takes the shifts 1..BASE_SHIFT_ATTEMPTS, so the two counts meet
  // exactly and nothing is skipped or probed twice.
  if ((await probePort(portOf(preferred, 1))).status !== "unusable") {
    return activate(await claimOrFollow(preferred));
  }
  for (let shift = 1; shift <= BASE_SHIFT_ATTEMPTS; shift++) {
    const candidate = preferred + shift * BASE_STRIDE;
    // [G3] A candidate is walkable only when its whole range fits - a base near
    // the top of the port space is skipped here exactly where a mid-range shift
    // would have sent a slot bind past 65535.
    if (candidate >= 65536 || baseRangeFault(candidate) !== null) continue;
    if ((await probePort(portOf(candidate, 1))).status === "unusable") continue;
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
    // [G3] Same rule as the walk: stop at the first candidate whose range
    // cannot exist, not at a bind failure it would cause.
    if (candidate >= 65536 || baseRangeFault(candidate) !== null) break;
    if ((await probePort(candidate)).status === "free") return candidate;
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
  | { ok: false; reason: "busy" | "unusable" | "retryable"; port: number; code: string };

// [F22] Slot metadata is keyed by the PORT, never by the slot index: two bases
// can each hold "slot 1" at the same time (a re-decided base and the old one's
// holder), and an index key would make the second writer overwrite the first
// holder's file - release() of one would then delete the other holder's
// metadata and the status scan would misreport a live holder as stale.
function slotMetaPath(port: number, dir: string = stateDir()): string {
  return join(dir, `slot-${port}.json`);
}

export async function tryTake(index: number, label: string): Promise<TakeResult> {
  const port = portFor(index);
  const opened = await openServerImpl(port);
  if ("error" in opened) return { ok: false, reason: opened.error, port, code: opened.code };
  const server = opened.server;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      slotMetaPath(port),
      JSON.stringify({ slot: index, port, pid: process.pid, label, startedAt: new Date().toISOString() }),
    );
  } catch {
    /* metadata is a hint, the bound port is the truth */
  }
  return { ok: true, slot: { index, port, server } };
}

export function release(slot: Slot): void {
  try {
    rmSync(slotMetaPath(slot.port), { force: true });
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

/** holders() plus the ports that fail to bind outright (EACCES) or at all (EMFILE and friends) - status needs all three so a broken range is never reported as an empty queue and a machine-side refusal is never reported as a running job [G2]. */
async function scanSlots(): Promise<{
  list: Holder[];
  unusablePorts: number[];
  retryablePorts: number[];
  retryableCode: string | null;
}> {
  const list: Holder[] = [];
  const unusablePorts: number[] = [];
  const retryablePorts: number[] = [];
  const retryablePortsByCode = new Map<string, number[]>();
  for (let i = 1; i <= maxSlots(); i++) {
    const port = portFor(i);
    const { status: probe, code } = await probePort(port);
    if (probe === "unusable") {
      unusablePorts.push(port);
      continue;
    }
    if (probe === "retryable") {
      const same = retryablePortsByCode.get(code ?? "UNKNOWN") ?? [];
      same.push(port);
      retryablePortsByCode.set(code ?? "UNKNOWN", same);
      continue;
    }
    let label = "(unknown)";
    let pid: number | undefined;
    let startedAt: string | undefined;
    try {
      const raw = readFileSync(slotMetaPath(port), "utf8");
      // SAFETY: shape matches what tryTake writes.
      const j = JSON.parse(raw) as { label?: string; pid?: number; startedAt?: string };
      label = j.label ?? label;
      pid = j.pid;
      startedAt = j.startedAt;
    } catch {
      /* no metadata */
    }
    if (probe === "busy") list.push({ slot: i, port, label, pid, startedAt, stale: false });
    else if (existsSync(slotMetaPath(port))) list.push({ slot: i, port, label, pid, startedAt, stale: true });
  }
  const codes = [...retryablePortsByCode.keys()];
  const retryableCode = codes.length === 1 ? codes[0] ?? null : null;
  return { list, unusablePorts, retryablePorts, retryableCode };
}

async function printHolders(): Promise<void> {
  const { list, unusablePorts, retryablePorts, retryableCode } = await scanSlots();
  if (unusablePorts.length > 0) {
    console.log(
      `[heavy-slot] warning: slot ports ${unusablePorts.join(", ")} do not bind with EACCES (reserved on this machine?): check "netsh int ipv4 show excludedportrange protocol=tcp"`,
    );
  }
  if (retryablePorts.length > 0) {
    // [G2] A machine-side bind refusal is not a held slot: named apart from the
    // holder lines, which is why this does not read "running".
    console.log(
      `[heavy-slot] warning: slot ports ${retryablePorts.join(", ")} failed to bind` +
        `${retryableCode === null ? "" : ` (${retryableCode})`} - a machine-side refusal, neither free nor held on this pass; check the machine's open-file and socket limits`,
    );
  }
  if (list.length === 0) {
    if (unusablePorts.length === 0 && retryablePorts.length === 0) console.log("the queue is empty");
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
  // [G3] Name the configuration fault before any bind: the banner below is
  // about_RESERVED ranges, and a base past the port space is not one.
  const configFault = baseRangeFault();
  if (configFault !== null) {
    console.log(`[heavy-slot] ${configFault} - refusing loudly, never "the queue is full" (exit 76)`);
    return;
  }
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
  | { status: "refused"; reason: "unusable" | "config" };

/** Wait for a slot until the queue admits one, the range is refused, or the wait budget runs out. */
/**
 * [F1/F2/#365] Confirm the record still names the base this process resolved,
 * immediately before the first bind.
 *
 * The protocol's remaining window is a process that resolved base A while another
 * process replaced the record with B; the first process then binds A's ports while
 * the record says B, and the two queues coexist. `writeBase` already returns what
 * the file holds AFTER a write, so a writer converges; the gap is between the
 * resolution and the first bind.
 *
 * This closes it without a lock: one re-read before any port is taken, and the
 * record's answer wins. If the two disagree and the record's range is unusable
 * here, that is a machine that cannot satisfy both observations - refuse loudly
 * rather than run a private queue (EACCES is machine-global, so a record this
 * process cannot use is a broken record, not a different opinion).
 */
async function confirmBase(): Promise<number | null> {
  const recorded = readPersistedBase();
  if (recorded === null) return agreedBase;
  if ((await probePort(recorded)).status === "unusable") return agreedBase;
  if (agreedBase !== null && recorded !== agreedBase) {
    console.error(`[heavy-slot] the shared record moved to ${recorded} while this process resolved ${agreedBase} - adopting the record`);
    activate(recorded);
  }
  return recorded;
}

export async function acquireSlot(label: string): Promise<AcquireResult> {
  const started = Date.now();
  const urgent = process.env.HEAVY_PRIORITY === "high";

  // [G3] The base's range is validated against the port space BEFORE anything
  // binds: a base past the top (HEAVY_SLOT_BASE=65535 with HEAVY_SLOT_MAX=4
  // wants ports 65536+) would otherwise surface as EADDRNOTAVAIL bind failures
  // - a configuration error dressed as a machine problem.
  const configFault = baseRangeFault();
  if (configFault !== null) {
    console.error(`[heavy-slot] ${configFault} - refusing loudly, never "the queue is full" (exit 76)`);
    return { status: "refused", reason: "config" };
  }
  if ((await resolveBase()) === null) return { status: "refused", reason: "unusable" };
  if ((await confirmBase()) === null) return { status: "refused", reason: "unusable" };
  let redecided = false;

  while (true) {
    const freeGb = freemem() / 1e9;
    const cpuLoad = await cpuLoadPercent();
    const capacity = capacityFor(freeGb, cpuLoad, urgent);
    const unusablePorts: number[] = [];
    let unusableCode: string | null = null;
    const retryablePorts: number[] = [];
    let retryableCode: string | null = null;
    for (let i = 1; i <= capacity; i++) {
      const taken = await tryTake(i, label);
      if (taken.ok) return { status: "acquired", slot: taken.slot };
      if (taken.reason === "busy") continue; // busy = a slot is held; not a reason to re-decide or refuse
      if (taken.reason === "retryable") {
        // [G2] A machine-side bind refusal (EMFILE and friends): the port has no
        // holder, so it must not read as one - and it is not reserved either, so
        // waiting still can help. The code travels to the progress line below
        // instead of being dropped as an answer that reads "full" for no reason.
        retryableCode ??= taken.code;
        retryablePorts.push(taken.port);
        continue;
      }
      unusablePorts.push(taken.port);
      unusableCode ??= taken.code;
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
      if (next === null || next === before) {
        // [F20] This process has now PROVEN at bind time (machine-global EACCES)
        // that the refused base's range cannot serve work: keep the proof - the
        // record is cleared when it still names the refused base, so the next
        // acquire walks candidates instead of inheriting a frozen, broken
        // record forever ("until someone deletes the file by hand"). A record
        // that changed meanwhile is a newer decision this process never probed
        // - not ours to delete, the same rule claimOrFollow enforces.
        const recorded = readPersistedBase();
        if (recorded !== null && (recorded === before || next === null)) {
          try {
            rmSync(baseFilePath(), { force: true });
          } catch {
            /* the next process re-probes the same range and repeats the decision */
          }
        }
        // The cached decision proved broken with the record itself: forget it,
        // so the next resolveBase in this process re-derives from the file
        // instead of trusting the refused base.
        resetBase();
        return { status: "refused", reason: "unusable" };
      }
      continue;
    }
    if (retryableCode !== null) {
      console.error(
        `[heavy-slot] slot ports ${retryablePorts.join(", ")} failed to bind (${retryableCode}) - a machine-side refusal, not a held slot; the same step is retried after this wait`,
      );
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
 * Exported (F23): `run()` returns a code a library caller must be able to name,
 * and the constants ARE the contract.
 */
export const EXIT_FULL = 75;
export const EXIT_REFUSED = 76;
export const EXIT_USAGE = 2;

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
    if (acquired.reason === "config") {
      console.error(`[heavy-slot] ${baseRangeFault()} - refusing loudly, never "the queue is full" (exit 76)`);
    } else {
      console.error(unusableBanner());
    }
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
  // SAFETY: process is an EventEmitter at runtime; bun's NodeJS.Process augmentation
  // declares off() only for its own "memoryPressure" event, which is what narrows the
  // call away from the EventEmitter signature. The cast names the interface in use.
  const emitter = process as NodeJS.EventEmitter;
  // Settled by the promise below; 1 (a failed launch's outcome) if a throw from
  // spawn itself beats it - the finally still releases the slot.
  let code = 1;
  try {
    code = await new Promise<number>((resolve) => {
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
      // [G1] Exactly one outcome: 'close' OR 'error'. spawn can fail to start the
      // shell at all (the machine at its process limit is the classic case) - then
      // 'error' fires alone, 'close' never fires, and the old shape had no 'error'
      // listener: the event threw unhandled instead of returning a code. A failed
      // launch is an outcome, a code the caller reads - never an exception and
      // never a slot held hostage by a close that will not come.
      let settled = false;
      child.on("close", (c) => {
        if (!settled) {
          settled = true;
          resolve(c ?? 1);
        }
      });
      child.on("error", (err: NodeJS.ErrnoException | undefined) => {
        if (!settled) {
          settled = true;
          console.error(
            `[heavy-slot] the command could not start (${err?.code ?? "UNKNOWN"}: ${err?.message ?? err}): ${command} - returning 1, no shell was launched`,
          );
          resolve(1);
        }
      });
    });
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
      // [F21] Disclose the give-up: the bounded budget ran out with the tree still
      // alive, so the slot is released while work may still be running - the same
      // double load the queue exists to prevent. A disclosed weakness is a
      // visible one; the old silent fallthrough read as a clean release.
      if (treeAlive(child)) {
        console.error(
          `[heavy-slot] the tree under pid ${child.pid} survived ${STOP_GRACE_MS}ms of forced kills - releasing slot ${slot.index} with work possibly still running`,
        );
      }
    }
  } finally {
    // [G1] Release and listener removal on EVERY exit path - the pre-'close'
    // exit ('error' before 'close', the launch that never happened, a throw the
    // caller lets propagate) held the slot and accumulated listeners before this.
    emitter.off("SIGINT", stop);
    emitter.off("SIGTERM", stop);
    release(slot);
    console.error(`[heavy-slot] slot ${slot.index} released, exit ${code}`);
  }
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
