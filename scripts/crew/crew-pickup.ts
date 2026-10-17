#!/usr/bin/env bun
// crew-pickup.ts — pull the highest-priority item off the AGENT queue and start a lane.
//
// This is the step that was missing. `crew-queue.ts` is the queue and
// `crew-admit.ts` is the policy, but nothing joined them: a queue with four items
// and a 30% CPU sat there because a human had to act. That is exactly the failure
// the queue was built to remove.
//
//   crew-pickup.ts              # admit as many as the machine allows
//   crew-pickup.ts --max 1      # at most one
//   crew-pickup.ts --dry-run    # decide and print, change nothing
//   crew-pickup.ts --why        # --dry-run, and one line per decision
//   crew-pickup.ts --selftest   # prove the guards with fake I/O
//
// The policy lives in ONE place: crew-admit.ts decides ADMIT / HOLD / SHED from
// the CPU window and the e2e slots. This script only asks it and obeys. It never
// re-implements a threshold, so the number in the footer and the number that
// gates a launch cannot disagree.
//
// Priority order comes from the queue file: high, then normal, then low. Two
// items of equal priority keep insertion order.
//
// WHAT THE TYPESCRIPT VERSION KEEPS, LINE FOR LINE
// -----------------------------------------------
// `crew-loop.sh` parses `^\[pickup\] started=N$` out of this stdout and
// `crew-autopilot.ts` matches `/started=([1-9][0-9]*)/`, so the last line is a
// contract, not a report. Every `[pickup]`/`[why]` line is reproduced.
//
// WHAT IT CHANGES, AND WHY
// ------------------------
// 1. The launch message is validated BEFORE `herdr worktree create`. The shell
//    checked `[ -z "$MSG" ]` after the worktree existed and the agent had started,
//    so the refusal left a REGISTERED worktree behind -- and the next tick read that
//    as "a lane already has it", removed the ticket from the queue and never
//    retried. Refusing where the refusal can still be obeyed is the same rule,
//    applied one step earlier.
// 2. The queue is parsed from `crew-queue.ts list` directly rather than by pairing
//    two `sed` streams with `paste`: a note containing a bracket used to pair an
//    issue with the wrong priority.
// 3. The launch message's line separator is LF. The shell's literal carried the
//    repo's CRLF bytes; the prompt is read by a model, not parsed.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { hostPath, winPath } from "./host-path";
import { check, report, type SelftestCase } from "./selftest";

export const DEFAULT_REPO = "D:/projects/mani-project";
/** This repo's lane-name convention, shared by pickup, launch-lane and crew-watch. */
export const LANE_RE = /^(issue|rev|pr|feat|fix|chore|refactor|docs|test|build|ci|perf|style)-/u;
/** 300s is stale enough to recover from a killed pickup, and shorter than a human noticing. */
const LOCK_STALE_SECONDS = 300;
const PROMPT_ATTEMPTS = 3;
const PROMPT_SETTLE_MS = 8000;

export type PickupOptions = { dryRun: boolean; why: boolean; maxCap: number };
export type Admission = { action: string; laneBudget: number | null; reason: string };
export type QueueEntry = { number: number; priority: string };
export type Brief = { path: string; text: string };

export function parseArgs(argv: string[]): PickupOptions | null {
  const options: PickupOptions = { dryRun: false, why: false, maxCap: 99 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--why") {
      options.why = true;
      options.dryRun = true;
    } else if (arg === "--max") {
      i += 1;
      // Bash's `${1:-1}`: a bare `--max` means one lane, not a usage error.
      const parsed = Number.parseInt(argv[i] ?? "1", 10);
      options.maxCap = Number.isFinite(parsed) ? parsed : 1;
    } else if (arg !== undefined) {
      return null;
    }
  }
  return options;
}

/** `3. #259 [low] note` lines; the queue's `queue=1 blocked=1` footer is not an entry. */
export function parseQueueListing(stdout: string): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\d+\. #(\d+) \[([a-z]+)\]/u.exec(line);
    const number = match?.[1];
    const priority = match?.[2];
    if (number === undefined || priority === undefined) continue;
    entries.push({ number: Number(number), priority });
  }
  return entries;
}

/** An item blocked on another PR must not be started: it would collide with it. */
export function candidateIssues(entries: QueueEntry[]): number[] {
  return entries.filter((entry) => entry.priority !== "blocked").map((entry) => entry.number);
}

type HerdrWorkspaces = {
  result?: {
    workspaces?: {
      label?: string;
      workspace_id?: string;
      agent_status?: string;
      worktree?: { repo_name?: string };
    }[];
  };
};

function workspacesOf(json: string): NonNullable<NonNullable<HerdrWorkspaces["result"]>["workspaces"]> {
  try {
    // SAFETY: this is the harness' own `herdr workspace list` payload; a shape change
    // degrades to "no lanes", never to a crash mid-launch.
    const parsed = JSON.parse(json) as HerdrWorkspaces;
    return parsed.result?.workspaces ?? [];
  } catch {
    return [];
  }
}

/**
 * Count only THIS repo's lanes. Counting every workspace whose label matches the
 * lane pattern includes the OTHER project's lanes, so six foreign lanes once read
 * as `lanes=6 budget=6 headroom=0` and held a full queue behind a budget they were
 * not spending.
 */
export function countLanes(workspacesJson: string, repoName: string): number {
  return workspacesOf(workspacesJson).filter(
    (workspace) =>
      LANE_RE.test(workspace.label ?? "") && (workspace.worktree?.repo_name ?? "") === repoName,
  ).length;
}

export function statusOfLabel(workspacesJson: string, label: string): string {
  for (const workspace of workspacesOf(workspacesJson)) {
    if (workspace.label === label) return workspace.agent_status ?? "";
  }
  return "";
}

export function workspaceIdOfLabel(workspacesJson: string, label: string): string {
  for (const workspace of workspacesOf(workspacesJson)) {
    if (workspace.label === label) return workspace.workspace_id ?? "";
  }
  return "";
}

