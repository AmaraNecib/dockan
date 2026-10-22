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
 * Exits with the child's exit code, or 75 if it gave up waiting without running anything.
 */

import net from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir, freemem, totalmem, cpus } from "node:os";
import { join } from "node:path";

const SLOT_BASE = Number(process.env.HEAVY_SLOT_BASE ?? 45700);
const MAX_SLOTS = Math.max(1, Number(process.env.HEAVY_SLOT_MAX ?? 5));
const PER_JOB_GB = Number(process.env.HEAVY_SLOT_PER_JOB_GB ?? 2.5);
const RESERVE_GB = Number(process.env.HEAVY_SLOT_RESERVE_GB ?? 4);
const WAIT_MS = Number(process.env.HEAVY_SLOT_WAIT_MS ?? 30 * 60 * 1000);
const STATE_DIR = process.env.HEAVY_SLOT_STATE_DIR ?? join(homedir(), ".pi", "heavy-slots");

export { SLOT_BASE, MAX_SLOTS, PER_JOB_GB, RESERVE_GB, WAIT_MS, STATE_DIR };

export function portFor(index: number): number {
  return SLOT_BASE + index - 1;
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
  const byRam = Math.floor((freeGb - RESERVE_GB) / PER_JOB_GB);
  let capacity = Math.max(1, Math.min(MAX_SLOTS, byRam < 1 ? 1 : byRam));
  if (cpuLoad > 85) capacity = Math.max(1, capacity - 2);
  else if (cpuLoad > 70) capacity = Math.max(1, capacity - 1);
  else if (cpuLoad < 35 && freeGb > RESERVE_GB) capacity = Math.min(MAX_SLOTS, capacity + 1);
  if (urgent && freeGb > RESERVE_GB && cpuLoad < 80) capacity = MAX_SLOTS;
  return capacity;
}

export type Slot = { index: number; server: net.Server };

export function tryTake(index: number, label: string): Promise<Slot | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (ok: boolean) => {
      if (!ok) {
        server.removeAllListeners();
        try {
          server.close();
        } catch {
          /* not listening */
        }
      }
      resolve(ok ? { index, server } : null);
    };
    server.once("error", () => done(false));
    server.listen({ port: portFor(index), host: "127.0.0.1", exclusive: true }, () => {
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(
          join(STATE_DIR, `slot-${index}.json`),
          JSON.stringify({ slot: index, pid: process.pid, label, startedAt: new Date().toISOString() }),
        );
      } catch {
        /* metadata is a hint, the port is the truth */
      }
      done(true);
    });
  });
}

export function release(slot: Slot): void {
  try {
    rmSync(join(STATE_DIR, `slot-${slot.index}.json`), { force: true });
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
  const held: Holder[] = [];
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const busy = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(true));
      s.listen({ port: portFor(i), host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(false)));
    });
    let label = "(unknown)";
    let pid: number | undefined;
    let startedAt: string | undefined;
    try {
      const raw = readFileSync(join(STATE_DIR, `slot-${i}.json`), "utf8");
      // SAFETY: shape matches what tryTake writes.
      const j = JSON.parse(raw) as { label?: string; pid?: number; startedAt?: string };
      label = j.label ?? label;
      pid = j.pid;
      startedAt = j.startedAt;
    } catch {
      /* no metadata */
    }
    if (busy) held.push({ slot: i, port: portFor(i), label, pid, startedAt, stale: false });
    else if (existsSync(join(STATE_DIR, `slot-${i}.json`)))
      held.push({ slot: i, port: portFor(i), label, pid, startedAt, stale: true });
  }
  return held;
}

async function status(): Promise<void> {
  const freeGb = gb(freemem());
  const cpuLoad = await cpuLoadPercent();
  console.log(
    `free ${freeGb} GB of ${gb(totalmem())} GB, cpu ${cpuLoad}%  ->  capacity ${capacityFor(freeGb, cpuLoad, false)} of max ${MAX_SLOTS}`,
  );
  const held = await holders();
  if (!held.length) return console.log("the queue is empty");
  for (const h of held) {
    const age = h.startedAt ? `${Math.round((Date.now() - Date.parse(h.startedAt)) / 1000)}s` : "?";
    console.log(
      `slot ${h.slot}: '${h.label}' pid ${h.pid ?? "?"} running ${age}${h.stale ? "  [port free - stale metadata]" : ""}`,
    );
  }
}

export async function run(label: string, command: string): Promise<void> {
  const started = Date.now();
  const urgent = process.env.HEAVY_PRIORITY === "high";
  let slot: Slot | null = null;

  while (!slot) {
    const freeGb = freemem() / 1e9;
    const cpuLoad = await cpuLoadPercent();
    const capacity = capacityFor(freeGb, cpuLoad, urgent);
    for (let i = 1; i <= capacity; i++) {
      slot = await tryTake(i, label);
      if (slot) break;
    }
    if (slot) break;
    if (Date.now() - started > WAIT_MS) {
      console.error(
        `[heavy-slot] gave up after ${Math.round((Date.now() - started) / 1000)}s waiting for a slot. Nothing was run.`,
      );
      process.exit(75);
    }
    const busy = (await holders()).filter((h) => !h.stale).map((h) => `${h.label}(${h.slot})`);
    console.error(
      `[heavy-slot] queued ${Math.round((Date.now() - started) / 1000)}s - free ${gb(freeGb * 1e9)} GB, cpu ${cpuLoad}%, capacity ${capacity}, busy [${busy.join(", ")}]`,
    );
    await new Promise((r) => setTimeout(r, 3000));
  }

  const waited = Math.round((Date.now() - started) / 1000);
  console.error(`[heavy-slot] ${waited >= 5 ? `got slot ${slot.index} after ${waited}s` : `got slot ${slot.index}`}, running: ${command}`);

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
