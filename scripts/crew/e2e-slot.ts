#!/usr/bin/env bun
// e2e-slot.ts — serialise the heavy Playwright runs across crew lanes.
//
// Why: a full `bun run test:e2e` boots four servers and saturates the CPU. More
// than a couple at once makes the GUARDS flaky, and a flaky guard costs more time
// than it saves (2026-10-13: five lanes fought over the shared dev ports and every
// one of them reported a false failure). A lane may always run cheap tests
// (typecheck, lint, unit, a single spec) with no slot at all.
//
// The lock lives in ONE shared directory (the main repo, not a worktree), because
// each worktree has its own `.scratch`.
//
//   e2e-slot.ts acquire <lane> [--timeout SECONDS] [--no-wait]
//   e2e-slot.ts release <lane>
//   e2e-slot.ts status
//   e2e-slot.ts --selftest
//
// `acquire` prints the port quartet to export, then exits 0. If it cannot get a
// slot inside the timeout it exits 2 and the caller must NOT run e2e: commit and
// report instead, and the next lane's release frees the slot.
//
// Slots are FIRST COME, FIRST SERVED by request time, and each slot owns a
// DISJOINT port quartet, so two concurrent runs cannot fight over ports either.
//
// The stdout is a CONTRACT, not prose: `~/.pi/agent/extensions/e2e-slot-guard.ts`
// reads `^PORTS (.+)$` from it and treats a non-zero exit as "block the heavy run".
// The line shape and the exit codes are reproduced from `e2e-slot.sh` exactly.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { hostPath } from "./host-path.ts";
import { check, diff, report, type SelftestCase } from "./selftest.ts";

export const DEFAULT_ROOT = "/d/projects/mani-project/.scratch/sessions/crew/e2e-slots";
export const DEFAULT_SLOTS = 2;
export const DEFAULT_MAX_HOLD_SECONDS = 1800;
/** A killed lane must not block the queue: a request that stopped polling is dead. */
const STALE_REQUEST_MS = 120_000;
const POLL_MS = 10_000;

/** Slot 1 -> 4700/5700/4701/5701, slot 2 -> 4800/5800/4801/5801, ... */
export function portsFor(slot: number): string {
  const base = 4600 + slot * 100;
  return [
    `DOKAN_PORT=${String(base)}`,
    `DOKAN_WEB_PORT=${String(base + 1000)}`,
    `DOKAN_VAULT_PORT=${String(base + 1)}`,
    `DOKAN_VAULT_WEB_PORT=${String(base + 1001)}`,
  ].join(" ");
}

export type SlotConfig = { root: string; rootOnDisk: string; slots: number; maxHoldSeconds: number };

function config(env: NodeJS.ProcessEnv, platform: string): SlotConfig {
  const root = env.E2E_SLOT_DIR ?? DEFAULT_ROOT;
  const slots = Number.parseInt(env.E2E_SLOTS ?? String(DEFAULT_SLOTS), 10);
  const maxHold = Number.parseInt(env.E2E_SLOT_MAX_HOLD ?? String(DEFAULT_MAX_HOLD_SECONDS), 10);
  return {
    root,
    rootOnDisk: hostPath(root, platform),
    slots: Number.isFinite(slots) ? slots : DEFAULT_SLOTS,
    maxHoldSeconds: Number.isFinite(maxHold) ? maxHold : DEFAULT_MAX_HOLD_SECONDS,
  };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function dirsOf(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function filesOf(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * A slot whose owner died (killed lane, slept laptop, backgrounded run) must not
 * stall everyone behind it. `E2E_SLOT_MAX_HOLD` is generous: a full suite is ~9 min.
 */
export function reapHeld(cfg: SlotConfig, nowMs: number, held: string): void {
  for (const name of dirsOf(held)) {
    const since = (readText(join(held, name, "since")) ?? "").trim();
    const started = Date.parse(since);
    // An unreadable marker is not evidence of a live holder, but it is not evidence
    // of a stale one either: the shell's `date -d` failed on it and skipped too.
    if (!Number.isFinite(started)) continue;
    if (nowMs - started > cfg.maxHoldSeconds * 1000) {
      const lane = (readText(join(held, name, "lane")) ?? "").trim();
      process.stderr.write(`reaped stale ${name} (held by ${lane}, ${String(cfg.maxHoldSeconds)}s)\n`);
      rmSync(join(held, name), { recursive: true, force: true });
    }
  }
}

function slotOf(held: string, lane: string): string {
  for (const name of dirsOf(held)) {
    if ((readText(join(held, name, "lane")) ?? "").trim() === lane) return name;
  }
  return "";
}

function tickets(queue: string): string[] {
  return filesOf(queue).filter((name) => name.endsWith(".req"));
}

function reapDeadTickets(queue: string, nowMs: number): void {
  for (const name of tickets(queue)) {
    const path = join(queue, name);
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = nowMs - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs > STALE_REQUEST_MS) rmSync(path, { force: true });
  }
}

function ticketStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:]/gu, "").slice(0, 15);
}

