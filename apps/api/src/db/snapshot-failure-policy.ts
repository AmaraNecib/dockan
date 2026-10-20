import type { LogEvent } from "@dokan/contracts";

import type { SnapshotFailureReason } from "./encrypted-connection";

/**
 * What one snapshot failure reason MEANS, answered once.
 *
 * `SnapshotFailureReason` says what happened. Three call sites used to each
 * decide what that meant for them — the store's log line, main's fatal handler,
 * and main's shutdown path — and each derived it by hand from the same enum. A
 * fourth would have copied it the moment it wanted the same words. That scatter
 * is what let the store's line claim a fence event code the branch does not
 * emit (#291), and what left `.reason` asserted by no test at all (#305).
 *
 * # Why here
 *
 * Beside the enum, in `db/`, because that is where the reason is declared. The
 * import of the union is `import type`, so nothing is loaded at runtime and the
 * module graph stays one-directional: `db/encrypted-connection` calls this,
 * this calls nothing.
 *
 * # Adding a reason
 *
 * The switch has no `default` on purpose. A new member of the union fails
 * `tsc` HERE, at the one place that has to answer for it, instead of silently
 * inheriting the meaning of whichever branch happened to be last.
 */
export type SnapshotFailurePolicy = {
  /** The event code the failure is filed under, for the diagnostics viewer. */
  readonly event: LogEvent;
  /**
   * `warn` for a failure the process can keep serving, `error` for one it
   * cannot. Every reason is `error` today: each of them means a committed unit
   * is not on disk, and a lost committed unit is never a warning. The field
   * exists so the first reason that is survivable says so here rather than at
   * three call sites that would each need the same edit.
   */
  readonly severity: "warn" | "error";
  /**
   * Whether the process must stop. Every reason is fatal today, for the same
   * reason `severity` is uniform: a unit the client was not told about must not
   * be reported as a failure either (the client would retry a committed write),
   * so the only honest answer left is a connection loss, which is an exit.
   */
  readonly fatal: boolean;
  /**
   * The sentence the owner reads, as a clause: lower case, no trailing stop, so
   * each caller can put it in its own frame ("FATAL: ... (<sentence>); exiting")
   * without a second copy of the meaning existing anywhere.
   */
  readonly sentence: string;
};

const NOT_DURABLE: Pick<SnapshotFailurePolicy, "event" | "severity" | "fatal"> = {
  event: "SNAPSHOT_PERSIST_FAILED",
  severity: "error",
  fatal: true,
};

export function snapshotFailurePolicy(reason: SnapshotFailureReason): SnapshotFailurePolicy {
  switch (reason) {
    case "write-failed":
      return { ...NOT_DURABLE, sentence: "the write to the snapshot file failed at the filesystem" };
    case "foreign":
      return { ...NOT_DURABLE, sentence: "another writer's envelope replaced the snapshot this holder wrote" };
    case "unstamped":
      return { ...NOT_DURABLE, sentence: "a legacy unfenced envelope replaced the snapshot this holder wrote" };
    case "unfenced-holder":
      return { ...NOT_DURABLE, sentence: "the snapshot is fenced and this connection has no stamp to check it against" };
    case "undecidable":
      return { ...NOT_DURABLE, sentence: "the bytes on disk are not a snapshot envelope this build knows" };
    case "absent":
      return { ...NOT_DURABLE, sentence: "the snapshot file is gone" };
    case "unreadable":
      return { ...NOT_DURABLE, sentence: "the snapshot fence could not be read" };
    case "dropped":
      // The one reason with its own event code: the connection named the drop
      // under SNAPSHOT_PERSIST_DROPPED, and a unit that was never written is not
      // the same row as a write that failed. Same meaning for the owner, its own
      // filter in the diagnostics viewer.
      return {
        event: "SNAPSHOT_PERSIST_DROPPED",
        severity: "error",
        fatal: true,
        sentence: "the connection closed before this committed unit reached the snapshot, so nothing could write it",
      };
  }
}
