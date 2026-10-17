#!/usr/bin/env bun
// herdr-wake.ts <target> <message> [deadline-seconds] [poll-seconds]
//
// Deliver a message to a Pi pane and PROVE it landed.
//
// Why this exists
// ---------------
// `herdr agent prompt` REJECTS a submission *before any input is sent* when the
// target is mid-dialog (`agent_blocked`), and refuses outright when the target is
// gone (`agent_not_found`). Its own --help says so.
//
// Every caller used to run the prompt, log it, and `exit 0` regardless. So a
// wake that was never delivered left exactly the same trace as one that was: a
// log line and a zero exit. A crew lane's report or a CI verdict could vanish
// with nothing to notice. Four callers shared the bug:
//
//   ~/.pi/agent/extensions/crew-watch.ts        (the crew_report tool)
//   .scratch/scripts/gh-pr-watch-settle.sh
//   .scratch/scripts/gh-pr-watch.sh
//   .scratch/scripts/gh-run-watch.sh
//
// Policy
// ------
//   target missing        -> exit 3 immediately; retrying cannot help
//   target blocked        -> wait and retry until the deadline. Blocked means a
//                            human has to dismiss a dialog; that is a delay, not
//                            a reason to throw the message away.
//   target idle/working   -> submit; retry on a refusal
//   deadline exceeded     -> exit 2, loudly. NEVER a false zero.
//
// `delivered` means herdr accepted the input and handed it to the target. For a
// working target Pi queues it as a steering message, which enters after the
// current turn -- it is not proof the target has *read* it.
//
// Exit codes: 0 delivered | 2 stayed blocked | 3 target missing/refused | 1 usage
// (`1` on a usage error is what the shell version's `${1:?}` did, and the exit-code
// table in its own header said `4`: the behavior is kept, the prose is fixed.)
//
// The transport is an argv array and the herdr reply is parsed in-process. The
// shell version piped it through `jq`, and a machine WITHOUT `jq` produced the same
// empty state as a pane that was gone -- both said "no agent at ...", exit 3. One
// fewer tool is one fewer way to misread a live pane as a dead one.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { check, report, type SelftestCase } from "./selftest.ts";

export const DEFAULT_DEADLINE_SECONDS = 900; // 15 minutes
export const DEFAULT_POLL_SECONDS = 15;
const MAX_REFUSALS = 5;

export type WakeOptions = {
  target: string;
  message: string;
  deadlineSeconds: number;
  pollSeconds: number;
};

/** Everything `runWake` needs from the outside world, so its policy is testable. */
export type WakeDeps = {
  hasHerdr: () => boolean;
  stateOf: (target: string) => string;
  prompt: (target: string, message: string) => boolean;
  now: () => number;
  pause: (ms: number) => Promise<void>;
  warn: (line: string) => void;
};

/**
 * The policy, and nothing else. Returns the exit code the CLI must use; every
 * non-zero code means the caller must NOT read the wake as delivered.
 */
export async function runWake(deps: WakeDeps, options: WakeOptions): Promise<number> {
  const { target, message, deadlineSeconds, pollSeconds } = options;
  if (!deps.hasHerdr()) {
    deps.warn("herdr-wake: herdr not on PATH");
    return 3;
  }
  const start = deps.now();
  let refusals = 0;
  for (;;) {
    const elapsed = Math.floor((deps.now() - start) / 1000);
    if (elapsed >= deadlineSeconds) {
      if (deps.stateOf(target) === "blocked") {
        deps.warn(`herdr-wake: '${target}' stayed blocked for ${String(deadlineSeconds)}s; message NOT delivered`);
        return 2;
      }
      deps.warn(`herdr-wake: deadline ${String(deadlineSeconds)}s reached without a delivery to '${target}'`);
      return 3;
    }

    const state = deps.stateOf(target);
    if (state === "") {
      // No agent state at all: the pane is gone, or is not an agent.
      deps.warn(`herdr-wake: no agent at '${target}'`);
      return 3;
    }
    if (state === "blocked") {
      // Someone must dismiss a dialog. Waiting is correct; discarding is not.
      await deps.pause(pollSeconds * 1000);
      continue;
    }

    if (deps.prompt(target, message)) return 0;

    refusals += 1;
    // A refusal on an idle/ready target is a race, not a policy: retry, but do not
    // spin forever on something that will clearly never be accepted.
    if (refusals >= MAX_REFUSALS) {
      deps.warn(`herdr-wake: '${target}' refused the submission ${String(refusals)}x (state=${state})`);
      return 3;
    }
    await deps.pause(pollSeconds * 1000);
  }
}