export function status(cfg: SlotConfig, nowMs: number = Date.now()): number {
  const held = join(cfg.rootOnDisk, "held");
  const queue = join(cfg.rootOnDisk, "queue");
  reapHeld(cfg, nowMs, held);
  console.log(`slots: ${String(cfg.slots)}   root: ${cfg.root}`);
  const names = dirsOf(held);
  for (const name of names) {
    const lane = (readText(join(held, name, "lane")) ?? "").trim();
    const since = (readText(join(held, name, "since")) ?? "").trim();
    console.log(`  HELD  ${name.padEnd(6)} lane=${lane} since=${since}`);
  }
  if (names.length === 0) console.log("  (none held)");
  for (const name of tickets(queue)) {
    const body = (readText(join(queue, name)) ?? "").trim();
    const [asked = "", ...rest] = body.split(" ");
    console.log(`  QUEUE ${name.replace(/\.req$/u, "").padEnd(6)} lane=${rest.join(" ")} asked=${asked}`);
  }
  return 0;
}

export async function acquire(
  cfg: SlotConfig,
  lane: string,
  timeoutSeconds: number,
  noWait: boolean,
  now: () => number = Date.now,
): Promise<number> {
  const held = join(cfg.rootOnDisk, "held");
  const queue = join(cfg.rootOnDisk, "queue");
  mkdirSync(held, { recursive: true });
  mkdirSync(queue, { recursive: true });

  // An existing slot is a no-op, so a re-run never deadlocks against itself.
  const have = slotOf(held, lane);
  if (have !== "") {
    console.log(`PORT_SLOT=${have} already held by ${lane}`);
    console.log(`PORTS ${portsFor(Number(have.replace(/^slot/u, "")))}`);
    return 0;
  }

  // Reuse this lane's own request if it already queued, so retrying does not push
  // the lane to the back behind its own abandoned ticket.
  let mine = tickets(queue).find((name) => name.endsWith(`-${lane}.req`)) ?? "";
  if (mine === "") {
    mine = `${ticketStamp(now())}-${String(process.pid)}-${lane}.req`;
    writeFileSync(join(queue, mine), `${String(Math.floor(now() / 1000))} ${lane}\n`);
  }
  reapDeadTickets(queue, now());

  const deadline = Math.floor(now() / 1000) + timeoutSeconds;
  for (;;) {
    reapHeld(cfg, now(), held);
    // Activity marker: reaping above uses mtime, so a live waiter stays fresh.
    const minePath = join(queue, mine);
    try {
      utimesSync(minePath, new Date(now()), new Date(now()));
    } catch {
      /* the ticket is a marker, never a reason to fail an acquire */
    }
    const oldest = tickets(queue)[0] ?? "";
    const holders = dirsOf(held).length;
    if (oldest === mine && holders < cfg.slots) {
      for (let n = 1; n <= cfg.slots; n += 1) {
        // mkdir is the atomic claim: only one process can create the directory.
        try {
          mkdirSync(join(held, `slot${String(n)}`));
          writeFileSync(join(held, `slot${String(n)}`, "lane"), lane);
          writeFileSync(join(held, `slot${String(n)}`, "since"), new Date(now()).toISOString());
          rmSync(minePath, { force: true });
          console.log(`PORT_SLOT=slot${String(n)} held by ${lane}`);
          console.log(`PORTS ${portsFor(n)}`);
          return 0;
        } catch {
          /* taken by another lane: try the next slot */
        }
      }
    }
    if (noWait || Math.floor(now() / 1000) >= deadline) {
      // Give up the ticket as well as the wait. The shell left it behind for the
      // full 2-minute grace, and `e2e-slot-guard.ts` calls acquire with `--no-wait`
      // on EVERY heavy run -- so a blocked lane parked a ticket that then blocked
      // the next lane's acquire, the very serialisation this file exists to keep
      // fair. A lane that stopped waiting has no claim left.
      rmSync(minePath, { force: true });
      console.log(`PORT_SLOT=none (${lane} still queued; held=${String(holders)}/${String(cfg.slots)})`);
      return 2;
    }
    await sleep(POLL_MS);
  }
}

