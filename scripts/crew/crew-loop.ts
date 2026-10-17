#!/usr/bin/env bun
// crew-loop.ts — the always-on loop, for when no reload has armed crew-autopilot.
//
// Two jobs on one timer:
//   1. pickup   — run the pickup step so a lane starts as soon as the policy admits
//   2. pr watch — one PR read per tick, and wake the parent on a MEANINGFUL
//                 transition only
//
// WHAT COUNTS AS MEANINGFUL, and why the first version was wrong
// -------------------------------------------------------------
// The first version fingerprinted each check's status, so every step of a CI run
// (queued -> in_progress -> success, per check) looked like a change. A single
// push produced four or five wakes, all of them saying the same thing: nothing
// yet. A monitor that cries on every tick trains its reader to ignore it, which
// is worse than no monitor.
//
// So a wake needs one of these, and nothing else:
//   new head                  — the code moved, everything before is stale
//   new comment or review     — a Greptile verdict or a human reply landed
//   CI finished               — pending went from >0 to 0: the verdict is now real
//   CI started                — 0 to >0: a new run exists, so a re-review is coming
// Progress *within* a run wakes nobody. That judgement now lives in
// `crew-pr-watch.ts` (it was a python heredoc in this script that was dead for five
// hours behind a bare `except`); this loop consumes its lines.
//
//   crew-loop.ts start    # detached
//   crew-loop.ts status
//   crew-loop.ts stop
//   crew-loop.ts run      # the loop itself, in the foreground
//   crew-loop.ts --selftest
//
// THE CONTRACT. `crew-pickup`'s last line is `[pickup] started=N`; this loop is its
// only parser, and every `[pickup]` line it does NOT log is a decision a human
// cannot read back. Both the `tick:` and `pickup:` log shapes are reproduced.
import { appendFileSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { hostPath } from "./host-path";
import { check, report, type SelftestCase } from "./selftest";

export const DEFAULT_REPO = "D:/projects/mani-project";
const PICKUP_TIMEOUT_MS = 240_000;
const PR_WATCH_TIMEOUT_MS = 180_000;

export type LoopConfig = {
  repoRaw: string;
  repoPath: string;
  stateDir: string;
  pidFile: string;
  logPath: string;
  prState: string;
  wakeBin: string;
  parentPane: string;
  intervalSeconds: number;
  pickupEntry: string;
  prWatchEntry: string;
  mergeableEntry: string;
};

export type PickupOutcome = { started: number; firstLine: string; detail: string[] };

/**
 * The one way this loop reads pickup. `sed -n 's/^\[pickup\] started=\([0-9]*\)$/\1/p'`
 * printed every match; the last one wins here so a line that appears twice cannot turn
 * the count into `1\n1` and stop the arithmetic.
 */
export function parsePickupOutcome(stdout: string): PickupOutcome {
  const lines = stdout.split("\n");
  let started = 0;
  let seen = false;
  for (const line of lines) {
    const match = /^\[pickup\] started=(\d+)$/u.exec(line);
    if (match?.[1] === undefined) continue;
    started = Number(match[1]);
    seen = true;
  }
  const detail = lines
    .filter((line) => line.startsWith("[pickup]") && !line.startsWith("[pickup] started="))
    .slice(-12);
  return {
    // `head -1 | cut -c1-160`
    firstLine: (lines[0] ?? "").slice(0, 160),
    started: seen ? started : 0,
    detail,
  };
}

/** The `sed -n` extraction of `#<n>:` prefixes over the watcher's change lines. */
export function prNumbers(changes: string): number[] {
  const numbers: number[] = [];
  for (const line of changes.split("\n")) {
    const match = /^#(\d+):/u.exec(line);
    if (match?.[1] === undefined) continue;
    numbers.push(Number(match[1]));
  }
  return numbers;
}

export type VerdictPayload = { verdict?: string; reasons?: string[] };

export type Verdict = { verdict: string; reasons: string[] };

export function parseVerdict(stdout: string): Verdict {
  try {
    // SAFETY: crew-mergeable.ts --json owns this payload; anything else means the
    // verdict is unknown, and the loop then acts on nothing at all.
    const parsed = JSON.parse(stdout) as VerdictPayload;
    return { verdict: parsed.verdict ?? "", reasons: parsed.reasons ?? [] };
  } catch {
    return { verdict: "", reasons: [] };
  }
}

/** The PR wake is a SUMMARY plus the one command worth re-running, never a transcript. */
export function prWakeMessage(changes: string): string {
  return [
    "[autopilot] PR changes:",
    changes,
    "",
    "Verdicts applied by the loop (labels) — read the full verdict with:",
    "  bun .scratch/scripts/crew-mergeable.ts <pr>",
    "If a PR is AUTO, merge it: a script already decided, you are only executing. If OWNER, it is labelled and it is the owner's call.",
  ].join("\n");
}

export function pickupWakeMessage(started: number): string {
  return `[autopilot] pickup started ${String(started)} lane(s). Detail in .scratch/sessions/crew/crew-loop.log`;
}

export type LoopDeps = {
  /** Stdout of one pickup run (stderr folded in, as the shell's `2>&1` did). */
  pickup: () => string;
  /** One line per PR change, or "" when nothing changed. */
  prChanges: () => string;
  verdictOf: (pr: number) => string;
  labelOwner: (pr: number) => boolean;
  wake: (message: string) => void;
  say: (line: string) => void;
};

export type TickResult = { started: number; wokeForPickup: boolean; wokeForPr: boolean; logged: string[] };

/**
 * One tick, as a value. The loop body is a `while (true)`, so a tick that can only be
 * observed by running the loop is a tick nobody tests; this returns what it logged and
 * which wakes it sent.
 */
export function tickOnce(deps: LoopDeps): TickResult {
  const logged: string[] = [];
  const say = (line: string): void => {
    logged.push(line);
    deps.say(line);
  };

  const outcome = parsePickupOutcome(deps.pickup());
  // Log EVERY tick, not only the ones that start a lane. Logging only successes made a
  // throttling loop look identical to a dead one — the same confident-silence failure
  // the queue footer had.
  say(`tick: ${outcome.firstLine} | started=${String(outcome.started)}`);
  // Log what pickup DECIDED, not just its first line. Only `head -1` ever reached the
  // log, so every per-item reason -- "no brief declares it", "already a registered
  // worktree", "started but NEVER accepted its brief" -- was discarded, which made a
  // ticket that kept failing to launch indistinguishable from one that was never
  // eligible.
  if (outcome.detail.length > 0) {
    say(`pickup: ${outcome.detail.join("|").slice(0, 500)}`);
  }
  let wokeForPickup = false;
  if (outcome.started > 0) {
    // A wake carries a SUMMARY, never a raw transcript: the old version appended the
    // last six lines of pickup's combined stdout+stderr, so a stray shell error was
    // typed straight into the parent's input box, where the owner reads it as
    // something he must answer.
    deps.wake(pickupWakeMessage(outcome.started));
    wokeForPickup = true;
  }

  const changes = deps.prChanges();
  let wokeForPr = false;
  if (changes !== "") {
    say(`pr: ${changes.split("\n").join("|")}`);
    for (const pr of prNumbers(changes)) {
      const raw = deps.verdictOf(pr);
      if (raw === "") continue;
      const { verdict, reasons } = parseVerdict(raw);
      switch (verdict) {
        case "OWNER":
          // Label it, so an unreviewed production change is visible in the PR list
          // instead of only in a transcript nobody re-reads.
          if (deps.labelOwner(pr)) say(`#${String(pr)}: OWNER -> labelled needs-owner-review`);
          break;
        case "AUTO":
          // Do NOT merge here. A background shell merging with no reasoning is harder
          // to audit than the parent doing it while quoting the verdict; the loop
          // labels/wakes and the parent executes.
          say(`#${String(pr)}: AUTO -> the parent may merge it (script judges, parent acts)`);
          break;
        case "REFUSED":
          say(`#${String(pr)}: REFUSED -> ${reasons.slice(0, 2).join("; ")}`);
          break;
        default:
          break;
      }
    }
    deps.wake(prWakeMessage(changes));
    wokeForPr = true;
  }

  return { started: outcome.started, wokeForPickup, wokeForPr, logged };
}

export function config(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): LoopConfig {
  const repoRaw = env.CREW_REPO ?? DEFAULT_REPO;
  const repoPath = hostPath(repoRaw, platform);
  // Built from the RAW repo string with forward slashes, so the printed paths are the
  // ones a human types and `status` still reads byte-for-byte like the shell's. Node
  // accepts forward slashes on Windows, so one string serves both display and fs.
  const sessionRaw = env.CREW_SESSION_DIR ?? `${repoRaw}/.scratch/sessions/crew`;
  const stateDir = hostPath(sessionRaw, platform);
  const interval = Number.parseInt(env.CREW_LOOP_INTERVAL ?? "30", 10);
  return {
    repoRaw,
    repoPath,
    stateDir,
    pidFile: `${sessionRaw}/crew-loop.pid`,
    logPath: `${sessionRaw}/crew-loop.log`,
    prState: `${sessionRaw}/pr-watch-loop.json`,
    wakeBin: env.HERDR_WAKE_BIN ?? join(env.HOME ?? "", ".pi", "agent", "bin", "herdr-wake.sh"),
    parentPane: env.HERDR_PANE_ID ?? "w48:p1",
    intervalSeconds: Number.isFinite(interval) ? interval : 30,
    // Calling pickup's TypeScript entry directly drops a `bash` hop; the harness'
    // `.scratch/scripts/crew-pickup.sh` shim points at the same file.
    pickupEntry: env.CREW_PICKUP ?? `${repoRaw}/scripts/crew/crew-pickup.ts`,
    prWatchEntry: `${repoRaw}/.scratch/scripts/crew-pr-watch.ts`,
    mergeableEntry: `${repoRaw}/.scratch/scripts/crew-mergeable.ts`,
  };
}

function capture(command: string, args: string[], cwd: string, timeoutMs: number): string {
  const done = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return `${done.stdout ?? ""}${done.stderr ?? ""}`;
}

export function realDeps(cfg: LoopConfig): LoopDeps {
  return {
    pickup: () => capture(process.execPath, [cfg.pickupEntry], cfg.repoPath, PICKUP_TIMEOUT_MS),
    prChanges: () =>
      capture(process.execPath, [cfg.prWatchEntry, "--state", cfg.prState], cfg.repoPath, PR_WATCH_TIMEOUT_MS),
    verdictOf: (pr) => capture(process.execPath, [cfg.mergeableEntry, String(pr), "--json"], cfg.repoPath, 60_000),
    labelOwner: (pr) => {
      const done = spawnSync("gh", ["pr", "edit", String(pr), "--add-label", "needs-owner-review"], {
        cwd: cfg.repoPath,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      return done.status === 0;
    },
    wake: (message) => {
      capture("bash", [cfg.wakeBin, cfg.parentPane, message], cfg.repoPath, 300_000);
    },
    say: (line) => {
      appendFileSync(hostPath(cfg.logPath), `${utcClock()} ${line}\n`);
    },
  };
}

function utcClock(): string {
  return new Date().toISOString().slice(11, 19);
}

export async function runLoop(cfg: LoopConfig, deps: LoopDeps = realDeps(cfg)): Promise<number> {
  mkdirSync(cfg.stateDir, { recursive: true });
  deps.say(`loop started (parent=${cfg.parentPane} interval=${String(cfg.intervalSeconds)}s)`);
  for (;;) {
    tickOnce(deps);
    await sleep(cfg.intervalSeconds * 1000);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidFile: string): number | null {
  try {
    const parsed = Number.parseInt(readFileSync(hostPath(pidFile), "utf8").trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ selftest

export function loopSelftest(): SelftestCase[] {
  const cases: SelftestCase[] = [];

  const transcript = [
    "[pickup] admission=ADMIT budget=4 — load 10.0%",
    "[pickup] lanes=1 budget=4 headroom=1 (one per tick under the 80% ceiling; lanes are already inside busy)",
    "[pickup] queue: 262 ",
    "[pickup] #262 base=origin/develop",
    "[pickup] #262: 'issue-262-x' is already a registered worktree -- a lane has it; removing from the queue.",
    "[pickup] started=2",
  ].join("\n");
  const parsed = parsePickupOutcome(transcript);
  cases.push(check("started=2 is read from the last line", parsed.started === 2, String(parsed.started)));
  cases.push(check("the first line is the admission line, capped at 160 chars", parsed.firstLine === "[pickup] admission=ADMIT budget=4 — load 10.0%", parsed.firstLine));
  cases.push(
    check(
      "the detail excludes the started line so the count is not logged twice",
      parsed.detail.length === 5 && !parsed.detail.some((line) => line.startsWith("[pickup] started=")),
      parsed.detail.join("|"),
    ),
  );
  cases.push(check("no started line means 0, never NaN", parsePickupOutcome("[pickup] the queue is empty.").started === 0, "0"));
  const longDetail = Array.from({ length: 20 }, (_unused, i) => `[pickup] line ${String(i)}`).join("\n");
  cases.push(
    check(
      "the detail keeps the LAST 12 lines",
      parsePickupOutcome(longDetail).detail[0] === "[pickup] line 8" && parsePickupOutcome(longDetail).detail.length === 12,
      parsePickupOutcome(longDetail).detail[0] ?? "",
    ),
  );
  cases.push(check("a 200-char first line is cut at 160", parsePickupOutcome(`[pickup] ${"x".repeat(200)}`).firstLine.length === 160, String(parsePickupOutcome(`[pickup] ${"x".repeat(200)}`).firstLine.length)));

  cases.push(
    check(
      "PR numbers come from the change lines only",
      prNumbers("#264: new PR (checks=none)\n#265: CI started (pending=1)\nnot a change").join(",") === "264,265",
      prNumbers("#264: new PR\n#265: CI started\nnot a change").join(","),
    ),
  );

  type Recorded = { wakes: string[]; said: string[]; ownerLabel: number[] };
  const record = () => {
    const recorded: Recorded = { wakes: [], said: [], ownerLabel: [] };
    return recorded;
  };
  const deps = (recorded: Recorded, world: { pickup: string; prChanges: string; verdicts: Record<number, string>; labelOk: boolean }): LoopDeps => ({
    pickup: () => world.pickup,
    prChanges: () => world.prChanges,
    verdictOf: (pr) => world.verdicts[pr] ?? "",
    labelOwner: (pr) => {
      if (world.labelOk) recorded.ownerLabel.push(pr);
      return world.labelOk;
    },
    wake: (message) => recorded.wakes.push(message),
    say: (line) => recorded.said.push(line),
  });

  // A tick that starts a lane, with nothing on the PR side.
  const started = record();
  const startedTick = tickOnce(
    deps(started, { pickup: transcript, prChanges: "", verdicts: {}, labelOk: false }),
  );
  cases.push(
    check(
      "a tick that started lanes logs the count and wakes once",
      started.said[0] === "tick: [pickup] admission=ADMIT budget=4 — load 10.0% | started=2" &&
        startedTick.started === 2 &&
        started.wakes.length === 1 &&
        started.wakes[0] === "[autopilot] pickup started 2 lane(s). Detail in .scratch/sessions/crew/crew-loop.log",
      started.said.join(" | "),
    ),
  );
  cases.push(
    check(
      "the wake carries a summary, never pickup's transcript",
      started.wakes[0] !== undefined && !started.wakes[0].includes("admission="),
      started.wakes[0] ?? "",
    ),
  );

  // A quiet tick: nothing started, no PR change.
  const quiet = record();
  const quietTick = tickOnce(deps(quiet, { pickup: "[pickup] the queue is empty.", prChanges: "", verdicts: {}, labelOk: false }));
  cases.push(
    check(
      "a quiet tick logs started=0 and wakes nobody",
      quietTick.started === 0 && quiet.wakes.length === 0 && quiet.said[0] === "tick: [pickup] the queue is empty. | started=0",
      quiet.said.join(" | "),
    ),
  );

  // The verdicts a change line triggers, one per branch.
  const verdicts = record();
  const changes = "#264: new PR (checks=none)\n#265: CI finished (pending=0)\n#266: new head";
  tickOnce(
    deps(verdicts, {
      pickup: "[pickup] the queue is empty.",
      prChanges: changes,
      verdicts: {
        264: '{"verdict":"AUTO","reasons":[]}',
        265: '{"verdict":"OWNER","reasons":[]}',
        266: '{"verdict":"REFUSED","reasons":["last reviewed commit is not the head","a comment followed the verdict","third"]}',
      },
      labelOk: true,
    }),
  );
  const said = verdicts.said.join("\n");
  cases.push(check("AUTO is logged as the parent's move, not merged here", said.includes("#264: AUTO -> the parent may merge it (script judges, parent acts)"), said));
  cases.push(check("OWNER labels the PR and says so", said.includes("#265: OWNER -> labelled needs-owner-review") && verdicts.ownerLabel.join(",") === "265", verdicts.ownerLabel.join(",")));
  cases.push(check("REFUSED logs at most two reasons", said.includes("#266: REFUSED -> last reviewed commit is not the head; a comment followed the verdict") && !said.includes("third"), said));
  cases.push(
    check(
      "the PR wake carries the changes and the re-read command",
      verdicts.wakes.length === 1 &&
        verdicts.wakes[0]?.startsWith("[autopilot] PR changes:\n#264: new PR") === true &&
        verdicts.wakes[0]?.includes("bun .scratch/scripts/crew-mergeable.ts <pr>") === true,
      verdicts.wakes[0] ?? "",
    ),
  );

  const noVerdict = record();
  tickOnce(deps(noVerdict, { pickup: "", prChanges: "#270: new PR", verdicts: {}, labelOk: true }));
  cases.push(check("a PR the judge cannot read gets no verdict line (its change line still logs)", noVerdict.said.every((line) => !/^#270: (AUTO|OWNER|REFUSED)/u.test(line)), noVerdict.said.join("|")));
  cases.push(check("a PR change still wakes the parent", noVerdict.wakes.length === 1, String(noVerdict.wakes.length)));

  const unlabellable = record();
  tickOnce(deps(unlabellable, { pickup: "", prChanges: "#265: new head", verdicts: { 265: '{"verdict":"OWNER"}' }, labelOk: false }));
  cases.push(check("an OWNER verdict whose label request failed is not claimed as labelled", unlabellable.said.join("|").includes("labelled needs-owner-review") === false, unlabellable.said.join("|")));

  cases.push(check("parseVerdict survives junk", parseVerdict("not json").verdict === "" && parseVerdict('{"verdict":"AUTO"}').verdict === "AUTO", parseVerdict('{"verdict":"AUTO"}').verdict));

  // The real spawn path: a real child process printing a real `started=` line.
  const fakePickup = join(hostPath("/tmp/crew-loop-selftest"), String(process.pid), "fake-pickup.ts");
  try {
    mkdirSync(join(hostPath("/tmp/crew-loop-selftest"), String(process.pid)), { recursive: true });
    writeFileSync(
      fakePickup,
      'console.log("[pickup] admission=ADMIT budget=9 — load 1.0%");\nconsole.log("[pickup] started=3");\n',
    );
    const cfg: LoopConfig = {
      repoRaw: "D:/projects/mani-project",
      repoPath: process.cwd(),
      stateDir: join(hostPath("/tmp/crew-loop-selftest"), String(process.pid)),
      pidFile: "unused",
      logPath: "unused",
      prState: "unused",
      wakeBin: "unused",
      parentPane: "w48:p1",
      intervalSeconds: 1,
      pickupEntry: fakePickup,
      prWatchEntry: "unused",
      mergeableEntry: "unused",
    };
    const real = record();
    const realTick = tickOnce({
      ...realDeps(cfg),
      prChanges: () => "",
      wake: (message) => real.wakes.push(message),
      say: (line) => real.said.push(line),
    });
    cases.push(
      check(
        "a real child process's started=3 reaches the log",
        realTick.started === 3 && real.said[0]?.endsWith("| started=3") === true,
        real.said.join(" | "),
      ),
    );
    rmSync(join(hostPath("/tmp/crew-loop-selftest"), String(process.pid)), { recursive: true, force: true });
  } catch (error) {
    cases.push(check("a real child process's started=3 reaches the log", false, String(error)));
  }

  return cases;
}

// ----------------------------------------------------------------------- CLI

function main(argv: string[]): number {
  const cfg = config();
  mkdirSync(cfg.stateDir, { recursive: true });
  const command = argv[0] ?? "start";
  switch (command) {
    case "start": {
      const pid = readPid(cfg.pidFile);
      if (pid !== null && processAlive(pid)) {
        console.log(`already running pid ${String(pid)}`);
        return 0;
      }
      const log = openSync(hostPath(cfg.logPath), "a");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run"], {
        cwd: cfg.repoPath,
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
      child.unref();
      writeFileSync(cfg.pidFile, `${String(child.pid ?? 0)}\n`);
      console.log(`started pid ${String(child.pid ?? 0)} — log ${cfg.logPath}`);
      return 0;
    }
    case "stop": {
      const pid = readPid(cfg.pidFile);
      if (pid !== null && processAlive(pid)) {
        try {
          process.kill(pid);
          appendFileSync(hostPath(cfg.logPath), `${utcClock()} stopped pid ${String(pid)}\n`);
        } catch {
          /* already gone between the check and the kill */
        }
      }
      rmSync(hostPath(cfg.pidFile), { force: true });
      console.log("stopped");
      return 0;
    }
    case "status": {
      const pid = readPid(cfg.pidFile);
      if (pid !== null && processAlive(pid)) {
        console.log(`running pid ${String(pid)} — log ${cfg.logPath}`);
      } else {
        console.log("not running");
      }
      return 0;
    }
    default:
      console.error("usage: crew-loop.ts [start|stop|status]");
      return 2;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--selftest") {
    process.exit(report(loopSelftest()));
  }
  if (argv[0] === "run") {
    process.exit(await runLoop(config()));
  }
  process.exit(main(argv));
}