/** A brief declares the issue it serves with a literal `ISSUE: **#N**`. */
export function claimsFor(issue: number, briefs: Brief[]): string[] {
  return briefs.filter((brief) => brief.text.includes(`ISSUE: **#${String(issue)}**`)).map((brief) => brief.path);
}

/**
 * A brief may declare the ref to branch from. Strip markdown punctuation: writing
 * the base as ``origin/x`` in backticks is the natural thing to do, and the
 * backticks were captured as part of the ref, so `worktree create --base` failed
 * and every launch reported "started but NEVER accepted its brief".
 */
export function baseOf(briefText: string): string {
  for (const line of briefText.split("\n")) {
    if (!line.startsWith("BASE:")) continue;
    const field = line.split(/\s+/u)[1] ?? "";
    return field.replace(/[`*]/gu, "");
  }
  return "";
}

/** The lane label is the brief's file name, and it must satisfy the convention. */
export function labelOf(briefPath: string): string {
  return basename(briefPath).replace(/\.md$/u, "");
}

/**
 * Empty when the launch may proceed, otherwise the reason it must not. Bash's own
 * version of this check lived after the worktree was created; this one is called
 * before, so a refusal leaves nothing behind.
 */
export function validateLaunch(message: string, brief: string, briefExists: boolean): string {
  if (message.trim() === "") return `empty message or missing brief (${brief})`;
  if (!briefExists) return `empty message or missing brief (${brief})`;
  return "";
}

export type Run = { code: number; stdout: string; stderr: string };

export type PickupEnv = {
  /** The path as a human writes it (`D:/projects/mani-project` and `/d/...` both appear). */
  repoRaw: string;
  repoPath: string;
  repoName: string;
  briefDir: string;
  sessionDir: string;
  laneRootRaw: string;
  laneRootWin: string;
  admissionArgs: string[];
  queueScript: string;
  runner: (command: string, args: string[], cwd: string, timeoutMs: number) => Run;
  readBriefs: () => Brief[];
  readText: (path: string) => string;
  exists: (path: string) => boolean;
  pause: (ms: number) => Promise<void>;
  out: (line: string) => void;
  now: () => number;
  wakeBin: string;
  parentPane: string;
  parentWorkspace: string;
  /** Injected so the empty-message guard can be exercised without a side effect. */
  buildMessage: (issue: number, brief: string) => string;
};

export function buildLaunchMessage(issue: number, brief: string, repo: string): string {
  return LAUNCH_LINES.map((line) =>
    line.replaceAll("${issue}", String(issue)).replaceAll("${brief}", brief).replaceAll("${repo}", repo),
  ).join("\n");
}

function realRunner(command: string, args: string[], cwd: string, timeoutMs: number): Run {
  const done = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: done.status ?? -1, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
}

export function realEnv(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): PickupEnv {
  const repoRaw = env.CREW_REPO ?? DEFAULT_REPO;
  const repoPath = hostPath(repoRaw, platform);
  const laneRootRaw = env.CREW_WT_ROOT ?? "/d/projects/mani-worktrees";
  const sessionRaw = env.CREW_SESSION_DIR ?? `${repoRaw}/.scratch/sessions/crew`;
  const sessionDir = hostPath(sessionRaw, platform);
  const briefDir = `${sessionRaw}/briefs`;
  return {
    repoRaw,
    repoPath,
    repoName: basename(repoPath),
    briefDir,
    sessionDir,
    laneRootRaw,
    laneRootWin: hostPath(laneRootRaw, platform),
    admissionArgs: [`${repoRaw}/.scratch/scripts/crew-admit.ts`],
    queueScript: `${repoRaw}/.scratch/scripts/crew-queue.ts`,
    runner: realRunner,
    readBriefs: () => {
      // The DISPLAY path is the raw one (`/tmp/...` as a caller typed it); the read goes
      // through hostPath. Keeping them separate is what makes the printed path identical
      // to the shell's while the file access still works on Windows.
      const dirHost = join(sessionDir, "briefs");
      let names: string[] = [];
      try {
        names = readdirSync(dirHost).filter((name) => name.endsWith(".md"));
      } catch {
        return [];
      }
      return names.map((name) => {
        try {
          return { path: `${briefDir}/${name}`, text: readFileSync(join(dirHost, name), "utf8") };
        } catch {
          return { path: `${briefDir}/${name}`, text: "" };
        }
      });
    },
    readText: (path) => {
      try {
        return readFileSync(hostPath(path, platform), "utf8");
      } catch {
        return "";
      }
    },
    exists: (path) => {
      try {
        statSync(hostPath(path, platform));
        return true;
      } catch {
        return false;
      }
    },
    pause: (ms) => sleep(ms),
    out: (line) => {
      console.log(line);
    },
    now: () => Date.now(),
    wakeBin: env.HERDR_WAKE_BIN ?? join(env.HOME ?? "", ".pi", "agent", "bin", "herdr-wake.sh"),
    parentPane: env.HERDR_PANE_ID ?? "w48:p1",
    parentWorkspace: env.HERDR_WORKSPACE_ID ?? "w48",
    buildMessage: (issue, brief) => buildLaunchMessage(issue, brief, repoRaw),
  };
}

function admissionOf(env: PickupEnv): Admission {
  const done = env.runner("bun", env.admissionArgs.concat(["--json", "--window", "20", "--interval", "4"]), env.repoPath, 90_000);
  if (done.code !== 0) return { action: "HOLD", laneBudget: null, reason: "" };
  try {
    // SAFETY: crew-admit.ts owns this payload; an unreadable one means HOLD, which is
    // the safe side for a script whose job is to start work.
    const parsed = JSON.parse(done.stdout) as { action?: string; laneBudget?: number; reason?: string };
    return {
      action: parsed.action ?? "HOLD",
      laneBudget: parsed.laneBudget ?? null,
      reason: parsed.reason ?? "",
    };
  } catch {
    return { action: "HOLD", laneBudget: null, reason: "" };
  }
}

function queueListing(env: PickupEnv): QueueEntry[] {
  const done = env.runner("bun", [env.queueScript, "list"], env.repoPath, 30_000);
  return parseQueueListing(done.stdout);
}

function queueRemove(env: PickupEnv, issue: number): void {
  env.runner("bun", [env.queueScript, "remove", String(issue)], env.repoPath, 30_000);
}

function worktreeListOf(env: PickupEnv): string {
  return env.runner("git", ["worktree", "list"], env.repoPath, 30_000).stdout;
}

function workspacesJson(env: PickupEnv): string {
  return env.runner("herdr", ["workspace", "list"], env.repoPath, 30_000).stdout;
}

/** The pickup lock, as a value: taken or not, and how to let it go. */
type Lock = { held: boolean; release: () => void };

function takeLock(env: PickupEnv): Lock {
  const lock = join(env.sessionDir, "pickup.lock");
  mkdirSync(env.sessionDir, { recursive: true });
  const claim = (): boolean => {
    try {
      mkdirSync(lock);
      return true;
    } catch {
      return false;
    }
  };
  if (!claim()) {
    let ageSeconds = Number.POSITIVE_INFINITY;
    try {
      ageSeconds = (env.now() - statSync(lock).mtimeMs) / 1000;
    } catch {
      ageSeconds = Number.POSITIVE_INFINITY;
    }
    if (ageSeconds > LOCK_STALE_SECONDS) {
      rmSync(lock, { recursive: true, force: true });
      if (!claim()) {
        env.out("[pickup] another pickup holds the lock.");
        return { held: false, release: () => undefined };
      }
    } else {
      env.out(`[pickup] another pickup holds the lock (${String(Math.floor(ageSeconds))}s old); skipping this tick.`);
      return { held: false, release: () => undefined };
    }
  }
  return {
    held: true,
    release: () => {
      rmSync(lock, { recursive: true, force: true });
    },
  };
}

export async function runPickup(env: PickupEnv, options: PickupOptions): Promise<number> {
  const lock = takeLock(env);
  if (!lock.held) return 0;
  try {
    return await pickupBody(env, options);
  } finally {
    lock.release();
  }
}

async function pickupBody(env: PickupEnv, options: PickupOptions): Promise<number> {
  const note = (issue: number | string, reason: string): void => {
    if (options.why) env.out(`[why] #${String(issue)}: ${reason}`);
  };

  // ---- 1. admission: one source of truth for CPU + e2e slots -------------------
  const admission = admissionOf(env);
  env.out(`[pickup] admission=${admission.action} budget=${String(admission.laneBudget)} — ${admission.reason}`);
  const entries = queueListing(env);

  if (admission.action !== "ADMIT") {
    env.out("[pickup] holding: the policy is not admitting. Nothing started.");
    // `--why` must still explain the ITEMS here. Exiting before the per-item pass made
    // the most common case -- "there is work and nothing is starting" -- print the
    // one-line host reason and no item detail, which is the case the flag exists for.
    const held = candidateIssues(entries);
    if (options.why && held.length > 0) {
      env.out(`[why] every item below is held by the HOST, not by the queue: admission=${admission.action} (${admission.reason})`);
      for (const issue of held) {
        env.out(`[why] #${String(issue)}: ready to pick, blocked by admission=${admission.action} (${admission.reason})`);
      }
    }
    return 0;
  }

  // ---- 2. how many lanes already exist ----------------------------------------
  // An unusable budget is not a green light. `crew-admit` returned `laneBudget: null`
  // (NaN through JSON) and the bash arithmetic died with "unbound variable" -- a
  // silent crash in the one script that starts lanes.
  if (!/^\d+$/u.test(String(admission.laneBudget))) {
    // A `null` budget is the case this exists for: JSON has no NaN, so crew-admit's
    // NaN arrived as null and the bash arithmetic died on it.
    env.out(`[pickup] holding: admission returned an unusable budget ('${String(admission.laneBudget)}').`);
    return 0;
  }
  const running = countLanes(workspacesJson(env), env.repoName);
  let headroom = 1;
  env.out(
    `[pickup] lanes=${String(running)} budget=${String(admission.laneBudget)} headroom=${String(headroom)} (one per tick under the 80% ceiling; lanes are already inside busy)`,
  );
  if (headroom < 1) {
    env.out("[pickup] holding: no headroom for another lane.");
    return 0;
  }
  if (headroom > options.maxCap) headroom = options.maxCap;

  // ---- 3. the queue, highest priority first ----------------------------------
  const items = candidateIssues(entries);
  if (items.length === 0) {
    env.out("[pickup] the queue is empty.");
    return 0;
  }
  env.out(`[pickup] queue: ${items.join(" ")} `);

  const briefs = env.readBriefs();
  let started = 0;

  for (const issue of items) {
    if (started >= headroom) break;

    // A brief declares the issue it serves; the file name is the lane label. That
    // convention already exists for launch-lane.sh, so pickup reuses it rather
    // than inventing a second mapping.
    const claims = claimsFor(issue, briefs);
    if (claims.length > 1) {
      // Which brief wins must never be an accident of the alphabet. Picking one
      // silently is how a lane gets launched against a stale base with instructions
      // nobody wrote for this attempt.
      const named = claims.map((path) => basename(path)).join(" ");
      env.out(`[pickup] skip #${String(issue)}: ${String(claims.length)} briefs claim it (${named}) - retire all but one.`);
      note(issue, `${String(claims.length)} briefs claim it: ${named}`);
      continue;
    }
    const brief = claims[0];
    if (brief === undefined) {
      env.out(`[pickup] skip #${String(issue)}: no brief under ${env.briefDir} declares it.`);
      note(issue, `no brief declares it (looked in ${env.briefDir})`);
      continue;
    }
    const label = labelOf(brief);
    if (!LANE_RE.test(label)) {
      env.out(`[pickup] skip #${String(issue)}: label '${label}' does not match the lane convention.`);
      note(issue, `label '${label}' violates the lane naming convention`);
      continue;
    }

    const base = baseOf(env.readText(brief)) || "origin/develop";
    env.out(`[pickup] #${String(issue)} base=${base}`);
    const wtRaw = `${env.laneRootRaw}/${label}`;
    const wtHost = hostPath(wtRaw);
    const wtWin = `${env.laneRootWin}/${label}`;

    // A registered git worktree, NOT merely a directory. A launch that dies between
    // `git worktree add` and `herdr agent start` leaves a plain directory behind, and
    // `[ -d ]` then skips that ticket forever -- the abandoned-worktree bug, caused by
    // a crash rather than by an abandoned branch.
    if (worktreeListOf(env).includes(`[${label}]`)) {
      env.out(`[pickup] #${String(issue)}: '${label}' is already a registered worktree -- a lane has it; removing from the queue.`);
      queueRemove(env, issue);
      note(issue, `'${label}' was already a registered worktree, so a lane holds it (removed from the queue)`);
      continue;
    }
    if (env.exists(wtHost)) {
      // Leftover from a failed launch: no git registration, so it cannot be used and
      // cannot be trusted. Remove it loudly rather than skip silently.
      env.out(`[pickup] #${String(issue)}: removing an UNREGISTERED leftover dir at ${wtRaw} (failed launch)`);
      // `rm -rf` is not enough on Windows. msys `rm` chokes on the long paths and
      // reparse points bun leaves under `node_modules`, so the leftover dir survives,
      // and it then blocks that ticket forever.
      rmSync(wtHost, { recursive: true, force: true });
      if (env.exists(wtHost)) {
        env.runner("cmd", ["/c", "rmdir", "/s", "/q", winPath(wtHost)], env.repoPath, 60_000);
      }
      if (env.exists(wtHost)) {
        env.out(`[pickup] could not remove it; leaving #${String(issue)} queued.`);
        note(issue, `a leftover dir at ${wtRaw} could not be removed (a process is holding files); the launch is stuck here`);
        continue;
      }
    }

    if (options.dryRun) {
      env.out(`[pickup] WOULD start #${String(issue)} as '${label}' from ${brief}`);
      started += 1;
      continue;
    }

    env.out(`[pickup] starting #${String(issue)} as '${label}'`);

    // The launch message. It is REBUILT here on purpose, and the guard is the reason:
    // a previous edit of the bash block deleted the definition while keeping every use
    // of it, so pickup sent an EMPTY prompt. herdr accepted it (exit 0, because an
    // empty submission is perfectly valid), the lane stayed idle, and three worktrees
    // were created and abandoned with nothing in their sessions. "Did the command
    // succeed" cannot catch that; refusing to send nothing at all can.
    const message = env.buildMessage(issue, brief);
    const refusal = validateLaunch(message, brief, env.exists(brief));
    if (refusal !== "") {
      env.out(`[pickup] #${String(issue)}: refusing to launch — ${refusal}; leaving it queued.`);
      note(issue, `refused to launch: ${refusal}`);
      continue;
    }

    // Check the exit. This used to be `>/dev/null 2>&1` with no check, so a failed
    // create still ran the mkdir, wrote a manifest, and started an agent on a pane
    // that never existed. A launch that cannot create its worktree must stop HERE and
    // leave the item queued.
    const created = env.runner(
      "herdr",
      ["worktree", "create", "--cwd", env.repoRaw, "--base", base, "--branch", label, "--path", wtWin, "--label", label, "--no-focus"],
      env.repoPath,
      120_000,
    );
    if (created.code !== 0 || created.stdout.includes('"error"')) {
      env.out(`[pickup] #${String(issue)}: worktree create FAILED; left in the queue. ${(created.stdout + created.stderr).slice(0, 200)}`);
      note(issue, "worktree create failed; the item is still queued");
      continue;
    }
    const opened = env.runner(
      "herdr",
      ["worktree", "open", "--cwd", env.repoRaw, "--path", wtWin, "--label", label, "--no-focus"],
      env.repoPath,
      120_000,
    );
    const pane = /"pane_id":"([^"]*)"/u.exec(opened.stdout)?.[1] ?? "";
    if (pane === "") {
      env.out(`[pickup] #${String(issue)}: no pane came back from worktree open; left in the queue. ${(opened.stdout + opened.stderr).slice(0, 200)}`);
      note(issue, "worktree open returned no pane; the item is still queued");
      continue;
    }
    mkdirSync(join(wtHost, ".scratch", "sessions", "crew"), { recursive: true });
    writeFileSync(
      join(wtHost, ".scratch", "sessions", "crew", `${label}.manifest.json`),
      `{\n  "parentPaneId": "${env.parentPane}",\n  "parentWorkspaceId": "${env.parentWorkspace}",\n  "issue": "${String(issue)}",\n  "launchedAt": "${new Date(env.now()).toISOString()}"\n}\n`,
    );

    // Start the agent BARE, then deliver the brief through the one mechanism that proves
    // delivery: `herdr agent prompt` rejects silently mid-dialog, and
    // `herdr agent start ... -- "$MSG"` is refused outright ("cannot be encoded safely
    // for the target shell").
    const start = env.runner(
      "herdr",
      ["agent", "start", label, "--kind", "pi", "--pane", pane, "--timeout", "120000"],
      env.repoPath,
      180_000,
    );
    if (start.code !== 0) {
      env.out(`[pickup] #${String(issue)}: agent start failed; leaving #${String(issue)} queued.`);
      note(issue, "herdr agent start failed; the item is still queued");
      continue;
    }

    let accepted = false;
    for (let attempt = 0; attempt < PROMPT_ATTEMPTS && !accepted; attempt += 1) {
      // `--wait` blocks until herdr has accepted the submission, so a rejection is
      // reported here instead of vanishing. This is the primary path.
      const prompted = env.runner("herdr", ["agent", "prompt", label, message, "--wait"], env.repoPath, 120_000);
      if (prompted.code !== 0) {
        env.out(`[pickup] #${String(issue)}: prompt was NOT accepted: ${(prompted.stdout + prompted.stderr).slice(0, 140)}`);
        // Fallback: the wake script waits out a mid-dialog target and proves delivery.
        if (env.exists(env.wakeBin)) {
          env.runner("bash", [env.wakeBin, pane, message, "60", "5"], env.repoPath, 90_000);
        }
      }
      await env.pause(PROMPT_SETTLE_MS);
      const status = statusOfLabel(workspacesJson(env), label);
      if (status === "working" || status === "done") accepted = true;
    }

    if (accepted) {
      // Out of the queue only once a lane actually took it: a launch that never
      // accepted its brief must not silently delete the work item.
      queueRemove(env, issue);
      env.out(`[pickup] #${String(issue)} -> ${label} (${pane}) accepted; removed from queue`);
      started += 1;
      continue;
    }

    // DO NOT leave the worktree registered. It used to stay, and the next tick then
    // reported "already a registered worktree" and skipped the ticket -- forever. A
    // failed launch must be reversible, or it is a deadlock rather than a delay.
    env.out(`[pickup] #${String(issue)} -> ${label} started but NEVER accepted its brief; tearing the launch down so the ticket can retry`);
    env.runner("git", ["worktree", "remove", "--force", wtRaw], env.repoPath, 120_000);
    if (env.exists(wtHost)) {
      env.runner("cmd", ["/c", "rmdir", "/s", "/q", winPath(wtHost)], env.repoPath, 60_000);
    }
    env.runner("git", ["worktree", "prune"], env.repoPath, 30_000);
    env.runner("git", ["branch", "-D", label], env.repoPath, 30_000);
    const workspaceId = workspaceIdOfLabel(workspacesJson(env), label);
    if (workspaceId !== "") {
      env.runner("herdr", ["workspace", "close", workspaceId], env.repoPath, 60_000);
    }
    env.out(`[pickup] #${String(issue)} left in the queue; next tick may retry it`);
    note(issue, "started but never accepted its brief; the launch was torn down so it can retry");
  }

  if (options.why) {
    env.out(
      `[pickup] --- why: admission=${admission.action} budget=${String(admission.laneBudget)} headroom=${String(headroom)} lanes=${String(running)} ---`,
    );
    if (admission.action !== "ADMIT") {
      env.out(`[why] EVERY item: admission=${admission.action} (${admission.reason}) - the host, not the queue`);
    }
  }
  env.out(`[pickup] started=${String(started)}`);
  return 0;
}

