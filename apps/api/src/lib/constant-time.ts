import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (issue #52): replaces `===`,
 * whose early-exit lets a local attacker time-guess a secret byte by byte.
 *
 * Length is guarded on UTF-8 BYTES, not string length: two strings with equal
 * code-unit counts can have different byte lengths ("é" vs "a"), and
 * timingSafeEqual itself throws on unequal buffers. The early false return
 * leaks only the secret's BYTE LENGTH, which for a long random per-customer
 * build secret reveals nothing exploitable.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  // SAFETY: both buffers are equal-length above, so timingSafeEqual cannot throw
  return timingSafeEqual(bufA, bufB);
}
