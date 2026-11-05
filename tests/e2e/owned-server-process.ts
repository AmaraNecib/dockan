import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const owned = new WeakMap<ChildProcess, { closed: boolean; groupGone: boolean; windowsTreeStopped: boolean }>();
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/** Only children launched here may be signalled as detached POSIX groups. */
export function spawnOwnedServer(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
  const state = { closed: false, groupGone: false, windowsTreeStopped: false };
  owned.set(child, state);
  child.once("close", () => { state.closed = true; });
  // A failed spawn still emits close. Consume error so teardown can handle it.
  child.once("error", () => {});
  return child;
}

async function waitUntil(check: () => boolean, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await pause();
  }
  return true;
}

export async function stopOwnedServer(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined) return;
  const state = owned.get(child);
  if (state === undefined) throw new Error("Refusing to stop an unowned server process");
  const pid = child.pid;
  if (pid === undefined) {
    if (!await waitUntil(() => state.closed, 2_000)) throw new Error("Failed server spawn did not close");
    return;
  }
  if (process.platform === "win32") {
    if (state.windowsTreeStopped) {
      if (!await waitUntil(() => state.closed, 2_000)) throw new Error(`Owned server ${pid} did not close`);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Owned server ${pid} leader exited before a successful tree stop; preserve fixture data`);
    }
    {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      let finished = false;
      let code: number | null = null;
      let failure: Error | undefined;
      killer.once("close", (result) => { code = result; finished = true; });
      killer.once("error", (error) => { failure = error; finished = true; });
      if (!await waitUntil(() => finished, 3_000)) {
        killer.kill();
        throw new Error(`Tree kill timed out for owned server ${pid}`);
      }
      if (failure !== undefined) throw failure;
      // A failed tree kill cannot prove descendants stopped, even if the leader
      // exits concurrently. Keep the fixture on that ambiguous shutdown.
      if (code !== 0) {
        throw new Error(`Tree kill failed for owned server ${pid}: ${code}`);
      }
      state.windowsTreeStopped = true;
    }
    if (!await waitUntil(() => state.closed, 2_000)) throw new Error(`Owned server ${pid} did not close`);
    return;
  }
  const groupExists = (): boolean => {
    if (state.groupGone) return false;
    try { process.kill(-pid, 0); return true; } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      // Once this group disappears, never probe or signal a potentially reused ID.
      state.groupGone = true;
      return false;
    }
  };
  const signal = (value: NodeJS.Signals): void => {
    if (!groupExists()) return;
    try { process.kill(-pid, value); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      state.groupGone = true;
    }
  };
  // The detached group remains ours while descendants survive the leader.
  signal("SIGTERM");
  const stopped = () => !groupExists() && state.closed;
  if (await waitUntil(stopped, 2_000)) return;
  signal("SIGKILL");
  if (!await waitUntil(stopped, 2_000)) throw new Error(`Owned server group ${pid} did not stop`);
}

/** Wait for both stop attempts, including failure, before permitting cleanup. */
export async function stopOwnedServers(children: Array<ChildProcess | undefined>): Promise<void> {
  const results = await Promise.allSettled(children.map(stopOwnedServer));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, "Owned servers did not all stop; preserve fixture data");
}
