/**
 * One rule for reading a pid probe, shared by the vault lock and the port
 * record (issue #275, ADR-0012). Two copies of this rule is how the bug that
 * stranded a shipped install survived: `lock.ts` read `EPERM` as "alive", but
 * on Windows `process.kill(pid, 0)` also returns `EPERM` for a pid that no
 * longer runs, so a dead sidecar's lock looked held forever.
 *
 * The rule:
 * - the probe proves liveness only when it does NOT throw;
 * - `ESRCH` is a definitively gone pid;
 * - anything else — `EPERM` above all — is INCONCLUSIVE: the probe cannot
 *   tell, so each caller decides from its own evidence (the vault lock uses
 *   the recorded heartbeat).
 */

/** What a pid probe could establish about one pid. */
export type PidLiveness = "alive" | "gone" | "unknown";

/** The probe seam: injectable so tests can force the inconclusive outcome. */
export type PidLivenessProbe = (pid: number) => PidLiveness;

/** The errno of an error, when it carries one (fs and process errors do). */
export function errnoCode(error: Error): string | undefined {
  if (!("code" in error)) return undefined;
  // SAFETY: the `"code" in error` probe above established the NodeJS errno shape
  return (error as NodeJS.ErrnoException).code;
}

/** The OS probe. Only a throw tells us anything, and only `ESRCH` is final. */
export function probePidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error instanceof Error && errnoCode(error) === "ESRCH" ? "gone" : "unknown";
  }
}

/**
 * The port record's reading of the same probe: only a pid the probe calls
 * gone may have its lock or registry entry taken over, so an inconclusive
 * probe keeps it. Kept beside the probe so the two sites share one rule.
 */
export function pidIsAlive(pid: number, probe: PidLivenessProbe = probePidLiveness): boolean {
  return probe(pid) !== "gone";
}