export function release(cfg: SlotConfig, lane: string): number {
  const held = join(cfg.rootOnDisk, "held");
  const queue = join(cfg.rootOnDisk, "queue");
  for (const name of dirsOf(held)) {
    if ((readText(join(held, name, "lane")) ?? "").trim() !== lane) continue;
    rmSync(join(held, name), { recursive: true, force: true });
    console.log(`released ${name} from ${lane}`);
    for (const ticket of tickets(queue)) {
      if (ticket.endsWith(`-${lane}.req`)) rmSync(join(queue, ticket), { force: true });
    }
    return 0;
  }
  for (const ticket of tickets(queue)) {
    if (ticket.endsWith(`-${lane}.req`)) rmSync(join(queue, ticket), { force: true });
  }
  console.log(`no slot held by ${lane}`);
  return 0;
}

// ------------------------------------------------------------------ selftest

type Spawned = { code: number; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<Spawned> {
  return new Promise((resolve) => {
    const child = spawnCli(args, env);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
  return spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    env: { ...process.env, ...env },
    windowsHide: true,
  });
}

export async function slotSelftest(): Promise<SelftestCase[]> {
  const cases: SelftestCase[] = [];
  const root = join(tmpdir(), `crew-slot-selftest-${String(process.pid)}`, "slots");
  const fresh = (): void => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "held"), { recursive: true });
    mkdirSync(join(root, "queue"), { recursive: true });
  };
  const held = join(root, "held");
  const queue = join(root, "queue");
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    E2E_SLOT_DIR: root,
    E2E_SLOTS: "1",
    ...extra,
  });

  const slot1 = "DOKAN_PORT=4700 DOKAN_WEB_PORT=5700 DOKAN_VAULT_PORT=4701 DOKAN_VAULT_WEB_PORT=5701";
  const slot2 = "DOKAN_PORT=4800 DOKAN_WEB_PORT=5800 DOKAN_VAULT_PORT=4801 DOKAN_VAULT_WEB_PORT=5801";
  cases.push(check("ports for slot 1", portsFor(1) === slot1, diff(portsFor(1), slot1)));
  cases.push(check("ports for slot 2", portsFor(2) === slot2, diff(portsFor(2), slot2)));
  cases.push(check("msys /d/ translates on win32 only", hostPath("/d/projects/x", "win32") === "D:/projects/x" && hostPath("/d/projects/x", "linux") === "/d/projects/x", `win32=${hostPath("/d/projects/x", "win32")} linux=${hostPath("/d/projects/x", "linux")}`));
  cases.push(check("msys /tmp is the real TEMP, not D:\\tmp", hostPath("/tmp/x", "win32") === join(tmpdir(), "x") && hostPath("/tmp/x", "linux") === "/tmp/x", `win32=${hostPath("/tmp/x", "win32")}`));
  cases.push(check("a path with no drive letter is left alone", hostPath("/nowhere/x", "win32") === "/nowhere/x", hostPath("/nowhere/x", "win32")));

  // Mutual exclusion, the property rule 3 names for this script.
  fresh();
  const race = await Promise.all([
    runCli(["acquire", "lane-a", "--no-wait"], env()),
    runCli(["acquire", "lane-b", "--no-wait"], env()),
  ]);
  const winners = race.filter((result) => result.code === 0);
  const losers = race.filter((result) => result.code === 2);
  const held0 = winners[0] ?? { code: -1, stdout: "", stderr: "" };
  cases.push(
    check(
      "two concurrent acquires, one slot: exactly one holder",
      winners.length === 1 && losers.length === 1,
      `codes=${race.map((result) => String(result.code)).join(",")}`,
    ),
  );
  cases.push(
    check(
      "the loser exits 2 with PORT_SLOT=none",
      /^PORT_SLOT=none \(lane-[ab] still queued; held=1\/1\)$/mu.test(losers[0]?.stdout ?? ""),
      JSON.stringify(losers[0]?.stdout ?? ""),
    ),
  );
  const holder = /PORT_SLOT=slot1 held by (lane-[ab])/u.exec(held0.stdout)?.[1] ?? "";
  cases.push(
    check(
      "the winner holds slot1 and gets a quartet",
      holder !== "" && held0.stdout.includes("PORTS DOKAN_PORT="),
      JSON.stringify(held0.stdout),
    ),
  );

  const again = await runCli(["acquire", holder, "--no-wait"], env());
  cases.push(
    check(
      "a holder re-acquiring is a no-op, not a second slot",
      again.code === 0 && again.stdout.includes(`PORT_SLOT=slot1 already held by ${holder}`) && dirsOf(held).length === 1,
      JSON.stringify(again.stdout),
    ),
  );

  const freed = await runCli(["release", holder], env());
  const next = await runCli(["acquire", "lane-c", "--no-wait"], env());
  cases.push(
    check(
      "release frees the slot for the next lane",
      freed.stdout.trim() === `released slot1 from ${holder}` && next.code === 0 && next.stdout.includes("PORT_SLOT=slot1 held by lane-c"),
      `${JSON.stringify(freed.stdout)} ${JSON.stringify(next.stdout)}`,
    ),
  );
  const nothing = await runCli(["release", "lane-zz"], env());
  cases.push(
    check(
      "releasing an unheld lane says so and exits 0",
      nothing.code === 0 && nothing.stdout.trim() === "no slot held by lane-zz",
      JSON.stringify(nothing.stdout),
    ),
  );
  cases.push(check("release did not touch another lane's hold", dirsOf(held).length === 1, `held=${String(dirsOf(held).length)}`));

  // The atomic claim ITSELF, which the two-lane case above cannot reach: there, the queue
  // order means only the oldest lane ever attempts the mkdir, so a non-atomic claim would
  // still look correct. With four lanes and two slots the arbiter is `mkdir` alone -- and
  // `mkdirSync(..., { recursive: true })` (which never throws on an existing directory)
  // lets every lane "win" slot1. Measured: 4 winners on slot1 without the throw.
  fresh();
  const four = await Promise.all(
    ["lane-p", "lane-q", "lane-r", "lane-s"].map((lane) => runCli(["acquire", lane, "--no-wait"], env({ E2E_SLOTS: "2" }))),
  );
  const won = four.filter((result) => result.code === 0);
  const lost = four.filter((result) => result.code === 2);
  const wonSlots = won.map((result) => /^PORT_SLOT=(slot\d+)/u.exec(result.stdout)?.[1] ?? "?");
  cases.push(
    check(
      "four lanes, two slots: exactly two hold, on two distinct slots",
      won.length === 2 && lost.length === 2 && new Set(wonSlots).size === 2 && wonSlots.includes("slot1") && wonSlots.includes("slot2"),
      `won=${wonSlots.join(",")} losers=${String(lost.length)}`,
    ),
  );

  // A stale hold is reaped instead of waited on.
  fresh();
  mkdirSync(join(held, "slot1"), { recursive: true });
  writeFileSync(join(held, "slot1", "lane"), "ghost");
  writeFileSync(join(held, "slot1", "since"), new Date(Date.now() - 7_200_000).toISOString());
  const reaped = await runCli(["acquire", "lane-d", "--no-wait"], env({ E2E_SLOT_MAX_HOLD: "60" }));
  cases.push(
    check(
      "a stale hold is reaped, not waited on",
      reaped.code === 0 &&
        reaped.stderr.includes("reaped stale slot1 (held by ghost, 60s)") &&
        reaped.stdout.includes("PORT_SLOT=slot1 held by lane-d"),
      `${JSON.stringify(reaped.stdout)} ${JSON.stringify(reaped.stderr)}`,
    ),
  );

  // A dead waiter's ticket must not block the lane behind it.
  fresh();
  const dead = join(queue, "20200101T000000-1-ghost.req");
  writeFileSync(dead, "1577836800 ghost\n");
  const old = new Date(Date.now() - 600_000);
  utimesSync(dead, old, old);
  await runCli(["acquire", "lane-e", "--no-wait"], env());
  cases.push(check("a request that stopped polling is reaped after 2 minutes", !existsSync(dead), `still present: ${dead}`));

  // With zero slots nothing can be granted. A lane that WAITS keeps its ticket, so
  // the name and the queue line are observable; a lane that gives up must not park
  // one, because a parked ticket blocks the next lane's acquire.
  fresh();
  const waiting = spawnCli(["acquire", "lane-g", "--timeout", "30"], env({ E2E_SLOTS: "0" }));
  await sleep(1_500);
  const survivor = tickets(queue)[0] ?? "";
  cases.push(
    check(
      "a waiting lane's request is named <utc stamp>-<pid>-<lane>.req",
      /^\d{8}T\d{6}-\d+-lane-g\.req$/u.test(survivor),
      `survivor=${survivor}`,
    ),
  );
  const listed = await runCli(["status"], env({ E2E_SLOTS: "0" }));
  cases.push(
    check(
      "status prints the raw root, the holder column and the queue entry",
      listed.stdout.startsWith(`slots: 0   root: ${root}\n`) &&
        listed.stdout.includes("  (none held)\n") &&
        new RegExp(`  QUEUE ${survivor.replace(".req", "")} lane=lane-g asked=\\d+\n`, "u").test(listed.stdout),
      JSON.stringify(listed.stdout),
    ),
  );
  waiting.kill();
  await new Promise((resolve) => {
    waiting.on("close", resolve);
  });

  const queued = await runCli(["acquire", "lane-f", "--no-wait"], env({ E2E_SLOTS: "0" }));
  cases.push(
    check(
      "no slot available prints held=0/0 and exits 2",
      queued.code === 2 && queued.stdout.trim() === "PORT_SLOT=none (lane-f still queued; held=0/0)",
      JSON.stringify(queued.stdout),
    ),
  );
  cases.push(
    check(
      "a lane that stopped waiting leaves no ticket behind",
      tickets(queue).every((name) => !name.endsWith("-lane-f.req")),
      tickets(queue).join(","),
    ),
  );

  const usage = await runCli([], env());
  cases.push(
    check(
      "no subcommand → usage, exit 1",
      usage.code === 1 && /usage: e2e-slot\./u.test(usage.stdout + usage.stderr),
      `code=${String(usage.code)} out=${JSON.stringify(usage.stdout)} err=${JSON.stringify(usage.stderr)}`,
    ),
  );

  rmSync(join(tmpdir(), `crew-slot-selftest-${String(process.pid)}`), { recursive: true, force: true });
  return cases;
}

