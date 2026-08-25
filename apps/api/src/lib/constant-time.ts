import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (issue #52): replaces `===`,
 * whose early-exit lets a local attacker time-guess a secret byte by byte.
 *
 * The node primitive throws on unequal buffer lengths, so length is guarded
 * first — an early false return leaks only the secret's LENGTH, which for a
 * long random per-customer build secret reveals nothing exploitable.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // SAFETY: both buffers are equal-length above, so timingSafeEqual cannot throw
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