// The launch message, verbatim from crew-pickup.sh's `MSG=` literal.
const LAUNCH_LINES: string[] = [
  "CREW LANE — issue #${issue}.",
  "THE BRIEF IS THE SPECIFICATION: read ${brief} and follow it over anything in this message. Its acceptance criteria are what you build and prove.",
  "Then read .agents/skills/feature-implement/SKILL.md, then docs/engineering-workflow.md.",
  "LESSONS: read .agents/wisdom/README.md and grep .agents/wisdom/ for what bears on this task. Name the lessons you applied and the ones you deliberately did not, with the reason.",
  "AUTHORITY: commit only. The parent owns push, PR, review and merge. Never write .agents/wisdom/ — report a candidate lesson in crew_report instead.",
  "EVIDENCE (the standing rule, issue #259): if the change is VISUAL, leave before/after images AND a video at real user pace. If it is NOT visual, leave the MEASUREMENTS — the failing-first run (red before, green after) with the failing assertion named, the ablation proof that any new guard actually bites, before/after numbers, and the decisions you took with the reason. A test that never failed proves nothing. Put it in the commit message body and summarise it in crew_report.",
  "PATHS: the shared e2e slot script is ${repo}/.scratch/scripts/e2e-slot.sh — the MAIN repo, never your worktree. NEVER search from / or D:\\; two \\`find / -name e2e-slot.sh\\` scans ran for an hour each and pinned the box. Scope every find/grep/rg to the repo root or a subdirectory.",
  "CODEMODE -- USE IT AS MUCH AS POSSIBLE, IT IS THE DEFAULT. Reach for it first, not last: one codemode script replaces a chain of shell commands and file reads, collapses a sweep or an enumeration into a single step, and returns only the table instead of a wall of output. Write the script, run it, read the result.",
  "Fall back to plain bash/read/edit ONLY when codemode cannot do the job, or when using it would be HEAVIER or MORE EXPENSIVE than doing it directly -- editing a file, running one command whose output IS the answer, or needing the full control flow of a single file. Falling back is correct in those cases; skipping codemode out of habit is not. State in your report where you used codemode and where you did not, and why.",
  "Run bun install first. Commit before reporting, then crew_report with the commit SHA and the evidence.",
];