// ----------------------------------------------------------------------- CLI

const USAGE_ACQUIRE = "usage: e2e-slot.ts acquire <lane> [--timeout SECONDS] [--no-wait]";

function usage(): void {
  console.error(USAGE_ACQUIRE);
  console.error("       e2e-slot.ts release <lane>");
  console.error("       e2e-slot.ts status");
}

async function main(argv: string[]): Promise<number> {
  const [command = "", ...rest] = argv;
  const cfg = config(process.env, process.platform);
  switch (command) {
    case "acquire": {
      const lane = rest[0] ?? "";
      if (lane === "") {
        console.error(USAGE_ACQUIRE);
        return 1;
      }
      let timeout = DEFAULT_MAX_HOLD_SECONDS;
      let noWait = false;
      for (let i = 1; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === "--timeout") {
          const value = rest[i + 1];
          if (value === undefined) {
            console.error(USAGE_ACQUIRE);
            return 1;
          }
          const parsed = Number.parseInt(value, 10);
          timeout = Number.isFinite(parsed) ? parsed : DEFAULT_MAX_HOLD_SECONDS;
          i += 1;
        } else if (arg === "--no-wait") {
          noWait = true;
        }
        // Anything else is skipped, as the shell version skipped it.
      }
      return await acquire(cfg, lane, timeout, noWait);
    }
    case "release": {
      const lane = rest[0] ?? "";
      if (lane === "") {
        console.error("usage: e2e-slot.ts release <lane>");
        return 1;
      }
      return release(cfg, lane);
    }
    case "status":
      return status(cfg);
    case "--selftest":
      return report(await slotSelftest());
    default:
      usage();
      return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
