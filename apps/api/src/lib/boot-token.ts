import crypto from "node:crypto";

/**
 * Boot-token verification (PR #51 finding 1). The desktop shell hands its
 * spawned sidecar a one-time token via `DOKAN_BOOT_TOKEN` and requires the
 * api to echo it at `GET /health-token?token=…` before the webview navigates
 * to the api's port. A stale or tampered port record pointing at an unrelated
 * localhost server cannot satisfy the echo, so the authenticated webview can
 * never be redirected by a file.
 *
 * The comparison is constant-time: an attacker who can time a localhost probe
 * must not learn anything about the token byte by byte.
 */
export function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (expected === "") return false;
  const actual = given ?? "";
  // hashing first keeps timingSafeEqual's equal-length buffer requirement
  // without leaking the length difference of the raw strings
  const hashOf = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest();
  return crypto.timingSafeEqual(hashOf(actual), hashOf(expected));
}