/** `command -v`: a name is only usable if the PATH actually carries it. */
export function findExecutable(name: string, pathValue: string, platform: string = process.platform): string | null {
  const suffixes = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

type AgentGet = { result?: { agent?: { agent_status?: string } } };

export function realDeps(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): WakeDeps {
  const bin = env.HERDR_BIN ?? "herdr";
  const pathValue = env.PATH ?? "";
  const herdrAt = findExecutable(bin, pathValue, platform);
  const call = (args: string[]): string | null => {
    if (herdrAt === null) return null;
    const done = spawnSync(herdrAt, args, { encoding: "utf8", windowsHide: true });
    if (done.status !== 0) return null;
    return done.stdout;
  };
  return {
    hasHerdr: () => herdrAt !== null,
    stateOf: (target) => {
      const out = call(["agent", "get", target]);
      if (out === null) return "";
      try {
        // SAFETY: `herdr agent get --help` fixes this shape; a wrong shape throws
        // out of `stateOf` only in the sense of falling back to "" below.
        const parsed = JSON.parse(out) as AgentGet;
        return parsed.result?.agent?.agent_status ?? "";
      } catch {
        return "";
      }
    },
    prompt: (target, message) => call(["agent", "prompt", target, message]) !== null,
    now: () => Date.now(),
    pause: (ms) => sleep(ms),
    warn: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

// ------------------------------------------------------------------ selftest

type FakeHerdr = { state: string; accept: boolean; refused: number };

function fakeDeps(fake: FakeHerdr, warnLines: string[]): WakeDeps {
  let clock = 0;
  return {
    hasHerdr: () => true,
    stateOf: () => fake.state,
    prompt: () => {
      fake.refused += 1;
      return fake.accept;
    },
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
    warn: (line) => warnLines.push(line),
  };
}

export async function wakeSelftest(): Promise<SelftestCase[]> {
  const cases: SelftestCase[] = [];
  const run = async (fake: FakeHerdr, deadlineSeconds = 60): Promise<{ code: number; warned: string[]; attempts: number }> => {
    const warned: string[] = [];
    const code = await runWake(fakeDeps(fake, warned), {
      target: "w48:p1",
      message: "hello",
      deadlineSeconds,
      pollSeconds: 5,
    });
    return { code, warned, attempts: fake.refused };
  };

  const delivered = await run({ state: "idle", accept: true, refused: 0 });
  cases.push(check("the property: an accepted prompt exits 0", delivered.code === 0, `code=${String(delivered.code)}`));
  cases.push(check("a delivery is never announced as a failure", delivered.warned.length === 0, warnedText(delivered.warned)));

  const missing = await run({ state: "", accept: true, refused: 0 });
  cases.push(
    check(
      "a missing target exits 3 and says which target",
      missing.code === 3 && missing.warned[0] === "herdr-wake: no agent at 'w48:p1'",
      `code=${String(missing.code)} ${warnedText(missing.warned)}`,
    ),
  );

  const refused = await run({ state: "idle", accept: false, refused: 0 });
  cases.push(
    check(
      "5 refusals exit 3, never a false zero",
      refused.code === 3 && refused.warned.some((line) => line.includes("refused the submission 5x")),
      `code=${String(refused.code)} refusals=${String(5)} ${warnedText(refused.warned)}`,
    ),
  );

  const blocked = await run({ state: "blocked", accept: true, refused: 0 }, 20);
  cases.push(
    check(
      "a target blocked for the whole deadline exits 2",
      blocked.code === 2 && blocked.warned.some((line) => line.includes("stayed blocked for 20s; message NOT delivered")),
      `code=${String(blocked.code)} ${warnedText(blocked.warned)}`,
    ),
  );
  cases.push(
    check(
      "a blocked target is never submitted to",
      blocked.code === 2 && blocked.attempts === 0,
      `code=${String(blocked.code)} attempts=${String(blocked.attempts)}`,
    ),
  );

  const working = await run({ state: "working", accept: true, refused: 0 });
  cases.push(check("a working target still delivers (Pi queues it as steering)", working.code === 0, `code=${String(working.code)}`));

  const noHerdr = await runWake(
    { ...fakeDeps({ state: "idle", accept: true, refused: 0 }, []), hasHerdr: () => false },
    { target: "w48:p1", message: "hello", deadlineSeconds: 5, pollSeconds: 1 },
  );
  cases.push(check("herdr absent from PATH exits 3 before any attempt", noHerdr === 3, `code=${String(noHerdr)}`));

  const expected = "herdr-wake: herdr not on PATH";
  const noHerdrCli = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "w48:p1", "hello", "1", "1"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", HERDR_BIN: "herdr" },
    windowsHide: true,
  });
  cases.push(
    check(
      "the CLI agrees: PATH without herdr exits 3",
      noHerdrCli.status === 3 && (noHerdrCli.stderr ?? "").trim() === expected,
      `code=${String(noHerdrCli.status)} stderr=${JSON.stringify((noHerdrCli.stderr ?? "").trim())}`,
    ),
  );

  const oneArg = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "w48:p1"], {
    encoding: "utf8",
    windowsHide: true,
  });
  cases.push(check("a missing message is a usage error (exit 1, as the shell did)", oneArg.status === 1, `code=${String(oneArg.status)}`));

  cases.push(
    check(
      "findExecutable: PATH membership, not a name guess",
      findExecutable("herdr", "/nowhere", "linux") === null && findExecutable("bun", process.env.PATH ?? "", process.platform) !== null,
      `linux=${String(findExecutable("herdr", "/nowhere", "linux"))}`,
    ),
  );

  return cases;
}

function warnedText(lines: string[]): string {
  return lines.join(" | ");
}

// ----------------------------------------------------------------------- CLI

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--selftest") return report(await wakeSelftest());
  const [target, message, deadline, poll] = argv;
  if (target === undefined || message === undefined) {
    console.error("usage: herdr-wake.ts <target> <message> [deadline-seconds] [poll-seconds]");
    return 1;
  }
  const deadlineSeconds = Number.parseInt(deadline ?? String(DEFAULT_DEADLINE_SECONDS), 10);
  const pollSeconds = Number.parseInt(poll ?? String(DEFAULT_POLL_SECONDS), 10);
  return await runWake(realDeps(), {
    target,
    message,
    deadlineSeconds: Number.isFinite(deadlineSeconds) ? deadlineSeconds : DEFAULT_DEADLINE_SECONDS,
    pollSeconds: Number.isFinite(pollSeconds) ? pollSeconds : DEFAULT_POLL_SECONDS,
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