// ------------------------------------------------------------------ selftest

type FakeWorld = {
  briefs: Brief[];
  queueList: string;
  worktrees: string;
  workspaces: string;
  statusAfterPrompt: string;
  createCode: number;
  createOut: string;
  openOut: string;
  startCode: number;
  promptCode: number;
  admission: string;
  existingPaths: string[];
  /** The empty-message guard is only exercisable if the builder can be made to fail. */
  messageOverride?: string;
  lockHeldBy?: string;
};

type Fake = {
  env: PickupEnv;
  calls: string[];
  removed: string[];
  lines: string[];
};

function fakeEnv(world: Partial<FakeWorld>): Fake {
  const calls: string[] = [];
  const removed: string[] = [];
  const lines: string[] = [];
  const prompted = { done: false };
  const sessionDir = join(hostPath("/tmp/crew-pickup-selftest"), String(process.pid));
  const world2: FakeWorld = {
    briefs: [],
    queueList: "",
    worktrees: "",
    workspaces: '{"result":{"workspaces":[{"label":"issue-262-x","workspace_id":"w1","agent_status":"idle","worktree":{"repo_name":"mani-project"}}]}}',
    statusAfterPrompt: "working",
    createCode: 0,
    createOut: '{"result":{"worktree":{"path":"x"}}}',
    openOut: '{"result":{"pane":{"pane_id":"w99:p1"}}}',
    startCode: 0,
    promptCode: 0,
    admission: '{"action":"ADMIT","laneBudget":4,"reason":"load 10.0%"}',
    existingPaths: [],
    ...world,
  };
  if (world.lockHeldBy !== undefined) {
    mkdirSync(join(sessionDir, "pickup.lock"), { recursive: true });
  } else {
    rmSync(join(sessionDir, "pickup.lock"), { recursive: true, force: true });
  }
  const runner: PickupEnv["runner"] = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (command === "bun" && args[1] === "list") return { code: 0, stdout: world2.queueList, stderr: "" };
    if (command === "bun" && args[1] === "remove") {
      removed.push(args[2] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "bun") return { code: 0, stdout: world2.admission, stderr: "" };
    if (command === "git" && args[0] === "worktree" && args[1] === "list") {
      return { code: 0, stdout: world2.worktrees, stderr: "" };
    }
    if (command === "herdr" && args[0] === "workspace" && args[1] === "list") {
      const status = prompted.done ? world2.statusAfterPrompt : "idle";
      const body = world2.workspaces.replace(/"agent_status":"[^"]*"/gu, `"agent_status":"${status}"`);
      return { code: 0, stdout: body, stderr: "" };
    }
    if (command === "herdr" && args[0] === "worktree" && args[1] === "create") {
      return { code: world2.createCode, stdout: world2.createOut, stderr: "" };
    }
    if (command === "herdr" && args[0] === "worktree" && args[1] === "open") {
      return { code: 0, stdout: world2.openOut, stderr: "" };
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
      return { code: world2.startCode, stdout: "", stderr: "" };
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
      if (world2.promptCode === 0) prompted.done = true;
      return { code: world2.promptCode, stdout: "", stderr: "refused" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    removed,
    lines,
    env: {
      repoRaw: "D:/projects/mani-project",
      repoPath: hostPath("D:/projects/mani-project"),
      repoName: "mani-project",
      briefDir: join(sessionDir, "briefs"),
      sessionDir,
      laneRootRaw: "/d/projects/mani-worktrees",
      laneRootWin: "D:/projects/mani-worktrees",
      admissionArgs: ["/repo/scripts/crew-admit.ts"],
      queueScript: "/repo/.scratch/scripts/crew-queue.ts",
      runner,
      readBriefs: () => world2.briefs,
      readText: (path) => world2.briefs.find((brief) => brief.path === path)?.text ?? "",
      exists: (path) => world2.existingPaths.includes(path) || world2.briefs.some((brief) => brief.path === path),
      pause: async () => undefined,
      out: (line) => lines.push(line),
      now: () => Date.now(),
      wakeBin: "/nope/herdr-wake.sh",
      parentPane: "w48:p1",
      parentWorkspace: "w48",
      buildMessage: (issue, brief) => world2.messageOverride ?? buildLaunchMessage(issue, brief, "D:/projects/mani-project"),
    },
  };
}

const brief = (name: string, text: string): Brief => ({ path: `/briefs/${name}`, text });
const declared = (issue: number): string => `# ISSUE: **#${String(issue)}**\nBASE: \`origin/develop\`\n`;

export async function pickupSelftest(): Promise<SelftestCase[]> {
  const cases: SelftestCase[] = [];
  const ran = async (world: Partial<FakeWorld>, options: Partial<PickupOptions> = {}): Promise<Fake & { code: number }> => {
    const fake = fakeEnv(world);
    const code = await runPickup(fake.env, { dryRun: true, why: false, maxCap: 99, ...options });
    return { ...fake, code };
  };
  const joined = (fake: Fake): string => fake.lines.join("\n");

  cases.push(check("--max without a value means one lane, as bash's ${1:-1} did", parseArgs(["--max"])?.maxCap === 1, JSON.stringify(parseArgs(["--max"]))));
  cases.push(check("an unknown flag is a usage error", parseArgs(["--wat"]) === null, "parseArgs([--wat]) !== null"));
  cases.push(
    check(
      "--why implies --dry-run, --max sets the cap",
      parseArgs(["--why", "--max", "2"])?.dryRun === true && parseArgs(["--why", "--max", "2"])?.maxCap === 2,
      JSON.stringify(parseArgs(["--why", "--max", "2"])),
    ),
  );
  const listing = "1. #260 [blocked] blocked on #254\n2. #262 [high] chore(scripts)\n3. #255 [normal] x\nqueue=3 blocked=1";
  cases.push(
    check(
      "the queue footer is not an entry, and blocked is not a candidate",
      parseQueueListing(listing).length === 3 && candidateIssues(parseQueueListing(listing)).join(",") === "262,255",
      candidateIssues(parseQueueListing(listing)).join(","),
    ),
  );
  cases.push(
    check(
      "a note with a bracket cannot mispair an issue and a priority",
      candidateIssues(parseQueueListing("1. #7 [high] touches [blocked] logic"))[0] === 7,
      JSON.stringify(parseQueueListing("1. #7 [high] touches [blocked] logic")),
    ),
  );
  cases.push(
    check(
      "only this repo's lane workspaces are counted",
      countLanes('{"result":{"workspaces":[{"label":"issue-1-a","worktree":{"repo_name":"mani-project"}},{"label":"fix-9-b","worktree":{"repo_name":"tuari"}},{"label":"random","worktree":{"repo_name":"mani-project"}}]}}', "mani-project") === 1,
      "countLanes",
    ),
  );
  cases.push(check("BASE: strips backticks and asterisks", baseOf("BASE: `origin/fix-1`\n") === "origin/fix-1" && baseOf("BASE: **origin/x**\n") === "origin/x", baseOf("BASE: `origin/fix-1`\n")));
  cases.push(check("a brief declares its issue literally", claimsFor(7, [brief("issue-7.md", declared(7)), brief("other.md", "no claim")]).length === 1, claimsFor(7, [brief("issue-7.md", declared(7))]).join(",")));

  // THE property rule 3 names: refuse to launch with an empty message or a missing brief.
  const empty = await ran(
    {
      briefs: [brief("issue-262-x.md", declared(262))],
      queueList: "1. #262 [high] x\nqueue=1 blocked=0",
      messageOverride: "",
    },
    { dryRun: false },
  );
  cases.push(
    check(
      "an empty launch message is refused",
      joined(empty).includes("[pickup] #262: refusing to launch — empty message or missing brief") && joined(empty).includes("[pickup] started=0"),
      joined(empty),
    ),
  );
  cases.push(
    check(
      "the refusal happens BEFORE any worktree exists",
      !empty.calls.some((call) => call.includes("worktree create")) && !empty.calls.some((call) => call.includes("agent start")),
      empty.calls.join(" | "),
    ),
  );
  cases.push(
    check(
      "a refused launch leaves the issue queued",
      empty.removed.length === 0,
      empty.removed.join(","),
    ),
  );
  const emptyWithGuardAblated = await ran(
    {
      briefs: [brief("issue-262-x.md", declared(262))],
      queueList: "1. #262 [high] x\nqueue=1 blocked=0",
    },
    { dryRun: false },
  );
  cases.push(
    check(
      "ablation: the same world with a non-empty message launches, so the refusal is the guard biting",
      emptyWithGuardAblated.calls.some((call) => call.includes("worktree create")),
      emptyWithGuardAblated.calls.join(" | "),
    ),
  );

  const noBrief = await ran({ briefs: [], queueList: "1. #262 [high] x\nqueue=1 blocked=0" }, { dryRun: false });
  cases.push(
    check(
      "a missing brief is refused before anything is created",
      joined(noBrief).includes("[pickup] skip #262: no brief under") &&
        !noBrief.calls.some((call) => call.includes("worktree create")) &&
        joined(noBrief).includes("[pickup] started=0"),
      joined(noBrief),
    ),
  );

  const twoClaims = await ran(
    {
      briefs: [brief("issue-262-a.md", declared(262)), brief("issue-262-b.md", declared(262))],
      queueList: "1. #262 [high] x\nqueue=1 blocked=0",
    },
    { dryRun: false },
  );
  cases.push(
    check(
      "two briefs claiming one issue is a skip, with both names",
      joined(twoClaims).includes("skip #262: 2 briefs claim it (issue-262-a.md issue-262-b.md) - retire all but one.") &&
        !twoClaims.calls.some((call) => call.includes("worktree create")),
      joined(twoClaims),
    ),
  );

  const badLabel = await ran({
    briefs: [brief("notes.md", declared(262))],
    queueList: "1. #262 [high] x\nqueue=1 blocked=0",
  }, { dryRun: false });
  cases.push(
    check(
      "a label outside the convention is a skip",
      joined(badLabel).includes("skip #262: label 'notes' does not match the lane convention."),
      joined(badLabel),
    ),
  );

  const dry = await ran({
    briefs: [brief("issue-262-x.md", declared(262))],
    queueList: "1. #262 [high] x\nqueue=1 blocked=0",
  });
  cases.push(
    check(
      "--dry-run says what it would do and creates nothing",
      joined(dry).includes("[pickup] WOULD start #262 as 'issue-262-x' from /briefs/issue-262-x.md") &&
        joined(dry).includes("[pickup] started=1") &&
        !dry.calls.some((call) => call.includes("worktree create")) &&
        dry.removed.length === 0,
      joined(dry),
    ),
  );
  cases.push(
    check(
      "the last line is the loop's contract: [pickup] started=N",
      dry.lines[dry.lines.length - 1] === "[pickup] started=1",
      JSON.stringify(dry.lines[dry.lines.length - 1]),
    ),
  );
  cases.push(check("the queue echo keeps the shell's trailing space", joined(dry).includes("[pickup] queue: 262 "), JSON.stringify(dry.lines.find((line) => line.startsWith("[pickup] queue")) ?? "")));

  const real = {
    briefs: [brief("issue-262-x.md", declared(262))],
    queueList: "1. #262 [high] x\nqueue=1 blocked=0",
  };
  const accepted = await ran(real, { dryRun: false });
  cases.push(
    check(
      "an accepted prompt removes the issue from the queue",
      joined(accepted).includes("[pickup] #262 -> issue-262-x (w99:p1) accepted; removed from queue") &&
        accepted.removed.join(",") === "262" &&
        joined(accepted).includes("[pickup] started=1"),
      joined(accepted),
    ),
  );
  cases.push(
    check(
      "the manifest is written with the issue and the parent pane",
      accepted.calls.some((call) => call.includes("agent start issue-262-x --kind pi --pane w99:p1")),
      accepted.calls.join(" | "),
    ),
  );

  const createFailed = await ran({ ...real, createCode: 1, createOut: "boom" }, { dryRun: false });
  cases.push(
    check(
      "a failed worktree create leaves the item queued and starts no agent",
      joined(createFailed).includes("worktree create FAILED; left in the queue.") &&
        !createFailed.calls.some((call) => call.includes("agent start")) &&
        createFailed.removed.length === 0 &&
        joined(createFailed).includes("[pickup] started=0"),
      joined(createFailed),
    ),
  );

  const errorField = await ran({ ...real, createCode: 0, createOut: '{"error":"cannot be encoded"}' }, { dryRun: false });
  cases.push(
    check(
      "an {\"error\"} payload on exit 0 is still a failure",
      joined(errorField).includes("worktree create FAILED; left in the queue."),
      joined(errorField),
    ),
  );

  const noPane = await ran({ ...real, openOut: '{"result":{}}' }, { dryRun: false });
  cases.push(
    check(
      "no pane from worktree open leaves the item queued",
      joined(noPane).includes("no pane came back from worktree open; left in the queue.") && !noPane.calls.some((call) => call.includes("agent start")),
      joined(noPane),
    ),
  );

  const startFailed = await ran({ ...real, startCode: 1 }, { dryRun: false });
  cases.push(
    check(
      "a failed agent start leaves the item queued",
      joined(startFailed).includes("agent start failed; leaving #262 queued.") && startFailed.removed.length === 0,
      joined(startFailed),
    ),
  );

  const rejected = await ran({ ...real, promptCode: 1, statusAfterPrompt: "idle" }, { dryRun: false });
  cases.push(
    check(
      "a prompt rejected 3x tears the launch down and retries next tick",
      joined(rejected).includes("started but NEVER accepted its brief; tearing the launch down so the ticket can retry") &&
        rejected.calls.some((call) => call.includes("worktree remove --force /d/projects/mani-worktrees/issue-262-x")) &&
        rejected.calls.some((call) => call.includes("branch -D issue-262-x")) &&
        rejected.calls.some((call) => call.includes("workspace close w1")) &&
        rejected.removed.length === 0 &&
        joined(rejected).includes("[pickup] started=0"),
      joined(rejected),
    ),
  );
  cases.push(
    check(
      "the rejected prompt is reported before the teardown",
      joined(rejected).includes("prompt was NOT accepted:"),
      joined(rejected),
    ),
  );

  const registered = await ran(
    {
      ...real,
      worktrees: "worktree D:/projects/mani-project\nworktree D:/projects/mani-worktrees/issue-262-x [issue-262-x]",
    },
    { dryRun: false },
  );
  cases.push(
    check(
      "an already-registered worktree removes the ticket and launches nothing",
      joined(registered).includes("'issue-262-x' is already a registered worktree -- a lane has it; removing from the queue.") &&
        registered.removed.join(",") === "262" &&
        !registered.calls.some((call) => call.includes("worktree create")),
      joined(registered),
    ),
  );

  const held = await ran({ ...real, admission: '{"action":"HOLD","laneBudget":0,"reason":"load 95.0%"}' }, { dryRun: false });
  cases.push(
    check(
      "admission HOLD starts nothing",
      joined(held).includes("[pickup] admission=HOLD budget=0 — load 95.0%") &&
        joined(held).includes("[pickup] holding: the policy is not admitting. Nothing started.") &&
        !joined(held).includes("started=") &&
        held.lines.length === 2,
      joined(held),
    ),
  );

  const heldWhy = await ran(
    { ...real, admission: '{"action":"HOLD","laneBudget":0,"reason":"load 95.0%"}' },
    { dryRun: true, why: true },
  );
  cases.push(
    check(
      "--why explains every held item even when nothing is admitted",
      joined(heldWhy).includes("[why] every item below is held by the HOST, not by the queue: admission=HOLD (load 95.0%)") &&
        joined(heldWhy).includes("[why] #262: ready to pick, blocked by admission=HOLD (load 95.0%)"),
      joined(heldWhy),
    ),
  );

  const badBudget = await ran({ ...real, admission: '{"action":"ADMIT","laneBudget":null,"reason":"NaN"}' }, { dryRun: false });
  cases.push(
    check(
      "an unusable budget holds instead of crashing",
      joined(badBudget).includes("[pickup] holding: admission returned an unusable budget ('null').") && badBudget.code === 0,
      `${joined(badBudget)} code=${String(badBudget.code)}`,
    ),
  );

  const capped = await ran(
    {
      briefs: [brief("issue-262-a.md", declared(262)), brief("issue-263-b.md", declared(263))],
      queueList: "1. #262 [high] a\n2. #263 [high] b\nqueue=2 blocked=0",
    },
    { maxCap: 1 },
  );
  cases.push(
    check(
      "--max 1 starts one lane and leaves the second alone",
      joined(capped).includes("started=1") && joined(capped).split("WOULD start").length === 2,
      joined(capped),
    ),
  );

  const nobodyHome = await ran({ briefs: [], queueList: "queue=0 blocked=0" });
  cases.push(
    check(
      "an empty queue prints the shell's line and no started= (the loop defaults it)",
      nobodyHome.lines[nobodyHome.lines.length - 1] === "[pickup] the queue is empty." && !joined(nobodyHome).includes("started="),
      joined(nobodyHome),
    ),
  );

  const locked = fakeEnv({ lockHeldBy: "someone" });
  const lockCode = await runPickup(locked.env, { dryRun: true, why: false, maxCap: 99 });
  cases.push(
    check(
      "a live lock skips the tick without touching the queue",
      locked.lines.length === 1 && locked.lines[0]?.startsWith("[pickup] another pickup holds the lock") === true && lockCode === 0,
      locked.lines.join(" | "),
    ),
  );

  // A killed pickup must not wedge every later tick: a lock older than 300s is stolen.
  const staleDir = join(hostPath("/tmp/crew-pickup-selftest"), `${String(process.pid)}-stale`);
  rmSync(staleDir, { recursive: true, force: true });
  mkdirSync(join(staleDir, "pickup.lock"), { recursive: true });
  const staleAge = new Date(Date.now() - 400_000);
  utimesSync(join(staleDir, "pickup.lock"), staleAge, staleAge);
  const staleFake = fakeEnv({ lockHeldBy: "ghost", briefs: [brief("issue-262-x.md", declared(262))], queueList: "1. #262 [high] x\nqueue=1 blocked=0" });
  staleFake.env.sessionDir = staleDir;
  const staleCode = await runPickup(staleFake.env, { dryRun: true, why: false, maxCap: 99 });
  cases.push(
    check(
      "a lock older than 300s is stolen, not obeyed",
      staleCode === 0 && joined(staleFake).includes("[pickup] started=1") && !joined(staleFake).includes("another pickup holds the lock"),
      joined(staleFake),
    ),
  );
  rmSync(staleDir, { recursive: true, force: true });
  rmSync(join(hostPath("/tmp/crew-pickup-selftest"), String(process.pid)), { recursive: true, force: true });

  const message = buildLaunchMessage(262, "/x/briefs/issue-262-shell-to-ts.md", "D:/projects/mani-project");
  cases.push(
    check(
      "the launch message carries the issue, the brief and the brief-bedrock rules",
      message.startsWith("CREW LANE — issue #262.") &&
        message.includes("read /x/briefs/issue-262-shell-to-ts.md and follow it") &&
        message.includes("AUTHORITY: commit only.") &&
        message.includes("D:/projects/mani-project/.scratch/scripts/e2e-slot.sh") &&
        !message.includes("\r"),
      message.slice(0, 80),
    ),
  );
  cases.push(check("an empty message fails the guard", validateLaunch("", "/x.md", true) !== "", "validateLaunch('') === ''"));
  cases.push(check("a missing brief fails the guard", validateLaunch("hi", "/x.md", false) !== "", "validateLaunch(missing brief) === ''"));
  cases.push(check("a real message passes the guard", validateLaunch("hi", "/x.md", true) === "", validateLaunch("hi", "/x.md", true)));

  return cases;
}

// ----------------------------------------------------------------------- CLI

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--selftest") return report(await pickupSelftest());
  const options = parseArgs(argv);
  if (options === null) {
    console.error("usage: crew-pickup.ts [--dry-run] [--why] [--max N]");
    return 2;
  }
  return await runPickup(realEnv(), options);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
