import { describe, expect, it } from "bun:test";

import { logEvents } from "@dokan/contracts";

import type { SnapshotFailureReason } from "./encrypted-connection";
import { snapshotFailurePolicy } from "./snapshot-failure-policy";

/**
 * What each snapshot failure reason means, in one table (#305).
 *
 * This is the home `.reason` never had: the test-audit on PR #291 found it
 * asserted by zero tests, because the mapping was restated by hand at each
 * consumer and a spy beside a consumer proves only that the consumer copied the
 * mapping — never that the mapping is right. Each row is the whole answer for
 * one reason: the event code, the level, whether the process stops, and the
 * words the owner reads.
 *
 * `says` is a phrase only that reason's sentence carries. It is how the table
 * checks each sentence is about ITS reason instead of a leftover from the row
 * above, which is the failure a copy-paste actually produces.
 */
type Row = {
  readonly reason: SnapshotFailureReason;
  readonly event: string;
  readonly severity: "warn" | "error";
  readonly fatal: boolean;
  readonly says: string;
};

const TABLE = [
  { reason: "write-failed", event: "SNAPSHOT_PERSIST_FAILED", severity: "error", fatal: true, says: "filesystem" },
  { reason: "foreign", event: "SNAPSHOT_PERSIST_FAILED", severity: "error", fatal: true, says: "another writer's envelope" },
  { reason: "unstamped", event: "SNAPSHOT_PERSIST_FAILED", severity: "error", fatal: true, says: "legacy unfenced envelope" },
  { reason: "unfenced-holder", event: "SNAPSHOT_PERSIST_FAILED", severity: "error", fatal: true, says: "no stamp to check it against" },
  { reason: "undecidable", event: "SNAPSHOT_PERSIST_FAILED", severity: "error", fatal: true, says: "not a snapshot envelope this build knows" },
  { reason: "absent", event: "SNAPSHOT_PERSIST_FAILED", severity: "error", fatal: true, says: "file is gone" },
  { reason: "unreadable", event: "SNAPSHOT_PERSIST_FAILED", severity: "error", fatal: true, says: "fence could not be read" },
  { reason: "dropped", event: "SNAPSHOT_PERSIST_DROPPED", severity: "error", fatal: true, says: "closed before" },
] as const satisfies readonly Row[];

type ListedReason = (typeof TABLE)[number]["reason"];

/**
 * Compile-time proof the table lists every reason: when a seventh (or ninth)
 * member joins the union this assignment stops type-checking, so the table
 * cannot fall behind the type the way the hand-written mappings did.
 */
const EVERY_REASON_IS_LISTED: Exclude<SnapshotFailureReason, ListedReason> extends never ? true : false = true;

describe("snapshot failure policy (#305)", () => {
  it("lists every reason exactly once", () => {
    expect(EVERY_REASON_IS_LISTED).toBe(true);
    const listed = TABLE.map((row) => row.reason);
    expect(new Set(listed).size).toBe(listed.length);
  });

  for (const row of TABLE) {
    it(`"${row.reason}" files under ${row.event} at ${row.severity} and says what it means`, () => {
      const policy = snapshotFailurePolicy(row.reason);
      expect(policy.event).toBe(row.event);
      expect(policy.severity).toBe(row.severity);
      expect(policy.fatal).toBe(row.fatal);
      // A sentence is what the owner reads instead of the enum member, so it
      // has to exist and to be about this reason.
      expect(policy.sentence.length).toBeGreaterThan(0);
      expect(policy.sentence).toContain(row.says);
      // The diagnostics viewer renders `logEvent_<code>`: a reason under a code
      // outside the shared vocabulary renders as a raw English badge.
      expect(logEvents).toContain(policy.event);
    });
  }

  it("gives every reason its own sentence, so no two failures read alike", () => {
    const sentences = TABLE.map((row) => snapshotFailurePolicy(row.reason).sentence);
    expect(new Set(sentences).size).toBe(TABLE.length);
  });

  it("does not file a unit that was never written as a failed write", () => {
    // The one reason with its own event code, and the one the store used to
    // file under SNAPSHOT_PERSIST_FAILED while the connection filed it under
    // SNAPSHOT_PERSIST_DROPPED — two codes for one failure, from two places.
    expect(snapshotFailurePolicy("dropped").event).toBe("SNAPSHOT_PERSIST_DROPPED");
    expect(snapshotFailurePolicy("write-failed").event).toBe("SNAPSHOT_PERSIST_FAILED");
  });
});
