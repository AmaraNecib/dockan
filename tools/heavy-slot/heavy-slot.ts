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
 * no port range is usable (reserved on this machine) - refused loudly, never reported as
 * "the queue is full", because waiting will never help.
 */

import net from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir, freemem, totalmem, cpus } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config. Every value is read lazily from the environment, so a caller (and a
// test) can point env at a scenario even after importing the module.
// ---------------------------------------------------------------------------

export const DEFAULT_BASE = 45700;
export const BASE_STRIDE = 1000; // shift step when the preferred base's range is reserved
export const BASE_MAX_ATTEMPTS = 8; // bound on the shift walk, counting the preferred base

export function preferredBase(): number {
  return Number(process.env.HEAVY_SLOT_BASE ?? DEFAULT_BASE);
}
export function maxSlots(): number {
  return Math.max(1, Number(process.env.HEAVY_SLOT_MAX ?? 5));
}
export function perJobGb(): number {
  return Number(process.env.HEAVY_SLOT_PER_JOB_GB ?? 2.5);
}
export function reserveGb(): number {
  return Number(process.env.HEAVY_SLOT_RESERVE_GB ?? 4);
}
export function waitMs(): number {
  return Number(process.env.HEAVY_SLOT_WAIT_MS ?? 30 * 60 * 1000);
}
export function stateDir(): string {
  return process.env.HEAVY_SLOT_STATE_DIR ?? join(homedir(), ".pi", "heavy-slots");
}

// The base this process has agreed on: the recorded one, the preferred one, or a
// shifted one - see resolveBase. Until a decision, ports come from the preferred base.
let activeBase = preferredBase();
let agreedBase: number | null = null;

export function currentBase(): number {
  return activeBase;
}
export function portFor(index: number): number {
  return activeBase + index - 1;
}
/** Re-read the environment and forget this process's base decision. Mainly for tests. */
export function resetBase(): void {
  activeBase = preferredBase();
  agreedBase = null;
}

export function gb(n: number): number {
  return Math.round((n / 1e9) * 10) / 10;
}

export async function cpuLoadPercent(): Promise<number> {
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
  let capacity = Math.max(1, Math.min(maxSlots(), byRam < 1 ? 1 : byRam));
  if (cpuLoad > 85) capacity = Math.max(1, capacity - 2);
  else if (cpuLoad > 70) capacity = Math.max(1, capacity - 1);
  else if (cpuLoad < 35 && freeGb > reserveGb()) capacity = Math.min(maxSlots(), capacity + 1);
  if (urgent && freeGb > reserveGb() && cpuLoad < 80) capacity = maxSlots();
  return capacity;
}

// ---------------------------------------------------------------------------
// Binding a port. The only error family that means "the slot is held by
// someone, so wait" is EADDRINUSE. EACCES, EADDRNOTAVAIL, EPERM and friends
// mean "this port is not ours to use at all" - on Windows, TCP port ranges the
// OS has reserved (they move across reboots and Hyper-V changes). Waiting never
// fixes the second family, so the two must never be confused.
// ---------------------------------------------------------------------------

export type OpenResult = { server: net.Server } | { error: "busy" | "unusable"; code: string };
export type OpenServer = (port: number) => Promise<OpenResult>;

export function realOpenServer(port: number): Promise<OpenResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException | undefined) => {
      const code = err?.code ?? "UNKNOWN";
      resolve({ error: code === "EADDRINUSE" ? "busy" : "unusable", code });
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

export type PortProbe = "free" | "busy" | "unusable";

export async function probePort(port: number): Promise<PortProbe> {
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

export function baseFilePath(dir: string = stateDir()): string {
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
 * Decide the base for this process, once. Order of authority:
 * 1. a base a previous process recorded, while it still binds (every process agrees with it);
 * 2. the preferred base (HEAVY_SLOT_BASE or the default), while it binds;
 * 3. the preferred base shifted by BASE_STRIDE at a time, bounded; the first process to find
 *    a working candidate records it, a concurrent one reads the winner.
 *
 * Returns null when every candidate is excluded - the caller must refuse loudly, never
 * report the queue as full.
 */
export async function resolveBase(): Promise<number | null> {
  if (agreedBase !== null) return agreedBase;
  const preferred = preferredBase();
  const persisted = readPersistedBase();
  if (persisted !== null && (await probePort(persisted)) !== "unusable") return activate(persisted);
  if ((await probePort(portOf(preferred, 1))) !== "unusable") return activate(preferred);
  for (let attempt = 1; attempt <= BASE_MAX_ATTEMPTS; attempt++) {
    const candidate = preferred + attempt * BASE_STRIDE;
    if (candidate >= 65536) continue;
    if ((await probePort(portOf(candidate, 1))) === "unusable") continue;
    if (!claimBase(candidate)) {
      // Lost the first-writer race: use whatever the first process recorded, never overwrite.
      const winner = readPersistedBase();
      if (winner !== null && (await probePort(winner)) !== "unusable") return activate(winner);
    }
    return activate(candidate);
  }
  return null;
}

/** Helper for callers that need an actually free port region (tests pick their base with this): probe candidate slot-1 ports until one binds cleanly. */
export async function chooseFreeBase(
  preferred: number = preferredBase(),
  attempts: number = BASE_MAX_ATTEMPTS,
): Promise<number | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = preferred + attempt * BASE_STRIDE;
    if (candidate >= 65536) break;
    if ((await probePort(candidate)) === "free") return candidate;
  }
  return null;
}

export function unusableBanner(): string {
  return (
    `[heavy-slot] no usable port range on this machine: candidates ${preferredBase()}..` +
    `${preferredBase() + BASE_MAX_ATTEMPTS * BASE_STRIDE} (stride ${BASE_STRIDE}, ${BASE_MAX_ATTEMPTS + 1} probes) all fail to bind with EACCES. ` +
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

export type Holder = { slot: number; port: number; label: string; pid?: number; startedAt?: string; stale: boolean };

export async function holders(): Promise<Holder[]> {
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

export type AcquireResult = { slot: Slot } | { refused: "unusable" } | null;

/**
 * Wait for a slot. null = the wait budget ran out while slots were genuinely held
 * (the queue is full; the caller exits 75). { refused: "unusable" } = the port
 * range itself is broken - refused immediately, never counted as "busy".
 */
export async function acquireSlot(label: string): Promise<AcquireResult> {
  const started = Date.now();
  const urgent = process.env.HEAVY_PRIORITY === "high";

  if ((await resolveBase()) === null) return { refused: "unusable" };
  let redecided = false;

  while (true) {
    const freeGb = freemem() / 1e9;
    const cpuLoad = await cpuLoadPercent();
    const capacity = capacityFor(freeGb, cpuLoad, urgent);
    let busySeen = false;
    let unusableSeen = false;
    for (let i = 1; i <= capacity; i++) {
      const taken = await tryTake(i, label);
      if (taken.ok) return { slot: taken.slot };
      if (taken.reason === "busy") busySeen = true;
      else unusableSeen = true;
    }
    if (unusableSeen && !busySeen) {
      // No slot was held and every port refused: the range quietly broke (e.g. a reboot
      // re-reserved it). Re-decide the base once, then refuse - waiting never helps.
      if (redecided) return { refused: "unusable" };
      redecided = true;
      agreedBase = null;
      if ((await resolveBase()) === null) return { refused: "unusable" };
      continue;
    }
    if (Date.now() - started > waitMs()) return null;
    const busy = (await holders()).map((h) => `${h.label}(${h.slot})`);
    console.error(
      `[heavy-slot] queued ${Math.round((Date.now() - started) / 1000)}s - free ${gb(freeGb * 1e9)} GB, cpu ${cpuLoad}%, capacity ${capacity}, busy [${busy.join(", ")}]`,
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export async function run(label: string, command: string): Promise<void> {
  const started = Date.now();
  const acquired = await acquireSlot(label);

  if (acquired === null) {
    console.error(
      `[heavy-slot] gave up after ${Math.round((Date.now() - started) / 1000)}s waiting for a slot. Nothing was run.`,
    );
    process.exit(75);
  }
  if ("refused" in acquired) {
    console.error(unusableBanner());
    process.exit(76);
  }
  const slot = acquired.slot;

  const waited = Math.round((Date.now() - started) / 1000);
  console.error(
    `[heavy-slot] ${waited >= 5 ? `got slot ${slot.index} after ${waited}s` : `got slot ${slot.index}`} (port ${slot.port}), running: ${command}`,
  );

  const code = await new Promise<number>((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    const stop = () => child.kill();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("close", (c) => resolve(c ?? 1));
  });

  release(slot);
  console.error(`[heavy-slot] slot ${slot.index} released, exit ${code}`);
  process.exit(code);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "status" || (!cmd && process.stdin.isTTY)) {
    await status();
    process.exit(0);
  }
  if (cmd === "run") {
    if (rest.length < 2) {
      console.error('usage: bun tools/heavy-slot/heavy-slot.ts run "<label>" "<command>"');
      process.exit(2);
    }
    const label = rest[0];
    if (!label) {
      console.error('usage: bun tools/heavy-slot/heavy-slot.ts status | run "<label>" "<command>"');
      process.exit(2);
    }
    await run(label, rest.slice(1).join(" "));
    process.exit(0);
  }
  console.error('usage: bun tools/heavy-slot/heavy-slot.ts status | run "<label>" "<command>"');
  process.exit(2);
}
