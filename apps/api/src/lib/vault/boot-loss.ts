/**
 * ADR-0012 clause 3: once another copy owns the folder, nothing this process
 * does may touch it again, not the live app and not the post-open tail.
 *
 * The boot flow asks this instead of re-deriving `lockLost` inline at each
 * site. It is pure so a unit test pins the decision a boot must make before it
 * installs the live app or runs the tail that writes to the folder.
 */
export type BootHandler = "live" | "refused";

/**
 * Which handler a boot that just opened the store installs.
 *
 * `"refused"` means the in-use refusal stays installed and the post-open tail
 * (header commit, plaintext cleanup, daily backup) does not run.
 */
export function readyHandlerFor(lockLost: boolean): BootHandler {
  return lockLost ? "refused" : "live";
}
