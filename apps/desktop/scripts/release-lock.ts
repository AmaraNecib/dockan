/**
 * One release build at a time per checkout.
 *
 * `tauri build` writes the shared `src-tauri/target/release` tree and the
 * pristine `bundle/nsis` artifact, and the bundler copies the sidecar after the
 * per-customer compile lock has been released. Two concurrent customer releases
 * could therefore stage their own sidecars correctly yet still package one
 * customer's binary under the other's artifact name (PR #117 re-review
 * finding 2). Every release path holds this checkout-wide lock from secret
 * resolution through bundling; the lock is refreshed while held so a
 * multi-minute build is never mistaken for a crashed owner.
 *
 * Standalone `bun run desktop:sidecar` does not take this lock (it only stages
 * one customer's binary); do not run it while a release is packaging.
 */

import path from "node:path";

import { acquireFileLock } from "./secrets";

/** Under the shared cargo target dir, which is gitignored. */
const RELEASE_LOCK_PATH = path.resolve("src-tauri/target/.dokan-release.lock");
const WAIT_MS = 60 * 60 * 1000;
const RETRY_MS = 500;
/** A live build refreshes every 30 s; five minutes without a touch is a crash. */
const STALE_MS = 5 * 60 * 1000;
const REFRESH_MS = 30 * 1000;

export interface ReleaseLockOptions {
  /** Test seam: lock path. */
  lockPath?: string;
}

/**
 * Run `work` while holding the checkout-wide release lock. Concurrent releases
 * wait for each other (up to an hour); a crashed holder's lock goes stale after
 * five minutes and is stolen.
 */
export async function withCheckoutReleaseLock<T>(
  work: () => Promise<T>,
  options: ReleaseLockOptions = {},
): Promise<T> {
  const release = acquireFileLock(options.lockPath ?? RELEASE_LOCK_PATH, {
    waitMs: WAIT_MS,
    retryMs: RETRY_MS,
    staleMs: STALE_MS,
    refreshMs: REFRESH_MS,
  });
  // `process.exit` skips `finally`; release on the exit event too.
  process.once("exit", release);
  try {
    return await work();
  } finally {
    release();
  }
}
