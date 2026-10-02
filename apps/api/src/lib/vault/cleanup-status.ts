import type { PlaintextCleanupStatus } from "@dokan/contracts";

/** What one legacy-plaintext sweep can report. */
export type PlaintextCleanupOutcome = {
  status: PlaintextCleanupStatus;
  /** the paths the sweep confirmed it could not remove (never guessed) */
  remaining: string[];
};

/**
 * Run the legacy-plaintext sweep and classify its result into three states
 * (round-4 finding): a confirmed clean sweep, a confirmed list of paths that
 * remain, or UNKNOWN when the sweep itself failed. A failure must never be
 * reported as an empty clean result — the UI would tell the owner everything
 * is fine while plaintext data may still sit on the disk.
 */
export async function classifyPlaintextCleanup(
  run: () => Promise<{ plaintextRemaining: string[] }>,
  onError: (error: Error) => void,
): Promise<PlaintextCleanupOutcome> {
  try {
    const { plaintextRemaining } = await run();
    return {
      status: plaintextRemaining.length > 0 ? "remaining" : "clean",
      remaining: plaintextRemaining,
    };
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return { status: "unknown", remaining: [] };
  }
}
